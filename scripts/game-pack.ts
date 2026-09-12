/**
 * THE WHOLE-GAME EVIDENCE PACK: one artefact holding everything true about one game.
 *
 * ## Why this exists
 *
 * The live coach's verdict on game 5639406342 was "0/10, nothing it said was useful, it was
 * generic and often hilariously wrong", and it is the right verdict. It spoke every ~20 seconds
 * with nothing new to say, so it read his own HUD back to him, and it told him to take Rift
 * Herald eight times over six minutes without ever being able to see that he was on the far side
 * of the map. That failure is structural: a turn has one screenshot, a few seconds, and a block
 * that knows the roster, the gold, the clock and the CS — and does not know where anybody IS.
 *
 * A POST-GAME pass has none of those constraints. The game finished hours ago and will hold
 * still: every sample, every frame, the whole event log, and — new with
 * `scripts/minimap-track.ts` — a POSITION TRACK read off the minimap. So this script assembles
 * the pack a reviewer with unlimited time should be handed, and the single most valuable thing in
 * it is a join the live path could never make: WHERE HE WAS when each objective fell.
 *
 * ## What this is not
 *
 * It is not a review, and nothing here decides what anything MEANS. No advice, no severity, no
 * judgement, and no number that was not measured. Every joined field carries its own gap and its
 * own confidence, and where a channel cannot answer (the minimap reader returns unlabelled red
 * rings, so it cannot tell you that a ring is Kayn) the pack says so in the field rather than
 * guessing. A pack that quietly interpolates is a pack that teaches the next review to fabricate.
 *
 * ## Provenance of every section
 *
 *   spine        raw `allgamedata` samples, one entry per minute plus one per notable event
 *   events       the accumulated `events.Events` array off the LAST sample, names resolved
 *   position     `data/eval/minimap-track/<session>.json` — a Gemini read of the minimap crop
 *   objectives   the event log joined onto the position track by game clock
 *   baselines    `baselineDuring` (which excludes this game AND everything after it), unaltered
 *   frames       `journal_frame`, run-segmented, rebased onto this checkout
 *   liveCoach    `data/logs/live-transcript.jsonl`, windowed to this run, clocks derived
 *
 * ## Traps this script is built around
 *
 * A SESSION IS NOT A GAME. `js-mtvxb5f4-f81a` holds 340 frames of the 28-minute Lillia game and
 * then, five wall-clock minutes later, the frames of the NEXT game starting again at tSec 2.
 * Frames AND samples are cut with `segment` on the sampler's own two rules and one run is taken.
 *
 * EVERYTHING JOINS ON THE GAME CLOCK, never on wall clock — except the transcript, which stores
 * only `atMs` (its `gameTimeSec` is null for every line of this game), so its clocks are derived
 * through the nearest sample and the derivation is stated per line rather than hidden.
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/game-pack.ts --session js-mtvxb5f4-f81a
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PURSE_CARRYING_GOLD } from "../src/analysis/deaths.ts"
import {
	buildTruth,
	checkpoints,
	seatsOf,
	truthAt,
	truthEvents,
	type TruthEvent,
	type TruthRow
} from "../src/analysis/game-truth.ts"
import { BLOB_TIMELINE, readBlob } from "../src/db/blobs.ts"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { dragonPhrase } from "../src/shared/dragons.ts"
import { fromMinimapPct, half, type Half, type TeamId } from "../src/shared/map.ts"
import type { LcuTimeline } from "../src/shared/schema/lcu.ts"
import { assistersAreReadable } from "../src/shared/schema/live.ts"
import { clockText, rebaseFramePath, segment } from "./lib/stream.ts"
import { baselineDuring, readVerbatim } from "./lib/stream.ts"
import type { RawSample } from "./lib/stream.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

/* ================================================================== shapes */

interface RawItem {
	displayName?: string
	itemID?: number
	price?: number
	count?: number
	slot?: number
}

interface RawScores {
	kills?: number
	deaths?: number
	assists?: number
	creepScore?: number
	wardScore?: number
}

interface RawPlayer {
	championName?: string
	riotId?: string
	riotIdGameName?: string
	summonerName?: string
	team?: string
	position?: string
	level?: number
	isDead?: boolean
	respawnTimer?: number
	items?: RawItem[]
	scores?: RawScores
	summonerSpells?: { summonerSpellOne?: { displayName?: string }; summonerSpellTwo?: { displayName?: string } }
}

interface RawEvent {
	EventID?: number
	EventName?: string
	EventTime?: number
	KillerName?: string
	VictimName?: string
	Assisters?: string[]
	DragonType?: string
	Stolen?: string
	TurretKilled?: string
	InhibKilled?: string
	Recipient?: string
	Acer?: string
	AcingTeam?: string
	KillStreak?: number
}

interface RawGameData {
	activePlayer?: {
		riotId?: string
		summonerName?: string
		riotIdGameName?: string
		level?: number
		currentGold?: number
		championStats?: Record<string, number>
	}
	allPlayers?: RawPlayer[]
	events?: { Events?: RawEvent[] }
	gameData?: { gameMode?: string; mapName?: string; gameTime?: number }
}

/* ============================================================ the roster */

interface RosterEntry {
	champion: string
	/** `riotIdGameName` — the ONLY name the event feed uses, and the join key for every event. */
	handle: string
	riotId: string
	team: string
	side: "his" | "enemy"
	position: string
	summoners: string[]
}

const handleOf = (p: RawPlayer): string =>
	p.riotIdGameName ?? (p.summonerName ?? p.riotId ?? "").split("#")[0] ?? ""

const buildRoster = (players: readonly RawPlayer[], hisTeam: string): RosterEntry[] =>
	players.map(p => ({
		champion: p.championName ?? "?",
		handle: handleOf(p),
		riotId: p.riotId ?? p.summonerName ?? "",
		team: p.team ?? "?",
		side: p.team === hisTeam ? "his" : "enemy",
		position: p.position ?? "",
		summoners: [
			p.summonerSpells?.summonerSpellOne?.displayName ?? "",
			p.summonerSpells?.summonerSpellTwo?.displayName ?? ""
		].filter(s => s !== "")
	}))

/**
 * A raw event name to a champion, or an honest label for what is not a champion.
 *
 * The feed names killers by HANDLE — `zx6r`, `uglysand`, `FIRE BLAZE 533` — and a review that
 * passes those through reads out gibberish, which is exactly what this map exists to prevent.
 * Minions and turrets are named too (`Minion_T200L1S26N0161`), and those resolve to a KIND rather
 * than to a champion, because "a minion took the tower" is true and "zx6r took the tower" is not.
 */
const resolveName = (raw: string | undefined, roster: readonly RosterEntry[]): string => {
	if (!raw) return "?"
	const hit = roster.find(r => r.handle === raw)
	if (hit) return hit.champion
	if (raw.startsWith("Minion_")) return "a minion"
	if (raw.startsWith("Turret_")) return "a turret"
	if (raw.startsWith("SRU_") || raw.startsWith("Sru_")) return "a neutral monster"
	// Never invent. An unresolved name is reported AS an unresolved name.
	return `${raw} (unresolved handle)`
}

/* ================================================= state at one instant */

interface PlayerState {
	champion: string
	position: string
	level: number
	cs: number
	kills: number
	deaths: number
	assists: number
	wardScore: number
	dead: boolean
	respawnSec: number
	items: { name: string; itemId: number; price: number; slot: number }[]
	/** Sum of the feed's own `price` values. A FLOOR on spend — see `feedProperties`. */
	itemPriceSum: number
}

