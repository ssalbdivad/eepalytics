/**
 * End-to-end evaluation of the live voice coach.
 *
 * ## Why this exists
 *
 * The first real session produced advice the user described as "dumb stuff and overly critical" —
 * the standout being *"clear faster, you need to use more abilities"* said to someone who was
 * using abilities on cooldown. Nothing in the live data says anything about ability usage, so
 * that claim could not have been checked; it was invented and delivered confidently.
 *
 * Fixing that by reading the prompt and hoping is how the last three attempts went. This runs the
 * real socket against real game states and scores what comes back, so a prompt change is a
 * measurement rather than an opinion.
 *
 * ## Where the game states come from
 *
 * Nothing records live-client samples yet, so states are RECONSTRUCTED from stored post-game
 * timelines: per-minute `participantFrames` give level, gold and CS, and `CHAMPION_KILL` events
 * give the scoreline and who was dead when. That is real data about a real game, assembled into
 * the shape the live path would have produced.
 *
 * ## One thing this fixture cannot supply
 *
 * The player's CURRENT HEALTH. `buildLiveState` includes it in production (the live client
 * reports `championStats.currentHealth`), but a post-game timeline records gold, level and CS per
 * minute and never health. So a line like "you survived with 411 health!" — read correctly off
 * the frame — scores as a number not in the block, because in this harness it genuinely is not.
 * That is a gap in the fixture, not in the coach; do not "fix" it by tightening the prompt.
 *
 * ## The other approximation is the respawn clock — the timeline says when someone died, not when
 * they came back, and the real formula is level- and patch-dependent. `RESPAWN_SEC` is a fixture
 * constant, and it is only ever used to decide whether to mark someone dead in a test input. It
 * is never presented as a measurement and never ships.
 *
 * ## Usage
 *
 *   node --env-file-if-exists=.env --experimental-strip-types scripts/eval-live.ts \
 *     [--games 3] [--marks 8,14,20,26] [--frame path.jpg] [--judge] [--out report.json] \
 *     [--no-knowledge]
 *
 * `--marks` is in MINUTES of game clock. `--no-knowledge` withholds the champion notes the app
 * sends once per session, which is the A/B for whether they are earning their tokens.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH, USER_PUUID } from "../src/shared/constants.ts"
import { RECENT_EVENT_WINDOW_SEC, renderState } from "../src/shared/live-state.ts"
import type { VisionState, VisionStatePlayer } from "../src/shared/live-state.ts"
import { renderKnowledgePrimer } from "../src/shared/live-knowledge.ts"
import { championNote } from "../src/knowledge/index.ts"
import { geminiKey, GEMINI_LIVE_MODEL } from "../src/review/gemini-live.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { buildFacts, newFactMemory } from "../src/analysis/live-facts.ts"
import type { FactInput, FactMemory } from "../src/analysis/live-facts.ts"
import {
	BARON_RESPAWN_SEC,
	DRAGON_RESPAWN_SEC,
	HERALD_RESPAWN_SEC,
	paceReading
} from "../src/analysis/live-coach.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"

/** Fixture-only. See the header: the timeline records deaths, not respawns. */
const RESPAWN_SEC = 28

/** The same memory object the daemon keeps, rebuilt per game. */
let mem: FactMemory = newFactMemory()
const resetSessionState = () => {
	mem = newFactMemory()
}

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

/* ------------------------------------------------------- state rebuilding */

interface Roster {
	[participantId: number]: {
		champion: string
		teamId: number
		puuid: string
		isUser: boolean
		/** `TOP|JGL|MID|ADC|SUP|UNKNOWN`, as `analysis/roles.ts` inferred it at ingest. */
		role: string
	}
}

/**
 * The stored role vocabulary, as a coach would say it.
 *
 * Production reads the LIVE client's `position` field, which the client publishes directly. This
 * harness has no such field — the timeline has none — so it falls back to the role the ingest
 * already inferred, which for the jungler is the Smite holder. That is why every reconstructed
 * state reports the counterpart with basis `smite` and never `declared`: it is the honest label
 * for how the fixture knows, and it exercises the hedge that a real undeclared queue would need.
 */
const SPOKEN_ROLE: Record<string, string | undefined> = {
	TOP: "top",
	JGL: "jungle",
	MID: "mid",
	ADC: "bot",
	SUP: "support"
}

/**
 * Roster from the database, frames from the blob.
 *
 * Not from the match blob: it is the LCU's shape, not the Riot API's, so participants carry a
 * `championId` and no name, and the puuid lives off in `participantIdentities`. The ingest step
 * has already resolved both into the `participant` table, so this reads the resolved answer
 * rather than re-deriving it and getting it subtly different from what the app uses.
 */
