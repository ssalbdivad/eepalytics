/**
 * Can the other 1,280 journal frames be rescued into a benchmark corpus? Yes, and here is the
 * evidence, printed every time this runs.
 *
 * ## What was on disk
 *
 * `data/live-samples/split-03.ndjson` holds the raw `allgamedata` for exactly ONE game
 * (5635467422), and only 43 journal frames fall inside it. Every other frame — 1,280 of them with
 * the JPEG still on disk — has a stored ground-truth block and no raw sample, so the block cannot
 * be re-rendered by the shipped code. The question this script answers is whether those frames can
 * be assigned to a game with confidence and their blocks repaired without inventing anything.
 *
 * ## Assignment: the wall clock, not the roster
 *
 * The brief suggested fingerprinting the roster. There is a stronger key and it was already there.
 * A frame carries `atMs` (wall clock) and `tSec` (game clock), so `atMs - tSec*1000` is the wall
 * time at which THAT game's clock read zero. Measured against `game.gameCreationMs` — which is the
 * LOBBY, not the spawn — that implied start lands 17 to 92 seconds late and is stable to
 * milliseconds within a game, while **the closest two of the 70 stored games start 589 seconds
 * apart**. So a 120-second window separates them with about five times the margin it needs, and a
 * frame lands on exactly one game or on none.
 *
 * Measured: **1,826 of 1,826 frames assign uniquely**, including all 1,323 whose JPEG still
 * exists. Nothing is ambiguous and nothing is orphaned.
 *
 * (Do not narrow the window by also requiring `atMs` to fall inside `gameCreationMs +
 * gameDurationSec`: 59 frames in game 5635104242 carry a clock past the recorded duration, and 58
 * of those are `clock: "interpolated"` — the daemon's own marker for a frame whose game clock could
 * not be read and was extended from the last anchor. Filtering on the game window silently drops
 * them; assigning them and reporting the marker is the honest handling, and it is what
 * `clockSource` on each checkpoint is for.)
 *
 * The roster fingerprint is kept anyway, as an INDEPENDENT check rather than the key: for every
 * assigned frame the block's `Your team:` / `Enemy team:` lines are compared slot by slot against
 * the post-game participant list. 1,787 of 1,809 agree exactly, and the 22 that do not are Viego
 * (see `rosterDrift` in `src/analysis/journal-repair.ts`). Zero frames name a champion who is not
 * in the game they were assigned to. Two independent keys agreeing on every frame is what "with
 * confidence" is allowed to mean here.
 *
 * ## Repair, and the check that it is not fiction
 *
 * The stored blocks predate the `championOf` fix, so their `Just happened:` lines carry bare riot
 * game names. `participant.riotId` plus `participant.championName` is exactly the mapping the old
 * code was missing. 12,786 name slots across 1,809 blocks resolve: 12,226 by riot ID and 560 that
 * were already champion names (accounts the client serves with no riot ID at all). None are left
 * unresolved.
 *
 * And it is checked rather than asserted, by two checks that were chosen because a WRONG repair
 * fails them. Game 5635467422 has BOTH the stored blocks and the raw feed, so the blob's
 * riot-ID→champion mapping is compared entry by entry with the live feed's own `allPlayers`
 * (**9 of 10 agree, 0 disagree**, the tenth being the account the client serves with no riot ID),
 * and every repaired kill must appear in the shipped renderer's events within ±15s of that frame
 * (**48 of 48**). A roster rotated one slot — wrong in all ten — scores **0 of 48** on the second
 * check and is run on every invocation as a control. Any of the three failing exits non-zero,
 * because a corpus that is quietly half-wrong is worse than a small correct one. See the comment
 * above `verify` for why the obvious check (is this kill anywhere in the game?) was thrown out: it
 * scored a rotated roster 45 of 48.
 *
 * ## What these blocks are NOT — read this before scoring anything against them
 *
 * A repaired block is a REPAIRED LEGACY BLOCK, never what `renderState` would emit today. It
 * predates three sections the shipped block now carries, and no amount of post-processing can
 * recover them without the raw sample:
 *
 *   - `Enemy jungler right now:` — the counterpart's live CS. Not derivable; the block never
 *     stored an enemy's CS.
 *   - `Farm baseline (CONTEXT ONLY ...)` — present in later blocks, absent in earlier ones, and
 *     the explicit "NONE" wording that replaced a missing baseline came after all of these.
 *   - the vetted `### What he is NOT looking at` list — `buildUnseen` ranks and rate-limits facts
 *     against a running memory of what was already said. That memory was never stored.
 *
 * Per-player death state is gone too: the roster line deliberately stopped printing `DEAD`, so
 * only the `Alive right now:` counts survive. Every checkpoint therefore ships with
 * `blockShape: "legacy-repaired"` and the caller is told, in the file, what it is holding.
 *
 * ## Usage
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/expand-corpus.ts \
 *     [--out data/eval/fixture-expanded.json] [--every 1]
 *
 * `--every N` keeps one frame in N (default 1, i.e. all of them). The audit is always computed
 * over every frame regardless, so thinning the corpus never thins the evidence.
 *
 * The corpus it writes is 1,319 checkpoints: the 1,323 frames whose JPEG survives, less the four
 * that were POSTed before the page had a ground-truth block to send with them. A frame with no
 * block is not a checkpoint — it is a picture with nothing to check the answer against.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { gameNameOf, repairBlock } from "../src/analysis/journal-repair.ts"
import type { RepairRosterEntry, RosterDrift } from "../src/analysis/journal-repair.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"

/* ------------------------------------------------------------------- args */

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const outPath = resolve(arg("out", "data/eval/fixture-expanded.json"))
const every = Math.max(1, Number(arg("every", "1")))

