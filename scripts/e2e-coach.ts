/**
 * One command that plays a real game back through the real live coach and FAILS if what she says
 * is the thing the owner quit on.
 *
 * ## Why this exists, and why the 682-test suite did not
 *
 * Three defects shipped past a green suite in one week, and every one of them was invisible to a
 * unit test because every unit was correct:
 *
 *   - the pronunciation guide sat in the ground-truth block, and the coach read the RESPELLING out
 *     loud — "BRY-er is still at 0 CS", to the player, repeatedly. `pronounce.ts` was right,
 *     `renderState` was right, and the sentence was still unusable;
 *   - the farm baseline was a bare line in the block, so it was read out verbatim: *"your 40 farm
 *     is just behind your average of 42"* — a two-CS gap that no ranked fact would ever have
 *     offered, because `buildFacts` never offered it. Nothing in `live-facts.test.ts` can see a
 *     line `buildFacts` did not produce;
 *   - `grabFrame()` returned null and the turn went out text-only, in silence. She coached
 *     fluently from the block, and the player's own diagnosis was the right one: *"the agent is
 *     not looking at the actual frames at all, its stuff that could all be inferred from the
 *     logs"*.
 *
 * The common shape is that the defect is a property of the TRANSCRIPT, not of any function. So the
 * assertions here are over the transcript: what she said, how often, about what, and whether every
 * figure in it can be traced back to the block she was holding.
 *
 * ## What is real about it
 *
 *   - **the states** are replayed from `data/live-samples/<game>.ndjson`, the raw `allgamedata`
 *     the daemon recorded every five seconds of an actual game, through the daemon's own
 *     `buildLiveStateForBench` -> `buildLiveState` -> `buildFacts`. Not a reconstruction: the same
 *     code path, consuming the same announce-once memory in the same order;
 *   - **the frames** are the journal's own screenshots of that same game, matched to each state on
 *     the game clock AND on the wall clock, so the picture and the block describe the same instant.
 *     No previous harness here could say that: `bench-providers.ts` and `eval-live.ts` both send
 *     one saved screenshot against reconstructed states, and both document at length that their
 *     absolute rates are therefore not a forecast of a real game.
 *
 *     A state with no verified frame is sent WITHOUT one and recorded as blind, which fails the
 *     run. That is not a harness limitation being papered over, it is the finding: in the game the
 *     owner quit on, the journal holds 43 frames covering 0:02 to 6:43 and nothing at all for the
 *     remaining thirty minutes, while the sampler recorded the whole thing. He was right that she
 *     was not looking at the frames — for 82% of that game there were none;
 *   - **the socket** is the shipped one — one session per game, `LIVE_COACH_SYSTEM_PROMPT`, the
 *     frame as `inlineData` INSIDE the turn, at the app's own 20s cadence.
 *
 * ## It prints sentences, not percentages
 *
 * A harness that reports "8% unbacked numbers" is how all three of these survived: the numbers
 * looked fine. Every finding here quotes the offending line verbatim, next to the part of the
 * block that contradicts it, and the process exits non-zero. A run with no findings still prints
 * the whole transcript, because a coach that says nothing at all also passes every check.
 *
 * ## What it reuses, and what that reuse cannot catch
 *
 * Check 3 is `scoreLine` from `src/analysis/coach-score.ts` rather than a second scorer, so
 * "unbacked" and "misattributed" mean here exactly what they mean in the judge and in
 * `bench-providers.ts`. Two known blind spots, both measured against real blocks from the game the
 * owner quit on:
 *
 *   - **a fabricated figure that collides with any digit in the block is not unbacked.** Told
 *     *"You are on 40 CS to Briar's 29"* against the 6:29 block, `unbackedNumbers` was empty: the
 *     only `29` in the whole block is in the clock. It was caught, but by the ATTRIBUTION arm, and
 *     only because the sentence named an owner. A figure that collides with a clock, a level or a
 *     K/D/A and names nobody is invisible to check 3 — which is why checks 1, 2, 4 and 5 do not
 *     route through it;
 *   - **it is per line, so it cannot see a pile.** Every one of the nine lines he quit on was
 *     individually grounded; eight of them were about farm. Checks 4 and 5 exist because no
 *     line-level scorer, this one included, can fail a transcript for what it is as a whole.
 *
 * And the limit of the whole file, stated plainly because it is the owner's actual complaint:
 * **nothing here can prove she LOOKED at the picture.** `blind-turn` proves only that one was
 * sent. A sentence that is true of the block and also true of the frame scores identically to one
 * read off the block alone, and every line in the transcript he quit on was of the second kind
 * while frames were being sent. The mechanical version of that question is an A/B — the same
 * states twice, once normally and once under `--no-frame`, two `--out` files, and a diff. It is
 * not a gate here because it has no power at this sample size: on the run recorded below she
 * declined 17 of 18 turns, so both arms would be seventeen PASSes and one sentence, and "the
 * transcripts look alike" would mean nothing. Until she talks enough for that comparison to say
 * something, the answer is the transcript printed in full, for a human to read.
 *
 * ## What it measured the first time it was run for real
 *
 * Game `js-mtn2jrku-8ae9`, run 3 — **the game he shut the coach off in**. The replayed roster is
 * his (Lillia, Urgot, Taliyah, Smolder, Braum against Ornn, Briar, Lissandra, Jhin, Senna), the
 * enemy jungler is Briar sitting on 0 CS, a Hextech drake goes down at 6:05, and the CONTEXT-ONLY
 * line reads `20 CS against 28` at 4:03, `20 CS against 30` at 4:27 and `40 CS against 42` at
 * 6:05 — the three baselines that were spoken back to him verbatim. Same blocks, same socket.
 *
 *   - **at HEAD, 18 turns from 0:00 to 6:54, 16 of them carrying that game's own screenshots: one
 *     spoken line.** *"They just took Hextech Drake. Keep clearing your camps and plan for the next
 *     one."* — the one fact that was on the vetted list. 17 PASSes. 0.14 lines per minute against
 *     the 2.25 he refused to sit through, and not one of the farm baselines was read out. The only
 *     finding was `blind-turn`: 0:00 and 6:54 had no verified frame;
 *   - **the same 18 blocks with the nine lines he quit on grafted back onto them fails 19 times in
 *     5 checks and exits 1** — 8 `spoken-artefact` (BRY-er, caught by both arms), 6
 *     `context-only`, 2 `bad-figure` (37 and 42), 2 `too-chatty`, 1 `one-note` at 89% farm. That
 *     graft is the negative control, and it is what makes the paragraph above worth anything: a
 *     harness that passes a good run and cannot fail the bad one has measured nothing.
 *
 * Then the same game from 10:00 to 17:22, where the journal has nothing at all — **19 turns, 0
 * with a picture, and she said nine things.** Kill participation against Briar, a drake timer, a
 * level gap, a Herald charge, a respawn window; varied (33% objectives, 22% deaths, 22% farm, 22%
 * other, so `one-note` stays quiet) and every one of them grounded. It is also every one of them
 * derivable from the block alone, which is the owner's sentence — *"the agent is not looking at
 * the actual frames at all"* — reproduced under laboratory conditions, because on those turns
 * there was no frame to look at. That run fails on `blind-turn` and `too-chatty` (1.16 a minute).
 *
 * The two runs are NOT a controlled comparison — 0:00-6:54 is the early game, where there is
 * genuinely less to say than at 17:00 — so nothing here shows that a picture makes her quieter.
 * What it shows is narrower and enough: nothing she says needs one.
 *
 * One asymmetry, stated rather than buried: `buildFacts` ran inside the replay with a null
 * baseline (see the graft below), so the vetted list carries no farm fact and she had less to say
 * than production would have offered. The CONTEXT-ONLY check is therefore STRICTER than production
 * and the rate check LOOSER. Fixing it is one optional parameter on `buildLiveStateForBench`.
 *
 * ## Usage
 *
 *     node --experimental-strip-types scripts/e2e-coach.ts --data ~/eepalytics/data
 *     node --experimental-strip-types scripts/e2e-coach.ts --dump          # blocks only, no socket
 *     node --experimental-strip-types scripts/e2e-coach.ts --replay run.json   # re-check a saved run
 *
 *     --data DIR        where data/live-samples and data/journal live (default: ./data)
 *     --game ID         sampled game to replay (default: newest on disk)
 *     --run N           which game inside that sample file (default: the last; they are listed)
 *     --every SEC       game-clock seconds between turns (default 20, the app's own cadence)
 *     --from MIN --to MIN   clip the replay (default: the whole game)
 *     --turns N         stop after N turns
 *     --out FILE        write the run as JSON, so `--replay` can re-derive every verdict later
 *     --replay FILE     score a saved run with no socket and no key
 *     --dump            print the blocks and exit
 *     --verbose         print the fact list beside every line
 *     --no-frame        deliberately send no picture — see `blind-turn`, which then FAILS
 *     --max-lpm N       ceiling on spoken lines per minute (default 1)
 *     --max-window N    ceiling on spoken lines in any 4 minutes (default 5)
 *     --max-share N     ceiling on one subject's share of spoken lines, 0-1 (default 0.4)
 *
 * DO NOT run this during a game: it holds a Gemini Live socket, which the live coach wants. It
 * reads the League APIs not at all.
 */