const loadGame = (db: DatabaseSync, gameId: string) => {
	const timeline = JSON.parse(
		gunzipSync(readFileSync(`${DATA_DIR}/blobs/${gameId}/timeline.json.gz`)).toString()
	)
	const roster: Roster = {}
	for (const r of db
		.prepare("SELECT participantId, teamId, puuid, championName, role, isUser FROM participant WHERE gameId = ?")
		.all(gameId) as {
		participantId: number
		teamId: number
		puuid: string
		championName: string
		role: string
		isUser: number
	}[])
		roster[r.participantId] = {
			champion: r.championName,
			teamId: r.teamId,
			puuid: r.puuid,
			isUser: r.isUser === 1,
			role: r.role
		}
	return { roster, frames: (timeline.info ?? timeline).frames ?? [] }
}

/**
 * Rebuild what the live ground-truth block would have said at `atSec`.
 *
 * Deliberately built from the same fields the live path uses, so a prompt tuned against this is
 * tuned against the real thing rather than against a convenient fiction.
 */
const stateAt = (
	game: ReturnType<typeof loadGame>,
	atSec: number,
	baseline: ReturnType<typeof baselineFromRows> | null
): { state: VisionState; mePid: number } | null => {
	const { roster, frames } = game
	const mePid = Number(
		Object.keys(roster).find(k => roster[Number(k)]!.isUser) ??
			Object.keys(roster).find(k => roster[Number(k)]!.puuid === USER_PUUID) ??
			0
	)
	if (!mePid) return null

	const frame = [...frames].reverse().find((f: { timestamp: number }) => f.timestamp <= atSec * 1000)
	if (!frame) return null

	const kda: Record<number, { k: number; d: number; a: number; diedAt: number | null }> = {}
	for (const pid of Object.keys(roster)) kda[Number(pid)] = { k: 0, d: 0, a: 0, diedAt: null }
	for (const f of frames)
		for (const e of f.events ?? []) {
			if (e.type !== "CHAMPION_KILL" || e.timestamp > atSec * 1000) continue
			if (kda[e.killerId]) kda[e.killerId]!.k++
			if (kda[e.victimId]) {
				kda[e.victimId]!.d++
				kda[e.victimId]!.diedAt = e.timestamp
			}
			for (const a of e.assistingParticipantIds ?? []) if (kda[a]) kda[a]!.a++
		}

	const pf = (pid: number) => frame.participantFrames?.[String(pid)] ?? {}
	const deadFor = (pid: number): number | undefined => {
		const d = kda[pid]?.diedAt
		if (d === null || d === undefined) return undefined
		const since = atSec - d / 1000
		return since >= 0 && since < RESPAWN_SEC ? Math.round(RESPAWN_SEC - since) : undefined
	}

	const player = (pid: number): VisionStatePlayer => {
		const f = pf(pid)
		const left = deadFor(pid)
		return {
			champion: roster[pid]!.champion,
			role: SPOKEN_ROLE[roster[pid]!.role],
			level: f.level,
			k: kda[pid]!.k,
			d: kda[pid]!.d,
			a: kda[pid]!.a,
			dead: left !== undefined,
			respawnSec: left
		}
	}

	const myTeam = roster[mePid]!.teamId
	const mf = pf(mePid)
	const others = Object.keys(roster).map(Number).filter(p => p !== mePid)
	const meLeft = deadFor(mePid)

	/*
	 * The facts come from the SAME function the daemon calls.
	 *
	 * This used to be a hand-copied reimplementation with the tuning constants re-typed as bare
	 * literals, which meant the eval scored a lookalike of the coach rather than the coach — the
	 * one thing an eval must never do.
	 */
	const csNow = (mf.minionsKilled ?? 0) + (mf.jungleMinionsKilled ?? 0)
	const paced =
		baseline ?
			paceReading({
				live: {
					gameTimeSec: atSec,
					championName: roster[mePid]!.champion,
					cs: csNow,
					deaths: kda[mePid]!.d,
					kills: kda[mePid]!.k,
					assists: kda[mePid]!.a,
					level: mf.level ?? 0,
					observed: { dragonSec: null, baronSec: null, heraldSec: null }
				},
				baseline,
				focus: []
			})
		:	null

	/*
	 * The stored timeline has no KillStreak counter, so a multi-kill is reconstructed as "N kills
	 * by him inside 10 seconds", which is what a multi-kill is. Ids are synthesised from the
	 * event timestamp so `buildFacts` can still announce each once.
	 */
	const myEvents: FactInput["myEvents"] = []
	for (const f of frames)
		for (const e of f.events ?? []) {
			if (e.timestamp > atSec * 1000 || e.timestamp < (atSec - 30) * 1000) continue
			if (e.type === "CHAMPION_KILL" && e.killerId === mePid) {
				const burst = frames
					.flatMap((fr: { events?: { type: string; killerId?: number; timestamp: number }[] }) => fr.events ?? [])
					.filter(
						(x: { type: string; killerId?: number; timestamp: number }) =>
							x.type === "CHAMPION_KILL" &&
							x.killerId === mePid &&
							Math.abs(x.timestamp - e.timestamp) <= 10_000
					).length
				if (burst >= 2)
					myEvents.push({ id: e.timestamp, name: "ChampionKill", killStreak: Math.min(burst, 5) })
			} else if (e.type === "ELITE_MONSTER_KILL" && e.killerId === mePid) {
				const name =
					e.monsterType === "DRAGON" ? "DragonKill"
					: e.monsterType === "BARON_NASHOR" ? "BaronKill"
					: e.monsterType === "RIFTHERALD" ? "HeraldKill"
					: ""
				if (name !== "") myEvents.push({ id: e.timestamp, name })
			}
		}

	/** Who last killed this participant before `atSec`, by participantId, or 0 if unknown. */
	const lastKillerOf = (victimPid: number): number => {
		let killer = 0
		for (const f of frames)
			for (const e of f.events ?? [])
				if (e.type === "CHAMPION_KILL" && e.victimId === victimPid && e.timestamp <= atSec * 1000)
					killer = e.killerId
		return killer
	}

	const backIn = (monster: string, respawnSec: number): number | null => {
		let lastAt: number | null = null
		for (const f of frames)
			for (const e of f.events ?? [])
				if (
					e.type === "ELITE_MONSTER_KILL" &&
					String(e.monsterType ?? "").startsWith(monster) &&
					e.timestamp <= atSec * 1000
				)
					lastAt = e.timestamp / 1000
		return lastAt === null ? null : Math.round(lastAt + respawnSec - atSec)
	}

	const finalUnseen = buildFacts(
		{
			nowSec: atSec,
			// His own respawn, from the same reconstruction the enemies' comes from.
			meDeadForSec: meLeft ?? null,
			alliesAlive:
				(meLeft === undefined ? 1 : 0) +
				others.filter(p => roster[p]!.teamId === myTeam && deadFor(p) === undefined).length,
			enemiesAlive: others.filter(
				p => roster[p]!.teamId !== myTeam && deadFor(p) === undefined
			).length,
			deadEnemies: others
				.filter(p => roster[p]!.teamId !== myTeam)
				.map(p => ({
					champion: roster[p]!.champion,
					respawnSec: deadFor(p) ?? 0,
					// Mirrors the daemon: a kill he made himself is a readback, not scouting.
					killedByMe: lastKillerOf(p) === mePid
				}))
				.filter(d => d.respawnSec > 0),
			currentGold: mf.currentGold ?? null,
			pace: paced ? { cs: paced.cs, expected: paced.expected, exact: paced.exact } : null,
			myEvents,
			/*
			 * Objective respawns reconstructed from the timeline's own ELITE_MONSTER_KILL events,
			 * using the same constants the daemon and the overlay share. Passing null here left
			 * the newest fact type untested, which is how an eval quietly stops covering the thing
			 * it was extended for.
			 */
			drakeBackInSec: backIn("DRAGON", DRAGON_RESPAWN_SEC),
			baronBackInSec: backIn("BARON_NASHOR", BARON_RESPAWN_SEC),
			heraldBackInSec: backIn("RIFTHERALD", HERALD_RESPAWN_SEC)
		},
		mem
	)

	/*
	 * "Just happened", reconstructed — the fixture used to send an empty list, so every judged
	 * transcript was scored against a coach that had never been shown a fight. Production reads
	 * these from the live event feed; here they come from the timeline's own events, phrased the
	 * same way, resolved to champion names and bounded by the same window.
	 */
	const recentEvents: string[] = []
	for (const f of frames)
		for (const e of f.events ?? []) {
			const at = e.timestamp / 1000
			if (at > atSec || atSec - at > RECENT_EVENT_WINDOW_SEC) continue
			const name = (pid: number): string =>
				pid === mePid ? "you" : (roster[pid]?.champion ?? "someone")
			if (e.type === "CHAMPION_KILL")
				recentEvents.push(
					`${name(e.killerId)} killed ${name(e.victimId)}${
						(e.assistingParticipantIds ?? []).length > 0 ?
							` (with ${(e.assistingParticipantIds as number[]).map(name).join(", ")})`
						:	""
					}`
				)
			else if (e.type === "ELITE_MONSTER_KILL")
				recentEvents.push(
					`${
						e.monsterType === "DRAGON" ? `${String(e.monsterSubType ?? "").toLowerCase().replace(/_dragon$/, "")} dragon`
						: e.monsterType === "BARON_NASHOR" ? "Baron"
						: "Herald"
					} taken by ${name(e.killerId)}`.replace(/^ /, "")
				)
			else if (e.type === "BUILDING_KILL") recentEvents.push("turret down")
		}

	const counterpartPid = others.find(
		p => roster[p]!.teamId !== myTeam && roster[p]!.role === "JGL"
	)

	return {
		mePid,
		state: {
			clock: `${Math.floor(atSec / 60)}:${String(Math.floor(atSec % 60)).padStart(2, "0")}`,
			counterpart:
				counterpartPid === undefined ?
					null
				:	{
						champion: roster[counterpartPid]!.champion,
						// See SPOKEN_ROLE: the fixture knows this the way `roles.ts` does, by Smite.
						basis: "smite" as const,
						level: pf(counterpartPid).level,
						k: kda[counterpartPid]!.k,
						d: kda[counterpartPid]!.d,
						a: kda[counterpartPid]!.a
					},
			me: {
				champion: roster[mePid]!.champion,
				level: mf.level,
				gold: mf.currentGold,
				k: kda[mePid]!.k,
				d: kda[mePid]!.d,
				a: kda[mePid]!.a,
				cs: (mf.minionsKilled ?? 0) + (mf.jungleMinionsKilled ?? 0),
				dead: meLeft !== undefined,
				respawnSec: meLeft
			},
			allies: others.filter(p => roster[p]!.teamId === myTeam).map(player),
			enemies: others.filter(p => roster[p]!.teamId !== myTeam).map(player),
			recentEvents,
			unseen: finalUnseen
		}
	}
}

