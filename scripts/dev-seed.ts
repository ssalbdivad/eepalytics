/**
 * `pnpm seed` — populate the database with your REAL recent games, right now.
 *
 * This exists so the UI has real data to develop against without waiting for the daemon to
 * observe a game ending. It does exactly what the `match-ingest` job does, in a loop, in the
 * foreground, with a progress line.
 *
 * SAFETY: GET only. It reads match history, match details, timelines and champion names from
 * the League client and writes them into the local DB. It never POSTs to the client, never
 * launches a replay, never starts a game. Safe to run while you are in champ select or in a
 * match — the client answers history queries mid-game.
 *
 * WHAT IT CANNOT DO: `begIndex`/`endIndex` on match history are silently ignored, so there is
 * no backfill. You get whatever recent window the client feels like handing over (~20 games,
 * and it has been observed to shrink to 5 mid-game). Run it repeatedly over days and the
 * union accumulates in SQLite — that is the only way to build deep history.
 *
 *   pnpm seed                     ingest every game in the current window that we do not have
 *   pnpm seed --limit 5           only the 5 most recent
 *   pnpm seed --games 5633857616  specific gameIds (works for ids outside the window)
 *   pnpm seed --force             re-ingest games already in the DB
 *   pnpm seed --queue-reviews     also enqueue review-game jobs (costs model tokens)
 *   pnpm seed --curl              force the slow transport, to test the fallback
 *   pnpm seed --dry-run           fetch and report, write nothing
 */

import {
	LANING_END_SEC,
	LANING_START_SEC,
	PLATFORM_ID,
	SMITE_SPELL_ID,
	USER_PUUID,
	patchOf,
	queueName
} from "../src/shared/constants.ts"
import { distToLane, LANES, type Lane, type Pos } from "../src/shared/map.ts"
import { fmtDuration } from "../src/shared/time.ts"
import {
	ChampionSummary,
	LcuGame,
	LcuMatchHistory,
	LcuTimeline,
	parseOrNull,
	riotIdOf,
	type LcuFrame,
	type LcuParticipant
} from "../src/shared/schema/lcu.ts"
import type { Confidence, Role } from "../src/shared/schema/domain.ts"
import { ensureDataDirs, getDb, closeDb } from "../src/db/index.ts"
import {
	countGames,
	enqueue,
	existingGameIds,
	setGameBlobs,
	upsertGame,
	upsertParticipants,
	type ParticipantUpsert
} from "../src/db/queries.ts"
import { BLOB_MATCH, BLOB_TIMELINE, contentHash, writeBlob } from "../src/db/blobs.ts"
import { getJson, openLcu, type LcuTransport } from "./lib/win-lcu.ts"

/* ============================================================ args */

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const value = (name: string): string | null => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 ? (argv[i + 1] ?? null) : null
}

const OPTS = {
	limit: Number(value("limit") ?? 0) || 0,
	games: (value("games") ?? "")
		.split(",")
		.map(s => Number(s.trim()))
		.filter(n => Number.isSafeInteger(n) && n > 0),
	force: flag("force"),
	noTimeline: flag("no-timeline"),
	queueReviews: flag("queue-reviews"),
	dryRun: flag("dry-run"),
	curl: flag("curl")
}

const log = (s = ""): void => console.log(s)
const step = (s: string): void => console.log(`  ${s}`)

if (flag("help") || flag("h")) {
	log(`
coachskaffur seed — ingest your real recent games from the running League client (GET only)

  pnpm seed                      every game in the client's window that is not already stored
  pnpm seed --limit 5            only the 5 most recent
  pnpm seed --games 5633857616   specific gameIds, comma separated (ids outside the window work)
  pnpm seed --force              re-ingest games already in the database
  pnpm seed --no-timeline        skip timelines (faster; disables role inference)
  pnpm seed --queue-reviews      also enqueue review-game jobs — this spends model tokens
  pnpm seed --curl               force the slow curl.exe transport, to test the fallback
  pnpm seed --dry-run            fetch and report, write nothing

There is no backfill: begIndex/endIndex are silently ignored by the client, so you get a
server-chosen recent window (~20 games). Run this over several days and the union accumulates.
`)
	process.exit(0)
}