/**
 * Two implied starts closer than this would make a frame ambiguous.
 *
 * 120s is not a tolerance on the measurement — the implied start is stable to milliseconds within
 * a game. It is a guard: if two games ever started this close together the frame is reported
 * ambiguous and dropped rather than assigned to the nearer one.
 */
const START_WINDOW_MS = 120_000

/* -------------------------------------------------------------------- data */

const db = new DatabaseSync(DB_PATH, { readOnly: true })

interface GameRow {
	gameId: number
	gameCreationMs: number
	gameDurationSec: number
	championName: string
	win: number
}
const games = db
	.prepare("select gameId, gameCreationMs, gameDurationSec, championName, win from game")
	.all() as unknown as GameRow[]

/** SQLite has no booleans, so `isUser` arrives as 0/1 and is narrowed on the way in. */
interface ParticipantRow {
	participantId: number
	teamId: number
	championName: string
	riotId: string
	isUser: number
}

const rosterOf = new Map<number, RepairRosterEntry[]>()
for (const g of games)
	rosterOf.set(
		g.gameId,
		(
			db
				.prepare(
					"select participantId, teamId, championName, riotId, isUser from participant where gameId = ? order by participantId"
				)
				.all(g.gameId) as unknown as ParticipantRow[]
		).map(p => ({
			participantId: p.participantId,
			teamId: p.teamId,
			championName: p.championName,
			riotId: p.riotId,
			isUser: p.isUser === 1
		}))
	)

interface FrameRow {
	id: string
	tSec: number
	path: string
	atMs: number
	clock: string
	truthJson: string | null
}
const frames = db
	.prepare("select id, tSec, path, atMs, clock, truthJson from journal_frame order by atMs")
	.all() as unknown as FrameRow[]

/* -------------------------------------------------------------- assignment */

interface Assigned {
	frame: FrameRow
	game: GameRow
}
const assigned: Assigned[] = []
const unassigned: { frame: FrameRow; candidates: number; onDisk: boolean }[] = []

for (const f of frames) {
	const implied = f.atMs - f.tSec * 1000
	const cands = games.filter(g => Math.abs(g.gameCreationMs - implied) < START_WINDOW_MS)
	if (cands.length === 1) assigned.push({ frame: f, game: cands[0]! })
	else unassigned.push({ frame: f, candidates: cands.length, onDisk: existsSync(f.path) })
}

/* ------------------------------------------------------------------ repair */

interface Checkpoint {
	id: string
	tSec: number
	clock: string
	sampleLine: null
	framePath: string | null
	frameSkewSec: null
	block: string
	storedBlock: string
	gameId: string
	/** Never `shipped`: see the header. A judge that treats this as a current block is wrong. */
	blockShape: "legacy-repaired"
	/** `interpolated` means the game clock was extended, not read. Such a frame anchors nothing. */
	clockSource: string
	repair: { namesByRiotId: number; namesByChampionName: number; unresolved: string[]; droppedEvents: number }
	/** Non-empty only for Viego possessions. The block is left as the client reported it. */
	rosterDrift: RosterDrift[]
}

const mmss = (t: number): string =>
	`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`

const audit = new Map<
	number,
	{
		gameId: number
		champion: string
		frames: number
		onDisk: number
		withBlock: number
		byRiotId: number
		byChampionName: number
		unresolved: number
		dropped: number
		driftFrames: number
		interpolated: number
	}
>()

const checkpoints: Checkpoint[] = []
const unresolvedNames = new Map<string, number>()
let kept = 0

