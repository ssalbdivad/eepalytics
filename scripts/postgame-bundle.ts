/**
 * FREEZE the post-game review input, once, so every model arm reads the same bytes.
 *
 * ## Why a frozen bundle rather than a shared function
 *
 * The live coach scored 0/10 on game 5639406342 — "generic and often hilariously wrong". The
 * post-game pass has the opposite budget: the whole game at once, positions, and no clock. What
 * we want to learn is which MODEL uses that budget best, and that only works if the models are
 * the only thing that varies. This repo has already made the other mistake once: `bench-providers`
 * used to rebuild states from the post-game timeline, so a comparison that looked like a model
 * comparison was measuring how well each model improvised over a starved input.
 *
 * A shared builder function is not enough, because a builder re-reads the world: the journal
 * directory grows, `knowledge/*.md` is edited between runs by design, and the minimap track can be
 * regenerated. Two arms run an hour apart would then differ in their inputs and nobody would know.
 * So the bundle is written to disk ONCE and `manifest.json` carries a sha256 of every file in it,
 * including each selected JPEG. A later run proves the arms saw the same bytes or it proves they
 * did not; there is no third answer.
 *
 * ## What is in it, and why each piece is separate
 *
 * Seven files, because an arm may have to drop one and we want to know which:
 *
 *   prompt.txt     the review instructions — identical for every arm, truth rules verbatim
 *   pack.txt       the whole game, rendered  (the big one; see the trim note below)
 *   pack-trimmed.txt  the same with FRAME INDEX dropped, for an arm that cannot hold pack.txt
 *   knowledge.txt  Lillia's file + the role file, through `fullKnowledge`
 *   positions.txt  the minimap track joined to the clock, with its measured error stated
 *   heard.txt      the 62 lines the live coach actually said
 *   frames.json    12-16 frames chosen at DECISION MOMENTS, with what the pack says happened
 *   manifest.json  sha256 of all of the above and of every referenced JPEG
 *
 * ## Frames are chosen from the event log, never by even spacing
 *
 * Even spacing puts a picture on the walk between camps and misses the fight. The selector below
 * scores candidates off `pack.events` — his deaths first, then neutral objectives, then the two
 * moments he beat the counterpart — and each one carries the pack's own sentence about what was
 * happening, so the picture and the prose cannot drift apart. `--frames` caps the count; 16 is the
 * default because 16 frames at 1536x864 is about 28K image tokens, which is already a third of the
 * turn.
 *
 * ## The truth rules are copied, not paraphrased
 *
 * They are in `TRUTH_RULES` below as one string and they go into `prompt.txt` verbatim. They are
 * constraints on what may be ASSERTED — fog-gating, flooring, unreported enemy gold, silent
 * stretches of the position track — and not one of them says what to coach or when. That split is
 * deliberate: the arms are being graded on judgment, so guardrails on judgment would grade the
 * harness instead.
 *
 * Run: node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *        scripts/postgame-bundle.ts [--frames 16] [--out data/eval/bundle-5639406342]
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"

const GAME_ID = 5639406342
const SESSION = "js-mtvxb5f4-f81a"
const REPO = resolve(import.meta.dirname, "..")

const arg = (flag: string, fallback: string): string => {
	const at = process.argv.indexOf(flag)
	return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const OUT = resolve(REPO, arg("--out", `data/eval/bundle-${GAME_ID}`))
const FRAME_CAP = Number(arg("--frames", "16"))

const PACK_TXT = join(REPO, `data/eval/pack-${GAME_ID}.txt`)
const PACK_JSON = join(REPO, `data/eval/pack-${GAME_ID}.json`)
const TRACK = join(REPO, `data/eval/minimap-track/${SESSION}.json`)
const HANDLABELS = join(REPO, `data/eval/minimap-track/${SESSION}-handlabels.json`)

const clock = (tSec: number): string => `${Math.floor(tSec / 60)}:${String(Math.floor(tSec % 60)).padStart(2, "0")}`

/* ─────────────────────────────────────────────────────────────────────────────
   1 — prompt.txt
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Constraints on what may be ASSERTED. Copied into the prompt verbatim; nothing here tells the
 * model what to coach, because that is the thing being compared.
 */