const playerState = (p: RawPlayer): PlayerState => {
	const items = (p.items ?? []).map(i => ({
		name: i.displayName ?? "?",
		itemId: i.itemID ?? 0,
		price: i.price ?? 0,
		slot: i.slot ?? -1
	}))
	return {
		champion: p.championName ?? "?",
		position: p.position ?? "",
		level: p.level ?? 0,
		cs: p.scores?.creepScore ?? 0,
		kills: p.scores?.kills ?? 0,
		deaths: p.scores?.deaths ?? 0,
		assists: p.scores?.assists ?? 0,
		wardScore: round1(p.scores?.wardScore ?? 0),
		dead: p.isDead === true,
		respawnSec: round1(p.respawnTimer ?? 0),
		items,
		itemPriceSum: items.reduce((n, i) => n + i.price, 0)
	}
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/* ==================================================== fog: what is stale */

/**
 * How long each fog-gated field has been UNCHANGED, per champion, at every sample.
 *
 * The distinction this exists to keep honest: an enemy figure that has not moved for four minutes
 * is either a man who did not farm or a man nobody has seen, and THE FEED CANNOT TELL YOU WHICH.
 * The live coach said "Kayn is still level 1" three minutes into a game in which Kayn was level 3;
 * that was our stale data read out as a present-tense fact, not a hallucination. So the pack
 * reports the age of the reading beside the reading, and never the reading alone.
 */
interface FogAge {
	levelSinceSec: number
	csSinceSec: number
	itemsSinceSec: number
}

const fogHistory = (samples: readonly RawSample[]): Map<number, Record<string, FogAge>> => {
	const out = new Map<number, Record<string, FogAge>>()
	const last = new Map<string, { level: number; cs: number; items: number; at: FogAge }>()
	for (const s of samples) {
		const t = s.gameTime
		const players = (s.data as RawGameData).allPlayers ?? []
		const row: Record<string, FogAge> = {}
		for (const p of players) {
			const champ = p.championName ?? "?"
			const level = p.level ?? 0
			const cs = p.scores?.creepScore ?? 0
			const items = (p.items ?? []).length
			const prev = last.get(champ)
			const at: FogAge =
				prev === undefined ?
					{ levelSinceSec: t, csSinceSec: t, itemsSinceSec: t }
				:	{
						levelSinceSec: level === prev.level ? prev.at.levelSinceSec : t,
						csSinceSec: cs === prev.cs ? prev.at.csSinceSec : t,
						itemsSinceSec: items === prev.items ? prev.at.itemsSinceSec : t
					}
			last.set(champ, { level, cs, items, at })
			row[champ] = at
		}
		out.set(s.line, row)
	}
	return out
}

/* ============================================== the position track, joined */

/**
 * Half a minute either side of a mark, for a truth join. Timeline frames are 60s apart, so this
 * can never pick a neighbour, and past it the honest answer is that no frame covers the moment.
 */
const TRUTH_TOL_SEC = 35

/** 5s is the same camp; 12s is the next one; past that it is a neighbourhood, not a position. */
const WHERE_HIGH_SEC = 5
const WHERE_MED_SEC = 12

/** A read 3s away is the same moment; 8s is the next camp; past 20s it is a different decision. */
const POS_NEAR_SEC = 3
const POS_MID_SEC = 8
const POS_FAR_SEC = 20

interface TrackRead {
	tSec: number
	frameId: string
	framePath: string
	cropPath: string
	you: { pct: { left: number; top: number }; zone: string; label: string; coarse: string } | null
	enemyRings: { pct: { left: number; top: number }; label: string }[]
	alliesOnMinimap: number
	activity: string
	youChampion: string | null
	handLabel: { left: number; top: number; note?: string; set?: string } | null
	/** Distance between the model's read and the hand label, in % of the map. */
	handErrorPct: number | null
}

interface PositionJoin {
	zone: string
	label: string
	coarse: string
	pct: { left: number; top: number }
	activity: string
	gapSec: number
	confidence: "high" | "medium" | "low"
	basis: string
	frameId: string
	framePath: string
	handChecked: boolean
	enemyRings: number
	enemyRingLabels: string[]
}

/**
 * The position track, restricted to THIS RUN'S OWN FRAMES.
 *
 * The track file is keyed by SESSION and `joinPosition` matches on the game clock alone, so a
 * session that holds two games — `js-mtvxb5f4-f81a` holds the 28-minute Kayn game AND the
 * 31-minute Fiddlesticks game after it, both starting from zero — will happily hand run 1 a
 * position read taken during run 0. Every clock in the overlap has a candidate, so nothing looks
 * wrong: the pack just says he was in the enemy red-side jungle at 14:00 of a game the reader
 * never saw. `runFrameIds` is the only thing that distinguishes them, because a frame id belongs
 * to exactly one run. Reads from another run are dropped and COUNTED, never re-timed.
 */
const loadTrack = (
	session: string,
	runFrameIds: ReadonlySet<string> | null
): { meta: Record<string, unknown>; reads: TrackRead[]; foreignReads: number } => {
	const path = join(DATA_DIR, "eval", "minimap-track", `${session}.json`)
	if (!existsSync(path)) return { meta: { missing: path }, reads: [], foreignReads: 0 }
	const stored = JSON.parse(readFileSync(path, "utf8")) as {
		meta: Record<string, unknown>
		entries: {
			tSec: number
			frameId: string
			framePath: string
			cropPath: string
			ok: boolean
			read: {
				you: { pct: { left: number; top: number }; zone: string; label: string; coarse: string } | null
				enemies: { pct: { left: number; top: number }; label: string }[]
				alliesOnMinimap: number
				activity: string
				youChampion: string | null
			}
		}[]
	}
	const labelPath = join(DATA_DIR, "eval", "minimap-track", `${session}-handlabels.json`)
	const labels = new Map<string, { left: number; top: number; note?: string; set?: string }>()
	if (existsSync(labelPath)) {
		const raw = JSON.parse(readFileSync(labelPath, "utf8")) as {
			labels?: { frameId: string; left: number; top: number; note?: string; set?: string }[]
		}
		for (const l of raw.labels ?? []) labels.set(l.frameId, l)
	}
	const reads: TrackRead[] = []
	let foreignReads = 0
	for (const e of stored.entries) {
		// A read of ANOTHER GAME's frame is not a position in this one, whatever its clock says.
		if (runFrameIds !== null && !runFrameIds.has(e.frameId)) {
			foreignReads += 1
			continue
		}
		// A read the shipped fence REFUSED is not a position. It stays out of this list entirely.
		if (!e.ok || !e.read?.you) continue
		const hand = labels.get(e.frameId) ?? null
		reads.push({
			tSec: e.tSec,
			frameId: e.frameId,
			framePath: e.framePath,
			cropPath: e.cropPath,
			you: e.read.you,
			enemyRings: e.read.enemies ?? [],
			alliesOnMinimap: e.read.alliesOnMinimap ?? 0,
			activity: e.read.activity ?? "unclear",
			youChampion: e.read.youChampion ?? null,
			handLabel: hand,
			handErrorPct:
				hand === null ? null : (
					round1(Math.hypot(e.read.you.pct.left - hand.left, e.read.you.pct.top - hand.top))
				)
		})
	}
	reads.sort((a, b) => a.tSec - b.tSec)
	return { meta: stored.meta, reads, foreignReads }
}

const joinPosition = (tSec: number, reads: readonly TrackRead[]): PositionJoin | null => {
	let best: TrackRead | null = null
	let bestGap = Infinity
	for (const r of reads) {
		const gap = Math.abs(r.tSec - tSec)
		if (gap < bestGap) {
			bestGap = gap
			best = r
		}
	}
	if (best === null || best.you === null || bestGap > POS_FAR_SEC) return null
	const gapSec = round1(bestGap)
	const confidence: "high" | "medium" | "low" =
		best.handLabel !== null && bestGap <= POS_NEAR_SEC ? "high"
		: bestGap <= POS_NEAR_SEC ? "high"
		: bestGap <= POS_MID_SEC ? "medium"
		: "low"
	/* Two different uncertainties, and collapsing them is how a 17-second-old position becomes a
	 * fact: `handErrorPct` is how wrong the READ was where a human checked it, and `gapSec` is how
	 * far that read is from the moment being asked about. The gap is the one that dominates here. */
	const gapBasis =
		bestGap <= POS_NEAR_SEC ? `minimap read ${gapSec}s away`
		: bestGap <= POS_MID_SEC ? `nearest minimap read is ${gapSec}s away — he can cross a camp in that`
		: `nearest minimap read is ${gapSec}s away — that is most of a rotation, treat as a neighbourhood not a position`
	const basis =
		best.handLabel === null ? gapBasis : (
			`${gapBasis}; that read itself is HAND-CHECKED, ${best.handErrorPct ?? 0}% of the map from the human label`
		)
	return {
		zone: best.you.zone,
		label: best.you.label,
		coarse: best.you.coarse,
		pct: best.you.pct,
		activity: best.activity,
		gapSec,
		confidence,
		basis,
		frameId: best.frameId,
		framePath: best.framePath,
		handChecked: best.handLabel !== null,
		enemyRings: best.enemyRings.length,
		enemyRingLabels: best.enemyRings.map(e => e.label)
	}
}

interface GameEvent {
	id: number
	tSec: number
	clock: string
	name: string
	killerHandle: string | null
	killer: string | null
	killerSide: "his" | "enemy" | null
	victim: string | null
	victimHandle: string | null
	/** Readable. EMPTY on a neutral objective — see `assistersAreReadable`. */
	assisters: string[]
	/**
	 * The raw `Assisters` the feed sent on a NEUTRAL objective, kept only so the corruption stays
	 * measurable (`tallies.objectives.feedAssistsContradictedByDeath` counts the takes that name
	 * him as an assister at a clock the client itself says he was dead). Named for what it is so
	 * nobody renders it. Empty on every other kind of event, where `assisters` is the field.
	 */
	neutralAssistersUnusable: string[]
	dragonType: string | null
	dragonName: string | null
	stolen: boolean
	turret: string | null
	inhib: string | null
	recipient: string | null
	acer: string | null
	acingTeam: string | null
	involvesHim: boolean
}

/* ==================================================================== main */

const NOTABLE = new Set(["DragonKill", "HordeKill", "HeraldKill", "BaronKill", "InhibKilled"])
/** The neutral monsters. Their assist lists are corrupt in BOTH channels — see the OBJECTIVES header. */
const NEUTRAL_EVENTS = new Set(["DragonKill", "HordeKill", "HeraldKill", "BaronKill"])
const OBJECTIVE = new Set([
	"DragonKill",
	"HordeKill",
	"HeraldKill",
	"BaronKill",
	"InhibKilled",
	"TurretKilled"
])

const buildPack = () => {
	const session = arg("session", "js-mtvxb5f4-f81a")
	const runIndex = Number(arg("run", "0"))
	const everySec = Number(arg("every", "60"))

	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const sessionRow = db
		.prepare("select id, gameId, championName, riotId, startedMs from journal_session where id = ?")
		.get(session) as
		| { gameId: number | bigint | null; championName: string | null; riotId: string | null; startedMs: number | bigint }
		| undefined
	if (!sessionRow) throw new Error(`no journal session ${session}`)
	const allFrames = db
		.prepare("select id, tSec, path, atMs, clock, truthJson, bytes from journal_frame where sessionId = ? order by atMs")
		.all(session) as {
		id: string
		tSec: number
		path: string
		atMs: number | bigint
		clock: string
		truthJson: string | null
		bytes: number | bigint
	}[]
	const runs = segment(
		allFrames.map(f => ({ ...f, atMs: Number(f.atMs), bytes: Number(f.bytes) })),
		r => r.atMs,
		r => r.tSec
	)
	const frames = [...(runs[runIndex] ?? [])].sort((a, b) => a.tSec - b.tSec)
	if (frames.length === 0) throw new Error(`session ${session} has no run ${runIndex} (${runs.length} runs)`)
	const runFrom = Math.min(...frames.map(f => f.atMs))
	const runTo = Math.max(...frames.map(f => f.atMs))

	/* Samples: every file this session wrote, windowed to the run, then re-segmented — a sample
	 * file holds as many games as the supervisor ran between restarts. */
	const sampleDir = join(DATA_DIR, "live-samples")
	const sampleFiles = readdirSync(sampleDir)
		.filter(f => f.startsWith(session) && f.endsWith(".ndjson"))
		.map(f => join(sampleDir, f))
	const windowed = sampleFiles
		.flatMap(f => readVerbatim(f))
		.filter(s => s.atMs >= runFrom - 60_000 && s.atMs <= runTo + 60_000)
		.sort((a, b) => a.atMs - b.atMs)
	const sampleRuns = segment(windowed, s => s.atMs, s => s.gameTime)
	const samples = [...(sampleRuns.sort((a, b) => b.length - a.length)[0] ?? [])].sort(
		(a, b) => a.gameTime - b.gameTime
	)
	if (samples.length === 0) throw new Error(`no raw samples inside the window of run ${runIndex}`)

	const last = samples[samples.length - 1]!
	const lastData = last.data as RawGameData
	const players = lastData.allPlayers ?? []
	const myRiotId = lastData.activePlayer?.riotId ?? sessionRow.riotId ?? ""
	const me = players.find(p => (p.riotId ?? p.summonerName) === myRiotId)
	if (!me) throw new Error(`active player ${myRiotId} not in allPlayers`)
	const hisTeam = me.team ?? "ORDER"
	const roster = buildRoster(players, hisTeam)
	const myChampion = me.championName ?? sessionRow.championName ?? "?"
	const counterpart =
		roster.find(r => r.side === "enemy" && r.position === (me.position ?? "JUNGLE")) ??
		roster.find(r => r.side === "enemy" && r.summoners.includes("Smite")) ??
		null

	/**
	 * `journal_session.gameId` IS NOT THIS RUN'S GAME, and it is right for run 0 only by luck.
	 *
	 * One session row carries one id: `js-mtvxb5f4-f81a` says 5639406342 and holds 715 frames of
	 * TWO games, and `js-mtn2jrku-8ae9` says 5635110604 and holds 1470 frames of seven. Taking the
	 * session's id builds a pack whose frames, samples and minimap reads are the second game's and
	 * whose game row, participants, timeline and baselines are the first's — every join in it is
	 * then between two different games and nothing in the output says so. `--game` is how a caller
	 * that resolved the run's own id (from the zero-instant, the way `resolveGame` does) states it.
	 */
	const gameId = Number(arg("game", String(sessionRow.gameId ?? 0)))
	const gameRow = db
		.prepare(
			"select gameId, queueId, gameMode, patch, gameCreationMs, gameDurationSec, championName, role, win, kills, deaths, assists, cs, jungleCs, gold, visionScore, champLevel, damageToChampions from game where gameId = ?"
		)
		.get(gameId) as Record<string, number | bigint | string> | undefined
	/* The roster the INGESTED match knows, which is the only place `participantId` — the join key
	 * into the timeline — exists. Never re-derived from the last live sample: the feed has no
	 * participant ids at all, and its `position` labels are the same known-bad field AGENTS.md
	 * warns about. `role` here is this app's own inference (frames + Smite), not Riot's. */
	const participantRows = (
		db
			.prepare(
				"select participantId, teamId, riotId, championName, role, isUser, cs, jungleCs, gold, champLevel, visionScore, kills, deaths, assists from participant where gameId = ? order by participantId"
			)
			.all(gameId) as Record<string, number | bigint | string>[]
	).map(r => ({
		participantId: Number(r.participantId),
		teamId: Number(r.teamId),
		riotId: String(r.riotId ?? ""),
		championName: String(r.championName ?? ""),
		role: String(r.role ?? "UNKNOWN"),
		isUser: Number(r.isUser) === 1,
		cs: Number(r.cs) + Number(r.jungleCs),
		gold: Number(r.gold),
		champLevel: Number(r.champLevel),
		visionScore: Number(r.visionScore),
		kda: `${Number(r.kills)}/${Number(r.deaths)}/${Number(r.assists)}`
	}))
	db.close()
	const num = (v: number | bigint | string | undefined): number => Number(v ?? 0)

	/* ------------------------------------------------------------- the truth */

	/**
	 * THE SOURCE CHANGE THIS WHOLE PACK TURNS ON.
	 *
	 * CS, level, gold and position for all ten players now come from the ingested post-game
	 * timeline, which is exact, and no longer from the live feed, which for an ENEMY reports a
	 * VISIBILITY COUNTER wearing the name `creepScore`. The live samples stay — they are still
	 * the only source for his HP and mana, for item identity, for the event texture, and for
	 * what the coach was holding when it spoke — and every figure taken from them is labelled
	 * as the client's own view rather than as the game's.
	 */
	const timeline = readBlob<LcuTimeline>(gameId, BLOB_TIMELINE)
	const seats = seatsOf(participantRows)
	const truthFrames = buildTruth(timeline, seats)
	const tEvents = truthEvents(timeline, seats)
	const mySeat = seats.find(s => s.isUser) ?? null
	const hisTeamId = (mySeat?.teamId ?? 100) as TeamId
	/* The counterpart comes from the participant table's own role inference, not from the feed's
	 * `position` string — that field is one of the four AGENTS.md names as known-bad. The feed's
	 * pick is kept beside it so a disagreement is printed rather than silently resolved. */
	const cpSeat = seats.find(s => s.side === "enemy" && s.role === "JGL") ?? null
	const endOfGameSec = truthFrames[truthFrames.length - 1]?.atSec ?? num(gameRow?.gameDurationSec)
	/* Every five minutes, plus 14:00 because it is a jungle checkpoint this app already grades on,
	 * plus the last WHOLE minute and the final partial frame — a game that ends at 28:14 otherwise
	 * has no checkpoint after 25:00, which is exactly where the counterpart ran away with it. */
	const CHECKPOINT_MARKS = [
		...Array.from({ length: 20 }, (_, i) => (i + 1) * 300),
		840,
		Math.floor(endOfGameSec / 60) * 60,
		endOfGameSec
	]
		.filter(m => m > 0 && m <= endOfGameSec + TRUTH_TOL_SEC)
		.sort((a, b) => a - b)
		.filter((m, i, all) => i === 0 || m - all[i - 1]! > 1)

	/* ------------------------------------------------------------ the events */

	const rawEvents = lastData.events?.Events ?? []
	const events: GameEvent[] = rawEvents
		.map(e => {
			const killerRaw = e.KillerName ?? ""
			const killer = resolveName(killerRaw, roster)
			const killerSide = roster.find(r => r.handle === killerRaw)?.side ?? null
			return {
				id: e.EventID ?? -1,
				tSec: round1(e.EventTime ?? 0),
				clock: clockText(e.EventTime ?? 0),
				name: e.EventName ?? "?",
				killerHandle: killerRaw === "" ? null : killerRaw,
				killer: killerRaw === "" ? null : killer,
				killerSide,
				victim: e.VictimName ? resolveName(e.VictimName, roster) : null,
				victimHandle: e.VictimName ?? null,
				assisters:
					assistersAreReadable(e.EventName ?? "") ?
						(e.Assisters ?? []).map(a => resolveName(a, roster))
					:	[],
				neutralAssistersUnusable:
					assistersAreReadable(e.EventName ?? "") ?
						[]
					:	(e.Assisters ?? []).map(a => resolveName(a, roster)),
				dragonType: e.DragonType ?? null,
				dragonName: e.DragonType ? dragonPhrase(e.DragonType) : null,
				stolen: e.Stolen === "True",
				turret: e.TurretKilled ?? null,
				inhib: e.InhibKilled ?? null,
				recipient: e.Recipient ? resolveName(e.Recipient, roster) : null,
				acer: e.Acer ? resolveName(e.Acer, roster) : null,
				acingTeam: e.AcingTeam ?? null,
				involvesHim:
					killerRaw === handleOf(me) ||
					e.VictimName === handleOf(me) ||
					(assistersAreReadable(e.EventName ?? "") && (e.Assisters ?? []).includes(handleOf(me)))
			}
		})
		.sort((a, b) => a.tSec - b.tSec)

	/* ---------------------------------------------------------- the position */

	const track = loadTrack(session, new Set(frames.map(f => f.id)))

	/* ------------------------------------------------------------- the spine */

	const fog = fogHistory(samples)
	const sampleAt = (tSec: number): { sample: RawSample; gapSec: number } => {
		let best = samples[0]!
		let bestGap = Infinity
		for (const s of samples) {
			const gap = Math.abs(s.gameTime - tSec)
			if (gap < bestGap) {
				bestGap = gap
				best = s
			}
		}
		return { sample: best, gapSec: round1(bestGap) }
	}
	const frameAt = (tSec: number): { id: string; path: string; gapSec: number } | null => {
		let best: (typeof frames)[number] | null = null
		let bestGap = Infinity
		for (const f of frames) {
			const gap = Math.abs(f.tSec - tSec)
			if (gap < bestGap) {
				bestGap = gap
				best = f
			}
		}
		return best === null ? null : (
			{ id: best.id, path: rebaseFramePath(best.path, session), gapSec: round1(bestGap) }
		)
	}

	/* ------------------------------------------- the truth, joined to a clock */

	interface TruthSide {
		cs: number
		gold: number
		levels: number
	}

	interface SpineTruth {
		/** The frame that answered. NOT the clock asked for — frames drift off the minute. */
		atSec: number
		clock: string
		gapSec: number
		me: TruthRow | null
		counterpart: TruthRow | null
		/** him minus the counterpart. The figure the live feed got backwards all game. */
		csDiff: number | null
		goldDiff: number | null
		levelDiff: number | null
		teams: { his: TruthSide; enemy: TruthSide }
	}

	const truthSpineAt = (tSec: number): SpineTruth | null => {
		const hit = truthAt(truthFrames, tSec, TRUTH_TOL_SEC)
		if (hit === null) return null
		const me = mySeat === null ? null : (hit.frame.seats[mySeat.participantId] ?? null)
		const cp = cpSeat === null ? null : (hit.frame.seats[cpSeat.participantId] ?? null)
		const sideTotal = (side: "his" | "enemy"): TruthSide => {
			let cs = 0
			let gold = 0
			let levels = 0
			for (const seat of seats) {
				if (seat.side !== side) continue
				const row = hit.frame.seats[seat.participantId]
				if (row === undefined) continue
				cs += row.cs
				gold += row.totalGold
				levels += row.level
			}
			return { cs, gold, levels }
		}
		return {
			atSec: hit.frame.atSec,
			clock: hit.frame.clock,
			gapSec: hit.gapSec,
			me,
			counterpart: cp,
			csDiff: me && cp ? me.cs - cp.cs : null,
			goldDiff: me && cp ? me.totalGold - cp.totalGold : null,
			levelDiff: me && cp ? me.level - cp.level : null,
			teams: { his: sideTotal("his"), enemy: sideTotal("enemy") }
		}
	}

	/**
	 * Where he was at a clock, from WHICHEVER CHANNEL IS CLOSER IN TIME — and it names the channel.
	 *
	 * Two channels answer this question and neither dominates. The timeline frame is EXACT but
	 * arrives once a minute, so at a drake it is typically 15-28s away and describes a different
	 * decision. The minimap read is at 15s and hand-checked to 1.8% median position error, but the
	 * fence refuses 45 of 101 checkpoints. Measured on this game at the nine neutral objectives:
	 * the timeline was nearer twice (1.3s and 4.0s), the minimap seven times, and at 8:14 they
	 * disagree outright — the frame 18.9s away says his own blue-side jungle, the read 3.1s away
	 * says river (top). The read is right, because the gap is the error term, not the reader.
	 *
	 * So: nearest wins, the gap is printed, and neither is interpolated into the other.
	 */
	interface WhereJoin {
		source: "post-game timeline frame (exact position)" | "minimap read (a model reading a crop)"
		zone: string
		half: Half | null
		pct: { left: number; top: number }
		gapSec: number
		confidence: "high" | "medium" | "low"
	}

	const wherePos = (tSec: number): WhereJoin | null => {
		const gradeOf = (gap: number): "high" | "medium" | "low" =>
			gap <= WHERE_HIGH_SEC ? "high" : gap <= WHERE_MED_SEC ? "medium" : "low"
		const t = truthAt(truthFrames, tSec, TRUTH_TOL_SEC)
		const row = t && mySeat ? (t.frame.seats[mySeat.participantId] ?? null) : null
		const fromTruth: WhereJoin | null =
			t === null || row === null ? null : (
				{
					source: "post-game timeline frame (exact position)",
					zone: row.zone,
					half: row.half,
					pct: row.minimapPct,
					gapSec: t.gapSec,
					confidence: gradeOf(t.gapSec)
				}
			)
		const m = joinPosition(tSec, track.reads)
		const fromMap: WhereJoin | null =
			m === null ? null : (
				{
					source: "minimap read (a model reading a crop)",
					zone: m.label,
					/* The reader gives a percentage of the minimap, so the half has to be recovered
					 * through map coordinates rather than read off a label — `coarse` is the
					 * reader's own words and has never been graded as an ownership claim. */
					half: half(fromMinimapPct(m.pct.left, m.pct.top), hisTeamId),
					pct: m.pct,
					gapSec: m.gapSec,
					confidence: gradeOf(m.gapSec)
				}
			)
		if (fromTruth === null) return fromMap
		if (fromMap === null) return fromTruth
		return fromMap.gapSec < fromTruth.gapSec ? fromMap : fromTruth
	}

	/** Was he dead at this clock? Read off `isDead` in the nearest sample — not extrapolated. */
	const deadAt = (tSec: number): { dead: boolean; respawnSec: number; gapSec: number } => {
		const { sample, gapSec } = sampleAt(tSec)
		const mine = ((sample.data as RawGameData).allPlayers ?? []).find(
			p => (p.riotId ?? p.summonerName) === myRiotId
		)
		return { dead: mine?.isDead === true, respawnSec: round1(mine?.respawnTimer ?? 0), gapSec }
	}

	interface SpineEntry {
		tSec: number
		clock: string
		kind: "minute" | "event"
		why: string
		sampleLine: number
		sampleGapSec: number
		me: PlayerState & { goldInHand: number; csPerMin: number; hpPct: number; manaPct: number; hp: string; mana: string }
		counterpart:
			| (PlayerState & {
					fog: FogAge
					levelUnchangedSec: number
					csUnchangedSec: number
					itemsUnchangedSec: number
					/** The exact record for the same man at the same clock. Read this one FIRST. */
					truth: TruthRow | null
			  })
			| null
		/** The post-game record at this clock. Exact for all ten. Outranks everything above it. */
		truth: SpineTruth | null
		teams: {
			his: { levels: number; cs: number; alive: number; players: { champion: string; level: number; cs: number; kda: string }[] }
			enemy: { levels: number; csSeen: number; alive: number; players: { champion: string; level: number; cs: number; kda: string }[] }
		}
		position: PositionJoin | null
		frame: { id: string; path: string; gapSec: number } | null
		events: GameEvent[]
	}

	const wanted = new Map<number, string>()
	for (let t = 0; t <= samples[samples.length - 1]!.gameTime; t += everySec) wanted.set(t, "minute")
	for (const e of events) {
		if (NOTABLE.has(e.name)) wanted.set(e.tSec, `${e.name}`)
		else if (e.name === "ChampionKill" && e.involvesHim)
			wanted.set(e.tSec, e.victim === myChampion ? "his death" : "his kill/assist")
	}

	const spine: SpineEntry[] = [...wanted.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([tSec, why]) => {
			const { sample, gapSec } = sampleAt(tSec)
			const data = sample.data as RawGameData
			const all = data.allPlayers ?? []
			const mine = all.find(p => (p.riotId ?? p.summonerName) === myRiotId)
			const meState = playerState(mine ?? {})
			const stats = data.activePlayer?.championStats ?? {}
			const hp = stats.currentHealth ?? 0
			const maxHp = stats.maxHealth ?? 0
			const mana = stats.resourceValue ?? 0
			const maxMana = stats.resourceMax ?? 0
			const cpRaw = counterpart === null ? null : all.find(p => p.championName === counterpart.champion)
			const ages = fog.get(sample.line) ?? {}
			const cpAge = counterpart === null ? undefined : ages[counterpart.champion]
			const teamOf = (side: "his" | "enemy") =>
				all.filter(p => (p.team === hisTeam) === (side === "his")).map(p => playerState(p))
			const hisTeamStates = teamOf("his")
			const enemyStates = teamOf("enemy")
			const truthHere = truthSpineAt(tSec)
			return {
				tSec: round1(tSec),
				clock: clockText(tSec),
				kind: why === "minute" ? ("minute" as const) : ("event" as const),
				why,
				sampleLine: sample.line,
				sampleGapSec: gapSec,
				me: {
					...meState,
					goldInHand: Math.round(data.activePlayer?.currentGold ?? 0),
					csPerMin: tSec < 30 ? 0 : round1(meState.cs / (sample.gameTime / 60)),
					hpPct: maxHp > 0 ? Math.round((hp / maxHp) * 100) : 0,
					manaPct: maxMana > 0 ? Math.round((mana / maxMana) * 100) : 0,
					hp: `${Math.round(hp)}/${Math.round(maxHp)}`,
					mana: `${Math.round(mana)}/${Math.round(maxMana)}`
				},
				counterpart:
					cpRaw === undefined || cpRaw === null || cpAge === undefined ? null : (
						{
							...playerState(cpRaw),
							fog: cpAge,
							levelUnchangedSec: round1(sample.gameTime - cpAge.levelSinceSec),
							csUnchangedSec: round1(sample.gameTime - cpAge.csSinceSec),
							itemsUnchangedSec: round1(sample.gameTime - cpAge.itemsSinceSec),
							truth: truthHere?.counterpart ?? null
						}
					),
				truth: truthHere,
				teams: {
					his: {
						levels: hisTeamStates.reduce((n, p) => n + p.level, 0),
						cs: hisTeamStates.reduce((n, p) => n + p.cs, 0),
						alive: hisTeamStates.filter(p => !p.dead).length,
						players: hisTeamStates.map(p => ({
							champion: p.champion,
							level: p.level,
							cs: p.cs,
							kda: `${p.kills}/${p.deaths}/${p.assists}`
						}))
					},
					enemy: {
						levels: enemyStates.reduce((n, p) => n + p.level, 0),
						csSeen: enemyStates.reduce((n, p) => n + p.cs, 0),
						alive: enemyStates.filter(p => !p.dead).length,
						players: enemyStates.map(p => ({
							champion: p.champion,
							level: p.level,
							cs: p.cs,
							kda: `${p.kills}/${p.deaths}/${p.assists}`
						}))
					}
				},
				position: joinPosition(tSec, track.reads),
				frame: frameAt(tSec),
				events: events.filter(e => e.tSec >= tSec - 0.5 && e.tSec < tSec + everySec - 0.5 && why === "minute").concat(
					why === "minute" ? [] : events.filter(e => Math.abs(e.tSec - tSec) < 0.6)
				)
			}
		})

	/* --------------------------------------------------------- the objectives */

	const objectives = events
		.filter(e => OBJECTIVE.has(e.name))
		.map(e => {
			const { sample, gapSec } = sampleAt(e.tSec)
			const data = sample.data as RawGameData
			const mine = (data.allPlayers ?? []).find(p => (p.riotId ?? p.summonerName) === myRiotId)
			const st = playerState(mine ?? {})
			const side =
				e.turret ?? e.inhib ?
					((e.turret ?? e.inhib ?? "").includes("TOrder") ? "ORDER" : (e.turret ?? e.inhib ?? "").includes("TChaos") ? "CHAOS" : "?")
				:	null
			return {
				tSec: e.tSec,
				clock: e.clock,
				kind:
					e.name === "DragonKill" ? (e.dragonName ?? "drake")
					: e.name === "HordeKill" ? "voidgrub"
					: e.name === "HeraldKill" ? "Rift Herald"
					: e.name === "BaronKill" ? "Baron Nashor"
					: e.name === "InhibKilled" ? "inhibitor"
					: "turret",
				event: e.name,
				takenBy: e.killer,
				takenBySide: e.killerSide === "his" ? "his team" : e.killerSide === "enemy" ? "enemy" : "not a champion",
				assisters: e.assisters,
				/* Quarantined, not rendered. They exist so the count below stays derivable. */
				neutralAssistersUnusable: e.neutralAssistersUnusable,
				feedListedHimUnusably: e.neutralAssistersUnusable.includes(myChampion),
				stolen: e.stolen,
				structure: e.turret ?? e.inhib ?? null,
				/* The structure id names the side it BELONGED to — TOrder is his own, TChaos the enemy's.
				 * The lane/tier encoding (L0/L1/L2, P1..P5) is NOT decoded, because nobody here has
				 * verified what those digits mean and a guessed lane is a fabricated fact. */
				structureBelongedTo: side === null ? null : side === hisTeam ? "his team" : "enemy",
				/* The KILLER, plus a readable assist list. A neutral contributes its killer and
				 * nothing else: its assist list is the corrupt one, and "he was PRESENT" is exactly
				 * the sentence that field cannot support. */
				hePresent: e.killer === myChampion || e.assisters.includes(myChampion),
				/** A drake/grub/herald/baron, as opposed to a structure. Assist lists differ in kind. */
				isNeutral: NEUTRAL_EVENTS.has(e.name),
				whereHeWas: joinPosition(e.tSec, track.reads),
				/* The same question answered by whichever channel is nearer in time, with the
				 * channel named. This is the field the tallies count; `whereHeWas` above is the
				 * minimap-only join kept unchanged so the earlier measurement stays comparable. */
				whereHeWasBest: wherePos(e.tSec),
				heWasDead: deadAt(e.tSec),
				hisState: {
					level: st.level,
					cs: st.cs,
					kda: `${st.kills}/${st.deaths}/${st.assists}`,
					dead: st.dead,
					respawnSec: st.respawnSec,
					goldInHand: Math.round(data.activePlayer?.currentGold ?? 0),
					sampleGapSec: gapSec
				},
				/* Exact, from the timeline. `hisState` above is the client's own view of him,
				 * which for HIS OWN figures is honest but floored; this one is neither. */
				hisStateTruth: (() => {
					const t = truthSpineAt(e.tSec)
					return t === null || t.me === null ? null : (
						{
							level: t.me.level,
							cs: t.me.cs,
							totalGold: t.me.totalGold,
							zone: t.me.zone,
							half: t.me.half,
							frameAtSec: t.atSec,
							frameGapSec: t.gapSec
						}
					)
				})(),
				frame: frameAt(e.tSec)
			}
		})

	/* ---------------------------------------------------- what she said live */

	const transcriptPath = join(DATA_DIR, "logs", "live-transcript.jsonl")
	const atMsToSec = (atMs: number): { tSec: number; via: string } => {
		let best = samples[0]!
		let bestGap = Infinity
		for (const s of samples) {
			const gap = Math.abs(s.atMs - atMs)
			if (gap < bestGap) {
				bestGap = gap
				best = s
			}
		}
		return {
			tSec: round1(best.gameTime + (atMs - best.atMs) / 1000),
			via: `nearest sample line ${best.line}, ${Math.round(bestGap)}ms away`
		}
	}
	const liveCoach: {
		tSec: number
		clock: string
		atMs: number
		clockDerivedVia: string
		text: string
		position: PositionJoin | null
		blockChars: number
		block: string
	}[] = []
	if (existsSync(transcriptPath)) {
		for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
			if (line.trim() === "") continue
			let row: { atMs?: number; text?: string; fromUser?: boolean; groundTruth?: string }
			try {
				row = JSON.parse(line) as typeof row
			} catch {
				continue
			}
			const atMs = row.atMs ?? 0
			if (atMs < runFrom - 60_000 || atMs > runTo + 120_000) continue
			if (row.fromUser === true) continue
			const { tSec, via } = atMsToSec(atMs)
			liveCoach.push({
				tSec,
				clock: clockText(Math.max(0, tSec)),
				atMs,
				clockDerivedVia: via,
				text: row.text ?? "",
				position: joinPosition(tSec, track.reads),
				blockChars: (row.groundTruth ?? "").length,
				block: row.groundTruth ?? ""
			})
		}
	}
	liveCoach.sort((a, b) => a.tSec - b.tSec)

	/* ---------------------------------------------------------- the tallies */

	/**
	 * EVERY COUNT A REVIEW MIGHT WANT, COUNTED HERE INSTEAD.
	 *
	 * Models copy figures reliably and they cannot count over a long log, and the blinded grading
	 * of this exact game shows both halves of that. Asked to summarise 62 champion kills, 9 elite
	 * monsters and 17 buildings, the five arms reported that FOUR of his seven deaths were
	 * carrying at least 800 gold (six were) and that FIVE OF NINE neutral objectives went to the
	 * enemy (all nine did). Neither is a fabrication in the usual sense — both are arithmetic
	 * over a list too long to hold, which is TypeScript's job and never the model's.
	 *
	 * So the model is handed a SELECTION problem — which of these true things matters — and never
	 * an aggregation problem. Every figure below carries the clock range it covers and the channel
	 * it was read from, so a reviewer can quote it without re-deriving it.
	 */

	const isHis = (side: "his" | "enemy" | null): boolean => side === "his"
	const tally = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
		const out: Record<string, number> = {}
		for (const x of xs) {
			const k = key(x)
			out[k] = (out[k] ?? 0) + 1
		}
		return out
	}

	/* ---- deaths. Positions are EXACT here: CHAMPION_KILL carries its own position, so a death
	 * zone is the one claim about where he was that needs no interpolation and no minimap. ---- */

	const objectiveKindOf = (e: TruthEvent): string =>
		e.monsterType === "DRAGON" ? "drake"
		: e.monsterType === "HORDE" ? "voidgrub"
		: e.monsterType === "RIFTHERALD" ? "riftHerald"
		: e.monsterType === "BARON_NASHOR" ? "baron"
		: (e.monsterType ?? "unknown")

	const hisDeathEvents = tEvents.filter(e => e.kind === "kill" && e.victim?.isUser === true)
	const deathRows = hisDeathEvents.map(e => {
		const { sample, gapSec } = sampleAt(e.atSec)
		const data = sample.data as RawGameData
		/* Gold in hand is HIS OWN `activePlayer.currentGold` — exact, and the one gold figure the
		 * live feed reports for anybody. The timeline's `currentGold` is a frame boundary up to
		 * 60s away, which for a purse at the instant of death is a different number entirely. */
		const goldHeld = Math.round(data.activePlayer?.currentGold ?? 0)
		/* Time dead, reconstructed from two READ values and no formula: the first sample that
		 * shows him dead, plus the respawn timer that sample carried. Riot's death-timer formula
		 * would give a rounder answer and would be a derivation wearing a measurement's clothes. */
		const firstDead = samples.find(sp => {
			if (sp.gameTime < e.atSec - 1 || sp.gameTime > e.atSec + 90) return false
			const mine = ((sp.data as RawGameData).allPlayers ?? []).find(
				q => (q.riotId ?? q.summonerName) === myRiotId
			)
			return mine?.isDead === true
		})
		const firstDeadRespawn =
			firstDead === undefined ? null : (
				(((firstDead.data as RawGameData).allPlayers ?? []).find(
					q => (q.riotId ?? q.summonerName) === myRiotId
				)?.respawnTimer ?? 0)
			)
		const secondsDead =
			firstDead === undefined || firstDeadRespawn === null ? null : (
				round1(firstDead.gameTime + firstDeadRespawn - e.atSec)
			)
		const conceded = tEvents.filter(
			o =>
				o.kind === "objective" &&
				!isHis(o.killerSide) &&
				o.atSec >= e.atSec &&
				o.atSec <= e.atSec + (secondsDead ?? 0)
		)
		return {
			atSec: e.atSec,
			clock: e.clock,
			killer: e.victim === null ? null : (e.killer?.championName ?? "unknown"),
			zone: e.zone,
			half: e.half,
			goldHeld,
			goldHeldFromSampleGapSec: gapSec,
			carrying: goldHeld >= PURSE_CARRYING_GOLD,
			secondsDead,
			secondsDeadBasis:
				firstDead === undefined ? "no sample showed him dead — unknown, not zero" : (
					`first sample showing dead at ${clockText(firstDead.gameTime)} carried a ${firstDeadRespawn}s respawn timer`
				),
			objectivesLostWhileDown: conceded.map(o => `${o.clock} ${o.monsterName ?? objectiveKindOf(o)}`)
		}
	})
	const deadSeconds = deathRows.map(d => d.secondsDead).filter((n): n is number => n !== null)
	const totalSecondsDead = round1(deadSeconds.reduce((a, b) => a + b, 0))

	/* ---- neutral objectives ---- */

	const neutral = tEvents.filter(e => e.kind === "objective")
	const neutralRows = neutral.map(e => {
		const where = wherePos(e.atSec)
		const dead = deadAt(e.atSec)
		return {
			atSec: e.atSec,
			clock: e.clock,
			kind: objectiveKindOf(e),
			name: e.monsterName ?? objectiveKindOf(e),
			takenBy: e.killer?.championName ?? "unknown",
			takenBySide: e.killerSide,
			/* `assistingParticipantIds` is NOT read for an elite monster — 19% cross-team
			 * corruption — so credit here means the KILLER and nothing softer. */
			heTookIt: e.killer?.isUser === true,
			heWasDead: dead.dead,
			whereHeWas: where
		}
	})
	const positionedNeutral = neutralRows.filter(
		o => o.whereHeWas !== null && o.whereHeWas.confidence !== "low"
	)

	/* ---- structures. Two independent channels, cross-checked rather than merged. ---- */

	const buildings = tEvents.filter(e => e.kind === "building")
	const feedStructures = objectives.filter(o => o.structure !== null)
	const structureChecks = buildings.map(b => {
		const feed = feedStructures.find(f => Math.abs(f.tSec - b.atSec) <= 2)
		const feedSide =
			feed === undefined ? null : feed.structureBelongedTo === "his team" ? "his" : "enemy"
		return {
			clock: b.clock,
			what: `${b.buildingType ?? "?"}${b.towerType ? ` ${b.towerType}` : ""}${b.laneType ? ` ${b.laneType}` : ""}`,
			timelineSaysBelongedTo: b.belongedTo,
			feedSaysBelongedTo: feedSide,
			feedStructureId: feed?.structure ?? null,
			agree: feedSide !== null && feedSide === b.belongedTo
		}
	})

	/* ---- takedowns and kill participation ---- */

	const hisTeamKills = tEvents.filter(e => e.kind === "kill" && isHis(e.killerSide))
	const hisKills = tEvents.filter(e => e.kind === "kill" && e.killer?.isUser === true)
	const hisAssists = tEvents.filter(
		e => e.kind === "kill" && e.killer?.isUser !== true && e.assists.some(a => a.isUser)
	)

	/* ---- farm and gold against the counterpart, at every checkpoint ---- */

	const marks = checkpoints(truthFrames, CHECKPOINT_MARKS, TRUTH_TOL_SEC)
	const checkpointRows = marks.map(c => {
		const me = mySeat === null ? null : (c.rows[mySeat.participantId] ?? null)
		const cp = cpSeat === null ? null : (c.rows[cpSeat.participantId] ?? null)
		const feed = sampleAt(c.atSec)
		const feedPlayers = (feed.sample.data as RawGameData).allPlayers ?? []
		const feedCp =
			cpSeat === null ? null : (feedPlayers.find(q => q.championName === cpSeat.championName) ?? null)
		return {
			askedClock: c.askedClock,
			clock: c.clock,
			atSec: c.atSec,
			frameGapSec: c.gapSec,
			me:
				me === null ? null : (
					{ level: me.level, cs: me.cs, totalGold: me.totalGold, zone: me.zone }
				),
			counterpart:
				cp === null ? null : (
					{ level: cp.level, cs: cp.cs, totalGold: cp.totalGold, zone: cp.zone }
				),
			csDiff: me && cp ? me.cs - cp.cs : null,
			goldDiff: me && cp ? me.totalGold - cp.totalGold : null,
			levelDiff: me && cp ? me.level - cp.level : null,
			/* The same two numbers as the client showed them, kept side by side so the size of the
			 * lie is visible rather than asserted. Never quote the right-hand pair. */
			clientShowedCounterpartCs: feedCp?.scores?.creepScore ?? null,
			clientShowedCounterpartLevel: feedCp?.level ?? null,
			clientCsUnderReportedBy:
				cp === null || feedCp === undefined || feedCp === null ? null : (
					cp.cs - (feedCp.scores?.creepScore ?? 0)
				)
		}
	})

	/* ---- what the coach actually said, counted ---- */

	const coachVocab = [
		"herald",
		"baron",
		"drake",
		"dragon",
		"grub",
		"void",
		"recall",
		"ward",
		"vision",
		"smite",
		"objective",
		...roster.map(r => r.champion.toLowerCase())
	]
	const coachMentions: Record<string, number> = {}
	for (const word of coachVocab) {
		const n = liveCoach.filter(c => c.text.toLowerCase().includes(word)).length
		if (n > 0) coachMentions[word] = n
	}
	const coachRepeats = Object.entries(
		tally(liveCoach, c => c.text.trim().toLowerCase())
	)
		.filter(([, n]) => n > 1)
		.sort((a, b) => b[1] - a[1])
		.map(([text, n]) => ({ n, text }))

	const tallies = {
		howToUseThis:
			"Every count here was computed in TypeScript over the whole game. Quote these figures; do not recount them from the event log, and do not recount them from the timeline either — this IS the timeline, counted.",
		sourceOfEachCount:
			"objectives, deaths, takedowns, structures and checkpoints come from the ingested post-game timeline (exact for all ten players). Gold-in-hand at death and 'was he dead' come from the live samples, which are exact for HIS OWN figures. The coach tallies come from the transcript.",
		coversClock: `0:00-${clockText(endOfGameSec)}`,
		objectives: {
			neutralTotal: neutral.length,
			byHisTeam: neutral.filter(e => isHis(e.killerSide)).length,
			byEnemy: neutral.filter(e => e.killerSide === "enemy").length,
			byKind: tally(neutral, objectiveKindOf),
			byKindToEnemy: tally(neutral.filter(e => e.killerSide === "enemy"), objectiveKindOf),
			heWasCreditedOn: neutralRows.filter(o => o.heTookIt).length,
			creditMeansKillerOnly:
				"Neither channel's assist list is read on a neutral: the timeline's assistingParticipantIds names an opposing-team player in 23.1% of assisted takes and the live feed's Assisters in 22.9%. 'Credited' here means he landed the kill.",
			fellWhileHeWasDead: neutralRows.filter(o => o.heWasDead).length,
			/* A NEW measurement, and an unwelcome one: the live feed's assist list has the same
			 * defect AGENTS.md records in the timeline's. Counted here as the number of neutral
			 * objectives whose feed `Assisters` name him at a clock where the client's own
			 * `isDead` says he was dead — a contradiction inside one sample, needing no other
			 * source to prove. In this game it is the 10:22 voidgrub, taken 3 seconds into a
			 * 20-second death timer. */
			feedAssistsContradictedByDeath: objectives.filter(
				o => o.feedListedHimUnusably && o.hisState.dead
			).length,
			feedAssistsContradictedByDeathAt: objectives
				.filter(o => o.feedListedHimUnusably && o.hisState.dead)
				.map(o => `${o.clock} ${o.kind}`),
			fellWhileHeWasDeadAt: neutralRows.filter(o => o.heWasDead).map(o => `${o.clock} ${o.name}`),
			fellWhileHeWasInTheOtherHalf: positionedNeutral.filter(o => o.whereHeWas?.half === "enemy")
				.length,
			fellWhileHeWasInHisOwnHalf: positionedNeutral.filter(o => o.whereHeWas?.half === "own").length,
			fellWhileHeWasNeutralHalf: positionedNeutral.filter(o => o.whereHeWas?.half === "neutral")
				.length,
			positionUnknownAt: neutralRows
				.filter(o => o.whereHeWas === null || o.whereHeWas.confidence === "low")
				.map(o => `${o.clock} ${o.name}`),
			positionCaveat:
				"An objective is only counted into a half when a position was within 12s of it from one of the two channels. The rest are named in positionUnknownAt and are counted NOWHERE, because a 25-second-old position is a different decision.",
			each: neutralRows
		},
		deaths: {
			total: deathRows.length,
			goldHeldAtDeath: deathRows.map(d => d.goldHeld),
			withAtLeastCarryingGold: deathRows.filter(d => d.carrying).length,
			carryingGoldThreshold: PURSE_CARRYING_GOLD,
			byHalf: tally(deathRows, d => d.half ?? "unknown"),
			byZone: tally(deathRows, d => d.zone ?? "unknown"),
			byKiller: tally(deathRows, d => d.killer ?? "unknown"),
			secondsDead: deathRows.map(d => d.secondsDead),
			totalSecondsDead,
			shareOfGame: endOfGameSec > 0 ? round1((totalSecondsDead / endOfGameSec) * 1000) / 1000 : null,
			positionsAreExact:
				"Death zones come from CHAMPION_KILL.position in the timeline — the event's own coordinates. This is the only claim about where he was that needs neither the minimap nor an interpolation.",
			each: deathRows
		},
		takedowns: {
			total: hisKills.length + hisAssists.length,
			kills: hisKills.length,
			assists: hisAssists.length,
			hisTeamKills: hisTeamKills.length,
			killParticipation:
				hisTeamKills.length === 0 ? null : (
					round1(((hisKills.length + hisAssists.length) / hisTeamKills.length) * 1000) / 1000
				),
			assistsAreTrustedHere:
				"CHAMPION_KILL assists are fine — the 19% corruption AGENTS.md names is on ELITE_MONSTER_KILL only.",
			each: [...hisKills, ...hisAssists]
				.sort((a, b) => a.atSec - b.atSec)
				.map(e => ({
					clock: e.clock,
					role: e.killer?.isUser === true ? "kill" : "assist",
					victim: e.victim?.championName ?? "unknown",
					zone: e.zone,
					half: e.half
				}))
		},
		structures: {
			total: buildings.length,
			lost: buildings.filter(b => b.belongedTo === "his").length,
			taken: buildings.filter(b => b.belongedTo === "enemy").length,
			byKind: tally(buildings, b => `${b.belongedTo === "his" ? "lost " : "taken "}${b.buildingType ?? "?"}`),
			heTook: buildings.filter(b => b.killer?.isUser === true).length,
			crossCheck: {
				what: "BUILDING_KILL.teamId (the team that LOST it) against the live feed's own Turret_TOrder_/TChaos_ string, matched within 2s.",
				matched: structureChecks.filter(c => c.feedSaysBelongedTo !== null).length,
				agree: structureChecks.filter(c => c.agree).length,
				disagree: structureChecks.filter(c => c.feedSaysBelongedTo !== null && !c.agree),
				unmatched: structureChecks.filter(c => c.feedSaysBelongedTo === null)
			},
			each: structureChecks
		},
		checkpoints: {
			what: "Him against the counterpart at each five-minute mark, from the timeline. The last two columns are what his client was showing at the same instant, and they are here to be disbelieved.",
			marks: checkpointRows
		},
		liveCoach: {
			lines: liveCoach.length,
			mentions: coachMentions,
			repeatedVerbatim: coachRepeats,
			note: "Mentions are a substring count over a fixed vocabulary and nothing more. Whether a line was a DIRECTIVE is a judgement, so it is not counted here — read the lines."
		}
	}

	/* -------------------------------------------------------- the baselines */

	const { baseline, games: baselineGames } = baselineDuring(String(gameId))

	/* ------------------------------------------------------- feed properties */

	const firstCs = samples.find(s => {
		const p = ((s.data as RawGameData).allPlayers ?? []).find(q => q.championName === myChampion)
		return (p?.scores?.creepScore ?? 0) > 0
	})
	const allCs = samples.flatMap(s =>
		((s.data as RawGameData).allPlayers ?? []).map(p => p.scores?.creepScore ?? 0)
	)
	const trueCs = num(gameRow?.cs) + num(gameRow?.jungleCs)
	const feedCs = playerState(me).cs
	const cpFreeze =
		counterpart === null ? null : (
			(() => {
				let worst = { atSec: 0, unchangedSec: 0, level: 0 }
				for (const s of samples) {
					const age = (fog.get(s.line) ?? {})[counterpart.champion]
					const p = ((s.data as RawGameData).allPlayers ?? []).find(q => q.championName === counterpart.champion)
					if (!age) continue
					const unchanged = s.gameTime - age.levelSinceSec
					if (unchanged > worst.unchangedSec)
						worst = { atSec: round1(s.gameTime), unchangedSec: round1(unchanged), level: p?.level ?? 0 }
				}
				return worst
			})()
		)

	const feedProperties = {
		whatThisFeedIs:
			"Every figure in the spine comes from the Live Client Data API's `allgamedata`, sampled every ~5s of game clock by src/daemon/live-sampler.ts. It is the client's own view, which is not the same as the game's.",
		enemyFiguresAreFogGated: {
			claim:
				"Enemy level, CS, KDA and items are as LAST SEEN. They freeze while the enemy is in fog and jump when he reappears, so an enemy figure is a reading with an age, never a present-tense fact.",
			measuredHere:
				counterpart === null ? null : (
					`${counterpart.champion}'s level reading went unchanged for as long as ${cpFreeze?.unchangedSec ?? 0}s — still reading level ${cpFreeze?.level ?? 0} at ${clockText(cpFreeze?.atSec ?? 0)}. The live coach said "Kayn is still level 1" out of exactly this: our stale reading, spoken as news.`
				),
			longestUnchangedLevelRun: cpFreeze,
			howToUseIt:
				"Every counterpart line in the spine carries levelUnchangedSec / csUnchangedSec / itemsUnchangedSec. An unchanged figure means EITHER he did not farm OR nobody saw him, and this feed cannot tell you which. Say the age or say nothing."
		},
		enemyCsIsAVisibilityCounter: {
			claim:
				"For an ENEMY, `scores.creepScore` is not his CS. It counts only the last hits YOUR client witnessed, and it never catches up. It is not stale data about the right quantity — it is a different quantity wearing the same name.",
			measuredHere:
				cpSeat === null ? null : (
					`${cpSeat.championName}, this game — client showed ${checkpointRows.map(r => r.clientShowedCounterpartCs ?? "?").join("/")} at ${checkpointRows.map(r => r.askedClock).join("/")} against a true ${checkpointRows.map(r => r.counterpart?.cs ?? "?").join("/")}. ` +
					`Under-reported by up to ${Math.max(0, ...checkpointRows.map(r => r.clientCsUnderReportedBy ?? 0))} CS.`
				),
			whatItCostUsHere:
				"The live coach told him he was up 71 and later up 92 on Kayn's farm. The truth is that he was LEVEL all game and ended 18 CS DOWN. Two of the five blinded post-game reviews of this game were graded FALSE on this figure, and both had hedged it correctly while saying it — 'a farm lead of at least 81 CS on Kayn by 27:00 (160 to his last-seen 70)'. Hedging language cannot repair a wrong quantity.",
			consequence:
				"An enemy CS figure from the feed may never be quoted, compared, or hedged. Use `truth` and `tallies.checkpoints`, which come from the ingested timeline and are exact for all ten players.",
			whatTheFeedIsStillGoodFor:
				"LEVEL — exact at every checkpoint this game bar one, off by one at 20:00, and 93.5-97.0% exact across 14 games. ITEM IDENTITY — right once an item has been SEEN; an empty list means unseen, not unbought. DEATHS, RESPAWN TIMERS, WARD SCORE and the EVENT FEED are not fog-gated at all.",
			seeInstead: "truth, tallies.checkpoints, and the `truth:` line inside every spine entry."
		},
		itemPriceIsNotSpend: {
			claim:
				"The feed's per-item `price` is that item's own combine cost, not its build cost, and summed it recovers about a quarter of true spend.",
			measuredHere: `Across 15 corroboration games the price sum recovers 0.27 of gold truly earned. Item VALUE is a weak floor and it DIPS when components combine, so it is not even monotone.`,
			consequence:
				"itemPriceSum in this pack is reported because it is what the client says, and it may not be quoted as gold. Gold comes from `truth` (totalGold, exact for all ten) or, for his hand at an instant, from activePlayer.currentGold."
		},
		csIsFlooredToTens: {
			claim:
				"For HIS OWN figure and for enemy LANERS, creepScore is the right quantity but floored to a multiple of 10. For the enemy JUNGLER it is the wrong quantity entirely — see above.",
			evidence: `${allCs.length} creepScore readings across ${samples.length} samples: ${allCs.filter(n => n % 10 === 0).length} are multiples of 10, ${allCs.filter(n => n % 10 !== 0).length} are not.`,
			hisEndOfGame: `feed says ${feedCs}; the ingested match says ${trueCs} (${num(gameRow?.cs)} lane + ${num(gameRow?.jungleCs)} jungle). The feed is ${trueCs - feedCs} low, which is the flooring.`,
			consequence:
				"A CS lead under 10 is not measurable in this feed. Never quote a CS difference of 10 as if it were exact — it is anywhere from 1 to 19. None of that matters here any more: every CS figure a review should quote now comes from `truth`."
		},
		enemyGoldIsNotReported: {
			claim: "There is no gold field for anybody but him. `activePlayer.currentGold` is his gold IN HAND; nobody else has one.",
			whatIsKnowable:
				"What the enemy is HOLDING is listed item by item, so his purchases are visible even when his gold is not.",
			priceCaveat: `The feed's per-item \`price\` is that item's own (combine) cost, not its full build cost — Liandry's Torment lists 800. itemPriceSum in this pack is therefore a FLOOR on spend, not spend.`
		},
		noPositions: {
			claim:
				"`allgamedata` contains no position for anybody, including him. That is the hole the position track fills and the reason the live coach recited his HUD.",
			seeInstead: "spine[].position, objectives[].whereHeWas, and positionTrack."
		},
		eventsAccumulate: {
			claim: "`events.Events` is cumulative: the last sample carries the whole game's log, so the event log here is complete rather than stitched.",
			evidence: `${rawEvents.length} events on the final sample, spanning ${clockText(events[0]?.tSec ?? 0)}-${clockText(events[events.length - 1]?.tSec ?? 0)}.`
		},
		namesAreHandles: {
			claim:
				"Events name people by riot HANDLE (`uglysand`, `FIRE BLAZE 533`), never by champion. Unmapped, a review reads out gibberish.",
			resolvedThrough: "the roster in this pack; anything unresolved is labelled `(unresolved handle)` rather than guessed."
		},
		clocks: {
			claim:
				"Everything in this pack joins on the GAME clock. The live transcript is the exception — it stores only wall-clock atMs (its gameTimeSec is null for every line of this game), so each line's clock is derived through the nearest sample and the derivation is stated on the line.",
			firstCsAt: firstCs === undefined ? null : clockText(firstCs.gameTime)
		}
	}

	/* ------------------------------------------------------------- assemble */

	const positionTrack = track.reads.map(r => ({
		tSec: round1(r.tSec),
		clock: clockText(r.tSec),
		zone: r.you?.zone ?? null,
		label: r.you?.label ?? null,
		coarse: r.you?.coarse ?? null,
		pct: r.you?.pct ?? null,
		activity: r.activity,
		alliesOnMinimap: r.alliesOnMinimap,
		enemyRings: r.enemyRings.length,
		enemyRingLabels: r.enemyRings.map(e => e.label),
		handChecked: r.handLabel !== null,
		handErrorPct: r.handErrorPct,
		frameId: r.frameId,
		framePath: r.framePath,
		cropPath: r.cropPath
	}))

	const pack = {
		meta: {
			generatedMs: Date.now(),
			script: "scripts/game-pack.ts",
			session,
			runIndex,
			runsInSession: runs.length,
			gameId,
			champion: myChampion,
			riotId: myRiotId,
			spineCadenceSec: everySec,
			frames: frames.length,
			samples: samples.length,
			sampleFiles,
			events: events.length,
			truthFrames: truthFrames.length,
			truthEvents: tEvents.length,
			objectives: objectives.length,
			positionReads: positionTrack.length,
			/** Track entries belonging to another run of this session, dropped. See `loadTrack`. */
			positionReadsFromOtherRuns: track.foreignReads,
			liveCoachLines: liveCoach.length,
			whatThisIs:
				"Everything measured about one game, joined on the game clock. No advice, no judgement, no interpolated number without its own confidence.",
			howToAskForAPicture:
				"Every spine entry, objective and position read names a frame path. Open it with the Read tool; the minimap crop the reader actually saw is at cropPath."
		},
		game: {
			gameId,
			queueId: num(gameRow?.queueId),
			gameMode: String(gameRow?.gameMode ?? lastData.gameData?.gameMode ?? ""),
			patch: String(gameRow?.patch ?? ""),
			gameCreationMs: num(gameRow?.gameCreationMs),
			durationSec: num(gameRow?.gameDurationSec),
			durationClock: clockText(num(gameRow?.gameDurationSec)),
			result: num(gameRow?.win) === 1 ? "win" : "loss",
			hisLine: {
				champion: String(gameRow?.championName ?? myChampion),
				role: String(gameRow?.role ?? ""),
				kda: `${num(gameRow?.kills)}/${num(gameRow?.deaths)}/${num(gameRow?.assists)}`,
				cs: trueCs,
				csDetail: `${num(gameRow?.cs)} lane + ${num(gameRow?.jungleCs)} jungle`,
				gold: num(gameRow?.gold),
				visionScore: num(gameRow?.visionScore),
				champLevel: num(gameRow?.champLevel),
				damageToChampions: num(gameRow?.damageToChampions)
			},
			sampledFrom: clockText(samples[0]!.gameTime),
			sampledTo: clockText(last.gameTime),
			note:
				"The end-of-game figures in hisLine come from the INGESTED MATCH (exact). Every figure in the spine comes from the live feed (floored, fog-gated). They will not agree, and the difference is a property of the feed, not an error."
		},
		roster,
		counterpart: {
			champion: cpSeat?.championName ?? counterpart?.champion ?? null,
			participantId: cpSeat?.participantId ?? null,
			handle: cpSeat?.handle ?? counterpart?.handle ?? null,
			source:
				cpSeat === null ?
					"live feed roster (position, else the Smite holder) — no JGL row in the participant table"
				:	"participant table role=JGL — this app's own inference from frame positions + Smite, not Riot's timeline.role (4/10 of those are mislabelled JUNGLE)",
			feedAlsoPicked: counterpart?.champion ?? null,
			agree: cpSeat === null || counterpart === null || cpSeat.championName === counterpart.champion,
			truthAvailable: cpSeat !== null && truthFrames.length > 0,
			note:
				"Every figure about him in `truth` and `tallies` is exact. Every figure about him in `spine[].counterpart` is what HIS CLIENT SHOWED, which for CS is a different quantity — see feedProperties.enemyCsIsAVisibilityCounter."
		},
		truth: {
			what: "The ingested post-game timeline. Exact for all ten players — this is the game, not the client's view of it.",
			source: `data/blobs/${gameId}/timeline.json.gz`,
			frames: truthFrames.length,
			cadence:
				"One frame per minute plus a final partial frame. THE TIMESTAMPS ARE NOT ON THE MINUTE — this game's run 0, 60.028, … 1440.501, 1680.57, 1694.384 — so every row carries its own atSec and every join states its gap.",
			exactFor:
				"level, lane CS, jungle CS, total gold, gold in hand, xp and POSITION, for all ten players.",
			doesNotContain:
				"item purchases, wards, skill order and summoner-spell timers. No LCU timeline has ever carried them (only CHAMPION_KILL, ELITE_MONSTER_KILL and BUILDING_KILL exist in it), so item identity stays with the live samples and is labelled there.",
			seats,
			endOfGame: participantRows.map(r => ({
				participantId: r.participantId,
				champion: r.championName,
				side: r.teamId === (mySeat?.teamId ?? 100) ? "his" : "enemy",
				role: r.role,
				kda: r.kda,
				cs: r.cs,
				gold: r.gold,
				level: r.champLevel,
				visionScore: r.visionScore
			})),
			rows: truthFrames,
			events: tEvents
		},
		tallies,
		baselines: {
			source: "baselineDuring(gameId) — scripts/lib/stream.ts, unmodified",
			gamesInBaseline: baselineGames,
			excludes: "this game AND every game created after it, so the average is the one that existed at the time",
			everyFigureIsAMean: true,
			stats: baseline
		},
		feedProperties,
		spine,
		events,
		objectives,
		positionTrack: {
			meta: track.meta,
			reads: positionTrack,
			whatItCannotDo:
				"The reader returns his own icon and UNLABELLED red rings. It cannot tell you that a ring is the counterpart, so counterpart POSITION is unknown at every instant in this game — the ring counts are reported as ring counts and nothing more.",
			counterpartPosition: "UNKNOWN throughout. Not missing — unknowable from this channel."
		},
		liveCoach: {
			verdict: "0/10, nothing it said was useful, it was generic and often hilariously wrong (his words, this game)",
			lines: liveCoach,
			note: "Each line carries the exact ground-truth block the coach was holding when it spoke, so a post-game pass can say what should have been said from the same facts."
		},
		frames: frames.map(f => ({
			id: f.id,
			tSec: round1(f.tSec),
			clock: clockText(f.tSec),
			path: rebaseFramePath(f.path, session),
			atMs: f.atMs,
			clockSource: f.clock,
			bytes: f.bytes,
			hasBlock: f.truthJson !== null
		}))
	}

	return pack
}