for (const a of assigned) {
	const f = a.frame
	const roster = rosterOf.get(a.game.gameId) ?? []
	const rec = audit.get(a.game.gameId) ?? {
		gameId: a.game.gameId,
		champion: a.game.championName,
		frames: 0,
		onDisk: 0,
		withBlock: 0,
		byRiotId: 0,
		byChampionName: 0,
		unresolved: 0,
		dropped: 0,
		driftFrames: 0,
		interpolated: 0
	}
	audit.set(a.game.gameId, rec)
	rec.frames++
	const onDisk = existsSync(f.path)
	if (onDisk) rec.onDisk++
	if (f.clock !== "live") rec.interpolated++
	if (f.truthJson === null) continue
	rec.withBlock++

	const r = repairBlock(f.truthJson, roster)
	rec.byRiotId += r.events.byRiotId
	rec.byChampionName += r.events.byChampionName
	rec.unresolved += r.events.unresolved.length
	rec.dropped += r.events.dropped
	if (r.drift.length > 0) rec.driftFrames++
	for (const n of r.events.unresolved) unresolvedNames.set(n, (unresolvedNames.get(n) ?? 0) + 1)

	/*
	 * A frame with no picture is not a visual checkpoint. The whole point of this rescue is the
	 * pixels; a block with no frame is already reachable from the raw samples for the one game that
	 * has them, and is a hallucination risk everywhere else.
	 */
	if (!onDisk) continue
	kept++
	if (kept % every !== 0) continue
	checkpoints.push({
		id: `cp-${String(Math.round(f.tSec)).padStart(4, "0")}-g${a.game.gameId}`,
		tSec: Number(f.tSec.toFixed(2)),
		clock: mmss(f.tSec),
		sampleLine: null,
		framePath: relative(process.cwd(), f.path),
		frameSkewSec: null,
		block: r.block,
		storedBlock: f.truthJson,
		gameId: String(a.game.gameId),
		blockShape: "legacy-repaired",
		clockSource: f.clock,
		repair: {
			namesByRiotId: r.events.byRiotId,
			namesByChampionName: r.events.byChampionName,
			unresolved: r.events.unresolved,
			droppedEvents: r.events.dropped
		},
		rosterDrift: r.drift
	})
}

/* --------------------------------------------- the check that this is real */

/**
 * The repair, verified against the one game whose raw feed survives — and the control that shows
 * the verification can actually fail.
 *
 * An earlier version of this check asked only whether each repaired `X killed Y` appeared ANYWHERE
 * in the set of kills the shipped renderer produces from the 363 samples. It scored 48/48 and it
 * was nearly worthless: measured, rotating every champion name onto the next participant — a
 * mapping that is wrong in all ten slots — still scored **45 of 48**. Only 10 champions play, most
 * kills are cross-team, and 39 of the 50 possible cross-team pairs occurred at some point in a
 * 36-minute game, so set membership is close to a tautology.
 *
 * Two checks replace it, and both discriminate:
 *
 *  1. **The mapping, directly.** The live feed's own `allPlayers` carries `riotIdGameName` AND
 *     `championName` for this same game, so the post-game blob's mapping can be compared to it
 *     entry by entry instead of inferred from events. Measured: 9 of 10 agree, **0 disagree**, and
 *     the 1 remaining is the account the client serves with an empty `riotIdGameName` — the same
 *     account whose events already arrived as a champion name. This is the check that would catch
 *     a wrong blob; it is not a set membership test and nothing about the game's shape can make it
 *     pass by luck.
 *
 *  2. **Time-aligned events.** A repaired kill must appear in the events the shipped renderer
 *     produces from a sample within ±15s of the FRAME's own wall clock, not merely somewhere in
 *     the game. Measured: correct roster **48/48**, rotated roster **0/48**.
 *
 * The ±15s is a measured window, not a guess. Both event lists are trailing six-event windows and
 * the block's lags the sample's, so at ±3s two of the 48 miss — each the OLDEST segment in its
 * block, already scrolled out of the nearest sample. The sweep: 3s → 46/48, 10s → 48/48, 15s →
 * 48/48, 20s → 48/48 with the rotated control still at 0, and only at ±30s does the control score
 * its first segment. 15s sits in the middle of the interval where the real repair is complete and
 * the wrong one is still empty.
 *
 * The control is RUN and written into the output file rather than quoted here, because a check
 * whose power is only claimed in a comment is exactly the kind of thing this corpus exists to
 * avoid.
 */
const VERIFY_GAME = 5635467422
const VERIFY_SAMPLES = resolve(DATA_DIR, "live-samples/split-03.ndjson")