/* ============================================================ role inference

   The LCU's own `participants[].timeline.lane` / `.role` are garbage — four of ten players
   labelled JUNGLE in the game we checked, one of them with 273 lane CS. This is the recipe
   from `.research/analytics.md` §2.2, which produced a well-formed {TOP,JGL,MID,ADC,SUP} set
   for both teams in 22/22 games.

   The daemon's own copy lives in `src/analysis/`; this one exists so `pnpm seed` can fill in
   `role` at ingest time without depending on a unit that may not be wired up yet. If they
   ever disagree, `src/analysis/` wins and this should be deleted.
*/

const median = (xs: number[]): number => {
	if (xs.length === 0) return Number.POSITIVE_INFINITY
	const s = [...xs].sort((a, b) => a - b)
	const mid = Math.floor(s.length / 2)
	return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

interface RoleAssignment {
	roles: Map<number, Role>
	confidence: Map<number, Confidence>
	/** Frames inside the laning window that the inference actually used. */
	frames: number
	/** Per team: was the jungler identified by a unique Smite (the strong case)? */
	jungleBySmite: Record<number, boolean>
	/** Per team: end-of-game lane-CS gap between the assigned ADC and SUP. */
	botCsGap: Record<number, number>
}

const inferRoles = (
	game: LcuGame,
	timeline: LcuTimeline | null
): RoleAssignment => {
	const roles = new Map<number, Role>()
	const confidence = new Map<number, Confidence>()
	const jungleBySmite: Record<number, boolean> = { 100: false, 200: false }
	const botCsGap: Record<number, number> = { 100: 0, 200: 0 }

	// Laning-window frames only: 2:00-9:30, where lane assignments are still legible.
	const laningFrames: LcuFrame[] = (timeline?.frames ?? []).filter(f => {
		const sec = f.timestamp / 1000
		return sec >= LANING_START_SEC && sec <= LANING_END_SEC
	})

	const positionsOf = (participantId: number): Pos[] =>
		laningFrames
			.map(f => f.participantFrames[String(participantId)]?.position)
			.filter((p): p is Pos => p !== undefined)

	for (const teamId of [100, 200]) {
		const team = game.participants.filter(p => p.teamId === teamId)
		if (team.length === 0) continue

		// 1. Jungler = the unique Smite holder. Verified in 44/44 team-games.
		const smiters = team.filter(
			p => p.spell1Id === SMITE_SPELL_ID || p.spell2Id === SMITE_SPELL_ID
		)
		let jungler: LcuParticipant | undefined
		if (smiters.length === 1) {
			jungler = smiters[0]
			jungleBySmite[teamId] = true
		} else {
			// Fallback: most jungle camps. Weaker, so the confidence drops with it.
			jungler = [...team].sort(
				(a, b) => b.stats.neutralMinionsKilled - a.stats.neutralMinionsKilled
			)[0]
		}
		if (jungler) {
			roles.set(jungler.participantId, "JGL")
			confidence.set(jungler.participantId, smiters.length === 1 ? "high" : "low")
		}

		const laners = team.filter(p => p.participantId !== jungler?.participantId)

		// Without frames we cannot separate the four laners at all. Say so rather than guess.
		if (laningFrames.length < 5) {
			for (const p of laners) {
				roles.set(p.participantId, "UNKNOWN")
				confidence.set(p.participantId, "low")
			}
			continue
		}

		const medDist = new Map<number, Record<Lane, number>>()
		for (const p of laners) {
			const pos = positionsOf(p.participantId)
			const rec = {} as Record<Lane, number>
			for (const lane of LANES) rec[lane] = median(pos.map(q => distToLane(q, lane)))
			medDist.set(p.participantId, rec)
		}

		// 2. Greedy, TOP first: the top polyline is the most isolated and least ambiguous.
		const pool = [...laners]
		const takeClosest = (lane: Lane): LcuParticipant | undefined => {
			let best: LcuParticipant | undefined
			let bestD = Number.POSITIVE_INFINITY
			let runnerUp = Number.POSITIVE_INFINITY
			for (const p of pool) {
				const d = medDist.get(p.participantId)?.[lane] ?? Number.POSITIVE_INFINITY
				if (d < bestD) {
					runnerUp = bestD
					bestD = d
					best = p
				} else if (d < runnerUp) runnerUp = d
			}
			if (best) {
				pool.splice(pool.indexOf(best), 1)
				// A wide margin to the runner-up is what makes this assignment trustworthy.
				const margin = runnerUp - bestD
				confidence.set(best.participantId, margin >= 1500 ? "high" : "medium")
			}
			return best
		}

		const top = takeClosest("TOP")
		if (top) roles.set(top.participantId, "TOP")
		const mid = takeClosest("MID")
		if (mid) roles.set(mid.participantId, "MID")

		// 3. The remaining two are bot lane; the one with more LANE minions is the ADC.
		const bot = [...pool].sort((a, b) => b.stats.totalMinionsKilled - a.stats.totalMinionsKilled)
		const [adc, sup] = bot
		const gap =
			adc && sup ? adc.stats.totalMinionsKilled - sup.stats.totalMinionsKilled : 0
		botCsGap[teamId] = gap
		// Rule from the research: below a 40 CS gap the ADC/SUP split is not trustworthy.
		const botConfidence: Confidence = gap >= 40 ? "high" : "low"
		if (adc) {
			roles.set(adc.participantId, "ADC")
			confidence.set(adc.participantId, botConfidence)
		}
		if (sup) {
			roles.set(sup.participantId, "SUP")
			confidence.set(sup.participantId, botConfidence)
		}
	}

	for (const p of game.participants) {
		if (!roles.has(p.participantId)) roles.set(p.participantId, "UNKNOWN")
		if (!confidence.has(p.participantId)) confidence.set(p.participantId, "low")
	}

	return { roles, confidence, frames: laningFrames.length, jungleBySmite, botCsGap }
}

/* ============================================================ champion names */

const championNames = new Map<number, string>()

const loadChampionNames = async (transport: LcuTransport): Promise<boolean> => {
	try {
		const raw = await getJson(transport, "/lol-game-data/assets/v1/champion-summary.json")
		const parsed = parseOrNull(ChampionSummary, raw)
		if (!parsed) return false
		for (const c of parsed) if (c.id > 0 && c.name) championNames.set(c.id, c.name)
		return championNames.size > 0
	} catch {
		return false
	}
}

const championName = (id: number): string => championNames.get(id) ?? `Champion ${id}`

/* ============================================================ ingest one game */

/** "Ranked Solo/Duo · 38m 30s". */
const describeQueue = (queueId: number, durationSec: number): string =>
	`${queueName(queueId)} · ${fmtDuration(durationSec)}`

interface IngestResult {
	gameId: number
	ok: boolean
	note: string
	role?: Role
	win?: boolean
	/** "Ranked Solo/Duo · 38m 30s" — printed per row so the queue mix is visible at a glance. */
	queue?: string
}

const ingestGame = async (
	transport: LcuTransport,
	gameId: number,
	puuid: string
): Promise<IngestResult> => {
	const rawGame = await getJson(transport, `/lol-match-history/v1/games/${gameId}`)
	const game = parseOrNull(LcuGame, rawGame)
	if (!game) return { gameId, ok: false, note: "match JSON did not validate against LcuGame" }
	if (game.participants.length < 10)
		return { gameId, ok: false, note: `only ${game.participants.length} participants (list-shaped response)` }

	let timeline: LcuTimeline | null = null
	let timelineNote = ""
	if (!OPTS.noTimeline)
		try {
			const rawTimeline = await getJson(
				transport,
				`/lol-match-history/v1/game-timelines/${gameId}`
			)
			timeline = parseOrNull(LcuTimeline, rawTimeline)
			if (!timeline) timelineNote = "timeline did not validate"
		} catch (e) {
			timelineNote = `timeline unavailable (${(e as Error).message})`
		}

	// Identity: match on puuid. summonerName is "" and accountId is 0 everywhere now.
	const identity = game.participantIdentities.find(i => i.player?.puuid === puuid)
	if (!identity)
		return { gameId, ok: false, note: "you are not a participant in this game" }
	const me = game.participants.find(p => p.participantId === identity.participantId)
	if (!me) return { gameId, ok: false, note: `no participant row for id ${identity.participantId}` }

	const inference = inferRoles(game, timeline)
	const myRole = inference.roles.get(me.participantId) ?? "UNKNOWN"
	const myConfidence = inference.confidence.get(me.participantId) ?? "low"

	const queue = describeQueue(game.queueId, game.gameDuration)

	if (OPTS.dryRun)
		return {
			gameId,
			ok: true,
			queue,
			note: `dry run — ${game.participants.length}p, ${timeline?.frames.length ?? 0} frames${timelineNote ? `, ${timelineNote}` : ""}`,
			role: myRole,
			win: me.stats.win
		}

	// Raw payloads are kept verbatim and gzipped: re-analysis must never need the client again.
	const matchBlob = writeBlob(gameId, BLOB_MATCH, rawGame)
	const timelineBlob = timeline ? writeBlob(gameId, BLOB_TIMELINE, timeline) : null

	upsertGame({
		gameId: game.gameId,
		platformId: game.platformId || PLATFORM_ID,
		queueId: game.queueId,
		gameMode: game.gameMode,
		gameType: game.gameType,
		mapId: game.mapId,
		gameVersion: game.gameVersion,
		patch: patchOf(game.gameVersion),
		gameCreationMs: game.gameCreation,
		gameDurationSec: game.gameDuration,
		endedAtMs: game.gameCreation + game.gameDuration * 1000,
		participantId: me.participantId,
		teamId: me.teamId,
		championId: me.championId,
		championName: championName(me.championId),
		role: myRole,
		roleConfidence: myConfidence,
		win: me.stats.win,
		kills: me.stats.kills,
		deaths: me.stats.deaths,
		assists: me.stats.assists,
		cs: me.stats.totalMinionsKilled,
		jungleCs: me.stats.neutralMinionsKilled,
		gold: me.stats.goldEarned,
		visionScore: me.stats.visionScore,
		champLevel: me.stats.champLevel,
		damageToChampions: me.stats.totalDamageDealtToChampions
	})

	const identityById = new Map(game.participantIdentities.map(i => [i.participantId, i.player]))
	const participants: ParticipantUpsert[] = game.participants.map(p => {
		const player = identityById.get(p.participantId)
		return {
			gameId,
			participantId: p.participantId,
			teamId: p.teamId,
			puuid: player?.puuid ?? "",
			riotId: player ? riotIdOf(player) : "",
			summonerId: player?.summonerId ?? null,
			championId: p.championId,
			championName: championName(p.championId),
			role: inference.roles.get(p.participantId) ?? "UNKNOWN",
			roleConfidence: inference.confidence.get(p.participantId) ?? "low",
			isUser: p.participantId === me.participantId,
			kills: p.stats.kills,
			deaths: p.stats.deaths,
			assists: p.stats.assists,
			cs: p.stats.totalMinionsKilled,
			jungleCs: p.stats.neutralMinionsKilled,
			gold: p.stats.goldEarned,
			visionScore: p.stats.visionScore,
			champLevel: p.stats.champLevel,
			damageToChampions: p.stats.totalDamageDealtToChampions,
			win: p.stats.win,
			spell1Id: p.spell1Id,
			spell2Id: p.spell2Id,
			items: [0, 1, 2, 3, 4, 5, 6]
				.map(i => (p.stats as unknown as Record<string, number | undefined>)[`item${i}`] ?? 0)
				.filter(n => n > 0),
			// The whole 118-field row, kept for anything the domain type does not model.
			stats: p.stats
		}
	})
	upsertParticipants(gameId, participants)

	setGameBlobs(gameId, {
		matchBlob,
		timelineBlob,
		contentHash: contentHash(gameId)
	})

	// Metrics and moments are the analysis unit's job. Queue it rather than half-doing it here.
	enqueue({ kind: "analysis-run", gameId })
	if (OPTS.queueReviews) enqueue({ kind: "review-game", gameId })

	const frames = timeline?.frames.length ?? 0
	return {
		gameId,
		ok: true,
		queue,
		note:
			`${frames} frames` +
			(timelineNote ? `, ${timelineNote}` : "") +
			(inference.frames < 5 ? ", role inference had too few laning frames" : ""),
		role: myRole,
		win: me.stats.win
	}
}

/* ============================================================ main */

const main = async (): Promise<void> => {
	log("\ncoachskaffur seed")
	log("  ingests your real recent games from the League client (GET only)\n")

	ensureDataDirs()
	getDb() // opens + migrates
	const before = countGames()

	const { transport, lock, bridgeError } = await openLcu({ preferCurl: OPTS.curl })
	step(`transport: ${transport.kind} (client on port ${lock.port})`)
	if (bridgeError && !OPTS.curl) step(`  bridge unavailable, using curl: ${bridgeError}`)

	try {
		const summoner = await getJson<{ puuid?: string; gameName?: string; tagLine?: string }>(
			transport,
			"/lol-summoner/v1/current-summoner"
		)
		const puuid = summoner.puuid ?? USER_PUUID
		step(`account:   ${summoner.gameName}#${summoner.tagLine}`)
		if (puuid !== USER_PUUID)
			step(`  note: logged in as a different account than the configured CSK_PUUID`)

		const namesOk = await loadChampionNames(transport)
		step(`champions: ${namesOk ? `${championNames.size} names loaded` : "unavailable — ids only"}`)

		// Which games?
		let gameIds: number[]
		if (OPTS.games.length > 0) {
			gameIds = OPTS.games
			step(`window:    ${gameIds.length} gameId(s) from --games`)
		} else {
			const raw = await getJson(
				transport,
				`/lol-match-history/v1/products/lol/${puuid}/matches`
			)
			const history = parseOrNull(LcuMatchHistory, raw)
			if (!history) throw new Error("match history did not validate against LcuMatchHistory")
			gameIds = history.games.games.map(g => g.gameId).sort((a, b) => b - a)
			step(
				`window:    ${gameIds.length} games offered by the client ` +
					`(begIndex/endIndex are ignored — this is all there is)`
			)
		}

		const have = existingGameIds(gameIds)
		let todo = OPTS.force ? gameIds : gameIds.filter(id => !have.has(id))
		if (OPTS.limit > 0) todo = todo.slice(0, OPTS.limit)

		step(
			`to ingest: ${todo.length}${have.size > 0 && !OPTS.force ? ` (${have.size} already in the DB)` : ""}` +
				(OPTS.dryRun ? "  [dry run — nothing will be written]" : "")
		)
		log("")

		const results: IngestResult[] = []
		for (const [i, gameId] of todo.entries()) {
			const prefix = `  [${String(i + 1).padStart(2)}/${todo.length}] ${gameId}`
			const startedAt = performance.now()
			try {
				const r = await ingestGame(transport, gameId, puuid)
				results.push(r)
				const ms = (performance.now() - startedAt).toFixed(0)
				log(
					r.ok ?
						`${prefix}  ✓ ${r.win ? "W" : "L"} ${String(r.role).padEnd(4)} ${(r.queue ?? "").padEnd(26)} ${r.note}  ${ms}ms`
					:	`${prefix}  ✗ ${r.note}`
				)
			} catch (e) {
				results.push({ gameId, ok: false, note: (e as Error).message })
				log(`${prefix}  ✗ ${(e as Error).message}`)
			}
		}

		/* ---------------------------------------------------------- summary */

		const okCount = results.filter(r => r.ok).length
		const failed = results.filter(r => !r.ok)
		log("")
		log(`  ingested ${okCount}/${todo.length}; database now holds ${countGames()} games (was ${before})`)
		if (failed.length > 0) {
			log(`  ${failed.length} failed:`)
			for (const f of failed) log(`    ${f.gameId}: ${f.note}`)
		}

		if (!OPTS.dryRun && okCount > 0) {
			log("")
			log(`  queued ${okCount} analysis-run job${okCount === 1 ? "" : "s"}${OPTS.queueReviews ? ` and ${okCount} review-game jobs` : ""}.`)
			log(`  Start the daemon (\`pnpm dev\`) to drain the queue${OPTS.queueReviews ? "" : ", then hit Review in the UI"}.`)
		}

		// A tiny honesty note: the roles above are inferred, not read.
		const roleCounts = new Map<string, number>()
		for (const r of results)
			if (r.ok && r.role) roleCounts.set(r.role, (roleCounts.get(r.role) ?? 0) + 1)
		if (roleCounts.size > 0) {
			const summary = [...roleCounts].map(([role, n]) => `${n} ${role}`).join(", ")
			log("")
			log(`  your role, inferred from frame positions + Smite: ${summary}`)
			log(`  (the client's own timeline.lane/.role fields are wrong and are ignored)`)
		}
		log("")
	} finally {
		transport.close()
		closeDb()
	}
}

await main().catch(e => {
	console.error(`\n  seed failed: ${(e as Error).message}\n`)
	console.error(`  Run \`pnpm doctor\` to find out why.\n`)
	process.exit(1)
})