/* ================================================================= render */

type Pack = ReturnType<typeof buildPack>

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))

const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s)

/** Thousands separators, and a sign when the number is a difference. */
const g = (n: number | null | undefined): string =>
	n === null || n === undefined ? "?" : Math.round(n).toLocaleString("en-US")

const signed = (n: number | null | undefined): string =>
	n === null || n === undefined ? "?" : n > 0 ? `+${g(n)}` : g(n)

const render = (pack: Pack): string => {
	const L: string[] = []
	const w = (s = ""): void => {
		L.push(s)
	}
	const rule = (title: string): void => {
		w()
		w(`${"═".repeat(78)}`)
		w(title)
		w(`${"═".repeat(78)}`)
		w()
	}

	w(`GAME PACK — game ${pack.game.gameId} · ${pack.meta.champion} ${pack.game.hisLine.role} · ${pack.game.result.toUpperCase()} in ${pack.game.durationClock}`)
	w(`session ${pack.meta.session} run ${pack.meta.runIndex} of ${pack.meta.runsInSession} · patch ${pack.game.patch} · queue ${pack.game.queueId}`)
	w(`${pack.meta.samples} raw samples · ${pack.meta.frames} frames · ${pack.meta.events} events · ${pack.meta.positionReads} minimap reads · ${pack.meta.liveCoachLines} live coach lines`)
	w()
	w(`End of game, from the INGESTED MATCH (exact): ${pack.game.hisLine.kda}, ${pack.game.hisLine.cs} CS (${pack.game.hisLine.csDetail}), ${pack.game.hisLine.gold}g, vision ${pack.game.hisLine.visionScore}, level ${pack.game.hisLine.champLevel}, ${pack.game.hisLine.damageToChampions} damage to champions.`)
	w(`Everything in the TIMELINE below is the live feed instead: floored, fog-gated, and sampled every ~5s. The two will not agree; see THE FEED'S PROPERTIES.`)
	w()
	w(`HIS TEAM   ${pack.roster.filter(r => r.side === "his").map(r => `${r.champion} (${r.position || "?"})`).join(" · ")}`)
	w(`ENEMY      ${pack.roster.filter(r => r.side === "enemy").map(r => `${r.champion} (${r.position || "?"})`).join(" · ")}`)
	w(`COUNTERPART ${pack.counterpart.champion ?? "unknown"} — the man he is racing. Source: ${pack.counterpart.source}.`)
	w(`            Everything about him under TRUTH is exact. Everything about him under "client showed" is what this`)
	w(`            client witnessed, and for CS that is a DIFFERENT QUANTITY, not a stale one. Never quote it.`)

	rule("TRUTH — the ingested post-game timeline. Exact for all ten players.")
	w(String(pack.truth.what))
	w(`source ${pack.truth.source} · ${pack.truth.frames} frames · ${pack.truth.events.length} events`)
	w(pack.truth.cadence)
	w(`It does NOT contain: ${pack.truth.doesNotContain}`)
	w()
	const meSeat = pack.truth.seats.find(s => s.isUser) ?? null
	const cpSeatR = pack.truth.seats.find(s => s.participantId === pack.counterpart.participantId) ?? null
	const meName = meSeat?.championName ?? "you"
	const cpName = cpSeatR?.championName ?? "counterpart"

	w(`CHECKPOINTS — him against ${cpName}, and what his client was showing at the same instant.`)
	w()
	const lvlCsGold = (r: { level: number; cs: number; totalGold: number } | null): string =>
		r === null ? pad("—", 24) : (
			`lvl ${padL(String(r.level), 2)}  ${padL(String(r.cs), 3)} CS  ${padL(g(r.totalGold), 6)}g`
		)
	w(
		`${pad("asked", 7)} ${pad("frame", 7)} ${pad(`${meName}: lvl/CS/gold`, 24)} ${pad(`${cpName}: lvl/CS/gold`, 24)} ${pad("CS diff", 9)} ${pad("gold diff", 11)} client showed ${cpName}`
	)
	for (const c of pack.tallies.checkpoints.marks)
		w(
			`${pad(c.askedClock, 7)} ${pad(c.clock, 7)} ${pad(lvlCsGold(c.me), 24)} ${pad(lvlCsGold(c.counterpart), 24)} ${pad(signed(c.csDiff), 9)} ${pad(signed(c.goldDiff), 11)} ${c.clientShowedCounterpartCs ?? "?"} CS (${signed(-(c.clientCsUnderReportedBy ?? 0))} against the truth), lvl ${c.clientShowedCounterpartLevel ?? "?"}`
		)
	w()
	w(`Read the last column as a measurement of the CLIENT, not of ${cpName}.`)
	w()
	w(`EVERY FRAME — ${meName} and ${cpName}, with the exact positions the timeline recorded.`)
	w()
	const withZone = (r: TruthRow | null): string =>
		r === null ? "—" : `${lvlCsGold(r)}  ${r.zone}`
	w(`${pad("clock", 7)} ${pad("t=", 9)} ${pad(meName, 51)} ${pad(cpName, 51)} diff`)
	for (const f of pack.truth.rows) {
		const m = meSeat === null ? null : (f.seats[meSeat.participantId] ?? null)
		const c = cpSeatR === null ? null : (f.seats[cpSeatR.participantId] ?? null)
		w(
			`${pad(f.clock, 7)} ${pad(String(f.atSec), 9)} ${pad(withZone(m), 51)} ${pad(withZone(c), 51)} CS ${pad(signed(m && c ? m.cs - c.cs : null), 4)} gold ${signed(m && c ? m.totalGold - c.totalGold : null)}`
		)
	}
	w()
	w(`END OF GAME — all ten, from the ingested match.`)
	w()
	w(`${pad("champion", 12)} ${pad("side", 6)} ${pad("role", 8)} ${pad("kda", 10)} ${pad("cs", 5)} ${pad("gold", 8)} ${pad("lvl", 4)} vision`)
	for (const r of pack.truth.endOfGame)
		w(
			`${pad(r.champion, 12)} ${pad(r.side, 6)} ${pad(r.role, 8)} ${pad(r.kda, 10)} ${pad(String(r.cs), 5)} ${pad(g(r.gold), 8)} ${pad(String(r.level), 4)} ${r.visionScore}`
		)

	rule("COUNTED TOTALS — every aggregate, computed in TypeScript. Quote these; do not recount.")
	const t = pack.tallies
	w(String(t.howToUseThis))
	w(`sources: ${t.sourceOfEachCount}`)
	w(`covers ${t.coversClock}`)
	w()
	w(`NEUTRAL OBJECTIVES — ${t.objectives.neutralTotal} in the game: ${t.objectives.byHisTeam} to his team, ${t.objectives.byEnemy} to the enemy.`)
	w(`  by kind: ${Object.entries(t.objectives.byKind).map(([k, n]) => `${n} ${k}`).join(", ")}`)
	w(`  he is credited on ${t.objectives.heWasCreditedOn}. ${t.objectives.creditMeansKillerOnly}`)
	w(`  ${t.objectives.fellWhileHeWasDead} fell while he was DEAD${t.objectives.fellWhileHeWasDeadAt.length > 0 ? `: ${t.objectives.fellWhileHeWasDeadAt.join(", ")}` : ""}`)
	w(`  where he was, counted only where a position was within ${WHERE_MED_SEC}s: own half ${t.objectives.fellWhileHeWasInHisOwnHalf}, neutral ${t.objectives.fellWhileHeWasNeutralHalf}, ENEMY half ${t.objectives.fellWhileHeWasInTheOtherHalf}`)
	w(`  position unknown at ${t.objectives.positionUnknownAt.length}: ${t.objectives.positionUnknownAt.join(", ") || "none"}`)
	w(`  ${t.objectives.positionCaveat}`)
	w()
	w(`${pad("clock", 7)} ${pad("what", 16)} ${pad("taken by", 18)} ${pad("he was", 10)} where he was`)
	for (const o of t.objectives.each)
		w(
			`${pad(o.clock, 7)} ${pad(o.name, 16)} ${pad(`${o.takenBy} (${o.takenBySide ?? "?"})`, 18)} ${pad(o.heWasDead ? "DEAD" : "alive", 10)} ${o.whereHeWas ? `${o.whereHeWas.zone} (${o.whereHeWas.half}) — ${o.whereHeWas.confidence}, ${o.whereHeWas.gapSec}s` : "unknown"}`
		)
	w()
	w(`DEATHS — ${t.deaths.total}. ${t.deaths.withAtLeastCarryingGold} of them carrying at least ${t.deaths.carryingGoldThreshold}g.`)
	w(`  gold held at each: ${t.deaths.goldHeldAtDeath.join(", ")}`)
	w(`  by half: ${Object.entries(t.deaths.byHalf).map(([k, n]) => `${k} ${n}`).join(", ")}`)
	w(`  by zone: ${Object.entries(t.deaths.byZone).map(([k, n]) => `${k} ${n}`).join(", ")}`)
	w(`  by killer: ${Object.entries(t.deaths.byKiller).map(([k, n]) => `${k} ${n}`).join(", ")}`)
	w(`  seconds dead: ${t.deaths.secondsDead.map(n => n ?? "?").join(", ")} — ${t.deaths.totalSecondsDead}s total, ${t.deaths.shareOfGame === null ? "?" : `${Math.round(t.deaths.shareOfGame * 1000) / 10}%`} of the game`)
	w(`  ${t.deaths.positionsAreExact}`)
	w()
	w(`${pad("clock", 7)} ${pad("killer", 10)} ${pad("zone", 30)} ${pad("gold held", 10)} ${pad("dead for", 9)} objectives lost while down`)
	for (const d of t.deaths.each)
		w(
			`${pad(d.clock, 7)} ${pad(String(d.killer ?? "?"), 10)} ${pad(String(d.zone ?? "?"), 30)} ${pad(`${d.goldHeld}g${d.carrying ? " *" : ""}`, 10)} ${pad(`${d.secondsDead ?? "?"}s`, 9)} ${d.objectivesLostWhileDown.join(", ")}`
		)
	w(`  * carrying at least ${t.deaths.carryingGoldThreshold}g at the moment of death.`)
	w()
	w(`TAKEDOWNS — ${t.takedowns.total} (${t.takedowns.kills} kills, ${t.takedowns.assists} assists) of his team's ${t.takedowns.hisTeamKills} kills${t.takedowns.killParticipation === null ? "" : ` — ${Math.round(t.takedowns.killParticipation * 1000) / 10}% kill participation`}.`)
	w(`  ${t.takedowns.assistsAreTrustedHere}`)
	w()
	w(`STRUCTURES — ${t.structures.total} fell: ${t.structures.lost} of his, ${t.structures.taken} of the enemy's. He took ${t.structures.heTook}.`)
	w(`  cross-check: ${t.structures.crossCheck.what}`)
	w(`  ${t.structures.crossCheck.agree} of ${t.structures.crossCheck.matched} matched events AGREE; ${t.structures.crossCheck.disagree.length} disagree; ${t.structures.crossCheck.unmatched.length} had no partner within 2s.`)
	for (const d of t.structures.crossCheck.disagree)
		w(`  DISAGREEMENT at ${d.clock}: timeline says ${d.timelineSaysBelongedTo}, the feed's ${d.feedStructureId} says ${d.feedSaysBelongedTo}. NOT resolved here.`)
	w()
	w(`WHAT THE LIVE COACH SAID, COUNTED — ${t.liveCoach.lines} lines.`)
	w(`  mentions: ${Object.entries(t.liveCoach.mentions).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`)
	w(`  repeated verbatim: ${t.liveCoach.repeatedVerbatim.length === 0 ? "none" : t.liveCoach.repeatedVerbatim.map(r => `${r.n}x "${r.text}"`).join(" · ")}`)
	w(`  ${t.liveCoach.note}`)

	rule("THE TIMELINE — state, position, events and what the coach said, joined on the game clock")
	w(`Each block is one minute (or one notable event). "where" is the minimap read; its gap and`)
	w(`confidence are stated because a read 12 seconds away is a neighbourhood, not a position.`)

	for (const e of pack.spine) {
		w()
		w(`── ${e.clock} ${e.kind === "event" ? `· ${e.why} ` : ""}${"─".repeat(Math.max(0, 60 - e.clock.length - (e.kind === "event" ? e.why.length + 3 : 0)))}`)
		const me = e.me
		w(`  you    lvl ${me.level}  ${me.cs} CS (${me.csPerMin}/min)  ${me.goldInHand}g in hand  HP ${me.hpPct}% (${me.hp})  mana ${me.manaPct}%  ${me.kills}/${me.deaths}/${me.assists}  ward ${me.wardScore}${me.dead ? `  DEAD, ${me.respawnSec}s left` : ""}`)
		w(`         items ${me.items.length === 0 ? "none" : me.items.map(i => i.name).join(", ")}`)
		if (e.truth) {
			const t = e.truth
			w(
				`  TRUTH  you lvl ${t.me?.level ?? "?"}  ${t.me?.cs ?? "?"} CS  ${g(t.me?.totalGold)}g  ${t.me?.zone ?? "?"}`
			)
			if (t.counterpart)
				w(
					`         ${pad(t.counterpart.zone === undefined ? "" : (pack.counterpart.champion ?? "him"), 0)} lvl ${t.counterpart.level}  ${t.counterpart.cs} CS  ${g(t.counterpart.totalGold)}g  ${t.counterpart.zone}   —   CS ${signed(t.csDiff)}, gold ${signed(t.goldDiff)}, levels ${signed(t.levelDiff)}`
				)
			w(`         exact, from the ${t.clock} timeline frame (${t.gapSec}s from this clock)`)
		} else w(`  TRUTH  no timeline frame within ${TRUTH_TOL_SEC}s of this clock`)
		/* The minimap read comes SECOND now. It is 15s-cadence and the timeline is 60s, so it
		 * still wins on any clock more than ~30s from a frame — but where both answer, the frame
		 * is the position and the read is the corroboration, never the other way round. */
		if (e.position)
			w(`  where  ${e.position.label} (${e.position.coarse}, ${e.position.pct.left}%,${e.position.pct.top}%) — ${e.position.confidence} confidence from the MINIMAP: ${e.position.basis}${e.position.activity === "unclear" ? "" : `, activity "${e.position.activity}"`}`)
		else w(`  where  no minimap read within ${POS_FAR_SEC}s of this clock`)
		if (e.counterpart) {
			const c = e.counterpart
			w(`  ${pad(c.champion.toLowerCase(), 6)} client showed: lvl ${c.level}, ${c.cs} CS, ${c.kills}/${c.deaths}/${c.assists}, ${c.items.length} items (${c.itemPriceSum}g of listed prices — NOT gold spent, it recovers ~0.27 of it)`)
			w(
				`         that CS is a VISIBILITY COUNTER${c.truth ? `, and the truth above says ${c.truth.cs}` : ""} — do not quote it. Level is trustworthy; it has been unchanged ${c.levelUnchangedSec}s, items ${c.itemsUnchangedSec}s.`
			)
		}
		w(`  teams  ${pad(pack.roster.find(r => r.side === "his")?.team ?? "his", 5)} lvl ${e.teams.his.levels} · ${e.teams.his.cs} CS floored (truth ${e.truth?.teams.his.cs ?? "?"}) · ${e.teams.his.alive} alive    enemy lvl ${e.teams.enemy.levels} · ${e.teams.enemy.csSeen} CS your client witnessed (truth ${e.truth?.teams.enemy.cs ?? "?"}) · ${e.teams.enemy.alive} alive`)
		w(`         ${e.teams.his.players.map(p => `${p.champion} ${p.level}/${p.cs}cs ${p.kda}`).join(" · ")}`)
		w(`         ${e.teams.enemy.players.map(p => `${p.champion} ${p.level}/${p.cs}cs ${p.kda}`).join(" · ")}`)
		for (const ev of e.events) w(`  event  ${ev.clock} ${describe(ev)}`)
		for (const line of pack.liveCoach.lines.filter(
			c => c.tSec >= e.tSec - 0.5 && c.tSec < e.tSec + (e.kind === "minute" ? pack.meta.spineCadenceSec : 1) - 0.5
		))
			w(`  coach  ${line.clock} "${line.text}"`)
		if (e.frame) w(`  frame  ${e.frame.path} (${e.frame.gapSec}s away)`)
	}

	rule("OBJECTIVES — and where he was when each one fell")
	w(`The join the live coach could never make. "he was" is whichever channel is nearer in time —`)
	w(`the exact timeline frame or the minimap read — and it names the channel and the gap.`)
	w()
	w(`ASSIST LISTS ON NEUTRAL OBJECTIVES ARE NOT READ, IN EITHER CHANNEL. Measured across the whole`)
	w(`store: the timeline's ELITE_MONSTER_KILL.assistingParticipantIds names the other team in 183`)
	w(`of 791 assisted takes (23.1% [20.3-26.2], 112 games) and the live feed's own Assisters in 54`)
	w(`of 236 (22.9% [18.0-28.6], 36 games) — the same defect at the same rate down two channels,`)
	w(`and confined to the neutrals in both (0 of 2,289 live champion kills, 0 of 550 structures).`)
	w(`In THIS game, ${pack.tallies.objectives.feedAssistsContradictedByDeath} neutral ${pack.tallies.objectives.feedAssistsContradictedByDeath === 1 ? "take lists" : "takes list"} him as an assister at a clock the client itself`)
	w(`reports him DEAD. Credit on a neutral means the KILLER and nothing softer — see`)
	w(`tallies.objectives.heWasCreditedOn.`)
	w()
	for (const o of pack.objectives) {
		w(`${pad(o.clock, 7)} ${pad(o.kind, 14)} ${pad(`${o.takenBy} (${o.takenBySide})`, 26)}${o.stolen ? " STOLEN" : ""}`)
		if (o.assisters.length > 0) w(`        assists: ${o.assisters.join(", ")}`)
		else if (o.neutralAssistersUnusable.length > 0)
			w(`        assists: NOT AVAILABLE — the feed sent a list and it is the corrupt one`)
		if (o.structure) w(`        structure ${o.structure} — belonged to ${o.structureBelongedTo}; lane/tier digits NOT decoded (unverified)`)
		w(
			`        he was: ${o.heWasDead.dead ? "DEAD at this instant — everything below is from before he died: " : ""}${
				o.whereHeWasBest ?
					`${o.whereHeWasBest.zone} (${o.whereHeWasBest.half} half) — ${o.whereHeWasBest.confidence} confidence, ${o.whereHeWasBest.gapSec}s away, from the ${o.whereHeWasBest.source}`
				:	"UNKNOWN — no position from either channel within reach, and it stays unknown"
			}`
		)
		if (o.hisStateTruth)
			w(
				`        truth:  lvl ${o.hisStateTruth.level}, ${o.hisStateTruth.cs} CS, ${g(o.hisStateTruth.totalGold)}g, ${o.hisStateTruth.zone} — from the ${clockText(o.hisStateTruth.frameAtSec)} frame, ${o.hisStateTruth.frameGapSec}s away`
			)
		w(
			`        minimap-only join (unchanged, for comparison): ${o.whereHeWas ? `${o.whereHeWas.label} (${o.whereHeWas.confidence}, ${o.whereHeWas.basis})` : `no read within ${POS_FAR_SEC}s`}`
		)
		w(
			`        his state: lvl ${o.hisState.level}, ${o.hisState.cs} CS, ${o.hisState.kda}, ${o.hisState.goldInHand}g${o.hisState.dead ? `, DEAD with ${o.hisState.respawnSec}s left` : ""}${
				o.hePresent ? ", and he is credited on this take"
				: o.feedListedHimUnusably ?
					", and the feed lists him as an assister — SEE THE WARNING ABOVE, that list is not trustworthy on a neutral and is not read"
				: ""
			} — read from the sample ${o.hisState.sampleGapSec}s away`
		)
		if (o.frame) w(`        frame ${o.frame.path} (${o.frame.gapSec}s away)`)
		w()
	}

	rule("THE FULL EVENT LOG")
	w(`Names resolved from riot handles to champions through the roster. Unresolved handles are`)
	w(`labelled, never guessed.`)
	w()
	for (const ev of pack.events) w(`${pad(ev.clock, 7)} ${describe(ev)}`)

	rule("THE POSITION TRACK")
	w(String(pack.positionTrack.whatItCannotDo))
	w(`counterpart position: ${pack.positionTrack.counterpartPosition}`)
	w()
	w(`${pad("clock", 7)} ${pad("zone", 30)} ${pad("pct", 14)} rings  frame`)
	for (const r of pack.positionTrack.reads)
		w(
			`${pad(r.clock, 7)} ${pad(String(r.label ?? "?"), 30)} ${pad(`${r.pct?.left ?? "?"},${r.pct?.top ?? "?"}`, 14)} ${pad(String(r.enemyRings), 5)}  ${r.frameId}${r.handChecked ? `  HAND-CHECKED (${r.handErrorPct}% off)` : ""}`
		)

	rule("HIS BASELINES — his own averages, this game and everything after it EXCLUDED")
	w(`From baselineDuring(), unmodified: ${pack.baselines.gamesInBaseline} games. ${pack.baselines.excludes}.`)
	w(`Every figure is a MEAN. Copy them verbatim; do not derive one by subtracting a delta.`)
	w()
	w(`${pad("metric", 34)} ${pad("mean", 10)} ${pad("median", 10)} ${pad("sd", 10)} n`)
	const stats = (pack.baselines.stats ?? {}) as Record<string, { mean: number; median: number; sd: number; n: number }>
	for (const [key, s] of Object.entries(stats))
		w(`${pad(key, 34)} ${pad(String(round2(s.mean)), 10)} ${pad(String(round2(s.median)), 10)} ${pad(String(round2(s.sd)), 10)} ${s.n}`)

	rule("WHAT THE LIVE COACH ACTUALLY SAID")
	w(`His verdict: ${pack.liveCoach.verdict}`)
	w(`${pack.liveCoach.lines.length} lines. Clocks are derived from wall clock through the nearest sample.`)
	w(`The exact ground-truth block each line was given is in the JSON, not here.`)
	w()
	for (const c of pack.liveCoach.lines)
		w(`${pad(c.clock, 7)} "${c.text}"${c.position ? `   [he was: ${c.position.label}, ${c.position.confidence}]` : ""}`)

	rule("THE FEED'S PROPERTIES — read this before quoting any number above")
	const fp = pack.feedProperties
	w(`WHAT IT IS. ${fp.whatThisFeedIs}`)
	w()
	w(`ENEMY FIGURES ARE FOG-GATED. ${fp.enemyFiguresAreFogGated.claim}`)
	w(`  measured here: ${fp.enemyFiguresAreFogGated.measuredHere}`)
	w(`  how to use it: ${fp.enemyFiguresAreFogGated.howToUseIt}`)
	w()
	w(`ENEMY CS IS A VISIBILITY COUNTER — the single most expensive field in this feed.`)
	w(`  ${fp.enemyCsIsAVisibilityCounter.claim}`)
	w(`  measured here: ${fp.enemyCsIsAVisibilityCounter.measuredHere}`)
	w(`  what it cost: ${fp.enemyCsIsAVisibilityCounter.whatItCostUsHere}`)
	w(`  consequence: ${fp.enemyCsIsAVisibilityCounter.consequence}`)
	w(`  still good for: ${fp.enemyCsIsAVisibilityCounter.whatTheFeedIsStillGoodFor}`)
	w(`  see instead: ${fp.enemyCsIsAVisibilityCounter.seeInstead}`)
	w()
	w(`ITEM PRICE IS NOT SPEND. ${fp.itemPriceIsNotSpend.claim}`)
	w(`  measured: ${fp.itemPriceIsNotSpend.measuredHere}`)
	w(`  consequence: ${fp.itemPriceIsNotSpend.consequence}`)
	w()
	w(`CS IS FLOORED TO TENS. ${fp.csIsFlooredToTens.claim}`)
	w(`  evidence: ${fp.csIsFlooredToTens.evidence}`)
	w(`  his end of game: ${fp.csIsFlooredToTens.hisEndOfGame}`)
	w(`  consequence: ${fp.csIsFlooredToTens.consequence}`)
	w()
	w(`ENEMY GOLD IS NOT REPORTED. ${fp.enemyGoldIsNotReported.claim}`)
	w(`  knowable instead: ${fp.enemyGoldIsNotReported.whatIsKnowable}`)
	w(`  price caveat: ${fp.enemyGoldIsNotReported.priceCaveat}`)
	w()
	w(`NO POSITIONS. ${fp.noPositions.claim}`)
	w(`  see instead: ${fp.noPositions.seeInstead}`)
	w()
	w(`EVENTS ACCUMULATE. ${fp.eventsAccumulate.claim}`)
	w(`  evidence: ${fp.eventsAccumulate.evidence}`)
	w()
	w(`NAMES ARE HANDLES. ${fp.namesAreHandles.claim}`)
	w(`  resolved through: ${fp.namesAreHandles.resolvedThrough}`)
	w()
	w(`CLOCKS. ${fp.clocks.claim}`)

	rule("FRAME INDEX — ask for any of these by path")
	w(`${pack.frames.length} frames, ${clockText(pack.frames[0]?.tSec ?? 0)}-${clockText(pack.frames[pack.frames.length - 1]?.tSec ?? 0)}, all under data/journal/${pack.meta.session}/.`)
	w(`"block" marks a frame that carries the exact ground-truth text the coach held at that instant.`)
	w()
	for (const f of pack.frames)
		w(`${pad(f.clock, 7)} ${pad(f.id, 26)} ${pad(`${Math.round(f.bytes / 1024)}KB`, 7)} ${f.hasBlock ? "block" : "     "} ${f.path}`)

	w()
	return L.join("\n")
}