/** See above: the interval where the true repair is complete and a rotated roster scores nothing. */
const EVENT_WINDOW_MS = 15_000

interface Verification {
	ran: boolean
	/** The post-game blob's riot-ID→champion mapping, checked against the live feed's own roster. */
	mapping: { agreed: number; disagreed: string[]; absentFromFeed: string[] }
	/** Repaired kills found in a sample within ±15s of the frame. */
	events: { compared: number; matched: number; misses: string[] }
	/** The same event check with every champion rotated one slot. A high score here voids the run. */
	control: { compared: number; matched: number }
}

const verify = (): Verification => {
	const out: Verification = {
		ran: false,
		mapping: { agreed: 0, disagreed: [], absentFromFeed: [] },
		events: { compared: 0, matched: 0, misses: [] },
		control: { compared: 0, matched: 0 }
	}
	if (!existsSync(VERIFY_SAMPLES)) return out
	out.ran = true
	const samples = readFileSync(VERIFY_SAMPLES, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { atMs: number; gameTime: number; data: unknown })
	const roster = rosterOf.get(VERIFY_GAME) ?? []

	/* 1. the mapping itself, against the feed's own allPlayers */
	const feed = new Map<string, string>()
	for (const s of samples)
		for (const p of ((s.data as { allPlayers?: { riotIdGameName?: string; championName?: string }[] }).allPlayers ??
			[]))
			if (p.riotIdGameName && p.championName) feed.set(p.riotIdGameName, p.championName)
	for (const p of roster) {
		const seen = feed.get(gameNameOf(p.riotId))
		if (seen === undefined) out.mapping.absentFromFeed.push(gameNameOf(p.riotId))
		else if (seen === p.championName) out.mapping.agreed++
		else out.mapping.disagreed.push(`${gameNameOf(p.riotId)}: blob says ${p.championName}, feed says ${seen}`)
	}

	/* 2. the events, aligned in time — and the same pass over a deliberately wrong roster */
	const killsAt = samples.map(s => ({
		atMs: s.atMs,
		kills: (buildLiveStateForBench(s.data, s.gameTime)?.recentEvents ?? []).filter(e => e.includes(" killed "))
	}))
	const rotated = roster.map((p, i) => ({ ...p, championName: roster[(i + 1) % roster.length]!.championName }))
	for (const a of assigned) {
		if (a.game.gameId !== VERIFY_GAME || a.frame.truthJson === null) continue
		const near = new Set<string>()
		for (const k of killsAt) if (Math.abs(k.atMs - a.frame.atMs) <= EVENT_WINDOW_MS) for (const e of k.kills) near.add(e)
		const segs = (r: RepairRosterEntry[]): string[] =>
			(repairBlock(a.frame.truthJson!, r).block.match(/^Just happened: (.*)$/m)?.[1]?.split("; ") ?? []).filter(s =>
				s.includes(" killed ")
			)
		for (const seg of segs(roster)) {
			out.events.compared++
			if (near.has(seg)) out.events.matched++
			else out.events.misses.push(`${a.frame.id}: ${seg}`)
		}
		for (const seg of segs(rotated)) {
			out.control.compared++
			if (near.has(seg)) out.control.matched++
		}
	}
	return out
}

const checked = verify()

/* ------------------------------------------------------------------ output */