const TRUTH_RULES = `TRUTH RULES — these bind every sentence you write. They constrain what you may
ASSERT. They do not constrain what you choose to coach; that judgment is yours.

1. EVERY FIGURE COMES FROM THE PACK. Nothing is estimated, nothing is rounded to sound
   better, nothing is recalled from what you know about League. If a number is not in
   these files, it does not go in your review. A baseline is copied digit for digit from
   the line it appears on — do not derive one by subtracting a delta, and do not round it.

2. THE COUNTERPART HAS TWO SETS OF FIGURES AND ONLY ONE OF THEM IS HIM.

   Under TRUTH the pack now carries the INGESTED POST-GAME TIMELINE, which is exact for
   all ten players. Kayn's CS, level, gold and position there are what actually happened.
   Cite them straight, with no hedge — hedging a number that is exact is its own kind of
   wrong, because it teaches him to discount the figures that are solid.

   Under "client showed" the pack carries what this client WITNESSED, and for CS that is
   a DIFFERENT QUANTITY, not a stale one: it counts only the farm your own client saw him
   take. Measured on this game it read 70 where the truth was 183. NEVER quote it as his
   farm, and never compare it with Lillia's CS. It is a measurement of the client.

   This rule was the other way round for the run that produced the two items he graded
   FALSE. The pack was feed-sourced then, so "Kayn's CS" meant the visibility counter, and
   a review that dutifully cited it told him he was +71 and +92 up on a man he was level
   with all game. The fix is upstream — the pack is timeline-sourced now — and this rule
   changes with it rather than being left to contradict the file it describes.

3. CS IS FLOORED TO TENS FOR EVERYONE, INCLUDING HIM. A CS gap is therefore a RANGE, not
   a digit: a stated difference of 10 is anywhere from 1 to 19. Quote gaps as ranges or as
   "at least". His own exact end-of-game CS (165) comes from the ingested match and is the
   one exception; the per-minute spine figures are floored.

4. ENEMY GOLD IN HAND IS NOT REPORTED. There is no gold field for anyone but him. What an
   enemy has SPENT is knowable from his item list with prices — and even that is a FLOOR,
   because the feed's price is the combine cost, not the full build cost.

5. POSITIONS COME FROM THE MINIMAP TRACK AND CARRY ITS CONFIDENCE. Use the confidence and
   the gap that each read carries. WHERE THE TRACK IS SILENT, NOBODY KNOWS WHERE ANYONE
   WAS — do not fill it in, do not infer it from what happened next. The track reads HIS
   icon and unlabelled red rings: it cannot tell you a ring is Kayn, so the counterpart's
   position is UNKNOWN at every instant of this game. Not missing. Unknowable.

6. NEVER ATTACK THE PLAYER OR NAME A TEAMMATE AS THE PROBLEM. Teammates' figures are
   context you may cite; they are not the subject.`