import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"
import { isEmpty, scoreLine } from "../src/analysis/coach-score.ts"
import type { LineScore } from "../src/analysis/coach-score.ts"

/* ============================================================== the record */

/**
 * One turn, exactly as it was sent and answered.
 *
 * Serialisable on purpose: `--out` writes these and `--replay` scores them again with no socket,
 * so a verdict from a run six weeks ago can be re-derived rather than remembered. The block is
 * stored rendered rather than as a `VisionState`, because the block is what the model was actually
 * given and a re-render could differ after any edit to `renderState`.
 */
export interface CoachTurn {
	gameId: string
	atSec: number
	clock: string
	/** `renderState(state)` — the exact bytes sent. */
	block: string
	/** The pronunciation entries the block offered, if any. Kept for the respelling check. */
	pronounce: { name: string; say: string }[]
	/** The vetted list, i.e. `state.unseen`. */
	list: string[]
	roster: string[]
	/** What she said, transcribed. `""` when nothing came back at all. */
	text: string
	/** False when the turn went out with no picture. */
	hadFrame: boolean
	ms: number
}

/* ================================================================ speaking */

/** A deliberate decline. Counted, then excluded from every rate — she did not speak. */
export const isPass = (text: string): boolean =>
	text.replace(/[^A-Za-z]/g, "").toLowerCase() === "pass"

/** Turns on which she actually said something to him. */
export const spokenTurns = (turns: readonly CoachTurn[]): CoachTurn[] =>
	turns.filter(t => !isPass(t.text) && !isEmpty(t.text))

/* ================================================== 1. scaffolding, spoken */

/**
 * Strings that exist only because the block has a shape. None of them is a fact, and every one of
 * them has a plausible route into speech: the model is handed a document and asked to produce a
 * sentence, and a document read aloud sounds exactly like a sentence until you hear it.
 *
 * `BRY-er` is the worked example and it is NOT the only one. A respelling is data-shaped, and so
 * is `lv12`, so is `3/2/7`, so is the heading over the fact list. All of them have the same cause:
 * something in the block was not written to be said out loud.
 */
const FURNITURE: readonly string[] = [
	"ground truth",
	"context only",
	"farm baseline",
	"what he is not looking at",
	"prefer these",
	"nothing he is missing",
	"the ten champions",
	"your team:",
	"enemy team:",
	"the screenshot is not",
	"identified by smite",
	"say these names",
	"pronounce them this way",
	"(approximate)"
]

/**
 * Block headings that are ALSO ordinary coaching English, so they only count at the start of a
 * sentence.
 *
 * Measured against this file's own checker: with these in `FURNITURE`, *"Three of them are alive
 * right now, so take drake."* and *"Look at what just happened bot, rotate."* both failed — two
 * sentences that are exactly what the coach is supposed to say. A harness that fails good lines
 * teaches the reader to skip its findings, which is the habit this file exists to break.
 *
 * The heading read aloud still fails, because a heading read aloud opens the sentence: the block
 * writes `Alive right now: 5 of yours against 5 of theirs`, and the model reading it says it in
 * that order or not at all.
 */
const HEADINGS: readonly string[] = ["ground truth", "alive right now", "just happened", "enemy jungler right now"]