/* ------------------------------------------------------------ the socket */

interface Said {
	gameId: string
	atSec: number
	clock: string
	text: string
	ms: number
	state: VisionState
	/** Billed tokens for the turn, from Gemini's own usageMetadata. */
	tokens: { total: number; prompt: number } | null
}

/**
 * One Gemini Live session per game, so the "do not repeat yourself" instruction is exercised the
 * way it is in a real game rather than reset between every prompt.
 */
/**
 * The champion notes for one game, exactly as the daemon assembles them.
 *
 * `_default.md` counts as no notes on both sides — the same rule `routes/live.ts` and the
 * champ-select brief already apply, because that file does not describe a champion, it tells the
 * coach to stop talking about the champion.
 */
const knowledgeFor = (game: ReturnType<typeof loadGame>): string => {
	const rows = Object.values(game.roster)
	const me = rows.find(r => r.isUser)
	if (!me) return ""
	const opp = rows.find(r => r.teamId !== me.teamId && r.role === "JGL")
	const noteFor = (champion: string | undefined) => {
		if (champion === undefined) return null
		const note = championNote(champion)
		return note && !note.isDefault ? { champion, text: note.text } : null
	}
	const cp = noteFor(opp?.champion)
	return renderKnowledgePrimer({
		me: noteFor(me.champion),
		counterpart: cp ? { ...cp, basis: "smite" } : null
	})
}