const promptText = (): string => `POST-GAME REVIEW — game ${GAME_ID}

WHO THIS IS FOR
One player: Gooskaffur#NA1, NA1, a jungle main. He plays jungle in every game on record.
He is reviewing his own game and he will read this once, after the fact, on a screen with
nothing else on it. He is not in a hurry and he is not in a game.

WHAT HE PLAYED
Lillia, JUNGLE. LOSS in 28:14, patch 16.18, ranked solo (queue 420).
End of game, from the ingested match and therefore exact: 5/7/4, 165 CS (23 lane +
142 jungle), 11,142 gold, vision score 16, level 14, 16,465 damage to champions.
His counterpart — the jungler he was racing — was KAYN.
His team: Urgot top, Lillia jungle, Yone mid, Xayah bot, Morgana support.
The enemy: Ornn top, Kayn jungle, Singed mid, Draven bot, Lulu support.

THIS IS A POST-GAME REVIEW. THERE IS NO CLOCK.
Nothing here is spoken aloud and nothing here has to be short enough to hear. You have the
whole game at once: every minute of state, every event, a position track, the frames, and a
transcript of what a live coach said to him while he played. Take the time to actually read
it. You may reason as long as you like before you write.

The live coach that talked to him during THIS game scored 0/10 from him — "nothing it said
was useful, it was generic and often hilariously wrong". It spoke every ~20 seconds with
nothing new to say, so it read his own HUD back to him ("I see you have 975 gold") and told
him to take Rift Herald eight times across six minutes because it could not see the map.
heard.txt is that transcript. You are allowed to say what should have been said instead.

WHAT A GOOD ITEM IS
Four things, all four, or it is not an item:

  1. A TIMESTAMP. The game clock it points at, M:SS. An item anchored to a moment can be
     turned into a clip; an item anchored to nothing is an opinion.
  2. A REAL NUMBER, from the pack, cited where he can see it. "Down to 80 CS at 15:36
     against his own average of 101.4" — not "behind on farm".
  3. ONE IMPERATIVE FIX. A single sentence naming the thing to do differently, with a
     trigger he can notice mid-game. If you cannot say it in one sentence you have not
     worked out what the fix is.
  4. SOMETHING HE COULD NOT HAVE KNOWN BY LOOKING AT HIS OWN SCREEN DURING THE GAME.
     This is the test the live coach failed 62 times. His gold, his HP, his CS, his
     cooldowns and who just died were all on his screen. What was NOT on his screen: where
     he actually was when each objective fell, what his own pattern across this game looks
     like from above, how his figures compare to his own 20-game averages, what the shape
     of the game was before it ended, and what he did at 8:00 that he did again at 24:20.
     If an item would have been just as true said out loud at the time, cut it.

A fifth thing, not required but worth more than any of the four: an item that could ONLY be
written about this game. If your item would survive being pasted onto a different game of
his, it is padding — delete it and find the one that would not.

Write FEWER, BETTER items. Whatever number you think is right, the shorter list is usually
the better review. At least one of them should be something he did WELL, if the data
supports one; a review that is only criticism is a bad review even when every line is true.

${TRUTH_RULES}

WHAT YOU HAVE BEEN GIVEN
  pack.txt       The whole game: a per-minute spine (his state, the counterpart's as last
                 seen, both teams), every objective with where he was when it fell, the
                 full event log, the position track, his 20-game baselines, the live
                 transcript, and a section on the feed's own properties. Read that last
                 section — THE FEED'S PROPERTIES — before you quote any number.
  knowledge.txt  Champion and role notes. These are NOT measured from his game: they may
                 shape a fix and may never become a number, a timestamp, or a claim about
                 what happened. If they disagree with the pack, the pack wins. Absorb them;
                 never say "the notes say".
  positions.txt  The minimap track, joined to the clock, with its measured error rate.
  heard.txt      The 62 lines the live coach said, with clocks.
  frames.json    The frames you were sent, each with its clock and what was happening.
                 The images themselves are in this turn, in the order frames.json lists.

OUTPUT
Write the review. Lead with a one-line headline that carries a real number. Then the items,
best first, each with its clock, its number, and its one-sentence fix. Then at most three
goals for his next game, each checkable by a human. Plain prose or markdown; no JSON.\n`

/* ─────────────────────────────────────────────────────────────────────────────
   2 — positions.txt
   ───────────────────────────────────────────────────────────────────────── */

interface Track {
	meta: Record<string, unknown> & { reads: number; ok: number; everySec: number; model: string; upscale: number; crop: { w: number; h: number } }
	entries: {
		tSec: number
		frameId: string
		read: { you: { pct: { left: number; top: number }; label: string; coarse: string }; enemies: unknown[]; activity: string } | null
	}[]
}