const round2 = (n: number): number => Math.round(n * 100) / 100

const describe = (ev: GameEvent): string => {
	if (ev.name === "ChampionKill")
		return `${ev.killer} killed ${ev.victim}${ev.assisters.length > 0 ? ` (assists: ${ev.assisters.join(", ")})` : " (solo)"}`
	if (ev.name === "DragonKill")
		return `${ev.killer} took ${ev.dragonName}${ev.stolen ? " — STOLEN" : ""}${ev.assisters.length > 0 ? ` (assists: ${ev.assisters.join(", ")})` : ""}`
	if (ev.name === "HordeKill")
		return `${ev.killer} took a voidgrub${ev.assisters.length > 0 ? ` (assists: ${ev.assisters.join(", ")})` : ""}`
	if (ev.name === "HeraldKill")
		return `${ev.killer} took Rift Herald${ev.stolen ? " — STOLEN" : ""}${ev.assisters.length > 0 ? ` (assists: ${ev.assisters.join(", ")})` : ""}`
	if (ev.name === "BaronKill")
		return `${ev.killer} took Baron Nashor${ev.stolen ? " — STOLEN" : ""}${ev.assisters.length > 0 ? ` (assists: ${ev.assisters.join(", ")})` : ""}`
	if (ev.name === "TurretKilled") return `${ev.killer} killed a turret (${ev.turret})`
	if (ev.name === "InhibKilled") return `${ev.killer} killed an inhibitor (${ev.inhib})`
	if (ev.name === "FirstBlood") return `first blood to ${ev.recipient}`
	if (ev.name === "FirstBrick") return `first turret of the game (${ev.killer})`
	if (ev.name === "Ace") return `ACE for ${ev.acingTeam}, closed by ${ev.acer}`
	if (ev.name === "Multikill") return `${ev.killer} multikill`
	return `${ev.name}${ev.killer ? ` (${ev.killer})` : ""}`
}