const runSession = async (
	gameId: string,
	marks: number[],
	game: ReturnType<typeof loadGame>,
	frameB64: string,
	baseline: ReturnType<typeof baselineFromRows> | null,
	/** Sent once, on the first turn, exactly as `geminiLive.ts` does it. "" sends nothing. */
	knowledge: string
): Promise<Said[]> => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")

	const mint = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
		method: "POST",
		headers: { "x-goog-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({ uses: 1 })
	})
	const token = ((await mint.json()) as { name?: string }).name
	if (!token) throw new Error("could not mint a token")

	return await new Promise<Said[]>((resolve, reject) => {
		const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`
		const ws = new WebSocket(url)
		const out: Said[] = []
		let queue = [...marks]
		let current: { atSec: number; state: VisionState; sentAt: number } | null = null
		let partial = ""
		/** One socket is one session, and the notes go in once inside it — as the app does. */
		let knowledgeSent = false
		let lastUsage: { total: number; prompt: number } | null = null

		const next = () => {
			const atSec = queue.shift()
			if (atSec === undefined) {
				ws.close()
				resolve(out)
				return
			}
			const built = stateAt(game, atSec, baseline)
			if (!built) {
				// Silent skips are how the first run reported "0 lines" and explained nothing.
				process.stderr.write(`  [skip ${atSec}s: no reconstructable state]\n`)
				next()
				return
			}
			current = { atSec, state: built.state, sentAt: Date.now() }
			/*
			 * Frame INSIDE the turn, matching the app. Measured over eight turns on one socket:
			 * streaming it through `realtimeInput.video` took 3.5-5.4s and produced generic advice
			 * that never referenced the picture, while inline took 0.6-1.7s and read the screen
			 * correctly. An eval that used the other shape would be scoring a path nothing runs.
			 */
			/*
			 * Champion notes ride on the FIRST turn only, which is what the app does — see
			 * `beat()` in `web/lib/geminiLive.ts` and the placement argument in
			 * `shared/live-knowledge.ts`. Sending them every turn here would score a path nothing
			 * runs, which is the one thing an eval must never do.
			 */
			const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
				{ inlineData: { mimeType: "image/jpeg", data: frameB64 } }
			]
			if (knowledge !== "" && !knowledgeSent) {
				knowledgeSent = true
				parts.push({ text: knowledge })
			}
			parts.push({ text: renderState(built.state) })
			ws.send(
				JSON.stringify({
					clientContent: { turns: [{ role: "user", parts }], turnComplete: true }
				})
			)
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: GEMINI_LIVE_MODEL,
						generationConfig: { responseModalities: ["AUDIO"] },
						outputAudioTranscription: {},
						systemInstruction: { parts: [{ text: LIVE_COACH_SYSTEM_PROMPT }] }
					}
				})
			)

		ws.onmessage = async ev => {
			const m = JSON.parse(
				typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			) as {
				setupComplete?: unknown
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string }[] }
				}
			}
			if (m.setupComplete) {
				next()
				return
			}
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) if (p.text) partial += p.text
			if (sc.turnComplete) {
				if (current)
					out.push({
						gameId,
						atSec: current.atSec,
						clock: current.state.clock,
						text: partial.trim(),
						ms: Date.now() - current.sentAt,
						state: current.state,
						tokens: lastUsage
					})
				partial = ""
				next()
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => {
			if (e.code !== 1000 && out.length === 0)
				reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 160)}`))
			else resolve(out)
		}
		setTimeout(() => {
			ws.close()
			resolve(out)
		}, 180_000)
	})
}