/**
 * The reader's error, re-derived from the ten hand labels stored beside the track.
 *
 * Stated rather than recalled, and stated NEXT TO the prior benchmark it disagrees with, because
 * a model weighing a position needs to know both that this game's own hand-check came out tighter
 * (1.8% median over 10) and that the reader's standing figure is 3% over 18. The smaller number is
 * from the smaller sample; neither is dressed up as the other.
 */
const readerError = (track: Track): { median: number; worst: number; n: number; halves: string } => {
	const labels = JSON.parse(readFileSync(HANDLABELS, "utf8")).labels as { frameId: string; left: number; top: number }[]
	const byId = new Map(track.entries.map(e => [e.frameId, e]))
	const errs: number[] = []
	let halfOk = 0
	for (const l of labels) {
		const e = byId.get(l.frameId)
		if (!e?.read?.you) continue
		const p = e.read.you.pct
		errs.push(Math.hypot(p.left - l.left, p.top - l.top))
		// "His own half" is the diagonal: blue base is bottom-left, so left + (100 - top) < 100.
		if ((p.left + (100 - p.top) < 100) === (l.left + (100 - l.top) < 100)) halfOk++
	}
	errs.sort((a, b) => a - b)
	if (errs.length === 0) throw new Error(`${HANDLABELS} produced no comparable labels — the track and the labels disagree on frame ids`)
	return {
		median: errs[Math.floor(errs.length / 2)]!,
		worst: errs[errs.length - 1]!,
		n: errs.length,
		halves: `${halfOk}/${errs.length}`
	}
}

const positionsText = (pack: any, track: Track): string => {
	const err = readerError(track)
	const reads = pack.positionTrack.reads as any[]

	const rows = reads.map(r => {
		const hand = r.handChecked ? `  HAND-CHECKED (${r.handErrorPct}% off)` : ""
		const rings = r.enemyRingLabels?.length ? `${r.enemyRings} in ${r.enemyRingLabels.join(", ")}` : "none"
		return `${r.clock.padEnd(7)} ${r.label.padEnd(30)} ${(`${r.pct.left},${r.pct.top}`).padEnd(13)} ${String(r.activity ?? "").padEnd(9)} ${rings}${hand}`
	})

	// The gaps are the point: a reader that returns nothing for 90s is a reader that must be
	// allowed to say nothing, and a model needs the gaps in front of it to honour rule 5.
	const gaps: string[] = []
	for (let i = 1; i < reads.length; i++) {
		const d = reads[i].tSec - reads[i - 1].tSec
		if (d >= 45) gaps.push(`  ${reads[i - 1].clock} → ${reads[i].clock}  ${Math.round(d)}s with no read`)
	}

	return `THE POSITION TRACK — game ${GAME_ID}, session ${SESSION}

WHAT THIS IS
The live feed contains NO position for anybody, including him. This track is the hole being
filled from the other side: every ~${track.meta.everySec}s of game clock a ${track.meta.crop.w}x${track.meta.crop.h} crop of the minimap was cut
from the journal frame, upscaled ${track.meta.upscale}x, and read by ${track.meta.model} through the shipped reader
(src/review/read-minimap.ts). ${track.meta.reads} reads were attempted; ${track.meta.ok} passed the shipped fence, and ${reads.length}
of those returned a position for him. The rest returned nothing and are not in this table.

HOW WRONG IT IS — measured, twice, and the two do not match
  This game, hand-checked: a human opened ${err.n} of the upscaled crops, found his icon and read
  its centre. Median disagreement ${err.median.toFixed(1)}% of the map, WORST of the ten ${err.worst.toFixed(1)}%, and his own
  HALF of the map correct ${err.halves}. Ten is a small sample and the median of ten is a weak
  statistic — it is reported because it is what was actually checked, not because it settles
  anything. The human's own eyeball is worth about +/-1.5%, so a disagreement under that is
  not a disagreement.
  The reader's standing benchmark: 3% median position error, and his own half of the map
  right 94% of the time (17 of 18 reads). That is a different, earlier sample.
  Use the larger of the two if you are deciding whether to make a claim. Both say the same
  thing about SHAPE: the half of the map is reliable, the exact pixel is not.

WHAT IT CANNOT DO
${pack.positionTrack.whatItCannotDo}
Counterpart position: ${pack.positionTrack.counterpartPosition}
So a row's "red rings" is a COUNT of unlabelled enemy icons and the zone each ring sits in.
It is not an identification. You may not turn a ring into Kayn.

WHERE IT IS SILENT
${gaps.length === 0 ? "  (no gap of 45s or more)" : gaps.join("\n")}
Inside a gap nobody knows where he was. Not "probably in his jungle" — nobody knows.

clock   zone                           pct           activity  red rings
${rows.join("\n")}
`
}