/** Letters only, lower-cased: `BRY-er` and `bryer` and `BRY er` all collapse to the same key. */
const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "")

/**
 * Every artefact of the block found in one spoken line, named so a human can check the call.
 *
 * Written to catch the SHAPE rather than the instance. The pronunciation guide is out of the block
 * at HEAD, so the `state.pronounce` arm finds nothing today — it is the regression guard for the
 * day it comes back, and the hyphen-and-capitals arm catches a respelling that was never in this
 * game's table at all.
 */
export const artefactsIn = (
	line: string,
	opts: { pronounce?: readonly { name: string; say: string }[]; roster?: readonly string[] } = {}
): string[] => {
	const hits: string[] = []
	const flat = letters(line)

	for (const p of opts.pronounce ?? []) {
		const say = letters(p.say)
		// A respelling shorter than four letters would collide with ordinary words.
		if (say.length >= 4 && flat.includes(say) && !flat.includes(letters(p.name)))
			hits.push(`spoke the respelling "${p.say}" instead of "${p.name}"`)
	}

	/*
	 * A respelling has a shape: hyphenated syllables with the stress in capitals. That is how
	 * `BRY-er` reached the player, and matching the shape catches one this game's table never had.
	 * A roster name is exempt (`Kai'Sa`, `Rek'Sai` survive transcription as hyphenated forms).
	 */
	const rosterFlat = new Set((opts.roster ?? []).map(letters))
	for (const m of line.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)+\b/g)) {
		const tok = m[0]
		if (!/[A-Z]{2,}/.test(tok)) continue
		if (rosterFlat.has(letters(tok))) continue
		hits.push(`respelling-shaped token "${tok}"`)
	}

	// The roster line, read out: `Briar lv12 3/2/7`.
	const kda = line.match(/\b\d+\s*\/\s*\d+\s*\/\s*\d+\b/)
	if (kda) hits.push(`spoke the K/D/A shorthand "${kda[0]}"`)
	const lv = line.match(/\blv\s?\d+/i)
	if (lv) hits.push(`spoke the level shorthand "${lv[0]}"`)

	/*
	 * Units as letters. Not strictly block furniture — the block spells its units out — but the
	 * same failure and the same fix: `52s` is heard as "fifty two seds" and `1334g` as a letter,
	 * both in real games. The prompt bans them in as many words, so a violation is measurable.
	 */
	for (const m of line.matchAll(/\b\d+(s|g|m)\b/g)) hits.push(`spoke an abbreviated unit "${m[0]}"`)

	const low = line.toLowerCase()
	for (const f of FURNITURE) if (low.includes(f)) hits.push(`spoke block furniture "${f}"`)
	for (const sentence of low.split(/(?<=[.!?])\s+/))
		for (const h of HEADINGS)
			if (sentence.trimStart().startsWith(h)) hits.push(`spoke block furniture "${h}"`)
	if (/\*\*|##|·/.test(line)) hits.push("spoke markdown from the block")
	// The control word, loose inside a sentence rather than as the whole answer.
	if (!isPass(line) && /\bPASS\b/.test(line)) hits.push('spoke the control word "PASS"')

	return hits
}

/* ============================================ 2. the CONTEXT-ONLY material */

const digitsIn = (text: string): number[] => [...text.matchAll(/\d+/g)].map(m => Number(m[0]))

/**
 * Figures that appear ONLY inside a line the block marks `CONTEXT ONLY`.
 *
 * The marker is load-bearing and it is checked here rather than assumed: `renderState` writes
 * `Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below): 40 CS
 * against 42, …`, and `42` occurs nowhere else. So a `42` in a spoken line came from the one place
 * the block told her not to take it from — which is precisely how *"your 40 farm is just behind
 * your average of 42"* was produced. `40` is excluded automatically because it is also his CS on
 * the `You:` line; the check needs no list of exceptions because the block already distinguishes
 * them.
 */
export const contextOnlyNumbers = (block: string): Set<number> => {
	const marked: string[] = []
	const rest: string[] = []
	for (const l of block.split("\n"))
		/*
		 * The metric's NAME is not one of its figures.
		 *
		 * `paceReading` writes its source as "interpolated between your measured 10/14/20-minute
		 * averages", so 10, 14 and 20 were being treated as baselines she must not speak. Measured
		 * on the real 4:52 and 5:16 blocks from the game he quit on: two findings fired on a spoken
		 * "20 CS" and printed "30 CS against 36" underneath as the evidence, because the 20 was in
		 * the label rather than in the figure. Right verdict, unreadable proof — and an unreadable
		 * proof is how a reader learns to skip the findings. Both lines are still caught, by the
		 * respelling arm and by the own-average arm.
		 *
		 * "over 23 games" in the other source phrasing has the same shape and is left alone: it is
		 * rarer, and stripping a bare number after "over" would take real figures with it.
		 */
		(l.includes("CONTEXT ONLY") ? marked : rest).push(l.replace(/\d+(?:\/\d+)*-minute/g, "-minute"))
	const elsewhere = new Set(digitsIn(rest.join("\n")))
	return new Set(digitsIn(marked.join("\n")).filter(n => !elsewhere.has(n)))
}

/**
 * A comparison against his own history, in words.
 *
 * The number rule alone is not enough, and the real transcript proves it: *"your 20 farm is not
 * pacing to match your 28 CS average"* and *"you are farming above your average of 37"* both lean
 * on figures that also appear elsewhere in the block. What makes them violations is the CLAIM —
 * an own-average comparison — when no fact in the vetted list carries one.
 */
export const claimsOwnAverage = (line: string): boolean =>
	/\byour\s+(own\s+)?(usual|average|normal|baseline)\b/i.test(line) ||
	/\b(usual|average|normal)\s+(of|is|was)\s+\d/i.test(line) ||
	/\b(above|below|behind|ahead of|match|matching|meet|meeting)\s+(your|his)\s+(own\s+)?(usual|average|normal|pace|baseline)\b/i.test(
		line
	) ||
	/\b(on|off)\s+pace\b/i.test(line) ||
	/\bpacing\b/i.test(line) ||
	/\bthan\s+(usual|normal|average)\b/i.test(line)