/**
 * `--db` — render the pack the SHIPPED path builds, for any game, with no session.
 *
 * Everything above needs four channels (raw samples, journal frames, a Gemini read of the
 * minimap, the live coach's transcript) and three of them only exist when he screen-shared. That
 * is right for an evaluation and impossible for the daemon, which has to produce a debrief for
 * every game — so `src/review/pack.ts` builds the same joins out of the database alone and
 * `review-game` sends it on every review.
 *
 * This flag exists so the two are comparable rather than merely coexisting: run it against the
 * game he graded and diff the counterpart columns against the TRUTH section above. It writes
 * `data/eval/pack-db-<gameId>.txt` so it can never overwrite a stored measurement.
 */
const mainFromDb = async (): Promise<void> => {
	const gameId = Number(arg("game", "0"))
	if (!Number.isFinite(gameId) || gameId <= 0) throw new Error("--db needs --game <id>")
	const [{ getGame, getParticipants }, { journalFramesForGame }, { loadTimeline }, pack] =
		await Promise.all([
			import("../src/db/queries.ts"),
			import("../src/db/journal-frames.ts"),
			import("../src/daemon/corpus.ts"),
			import("../src/review/pack.ts")
		])
	const game = getGame(gameId)
	if (!game) throw new Error(`no game ${gameId} in the database`)
	const built = pack.buildGamePack({
		game,
		participants: getParticipants(gameId),
		timeline: loadTimeline(gameId),
		frames: journalFramesForGame(gameId)
	})
	const outDir = join(DATA_DIR, "eval")
	mkdirSync(outDir, { recursive: true })
	const jsonPath = join(outDir, `pack-db-${gameId}.json`)
	const textPath = join(outDir, `pack-db-${gameId}.txt`)
	writeFileSync(jsonPath, JSON.stringify(built, null, "\t"))
	writeFileSync(textPath, pack.renderPack(built))
	console.log(
		`${textPath}  ${(statSync(textPath).size / 1024).toFixed(0)} KB\n` +
			`${built.source.timelineFrames} timeline frames · ${built.objectives.length} objectives · ` +
			`${built.deaths.length} deaths · ${built.frames.length} journal frames · ` +
			`counterpart ${built.counterpart?.championName ?? "UNKNOWN"}`
	)
}

const main = (): void => {
	const pack = buildPack()
	const outDir = join(DATA_DIR, "eval")
	mkdirSync(outDir, { recursive: true })
	const jsonPath = join(outDir, `pack-${pack.game.gameId}.json`)
	const textPath = join(outDir, `pack-${pack.game.gameId}.txt`)
	writeFileSync(jsonPath, JSON.stringify(pack, null, "\t"))
	writeFileSync(textPath, render(pack))
	console.log(
		`${jsonPath}  ${(statSync(jsonPath).size / 1024).toFixed(0)} KB\n` +
			`${textPath}  ${(statSync(textPath).size / 1024).toFixed(0)} KB\n` +
			`spine ${pack.spine.length} entries · events ${pack.events.length} · ` +
			`objectives ${pack.objectives.length} · position reads ${pack.positionTrack.reads.length} · ` +
			`coach lines ${pack.liveCoach.lines.length} · frames ${pack.frames.length}`
	)
}

if (import.meta.main) {
	if (process.argv.includes("--db")) await mainFromDb()
	else main()
}