/* ─────────────────────────────────────────────────────────────────────────────
   3 — heard.txt
   ───────────────────────────────────────────────────────────────────────── */

const heardText = (pack: any): string => {
	const lines = pack.liveCoach.lines as any[]
	const rows = lines.map(l => {
		const where = l.position
			? `[he was: ${l.position.label}, ${l.position.confidence} confidence, read ${l.position.gapSec}s away]`
			: `[no minimap read near this line — where he was is unknown]`
		return `${l.clock.padEnd(7)} "${l.text}"\n${" ".repeat(8)}${where}`
	})

	return `WHAT THE LIVE COACH ACTUALLY SAID — game ${GAME_ID}

HIS VERDICT ON THESE ${lines.length} LINES: ${pack.liveCoach.verdict}

WHAT THE LIVE COACH HAD, AND DID NOT HAVE
It had: a screenshot every few seconds, and a ground-truth block computed from the live
feed — the roster, who was dead and for how long, the score, his gold, his farm against his
own average. It did NOT have: any position for anybody (the minimap track in positions.txt
did not exist at the time it spoke), the whole game at once, or the ability to wait.
It spoke roughly every 20 seconds whether or not anything had changed.

WHY THIS IS IN FRONT OF YOU
Not as an example to follow and not as a model to correct line by line. It is the record of
what he was told while it was still possible to act, and the gap between it and what you can
see is the review. You may say what should have been said instead, at a clock, and you may
name a line that was wrong. ${lines.length} lines over ${clock(lines[lines.length - 1].tSec)}, one every ${Math.round((lines[lines.length - 1].tSec - lines[0].tSec) / (lines.length - 1))}s.
Measured repetition, so you do not have to count it yourself: ${lines.filter((l: any) => /rift herald/i.test(l.text)).length} of the ${lines.length} lines tell him to take
Rift Herald, ${lines.filter((l: any) => /voidgrub/i.test(l.text)).length} tell him to take voidgrubs, and ${lines.filter((l: any) => /clear|farm/i.test(l.text)).length} tell him to clear camps or farm.

Clocks are derived from wall clock through the nearest live sample — the transcript stored
only wall time for this game — so each clock is within a few seconds, not exact.

${rows.join("\n")}
`
}

/* ─────────────────────────────────────────────────────────────────────────────
   4 — frames.json
   ───────────────────────────────────────────────────────────────────────── */

interface Candidate {
	tSec: number
	weight: number
	why: string
	what: string
	/** Set for objective candidates, so the pack's own position join is reused rather than redone. */
	objective?: any
}