/** Does the vetted list itself offer a pace comparison? If it does, saying one is correct. */
export const listOffersPace = (list: readonly string[]): boolean =>
	list.some(u => /\busual\b|\baverage\b|\bpace\b/i.test(u))

/* ================================================ 3. attribution of figures */

/**
 * Cut the block at sentence boundaries before `coach-score` segments it by line.
 *
 * `blockSegments` splits on newlines and the roster's interpunct, which is right for the roster and
 * wrong for the enemy-jungler line: that whole paragraph is ONE line, it names Briar and his CS,
 * and it ends *"…so any gold figure you have belongs to the player."* — so `you` becomes a
 * co-owner of Briar's CS and `misattributed-number` can never fire on the fact most worth
 * misattributing. Splitting sentences narrows the segment to the clause that actually carries the
 * figure. It only ever makes attribution finer; no number changes hands.
 */
export const sharpenBlock = (block: string): string =>
	block
		.split("\n")
		.map(l =>
			/*
			 * A bullet in the vetted list is written ABOUT HIM and usually without saying so:
			 * `- 1400 gold sitting unspent` names no owner at all, so `blockSegments` gives it
			 * none, and quoting the one fact the block explicitly told her to quote scored as
			 * `misattributed-number`. Naming him restores the attribution the phrasing implies.
			 *
			 * It does not weaken the rule it exists for. `- 21 seconds without Briar` still names
			 * Briar too, so his timer stays his; and a bullet that names nobody else still refuses
			 * *"Briar has 1400 gold unspent"*, because Briar owns no segment carrying 1400.
			 */
			l.startsWith("- ") ? `- You, ${l.slice(2)}`
			:	l.replace(/\.\s+(?=[A-Z*])/g, ".\n")
		)
		.join("\n")

/* ============================================================ 4. the subject */

export type Subject = "objectives" | "deaths" | "gold" | "farm" | "praise" | "other"

/**
 * What a line is ABOUT, in one word.
 *
 * Order is priority, and `farm` sits below the things that expire. The point is not taxonomy, it
 * is the ratio: the transcript the owner quit on was eight farm lines out of nine, and each one of
 * them was individually true, individually grounded and individually fine. Only the pile was
 * wrong, and no per-line check can see a pile.
 *
 * A CS comparison against the enemy jungler counts as `farm`, deliberately. The block calls it the
 * most valuable line it has, and it is — but *"you are 30 CS up on Briar"* three turns out of nine
 * is the same monotony as the own-average version wearing a different noun.
 */
export const subjectOf = (line: string): Subject => {
	const t = line.toLowerCase()
	if (/\b(baron|drake|dragon|herald|grub|atakhan|turret|tower|inhibitor|nexus)\b/.test(t))
		return "objectives"
	if (/\b(dead|died|dies|down for|is down|are down|respawn|seconds without|back up|corpse)\b/.test(t))
		return "deaths"
	if (/\b(gold|unspent|spend|shop|recall|back and buy)\b/.test(t)) return "gold"
	if (/\b(cs|creep score|camps?|farm|farming|clear|clearing|minions|route|path)\b/.test(t))
		return "farm"
	if (/\b(nice|great|well done|lovely|beautiful|brilliant|proud|excellent|good (work|job))\b/.test(t))
		return "praise"
	return "other"
}

/* ================================================================= the audit */

export type CheckId =
	| "spoken-artefact"
	| "context-only"
	| "bad-figure"
	| "too-chatty"
	| "one-note"
	| "blind-turn"

export interface Finding {
	check: CheckId
	/** `null` for a whole-transcript verdict, which is most of the interesting ones. */
	clock: string | null
	atSec: number | null
	what: string
	/** The offending sentence, verbatim. Never omitted — this is the whole point of the file. */
	line: string
	/** The part of the block that contradicts it, so the call can be checked without a rerun. */
	evidence: string
}

export interface AuditOptions {
	/** Every champion that exists, for the invented-name check. From the app's own roster table. */
	champions: readonly string[]
	maxLinesPerMinute?: number
	maxWindowLines?: number
	windowSec?: number
	maxSubjectShare?: number
	/** Below this many spoken lines a share is arithmetic on noise, not a pattern. */
	minLinesForShare?: number
}

export interface AuditStats {
	turns: number
	spoken: number
	passed: number
	empty: number
	blind: number
	spanSec: number
	linesPerMinute: number
	worstWindow: { lines: number; fromSec: number }
	subjects: Record<Subject, number>
	/** Lines whose figures did not all trace to the block. */
	scored: { turn: CoachTurn; score: LineScore }[]
	/** Reported, never gated — see the note in `auditTranscript`. */
	offList: { turn: CoachTurn; numbers: number[] }[]
}

/**
 * Defaults, and why these numbers.
 *
 * The cadence is fixed at 20s by the app, so she is invited to speak three times a minute. The
 * transcript the owner shut off mid-game was **nine lines in four minutes** — 2.25 a minute, i.e.
 * she took three invitations in four. One a minute is the ceiling asserted here: it still lets her
 * speak on one turn in three, which is a great deal of talking during a game of League, and it is
 * less than half of what he refused to sit through. It is a chosen threshold and it is printed on
 * every run, so a disagreement is with a number on the screen rather than with the harness.
 */
const DEFAULTS = {
	maxLinesPerMinute: 1,
	maxWindowLines: 5,
	windowSec: 240,
	maxSubjectShare: 0.4,
	minLinesForShare: 5,
	/**
	 * Below this many turns a rate is arithmetic on one sentence.
	 *
	 * Six turns is two minutes at the app's cadence. Without the floor a single-turn probe reports
	 * "3.00 lines per minute" and fails, which would train anyone reading this harness to ignore
	 * its loudest check — the failure mode it exists to prevent.
	 */
	minTurnsForRate: 6
}