/* -------------------------------------------------------------- scoring */

/**
 * Things the live data cannot support, so a confident claim about them is a defect.
 *
 * This list is the "clear faster, use more abilities" complaint turned into a check. Nothing in
 * `allgamedata` carries cooldowns, ward placements, item purchase times or skill order, so any
 * sentence asserting them is unfalsifiable by construction.
 */
const FORBIDDEN: { label: string; re: RegExp }[] = [
	{ label: "ability usage / cooldowns", re: /\b(cooldown|abilit(y|ies)|your (q|w|e|r)\b|spell rotation|combo)\b/i },
	/*
	 * "Vision" as a thing to take, steal, deny or contest.
	 *
	 * Added after a run where the coach said "steal his topside vision" and "move now to contest
	 * the vision" on the same pass. The block carries no vision data at all — not a ward, not a
	 * score — so those are instructions with nothing behind them, and the word is exactly what a
	 * model reaches for when it wants to sound tactical and has nothing to be tactical about.
	 * `ward` alone did not catch either one.
	 */
	{
		label: "ward / vision control",
		re: /\b(ward(s|ing)?|deep ward|control ward|pink|(take|steal|deny|contest|get|set up|setting up)( the| his| her| their)? vision|vision (control|game))\b/i
	},
	/*
	 * A claim about what an enemy is doing right now. The client publishes who they are, their
	 * level, their score and whether they are alive — never an activity. Measured: "gank bot while
	 * he is busy", which is a position and an intention in four words.
	 */
	{
		label: "enemy activity / intent",
		re: /\b(while (he|she|they)('s| is| are)? (busy|farming|clearing|recalling|backing)|(he|she|they)('s| is| are) (coming|farming topside|farming botside|on his way|rotating))\b/i
	},
	/*
	 * Build JUDGEMENT, not the verb "buy".
	 *
	 * The first version flagged "you have 2205g unspent, recall right now and buy some items" as
	 * unsupportable. It is not: the gold figure is in the block and spending it is the obvious
	 * consequence. What the data cannot support is grading the build — which item, in what order,
	 * at what time. Scoring the generic verb would have driven a real improvement out of the
	 * coach to satisfy a bad check.
	 */
	{
		label: "item build / timings",
		re: /\b(your build|built \w+|should have (bought|built|rushed)|rush(ing)? (a|the|his|her)? ?\w+ (first|before)|bought (it|them)? ?(too|at))\b/i
	},
	{ label: "summoner spells", re: /\b(flash|ignite|smite is (up|down)|summoner spell)\b/i },
	{ label: "clear speed judgement", re: /\b(clear faster|clearing too slow|speed up your clear|slow clear)\b/i },
	/*
	 * Summing or summarising a fight, which arrived the moment the block started showing fights.
	 *
	 * "Three of yours just died", "they just aced three of you", "your team's gone" — all three
	 * said in one run, none supported. The kill lines are a 45-second history and say nothing
	 * about who is standing NOW; "Alive right now" is the only count of the living in the block.
	 * "N of them are dead" is deliberately not matched: that one IS a computed fact from the
	 * ranked list.
	 */
	{
		label: "counted or summarised a fight",
		re: /\b((two|three|four|five|\d+) of (yours|your team|your teammates|you)\b|aced?\b|your team('s| is| was)? (gone|dead|wiped)|wiped you)/i
	},
	{ label: "unseeable enemy position", re: /\b(their jungler is (in|at|near)|enemy jungler is (in|at|near))\b/i }
]

const MOTIFS = /\b(bough|nap|dream|bloom|petal|pollen|prance|drift|slumber|glade|doze|bounce)\b/i

const scoreLine = (s: Said, championNames: Set<string>) => {
	const roster = new Set(
		[s.state.me.champion, ...s.state.allies.map(p => p.champion), ...s.state.enemies.map(p => p.champion)].map(c =>
			c.toLowerCase()
		)
	)
	const invented = [...championNames].filter(
		c => !roster.has(c.toLowerCase()) && new RegExp(`\\b${c.replace(/[^\w]/g, ".")}\\b`, "i").test(s.text)
	)
	const forbidden = FORBIDDEN.filter(f => f.re.test(s.text)).map(f => f.label)
	const block = renderState(s.state)
	/*
	 * TEST 2 from the prompt, automated as far as a regex honestly can: could this exact sentence
	 * have been said in a different game?
	 *
	 * The proxy is that a line anchored to THIS game names something from it — a number that
	 * appears in the block, or a champion on this roster. "Viego is your jungle counterpart so
	 * watch for his ganks" names a champion, so it would slip past this; "focus on your farm and
	 * take objectives" names nothing at all and is caught. It is a floor, not a ceiling — a judge
	 * pass is still what catches a generic line wearing a real champion's name.
	 */
	const generic =
		!/^pass\b/i.test(s.text) &&
		!/\d/.test(s.text) &&
		![...roster].some(c => new RegExp(`\\b${c.replace(/[^\w]/g, ".")}\\b`, "i").test(s.text))
	// Numbers above 3 are specific enough that inventing one is a real claim; 1-3 are counts.
	const nums = [...s.text.matchAll(/\b(\d{2,})\b/g)].map(m => m[1]!)
	const unbacked = nums.filter(n => !block.includes(n))

	/*
	 * A death claim must correspond to a DEAD marker in the block.
	 *
	 * Added after the coach announced "Shyvana just died, gone for 1s" at a tick where the facts
	 * list was empty and nobody was dead. The number check missed it — "1s" is a single digit and
	 * Shyvana was a real champion in that game — so the two signals that usually catch invention
	 * both passed a wholly invented event.
	 */
	const claimsDeath = /\b(just died|is dead|are dead|down for|gone for|respawn)/i.test(s.text)
	/*
	 * Matched against the VETTED LIST, not the roster.
	 *
	 * This used to look for "DEAD" in the block, which worked only while the roster printed a
	 * death marker. That marker was removed — the model kept inventing timers to go with it — and
	 * the check promptly flagged 19% of perfectly good lines. A check keyed to a string that the
	 * thing it checks is allowed to stop emitting is a check that will lie to you exactly once,
	 * loudly, at the worst moment.
	 */
	const deathOffered = /just died|of them are dead/i.test(block)
	const inventedDeath = claimsDeath && !deathOffered
	return {
		invented,
		forbidden,
		unbacked,
		inventedDeath,
		generic,
		motif: MOTIFS.test(s.text),
		hasNumber: /\d/.test(s.text),
		chars: s.text.length
	}
}

/* ---------------------------------------------------------------- judge */

const judge = async (said: Said[]): Promise<string> => {
	const payload = said
		.map(
			(s, i) =>
				`--- LINE ${i + 1} (clock ${s.clock}) ---\nGROUND TRUTH GIVEN:\n${renderState(s.state)}\n\nCOACH SAID: ${s.text}`
		)
		.join("\n\n")

	const rubric = `You are grading a live League of Legends voice coach. It is speaking to a jungle main
mid-game. It is given the ground truth shown, plus a video frame of the player's screen that you
cannot see.

Grade EVERY line on:
  A. SUPPORTED — is every claim backed by the ground truth, or plainly visible on any screen?
     A claim about ability usage, cooldowns, wards, item timings or clear speed is NEVER
     supportable from this data. Mark those.
  B. USEFUL — does it tell the player something they are not already looking at? Narrating the
     screen back at them scores 0.
  C. TONE — friendly and encouraging, or needlessly critical? The player quit on a coach that
     was "overly critical". Criticism is fine ONLY when anchored to a ground-truth fact.
  D. FRESH — does it repeat an earlier line's idea or joke?

Return a compact report: a table of line number, A/B/C/D each scored 0-2, and a one-line reason
only where a score is 0. Then the three worst lines verbatim with what specifically is wrong, and
finally 3-5 concrete prompt changes that would fix the failures you saw. Be blunt.`

	return await new Promise<string>(resolve => {
		const p = spawn(
			"claude",
			[
				"--print",
				"--model",
				"claude-opus-5",
				"--tools",
				"",
				"--disable-slash-commands",
				"--strict-mcp-config",
				"--no-session-persistence",
				"--safe-mode"
			],
			{ stdio: ["pipe", "pipe", "ignore"] }
		)
		let out = ""
		p.stdout.on("data", d => (out += String(d)))
		p.on("close", () => resolve(out.trim()))
		p.stdin.end(`${rubric}\n\n${payload}\n`)
	})
}

/* ----------------------------------------------------------------- main */

const main = async () => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const championNames = new Set(
		db.prepare("SELECT DISTINCT championName FROM participant WHERE championName IS NOT NULL").all().map(
			r => String((r as { championName: string }).championName)
		)
	)
	const wanted = Number(arg("games", "3"))
	/*
	 * Either explicit minute marks, or `--every N` seconds from `--from` to `--to` minutes.
	 *
	 * The dense form is the realistic one: production speaks on a 20s heartbeat, and sampling
	 * only on exact minutes almost never lands inside a 28s death window, which made an early
	 * run report a 45% PASS rate that was an artefact of the sampling rather than the coach.
	 */
	const every = Number(arg("every", "0"))
	const marks =
		every > 0 ?
			(() => {
				const from = Number(arg("from", "4")) * 60
				const to = Number(arg("to", "30")) * 60
				const out: number[] = []
				for (let t = from; t <= to; t += every) out.push(t)
				return out
			})()
		:	arg("marks", "6,11,16,22,28").split(",").map(m => Number(m) * 60)

	const baseline = baselineFromRows(perGameMetrics(loadCorpus(40)))
	/*
	 * `--game <id>[,<id>]` pins the games instead of taking the newest N.
	 *
	 * A before/after has to be run over the SAME states — the fact memory is stateful across
	 * marks, so a different game or a different mark set is a different experiment — and the
	 * newest-N default silently changes every time a game is played.
	 */
	const pinned = arg("game", "")
	const games =
		pinned !== "" ?
			pinned.split(",").map(g => g.trim())
		:	db
				.prepare("SELECT gameId FROM game WHERE timelineBlob IS NOT NULL ORDER BY endedAtMs DESC LIMIT ?")
				.all(wanted)
				.map(r => String((r as { gameId: number | bigint }).gameId))

	const frameB64 = readFileSync(arg("frame", `${DATA_DIR}/eval/frame.jpg`)).toString("base64")

	/*
	 * `--dump` reconstructs and prints the blocks without opening a socket. Cheap, instant, and
	 * the right tool for "what was it actually told?" — which is a different question from "what
	 * did it say", and the one that usually has the answer in it.
	 */
	if (flag("dump")) {
		for (const gameId of games) {
			resetSessionState()
			const game = loadGame(db, gameId)
			console.log(`\n########## game ${gameId} ##########`)
			const primer = flag("no-knowledge") ? "" : knowledgeFor(game)
			if (primer !== "") console.log(`\n----- champion notes, sent once -----\n${primer}`)
			for (const atSec of marks) {
				const built = stateAt(game, atSec, baseline)
				if (!built) continue
				console.log(`\n----- ${Math.floor(atSec / 60)}:00 -----`)
				console.log(renderState(built.state))
			}
		}
		return
	}

	const all: Said[] = []
	const failures: string[] = []
	for (const gameId of games) {
		process.stderr.write(`game ${gameId} … `)
		/*
		 * Retry the session, because Gemini Live really does fail transiently.
		 *
		 * Observed under repeated eval runs: `closed 1011: Internal error encountered` on two of
		 * three games, with per-turn latency spiking from ~700ms to 12-29s beforehand. A run that
		 * silently reports "5 lines" from a broken socket is worse than no run, because the
		 * numbers still print and look like a result.
		 */
		let attempt = 0
		for (;;) {
			try {
				resetSessionState()
				const game = loadGame(db, gameId)
				const said = await runSession(
					gameId,
					marks,
					game,
					frameB64,
					baseline,
					// `--no-knowledge` is the A/B: same states, same prompt, notes withheld.
					flag("no-knowledge") ? "" : knowledgeFor(game)
				)
				all.push(...said)
				process.stderr.write(`${said.length} lines\n`)
				break
			} catch (e) {
				attempt += 1
				const msg = e instanceof Error ? e.message : String(e)
				if (attempt >= 3) {
					process.stderr.write(`FAILED after ${attempt}: ${msg}\n`)
					failures.push(`${gameId}: ${msg}`)
					break
				}
				const wait = attempt * 20_000
				process.stderr.write(`retry ${attempt} in ${wait / 1000}s (${msg}) … `)
				await new Promise(r => setTimeout(r, wait))
			}
		}
		// Space the sessions out; back to back is what provoked the 1011s.
		await new Promise(r => setTimeout(r, 5_000))
	}

	if (failures.length > 0)
		console.log(`\n!! ${failures.length} session(s) failed — these numbers are incomplete:\n  ${failures.join("\n  ")}`)

	const scored = all.map(s => ({ said: s, score: scoreLine(s, championNames) }))
	const n = scored.length || 1
	const pct = (k: number) => `${Math.round((100 * k) / n)}%`

	console.log(`\n=== ${all.length} lines across ${games.length} games ===\n`)
	for (const { said, score } of scored) {
		const flags = [
			score.invented.length > 0 ? `INVENTED:${score.invented.join(",")}` : "",
			score.forbidden.length > 0 ? `UNSUPPORTABLE:${score.forbidden.join("|")}` : "",
			score.unbacked.length > 0 ? `UNBACKED#:${score.unbacked.join(",")}` : "",
			score.inventedDeath ? "INVENTED-DEATH" : "",
			score.generic ? "GENERIC" : ""
		]
			.filter(Boolean)
			.join(" ")
		console.log(`${said.clock.padStart(5)} ${String(said.ms).padStart(5)}ms ${flags ? `⚠ ${flags}` : "  ok"}`)
		console.log(`        ${said.text}`)
	}

	const passes = scored.filter(s => /^pass\b/i.test(s.said.text)).length
	console.log(`\n--- automatic checks ---`)
	console.log(`stayed quiet (PASS) ${pct(passes)}  ${passes}/${n}`)
	console.log(`invented champion   ${pct(scored.filter(s => s.score.invented.length > 0).length)}`)
	console.log(`unsupportable claim ${pct(scored.filter(s => s.score.forbidden.length > 0).length)}`)
	console.log(`invented a death    ${pct(scored.filter(s => s.score.inventedDeath).length)}`)
	console.log(`number not in block ${pct(scored.filter(s => s.score.unbacked.length > 0).length)}`)
	console.log(
		`generic (TEST 2)    ${pct(scored.filter(s => s.score.generic).length)}  — names nothing from this game`
	)
	const spoke = scored.filter(s => !/^pass\b/i.test(s.said.text))
	const spokeN = spoke.length || 1
	console.log(
		`carries a number    ${Math.round((100 * spoke.filter(s => s.score.hasNumber).length) / spokeN)}% (of lines it actually spoke)`
	)
	console.log(`lillia motif        ${pct(scored.filter(s => s.score.motif).length)}`)
	console.log(
		`median length       ${scored.map(s => s.score.chars).sort((a, b) => a - b)[Math.floor(n / 2)]} chars`
	)
	console.log(
		`median latency      ${all.map(s => s.ms).sort((a, b) => a - b)[Math.floor(n / 2)]}ms`
	)
	/*
	 * Real billed tokens, straight from Gemini's usageMetadata. Reported as tokens rather than
	 * dollars: the rate is Google's to change and quoting a price from memory is the kind of
	 * confident-sounding number this whole exercise exists to stamp out.
	 */
	const withTokens = all.filter(s => s.tokens)
	if (withTokens.length > 0) {
		const totals = withTokens.map(s => s.tokens!.total).sort((a, b) => a - b)
		console.log(
			`median tokens/turn  ${totals[Math.floor(totals.length / 2)]} (cumulative session count; the per-turn delta is what is billed)`
		)
	}

	/* Variety, which is what a judge pass flagged and the automatic checks could not see. */
	const spokeTexts = spoke.map(s => s.said.text)
	const share = (re: RegExp) =>
		`${Math.round((100 * spokeTexts.filter(t => re.test(t)).length) / (spokeTexts.length || 1))}%`
	console.log(`\n--- what it talked about (of spoken lines) ---`)
	console.log(`a death            ${share(/\b(died|dead|down for)\b/i)}`)
	console.log(`farm vs his pace   ${share(/\bcamps?\b|\bCS\b/i)}`)
	console.log(`gold               ${share(/\bgold\b|\d+g\b/i)}`)
	/*
	 * Fights, which the coach never once mentioned before this was measured — the ordered list in
	 * the prompt had camps, gold and objective timers in it and nothing about whether to commit,
	 * walk away, or go at all. The player asked for this directly.
	 */
	console.log(`a fight or a trade ${share(/\b(fight|fought|trade|traded|ace|killed|kill|dive|collapse|commit)\b/i)}`)

	const out = arg("out", "")
	if (out !== "") {
		writeFileSync(out, JSON.stringify({ at: Date.now(), scored }, null, 2))
		console.log(`\nwrote ${out}`)
	}

	if (flag("judge") && all.length > 0) {
		console.log(`\n--- judge ---\n`)
		console.log(await judge(all))
	}
}

await main()