/**
 * Decision moments, scored off the event log — never even spacing.
 *
 * Even spacing spends most of its pictures on the walk between camps. The three tiers below are
 * the moments where a jungler's game was actually decided and where a picture answers a question
 * the text cannot: was he in the fight, what was on the screen when the objective fell, what did
 * the map look like the instant before he died.
 *
 *   100  his own deaths — the pattern this review most needs to name
 *    90  a neutral objective taken by anyone (drakes, grubs, herald, baron)
 *    60  he killed the counterpart — the moments he WON, so the review can credit one
 *
 * Inside 20 seconds only one candidate survives — the earlier one, unless a later one outranks it.
 * A grub cluster (three grubs 11 seconds apart) is therefore one decision and one picture, and a
 * death immediately followed by an objective keeps the death, because the death frame already
 * shows the screen the objective fell on.
 */
const chooseFrames = (pack: any, cap: number) => {
	const events = pack.events as any[]
	const objectives = pack.objectives as any[]
	const cands: Candidate[] = []

	for (const e of events) {
		if (e.name === "ChampionKill" && e.victim === "Lillia") {
			const assists = e.assisters.length ? ` (assists: ${e.assisters.join(", ")})` : " (solo)"
			cands.push({ tSec: e.tSec, weight: 100, why: "his death", what: `${e.killer} killed him${assists}` })
		}
		if (e.name === "ChampionKill" && e.killer === "Lillia" && e.victim === "Kayn") {
			const assists = e.assisters.length ? ` (assists: ${e.assisters.join(", ")})` : " (solo)"
			cands.push({ tSec: e.tSec, weight: 60, why: "he killed the counterpart", what: `he killed Kayn${assists}` })
		}
	}
	for (const o of objectives) {
		if (o.structure) continue
		const assists = o.assisters?.length ? ` (assists: ${o.assisters.join(", ")})` : ""
		cands.push({
			tSec: o.tSec,
			weight: 90,
			why: "neutral objective",
			what: `${o.takenBy} took ${o.kind}${assists} — he was ${o.hePresent ? "PRESENT" : "not present"}`,
			objective: o
		})
	}

	cands.sort((a, b) => a.tSec - b.tSec)

	// One picture per decision: inside 20s the screen has not changed enough to be worth a second.
	const spaced: Candidate[] = []
	for (const c of cands) {
		const prev = spaced[spaced.length - 1]
		if (prev && c.tSec - prev.tSec < 20) {
			if (c.weight > prev.weight) spaced[spaced.length - 1] = c
			continue
		}
		spaced.push(c)
	}

	// Over cap, the lowest tier goes first — but keep at least one moment he won, or the review
	// is handed a picture set that only contains his mistakes.
	const chosen = [...spaced]
	while (chosen.length > cap) {
		const worst = chosen.reduce((w, c, i) => (c.weight < chosen[w]!.weight ? i : w), 0)
		const isLastWin = chosen[worst]!.weight === 60 && chosen.filter(c => c.weight === 60).length === 1
		if (isLastWin) {
			const alt = chosen.reduce((w, c, i) => (c.weight < chosen[w]!.weight && c.weight !== 60 ? i : w), -1)
			chosen.splice(alt === -1 ? worst : alt, 1)
		} else chosen.splice(worst, 1)
	}

	const frames = pack.frames as any[]
	const spine = pack.spine as any[]
	const reads = pack.positionTrack.reads as any[]

	return chosen.map(c => {
		const f = frames.reduce((best, x) => (Math.abs(x.tSec - c.tSec) < Math.abs(best.tSec - c.tSec) ? x : best))
		const s = spine.reduce((best, x) => (Math.abs(x.tSec - c.tSec) < Math.abs(best.tSec - c.tSec) ? x : best))
		// The pack's own join, reused where it exists and mirrored where it does not, so frames.json
		// and pack.txt can never name different places for the same instant. Bands are game-pack.ts's:
		// <=3s high, <=8s medium, <=20s low, past 20s no read at all.
		const packJoin = c.objective?.whereHeWas ?? null
		const r = reads.reduce((best: any, x: any) => (Math.abs(x.tSec - c.tSec) < Math.abs(best.tSec - c.tSec) ? x : best))
		const rGap = Math.abs(r.tSec - c.tSec)
		const band = rGap <= 3 ? "high" : rGap <= 8 ? "medium" : "low"
		const where =
			packJoin ? `${packJoin.label} (${packJoin.confidence} confidence — ${packJoin.basis})`
			: rGap <= 20 ? `${r.label} (${band} confidence — minimap read ${rGap.toFixed(1)}s away)`
			: `UNKNOWN — no minimap read within 20s (nearest is ${rGap.toFixed(0)}s away), so it stays unknown`
		const cp = s.counterpart
		return {
			tSec: Number(c.tSec.toFixed(1)),
			clock: clock(c.tSec),
			path: f.path,
			frameId: f.id,
			frameGapSec: Number(Math.abs(f.tSec - c.tSec).toFixed(1)),
			chosenBecause: c.why,
			/** One line, from the pack, of what was happening — so the picture and the prose cannot drift. */
			whatThePackSays:
				`${clock(c.tSec)} — ${c.what}. He was: ${where}. His state (sample ${s.sampleGapSec}s away): ` +
				`lvl ${s.me.level}, ${s.me.cs} CS, ${s.me.kills}/${s.me.deaths}/${s.me.assists}, ${s.me.goldInHand}g in hand, ` +
				`HP ${s.me.hpPct}%${s.me.dead ? `, DEAD (${s.me.respawnSec}s left)` : ""}. ` +
				`Kayn AS LAST SEEN: lvl ${cp.level} (unchanged ${cp.levelUnchangedSec}s), ${cp.cs} CS (unchanged ${cp.csUnchangedSec}s).`
		}
	})
}