const median = (ns: number[]): number =>
	ns.length === 0 ? 0 : [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

/**
 * Every check, over a whole transcript. Pure: same turns in, same findings out, forever.
 *
 * The gates are the six the owner asked for. One more thing is computed and NOT gated: `offList`,
 * the figures that are in the block but not in the vetted list. The prompt does say *"the line you
 * speak comes from the list"*, but the clock, his own CS and the enemy jungler's line are all
 * legitimately quotable context in ways this cannot yet tell apart, so it is printed as evidence
 * for a human rather than used to fail a run.
 */
export const auditTranscript = (
	turns: readonly CoachTurn[],
	opts: AuditOptions
): { findings: Finding[]; stats: AuditStats } => {
	const cfg = { ...DEFAULTS, ...opts }
	const findings: Finding[] = []
	const spoke = spokenTurns(turns)

	/* -- 1. scaffolding ---------------------------------------------------- */
	for (const t of spoke)
		for (const hit of artefactsIn(t.text, { pronounce: t.pronounce, roster: t.roster }))
			findings.push({
				check: "spoken-artefact",
				clock: t.clock,
				atSec: t.atSec,
				what: hit,
				line: t.text,
				evidence:
					t.pronounce.length > 0 ?
						`block offered: ${t.pronounce.map(p => `${p.name} = ${p.say}`).join(" · ")}`
					:	"nothing in the block was meant to be said in that form"
			})

	/* -- 2. the CONTEXT-ONLY material -------------------------------------- */
	for (const t of spoke) {
		const contextOnly = contextOnlyNumbers(t.block)
		const marked = t.block.split("\n").filter(l => l.includes("CONTEXT ONLY")).join(" ").trim()
		for (const n of new Set(digitsIn(t.text)))
			if (contextOnly.has(n))
				findings.push({
					check: "context-only",
					clock: t.clock,
					atSec: t.atSec,
					what: `spoke ${n}, which appears only on the CONTEXT-ONLY line`,
					line: t.text,
					evidence: marked
				})
		if (claimsOwnAverage(t.text) && !listOffersPace(t.list))
			findings.push({
				check: "context-only",
				clock: t.clock,
				atSec: t.atSec,
				what: "compared him to his own average when no fact in the list offered one",
				line: t.text,
				evidence: `${marked}\n         list held: ${t.list.length === 0 ? "(empty)" : t.list.join(" | ")}`
			})
	}

	/* -- 3. every figure, and whose it is ---------------------------------- */
	const scored: { turn: CoachTurn; score: LineScore }[] = []
	for (const t of spoke) {
		const score = scoreLine({
			line: t.text,
			block: sharpenBlock(t.block),
			roster: t.roster,
			champions: opts.champions
		})
		scored.push({ turn: t, score })
		if (score.unbackedNumbers.length > 0)
			findings.push({
				check: "bad-figure",
				clock: t.clock,
				atSec: t.atSec,
				what: `${score.unbackedNumbers.join(", ")} appear nowhere in the block`,
				line: t.text,
				evidence: `block figures: ${[...new Set(digitsIn(t.block))].sort((a, b) => a - b).join(" ")}`
			})
		for (const m of score.misattributed)
			findings.push({
				check: "bad-figure",
				clock: t.clock,
				atSec: t.atSec,
				what: `${m.value} is in the block, but not as ${m.claimedOwner === "you" ? "his" : `${m.claimedOwner}'s`}`,
				line: t.text,
				evidence: t.block.split("\n").filter(l => l.includes(String(m.value))).join("\n         ")
			})
		if (score.inventedChampions.length > 0)
			findings.push({
				check: "bad-figure",
				clock: t.clock,
				atSec: t.atSec,
				what: `named ${score.inventedChampions.join(", ")}, not in this game`,
				line: t.text,
				evidence: `roster: ${t.roster.join(", ")}`
			})
	}

	/* -- 4. how much she talked -------------------------------------------- */
	const times = turns.map(t => t.atSec)
	const gaps: number[] = []
	for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
	const gap = gaps.length > 0 ? median(gaps) : 20
	const spanSec =
		times.length === 0 ? 0 : Math.max(...times) - Math.min(...times) + gap
	const linesPerMinute = spanSec > 0 ? spoke.length / (spanSec / 60) : 0

	let worstWindow = { lines: 0, fromSec: 0 }
	for (const t of turns) {
		const n = spoke.filter(s => s.atSec >= t.atSec && s.atSec < t.atSec + cfg.windowSec).length
		if (n > worstWindow.lines) worstWindow = { lines: n, fromSec: t.atSec }
	}

	const quoteAll = (rows: readonly CoachTurn[]): string =>
		rows.map(s => `${s.clock.padStart(5)}  ${s.text}`).join("\n         ")

	const rateIsMeaningful = turns.length >= cfg.minTurnsForRate
	if (rateIsMeaningful && linesPerMinute > cfg.maxLinesPerMinute)
		findings.push({
			check: "too-chatty",
			clock: null,
			atSec: null,
			what: `${linesPerMinute.toFixed(2)} spoken lines per minute, ceiling ${cfg.maxLinesPerMinute} (${spoke.length} lines over ${Math.round(spanSec / 60)} minutes of game clock)`,
			line: quoteAll(spoke),
			evidence: `${turns.length} turns offered, ${turns.length - spoke.length} of them declined`
		})

	if (rateIsMeaningful && worstWindow.lines > cfg.maxWindowLines) {
		const from = worstWindow.fromSec
		const inWindow = spoke.filter(s => s.atSec >= from && s.atSec < from + cfg.windowSec)
		findings.push({
			check: "too-chatty",
			clock: null,
			atSec: from,
			what: `${worstWindow.lines} lines inside ${Math.round(cfg.windowSec / 60)} minutes from ${Math.floor(from / 60)}:${String(Math.floor(from % 60)).padStart(2, "0")}, ceiling ${cfg.maxWindowLines}`,
			line: quoteAll(inWindow),
			evidence: "he shut the coach off nine lines into four minutes"
		})
	}

	/* -- 5. what she talked about ------------------------------------------ */
	const subjects: Record<Subject, number> = {
		objectives: 0,
		deaths: 0,
		gold: 0,
		farm: 0,
		praise: 0,
		other: 0
	}
	for (const t of spoke) subjects[subjectOf(t.text)] += 1
	if (spoke.length >= cfg.minLinesForShare)
		for (const [subject, n] of Object.entries(subjects) as [Subject, number][]) {
			const share = n / spoke.length
			if (share > cfg.maxSubjectShare)
				findings.push({
					check: "one-note",
					clock: null,
					atSec: null,
					what: `${Math.round(share * 100)}% of spoken lines were about ${subject} (${n}/${spoke.length}), ceiling ${Math.round(cfg.maxSubjectShare * 100)}%`,
					line: quoteAll(spoke.filter(s => subjectOf(s.text) === subject)),
					evidence: (Object.entries(subjects) as [Subject, number][])
						.filter(([, k]) => k > 0)
						.map(([s, k]) => `${s} ${k}`)
						.join(" · ")
				})
		}

	/* -- 6. a turn with no picture ----------------------------------------- */
	const blind = turns.filter(t => !t.hadFrame)
	if (blind.length > 0) {
		const spokeBlind = blind.filter(t => !isPass(t.text) && !isEmpty(t.text))
		findings.push({
			check: "blind-turn",
			clock: null,
			atSec: null,
			what: `${blind.length} of ${turns.length} turns went out with no picture — she was coaching from the block alone`,
			/*
			 * A stated absence rather than an empty quote.
			 *
			 * Measured on the first real run of this file: 2 of 18 turns were blind, she declined
			 * both, and the finding printed a bare `""` under the headline. A quotation mark with
			 * nothing in it reads as a harness bug and invites the reader to dismiss the finding —
			 * which is the failure mode this whole file exists to prevent, arriving through the
			 * front door. The turn is still a finding: it cost a request, and she answered it
			 * holding nothing but the block.
			 */
			line:
				spokeBlind.length > 0 ?
					quoteAll(spokeBlind)
				:	"(she said nothing on any blind turn — but each one was still answered from the block alone)",
			evidence: `blind at: ${blind.map(t => t.clock).join(", ")}`
		})
	}

	/* -- reported, not gated ------------------------------------------------ */
	const offList: { turn: CoachTurn; numbers: number[] }[] = []
	for (const t of spoke) {
		const inList = new Set(digitsIn(t.list.join(" ")))
		const spokenNums = [...new Set(digitsIn(t.text))].filter(n => n >= 10 && !inList.has(n))
		if (spokenNums.length > 0) offList.push({ turn: t, numbers: spokenNums })
	}

	return {
		findings,
		stats: {
			turns: turns.length,
			spoken: spoke.length,
			passed: turns.filter(t => isPass(t.text)).length,
			empty: turns.filter(t => isEmpty(t.text)).length,
			blind: blind.length,
			spanSec,
			linesPerMinute,
			worstWindow,
			subjects,
			scored,
			offList
		}
	}
}

/* ================================================================ reporting */

const clockOf = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/**
 * Print the run, then the findings, then the verdict.
 *
 * The transcript comes FIRST and in full, always, including on a pass. Reading the sentences is
 * the only way anyone would have caught these; a summary that replaces them recreates the exact
 * conditions under which three defects shipped.
 */
export const report = (
	turns: readonly CoachTurn[],
	audit: ReturnType<typeof auditTranscript>,
	verbose: boolean
): void => {
	const { findings, stats } = audit
	console.log(`\n=== transcript: ${stats.turns} turns, ${stats.spoken} spoken ===\n`)
	for (const t of turns) {
		const flags = findings.filter(f => f.atSec === t.atSec && f.clock !== null).map(f => f.check)
		const mark = !t.hadFrame ? "BLIND" : flags.length > 0 ? "FAIL " : "     "
		const said = isEmpty(t.text) ? "(nothing came back)" : t.text
		console.log(`${mark} ${t.clock.padStart(5)} ${String(t.ms).padStart(5)}ms  ${said}`)
		if (verbose)
			console.log(
				`             list: ${t.list.length === 0 ? "(empty)" : t.list.join(" | ")}`
			)
	}

	console.log(`\n--- what she talked about ---`)
	for (const [s, n] of Object.entries(stats.subjects))
		if (n > 0)
			console.log(
				`  ${s.padEnd(11)} ${String(n).padStart(3)}  ${Math.round((100 * n) / (stats.spoken || 1))}%`
			)
	console.log(
		`\n  spoken lines/minute  ${stats.linesPerMinute.toFixed(2)} over ${Math.round(stats.spanSec / 60)} minutes of game clock`
	)
	console.log(
		`  busiest 4 minutes    ${stats.worstWindow.lines} lines from ${clockOf(stats.worstWindow.fromSec)}`
	)
	console.log(`  declined (PASS)      ${stats.passed}`)
	console.log(`  nothing came back    ${stats.empty}`)
	console.log(`  turns with a picture ${stats.turns - stats.blind}/${stats.turns}`)

	if (stats.offList.length > 0) {
		console.log(
			`\n--- figures spoken that were NOT in the vetted list (reported, not a failure) ---`
		)
		for (const o of stats.offList)
			console.log(`  ${o.turn.clock.padStart(5)}  ${o.numbers.join(", ")}  ${o.turn.text}`)
	}

	if (findings.length === 0) {
		console.log(`\n=== PASSED: no findings across ${stats.spoken} spoken lines ===\n`)
		return
	}

	const byCheck = new Map<CheckId, Finding[]>()
	for (const f of findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f])
	console.log(`\n=== FAILED: ${findings.length} findings in ${byCheck.size} checks ===`)
	for (const [check, fs] of byCheck) {
		console.log(`\n[${check}] ${fs.length}`)
		for (const f of fs) {
			console.log(`  ${f.clock === null ? "     " : f.clock.padStart(5)}  ${f.what}`)
			console.log(`         "${f.line}"`)
			if (f.evidence !== "") console.log(`         ${f.evidence}`)
		}
	}
	console.log("")
}

