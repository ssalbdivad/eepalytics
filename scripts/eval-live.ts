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
 * The one approximation is the respawn clock — the timeline says when someone died, not when
 * they came back, and the real formula is level- and patch-dependent. `RESPAWN_SEC` is a fixture
 * constant, and it is only ever used to decide whether to mark someone dead in a test input. It
 * is never presented as a measurement and never ships.
 *
 * ## Usage
 *
 *   node --env-file-if-exists=.env --experimental-strip-types scripts/eval-live.ts \
 *     [--games 3] [--marks 8,14,20,26] [--frame path.jpg] [--judge] [--out report.json]
 *
 * `--marks` is in MINUTES of game clock.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH, USER_PUUID } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState, VisionStatePlayer } from "../src/shared/live-state.ts"
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
	[participantId: number]: { champion: string; teamId: number; puuid: string; isUser: boolean }
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
		.prepare("SELECT participantId, teamId, puuid, championName, isUser FROM participant WHERE gameId = ?")
		.all(gameId) as { participantId: number; teamId: number; puuid: string; championName: string; isUser: number }[])
		roster[r.participantId] = {
			champion: r.championName,
			teamId: r.teamId,
			puuid: r.puuid,
			isUser: r.isUser === 1
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
			deadEnemies: others
				.filter(p => roster[p]!.teamId !== myTeam)
				.map(p => ({ champion: roster[p]!.champion, respawnSec: deadFor(p) ?? 0 }))
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

	return {
		mePid,
		state: {
			clock: `${Math.floor(atSec / 60)}:${String(Math.floor(atSec % 60)).padStart(2, "0")}`,
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
			recentEvents: [],
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
const runSession = async (
	gameId: string,
	marks: number[],
	game: ReturnType<typeof loadGame>,
	frameB64: string,
	baseline: ReturnType<typeof baselineFromRows> | null
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
			ws.send(
				JSON.stringify({
					clientContent: {
						turns: [
							{
								role: "user",
								parts: [
									{ inlineData: { mimeType: "image/jpeg", data: frameB64 } },
									{ text: renderState(built.state) }
								]
							}
						],
						turnComplete: true
					}
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
	{ label: "ward placement", re: /\b(ward(s|ing)?|deep ward|control ward|pink)\b/i },
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
	const anyoneDead = /DEAD/.test(block)
	const inventedDeath = claimsDeath && !anyoneDead
	return {
		invented,
		forbidden,
		unbacked,
		inventedDeath,
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
	const games = db
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
				const said = await runSession(gameId, marks, game, frameB64, baseline)
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
			score.inventedDeath ? "INVENTED-DEATH" : ""
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