const totals = [...audit.values()].reduce(
	(t, r) => ({
		frames: t.frames + r.frames,
		onDisk: t.onDisk + r.onDisk,
		withBlock: t.withBlock + r.withBlock,
		byRiotId: t.byRiotId + r.byRiotId,
		byChampionName: t.byChampionName + r.byChampionName,
		unresolved: t.unresolved + r.unresolved,
		dropped: t.dropped + r.dropped,
		driftFrames: t.driftFrames + r.driftFrames
	}),
	{ frames: 0, onDisk: 0, withBlock: 0, byRiotId: 0, byChampionName: 0, unresolved: 0, dropped: 0, driftFrames: 0 }
)

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(
	outPath,
	`${JSON.stringify(
		{
			source: {
				frames: "data/csk.db journal_frame (path + tSec + atMs + truthJson)",
				games: "data/csk.db game/participant, ingested from the post-game match blob",
				gameJoin: "atMs - tSec*1000 matched against game.gameCreationMs, confirmed by roster order"
			},
			/*
			 * Stated in the file, not only in this script, because the file will outlive the run and
			 * a judge that mistakes a legacy block for a shipped one will score the wrong thing.
			 */
			blockShape: {
				kind: "legacy-repaired",
				repaired: "the `Just happened:` line — riot game names replaced by the champion each played",
				missingVsShipped: [
					"Enemy jungler right now: <champion>, <cs> CS, level <n>",
					"Farm baseline (CONTEXT ONLY ...) / the explicit NONE wording",
					"### What he is NOT looking at — the vetted, rate-limited fact list",
					"per-player death state (only the `Alive right now:` counts survive)"
				],
				frameSkewSec: "null throughout: there is no raw sample for these frames to be skewed against"
			},
			/*
			 * Both checks, and the control that gives them their power. `controlMatched` is the score a
			 * roster wrong in all ten slots gets on the same data: it is 0, and if it ever stops being 0
			 * the event check has stopped discriminating and this corpus is unverified.
			 */
			verifiedAgainstRawFeed: {
				gameId: String(VERIFY_GAME),
				mappingAgreed: checked.mapping.agreed,
				mappingDisagreed: checked.mapping.disagreed,
				mappingAbsentFromFeed: checked.mapping.absentFromFeed,
				eventWindowSec: EVENT_WINDOW_MS / 1000,
				killSegmentsChecked: checked.events.compared,
				foundInFeedWithinWindow: checked.events.matched,
				misses: checked.events.misses,
				controlChecked: checked.control.compared,
				controlMatched: checked.control.matched
			},
			totals: { ...totals, unassignedFrames: unassigned.length, checkpoints: checkpoints.length },
			perGame: [...audit.values()],
			checkpoints
		},
		null,
		"\t"
	)}\n`
)

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`)
console.log("frames                    ", frames.length)
console.log("uniquely assigned to a game", assigned.length, pct(assigned.length, frames.length))
console.log("  ...with the JPEG on disk ", totals.onDisk)
console.log("unassigned                 ", unassigned.length, `(${unassigned.filter(u => u.onDisk).length} of them on disk)`)
console.log("blocks repaired            ", totals.withBlock)
console.log(
	"name slots resolved        ",
	totals.byRiotId + totals.byChampionName,
	`(${totals.byRiotId} by riot id, ${totals.byChampionName} already a champion name)`
)
console.log("name slots UNRESOLVED      ", totals.unresolved, [...unresolvedNames.keys()].slice(0, 10))
console.log("events dropped (both sides unresolvable)", totals.dropped)
console.log("frames whose roster drifted (Viego possession)", totals.driftFrames)
console.log(
	"mapping vs the live feed's own roster:",
	`${checked.mapping.agreed} agree, ${checked.mapping.disagreed.length} disagree, ${checked.mapping.absentFromFeed.length} absent from feed`
)
console.log(
	"repaired kills, time-aligned:        ",
	`${checked.events.matched}/${checked.events.compared} within ${EVENT_WINDOW_MS / 1000}s of the frame`,
	`(control: a roster wrong in every slot scores ${checked.control.matched}/${checked.control.compared})`
)
console.log("")
for (const r of [...audit.values()].sort((a, b) => a.gameId - b.gameId))
	console.log(
		`  ${r.gameId} ${r.champion.padEnd(9)} frames=${String(r.frames).padStart(4)} onDisk=${String(r.onDisk).padStart(4)} blocks=${String(r.withBlock).padStart(4)} names=${r.byRiotId}+${r.byChampionName} unresolved=${r.unresolved} drift=${r.driftFrames} interpolated=${r.interpolated}`
	)
console.log("")
console.log(`wrote ${checkpoints.length} checkpoints to ${relative(process.cwd(), outPath)}`)

if (checked.mapping.disagreed.length > 0) {
	console.error(`\nFAILED: the post-game blob and the live feed disagree about who played what:`)
	for (const m of checked.mapping.disagreed) console.error("  " + m)
	process.exit(1)
}
if (checked.events.compared > 0 && checked.events.misses.length > 0) {
	console.error(`\nFAILED: ${checked.events.misses.length} repaired kills are not in the feed near that frame:`)
	for (const m of checked.events.misses.slice(0, 20)) console.error("  " + m)
	process.exit(1)
}
/*
 * A control that starts scoring means the check stopped discriminating — a corpus that passes a
 * verification with no power is exactly the "quietly half-wrong" outcome this script exists to
 * refuse, so it fails the run rather than shipping.
 */
if (checked.ran && checked.control.matched > 0) {
	console.error(
		`\nFAILED: the negative control scored ${checked.control.matched}/${checked.control.compared}; a roster wrong in every slot should score 0, so this check no longer proves anything.`
	)
	process.exit(1)
}
if (totals.unresolved > 0) {
	console.error(`\nFAILED: ${totals.unresolved} names could not be resolved; the corpus would carry them as "someone".`)
	process.exit(1)
}