/* ==================================================================== main */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}
const flag = (name: string): boolean => argv.includes(`--${name}`)

/**
 * Pair each state with the journal's own screenshot of that instant.
 *
 * The journal names a frame `<session>-<gameTimeSec*10>.jpg`, so the game clock is in the filename
 * and no database read is needed.
 *
 * ## The clock alone is not enough, and finding out why is itself a finding
 *
 * One journal session on this machine spans **eleven and a half hours and four games**: the
 * session never rolled, so every game wrote `…-6000.jpg` over the previous game's `…-6000.jpg`.
 * Matching on the filename alone would therefore have handed the model a picture of a different
 * match, confidently, and a harness that feeds a mismatched frame is worse than one that feeds
 * none — it would score the coach for not reading a screen it was never shown.
 *
 * So a frame must agree on BOTH clocks: the game clock in its name, and its own mtime against the
 * WALL clock stamped on the sample. An overwritten frame fails the second test and the turn is
 * recorded blind, which is reported rather than hidden.
 */
const frameIndex = async (
	dir: string,
	session: string
): Promise<{ tenths: number; path: string; mtimeMs: number }[]> => {
	const { existsSync, readdirSync, statSync } = await import("node:fs")
	const d = `${dir}/journal/${session}`
	if (!existsSync(d)) return []
	return readdirSync(d)
		.filter(f => f.endsWith(".jpg"))
		.map(f => ({
			tenths: Number(f.replace(`${session}-`, "").replace(".jpg", "")),
			path: `${d}/${f}`,
			mtimeMs: statSync(`${d}/${f}`).mtimeMs
		}))
		.filter(f => Number.isFinite(f.tenths))
		.sort((a, b) => a.tenths - b.tenths)
}