/* ─────────────────────────────────────────────────────────────────────────────
   main
   ───────────────────────────────────────────────────────────────────────── */

const sha = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex")

const main = () => {
	if (!existsSync(PACK_TXT)) throw new Error(`missing ${PACK_TXT} — build the pack first, do not rebuild it here`)
	mkdirSync(OUT, { recursive: true })

	const pack = JSON.parse(readFileSync(PACK_JSON, "utf8"))
	const track = JSON.parse(readFileSync(TRACK, "utf8")) as Track
	const packTxt = readFileSync(PACK_TXT, "utf8")

	// The trimmed variant drops FRAME INDEX and nothing else: it is 340 lines of frame paths, and
	// the frames an arm is actually SENT are in frames.json with their clocks. Every other section
	// carries a figure a review might cite, so dropping any of them would change what is sayable.
	const cut = packTxt.indexOf("FRAME INDEX — ask for any of these by path")
	const trimmed =
		cut === -1 ?
			packTxt
		:	`${packTxt.slice(0, packTxt.lastIndexOf("\n", packTxt.lastIndexOf("\n", cut) - 1) + 1)}\n[FRAME INDEX DROPPED — ${(pack.frames as any[]).length} rows listing every journal frame's path and size. The frames actually sent with this turn are in frames.json, with their clocks. No figure a review could cite was in that section.]\n`

	const files: Record<string, string> = {
		"prompt.txt": promptText(),
		"pack.txt": packTxt,
		"pack-trimmed.txt": trimmed,
		"knowledge.txt": knowledgeText(),
		"positions.txt": positionsText(pack, track),
		"heard.txt": heardText(pack)
	}

	const frames = chooseFrames(pack, FRAME_CAP)
	files["frames.json"] = `${JSON.stringify(
		{
			note:
				"Frames chosen at DECISION MOMENTS from the event log, never by even spacing. They are sent as images " +
				"in this turn in the order listed. `whatThePackSays` is derived from the pack, not from the picture: " +
				"where they disagree the pack is the record of what the client reported and the picture is what he saw.",
			gameId: GAME_ID,
			session: SESSION,
			frameSize: "1536x864",
			count: frames.length,
			frames
		},
		null,
		"\t"
	)}\n`

	for (const [name, body] of Object.entries(files)) writeFileSync(join(OUT, name), body)

	const manifest = {
		gameId: GAME_ID,
		session: SESSION,
		builtAtMs: Date.now(),
		builtBy: "scripts/postgame-bundle.ts",
		why: "Every model arm reads these exact bytes. A later run compares these hashes or the comparison is void.",
		sources: {
			[PACK_TXT]: sha(readFileSync(PACK_TXT)),
			[PACK_JSON]: sha(readFileSync(PACK_JSON)),
			[TRACK]: sha(readFileSync(TRACK))
		},
		files: Object.fromEntries(
			Object.entries(files).map(([name, body]) => [name, { bytes: Buffer.byteLength(body), sha256: sha(body) }])
		),
		images: frames.map(f => ({
			clock: f.clock,
			frameId: f.frameId,
			path: f.path,
			bytes: readFileSync(f.path).length,
			sha256: sha(readFileSync(f.path))
		}))
	}
	writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`)

	// Report. Token estimates are chars/4 for text; images use Anthropic's (w*h)/750, which is the
	// tightest of the providers' formulas and therefore the one that will not under-promise.
	const imgTokens = frames.length * Math.ceil((1536 * 864) / 750)
	let textChars = 0
	for (const [name, body] of Object.entries(files)) {
		if (name === "pack-trimmed.txt") continue
		textChars += body.length
	}
	console.log(`bundle → ${OUT}\n`)
	for (const [name, body] of Object.entries(files))
		console.log(`  ${name.padEnd(18)} ${String(Buffer.byteLength(body)).padStart(8)} bytes  ~${Math.round(body.length / 4)} tok`)
	console.log(`  ${"manifest.json".padEnd(18)} ${String(Buffer.byteLength(JSON.stringify(manifest, null, "\t")) + 1).padStart(8)} bytes`)
	console.log(`\n  frames chosen: ${frames.length}`)
	for (const f of frames) console.log(`    ${f.clock.padEnd(7)} ${f.chosenBecause.padEnd(28)} ${f.frameId}`)
	console.log(`\n  TURN ESTIMATE (full pack + ${frames.length} images)`)
	console.log(`    text   ~${Math.round(textChars / 4).toLocaleString()} tok`)
	console.log(`    images ~${imgTokens.toLocaleString()} tok  (${frames.length} x 1536x864 at (w*h)/750)`)
	console.log(`    total  ~${Math.round(textChars / 4 + imgTokens).toLocaleString()} tok`)
	const trimSaving = Math.round((packTxt.length - trimmed.length) / 4)
	console.log(`    trimmed variant saves ~${trimSaving.toLocaleString()} tok of text`)
}

/** Kayn has no file on disk, and a missing file is stated rather than filled in. */
const knowledgeText = (): string => {
	const body = fullKnowledge({ champion: "Lillia", counterpart: "Kayn" })
	const hasKayn = body.includes("THE ENEMY JUNGLER: Kayn")
	const missing = hasKayn ? "" : `
NOTE ON THE COUNTERPART: there is NO knowledge file for Kayn in knowledge/champions/. One was
not written for this bundle and none is invented here. Coach the matchup from what the pack
measured — his items, his levels as last seen, what he took and when — and say nothing about
Kayn's kit that the pack does not show.
`
	return `CHAMPION AND ROLE KNOWLEDGE — game ${GAME_ID}

THE FENCE. Nothing below is measured from his game. It may shape a FIX; it may never become a
number, a timestamp, or a claim about what happened. If it disagrees with the pack, the pack
wins. Absorb it — never attribute it, never say "the notes say".
Loaded through src/review/live-knowledge-full.ts, the same loader the full-knowledge live coach
uses: complete prose, no clause parsing, no digit stripping.
${missing}
${body}
`
}

main()