const FRAME_TOLERANCE_SEC = 4
/** How far a frame's own write time may sit from the sample's before it is a different game. */
const FRAME_WALL_TOLERANCE_MS = 6_000

/**
 * Cut a sample file into the games it actually holds.
 *
 * `live-sampler.ts` appends every game to a file named after the JOURNAL SESSION, and that session
 * does not roll between games — so one file here holds four. Replaying across a boundary would
 * carry one game's roster into the next, which is the single failure this whole app is built to
 * prevent, so it is split on the sampler's own signal: a backwards jump in the game clock.
 */
export const splitRuns = <T extends { gameTime: number }>(rows: readonly T[]): T[][] => {
	const runs: T[][] = []
	let last = Infinity
	for (const r of rows) {
		if (runs.length === 0 || r.gameTime < last - 30) runs.push([])
		runs[runs.length - 1]!.push(r)
		last = r.gameTime
	}
	return runs
}

const main = async (): Promise<void> => {
	/*
	 * The data directory is chosen BEFORE anything that reads it is imported: `shared/constants.ts`
	 * resolves `DATA_DIR` once, at module evaluation, from the working directory. A static import
	 * would have fixed it to the checkout this script happens to live in, which in a worktree holds
	 * no samples, no journal and no database.
	 */
	const data = arg("data", "")
	if (data !== "") process.env.EEPALYTICS_DATA_DIR = data.replace(/^~/, process.env.HOME ?? "~")

	const replayPath = arg("replay", "")
	const { DATA_DIR, DB_PATH } = await import("../src/shared/constants.ts")
	const { DatabaseSync } = await import("node:sqlite")
	const { readFileSync, writeFileSync } = await import("node:fs")

	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const champions = db
		.prepare("SELECT DISTINCT championName FROM participant WHERE championName IS NOT NULL")
		.all()
		.map(r => String((r as { championName: string }).championName))

	const audit = (turns: CoachTurn[]) =>
		auditTranscript(turns, {
			champions,
			maxLinesPerMinute: Number(arg("max-lpm", String(DEFAULTS.maxLinesPerMinute))),
			maxWindowLines: Number(arg("max-window", String(DEFAULTS.maxWindowLines))),
			maxSubjectShare: Number(arg("max-share", String(DEFAULTS.maxSubjectShare)))
		})

	if (replayPath !== "") {
		const saved = JSON.parse(readFileSync(replayPath, "utf8")) as { turns: CoachTurn[] }
		/*
		 * An empty record is not a pass.
		 *
		 * `report` on zero turns prints "PASSED: no findings across 0 spoken lines" and the process
		 * exits 0 — a green verdict over a file that measured nothing, which is how a truncated or
		 * mis-pathed run gets mistaken for a clean one.
		 */
		if (!Array.isArray(saved.turns) || saved.turns.length === 0)
			throw new Error(`${replayPath} holds no turns — nothing to score`)
		const result = audit(saved.turns)
		report(saved.turns, result, flag("verbose"))
		process.exit(result.findings.length === 0 ? 0 : 1)
	}

	/* -- the states, from the daemon's own path ---------------------------- */
	const { readSamples, sampledGames } = await import("../src/daemon/live-sampler.ts")
	const { buildLiveStateForBench } = await import("../src/server/routes/live.ts")
	const { paceReading } = await import("../src/analysis/live-coach.ts")
	const { baselineFromRows, perGameMetrics } = await import("../src/analysis/index.ts")
	const { loadCorpus } = await import("../src/daemon/corpus.ts")

	const gameId = arg("game", "") || (sampledGames()[0]?.gameId ?? "")
	if (gameId === "")
		throw new Error(
			`no live samples under ${DATA_DIR}/live-samples — play a game with the daemon running, or pass --data`
		)
	const all = readSamples(gameId)
	if (all.length === 0) throw new Error(`no samples for ${gameId}`)
	const runs = splitRuns(all)
	console.error(`${gameId}: ${runs.length} game(s) in the sample file`)
	for (const [i, r] of runs.entries())
		console.error(
			`  run ${i + 1}: ${r.length} samples, ${clockOf(r[0]!.gameTime)} to ${clockOf(r[r.length - 1]!.gameTime)}`
		)
	const runIndex = Number(arg("run", String(runs.length)))
	const samples = runs[runIndex - 1]
	if (!samples) throw new Error(`no run ${runIndex}; the file holds ${runs.length}`)
	console.error(`replaying run ${runIndex}`)

	const every = Number(arg("every", "20"))
	const from = Number(arg("from", "0")) * 60
	const to = Number(arg("to", "999")) * 60
	const limit = Number(arg("turns", "0"))

	/*
	 * Selection happens BEFORE any state is built, and that is not a detail.
	 *
	 * `buildLiveState` consumes announce-once memory — each death announced once, gold once per
	 * step. Building a state for a sample that is never sent would spend those announcements on a
	 * turn the model never sees, so the replay would be quieter than the real game for a reason
	 * that has nothing to do with the coach. One built state per turn actually taken.
	 */
	const picked: { atSec: number; atMs: number; raw: unknown }[] = []
	let nextAt = -Infinity
	for (const s of samples) {
		if (s.gameTime < from || s.gameTime > to) continue
		if (s.gameTime < nextAt) continue
		nextAt = s.gameTime + every
		picked.push({ atSec: s.gameTime, atMs: s.atMs, raw: s.data })
		if (limit > 0 && picked.length >= limit) break
	}

	const baseline = baselineFromRows(perGameMetrics(loadCorpus(40)))
	const frames = await frameIndex(DATA_DIR, gameId)

	const built: { atSec: number; state: VisionState; block: string; frame: string | null }[] = []
	let unbuildable = 0
	for (const p of picked) {
		const st = buildLiveStateForBench(p.raw, p.atSec)
		if (st === null) {
			// Silently shrinking the run is how a harness reports a rate over a game it never
			// replayed. Counted here and printed below with the turn count.
			unbuildable += 1
			continue
		}
		/*
		 * The baseline, grafted back on.
		 *
		 * `buildLiveStateForBench` hands `buildLiveState` a null baseline, so `pace` is null and the
		 * block renders the "NONE" branch — which means the replay could not reproduce the farm leak
		 * at all, the second of the three defects this file exists to catch. This recomputes `pace`
		 * exactly as `buildLiveState` does, from his real corpus, and puts it back.
		 *
		 * The asymmetry is stated rather than hidden: `buildFacts` inside the daemon still ran with
		 * no pace, so the vetted list here never carries a farm fact. That makes the CONTEXT-ONLY
		 * check STRICTER than production on the turns where `buildFacts` would have offered one —
		 * and it is the common case regardless, since the farm fact is rate-limited to once every
		 * three minutes. The proper fix is a `baseline` parameter on `buildLiveStateForBench`; see
		 * the report accompanying this file.
		 */
		st.pace = paceReading({
			live: {
				gameTimeSec: p.atSec,
				championName: st.me.champion,
				cs: st.me.cs ?? 0,
				deaths: st.me.d ?? 0,
				kills: st.me.k ?? 0,
				assists: st.me.a ?? 0,
				level: st.me.level ?? 0,
				observed: { dragonSec: null, baronSec: null, heraldSec: null }
			},
			baseline,
			focus: []
		})
		const want = Math.round(p.atSec * 10)
		const near = frames.find(
			f =>
				Math.abs(f.tenths - want) <= FRAME_TOLERANCE_SEC * 10 &&
				Math.abs(f.mtimeMs - p.atMs) <= FRAME_WALL_TOLERANCE_MS
		)
		built.push({
			atSec: p.atSec,
			state: st,
			block: renderState(st),
			frame: flag("no-frame") || !near ? null : readFileSync(near.path).toString("base64")
		})
	}

	if (built.length === 0) throw new Error(`no reconstructable states in ${gameId}`)

	if (flag("dump")) {
		for (const b of built) {
			console.log(`\n----- ${b.state.clock} ${b.frame === null ? "(NO FRAME)" : ""} -----`)
			console.log(b.block)
		}
		return
	}

	const withPictures = built.filter(b => b.frame !== null).length
	console.error(
		`game ${gameId}: ${built.length} turns every ${every}s, ${withPictures} with a real frame${
			unbuildable > 0 ? `, ${unbuildable} sample(s) built no state and were dropped` : ""
		}`
	)

	/* -- the shipped socket ------------------------------------------------- */
	const { mintGeminiToken } = await import("../src/review/gemini-live.ts")
	const minted = await mintGeminiToken()
	if (!minted.ok) throw new Error(minted.error)

	const turns = await new Promise<CoachTurn[]>((resolve, reject) => {
		const ws = new WebSocket(
			`${minted.value.wsUrl}?access_token=${encodeURIComponent(minted.value.token)}`
		)
		const out: CoachTurn[] = []
		const queue = [...built]
		let current: (typeof built)[number] | null = null
		let sentAt = 0
		let partial = ""

		const next = () => {
			const item = queue.shift()
			if (item === undefined) {
				ws.close(1000)
				resolve(out)
				return
			}
			current = item
			sentAt = Date.now()
			/*
			 * Frame INSIDE the turn, exactly as `geminiLive.ts` sends it. Measured there over eight
			 * turns on one socket: streaming through `realtimeInput.video` silenced the audio and
			 * made the model name champions who were not on screen, 6/6 wrong. A harness using the
			 * other shape would be testing a path nothing runs.
			 */
			const parts: unknown[] = []
			if (item.frame !== null)
				parts.push({ inlineData: { mimeType: "image/jpeg", data: item.frame } })
			parts.push({ text: item.block })
			ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: minted.value.model,
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
			if (sc.turnComplete && current) {
				const s = current.state
				out.push({
					gameId,
					atSec: current.atSec,
					clock: s.clock,
					block: current.block,
					pronounce: s.pronounce,
					list: s.unseen,
					roster: [s.me.champion, ...s.allies.map(p => p.champion), ...s.enemies.map(p => p.champion)],
					text: partial.trim(),
					hadFrame: current.frame !== null,
					ms: Date.now() - sentAt
				})
				process.stderr.write(".")
				partial = ""
				next()
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => {
			if (e.code !== 1000 && out.length === 0)
				reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 200)}`))
			else resolve(out)
		}
		// Generous, and per turn: a stalled socket must end the run rather than hang a CI job.
		setTimeout(() => {
			ws.close()
			resolve(out)
		}, 20_000 * built.length + 60_000)
	})

	process.stderr.write("\n")
	/*
	 * A short run FAILS, rather than printing a note above a green verdict.
	 *
	 * `ws.onclose` resolves with whatever arrived when the socket dies mid-run, and the per-turn
	 * timeout does the same. Before this, three clean turns out of eighteen exited 0 with the
	 * warning scrolled off the top — a silent pass on a run that measured almost nothing, which is
	 * the exact shape of failure this whole file was written against.
	 */
	const truncated = turns.length < built.length
	if (truncated)
		console.log(
			`\n!! the socket answered ${turns.length} of ${built.length} turns — these numbers are incomplete`
		)

	const outPath = arg("out", "")
	if (outPath !== "") {
		writeFileSync(outPath, JSON.stringify({ at: Date.now(), gameId, turns }, null, 2))
		console.error(`wrote ${outPath}`)
	}

	const result = audit(turns)
	report(turns, result, flag("verbose"))
	process.exit(result.findings.length === 0 && !truncated ? 0 : 1)
}

/*
 * Guarded, because the checks above are imported by `src/analysis/coach-transcript.test.ts`.
 * An unguarded `await main()` would open a socket every time the suite runs.
 */
if (import.meta.main) await main()
