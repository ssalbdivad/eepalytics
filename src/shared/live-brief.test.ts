/**
 * These read a REAL recorded `allgamedata` pair, lifted verbatim from `data/live-samples/
 * split-03.ndjson` (a real game of his, Lillia vs Briar). Committed because `data/` is not:
 * a brief asserted against a hand-written fixture only proves the fixture, and the failures this
 * file exists to catch — a field that is not where it was thought to be — are exactly the ones a
 * fixture written from memory reproduces perfectly and wrongly.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { HP_LOW, MANA_LOW } from "../analysis/live-events.ts"
import { buildBrief, buildDelta, clock, DELTA_HARD_CAP, FEED_NOTES, HP_LOW_BAND, MANA_LOW_BAND } from "./live-brief.ts"
import { TRUSTED_PROMPT } from "./live-coach-mode.ts"

/*
 * THE CAP IS IMPORTED RATHER THAN TYPED OUT, because these four assertions are about the payload
 * staying inside it and never about the number being 2000.
 *
 * It moved to 2300 when the two absence lines — where he is not, and where the enemy jungler is
 * not — went into NEXT. Replayed over the 38 stored turns of game 5639406342 those 300 characters
 * came, at 2000, straight out of the sections that yield: the anti-repetition memory fell from 21
 * turns to 10 and MOVED from 17 to 6. At 2300 they are back at 25 and 17. See `DELTA_HARD_CAP`s
 * own comment for the latency regression that says a longer payload costs nothing.
 */

const samples = readFileSync(new URL("./__fixtures__/live-brief-sample.ndjson", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map(l => JSON.parse(l) as { gameTime: number; data: unknown })

const prev = samples[0]!
const cur = samples[1]!
const brief = buildBrief({
	raw: cur,
	gameTimeSec: cur.gameTime,
	previous: { raw: prev, gameTimeSec: prev.gameTime },
	baseline: { csPerMin: { key: "csPerMin", n: 12, mean: 5.42, sd: 0.8, median: 5.4 } }
})

test("builds from a real recorded sample", () => {
	assert.ok(brief)
	assert.equal(brief.me, "Lillia")
	assert.equal(brief.counterpart, "Briar")
	assert.equal(brief.roster.length, 10)
	assert.equal(brief.chars, brief.text.length)
})

test("carries his mana, which the thin block never sent", () => {
	/* The AMOUNT is the assertion, not the percentage: see `bar` and the 28%-became-"no mana left" line. */
	assert.match(brief!.text, /MANA \d+% \(\d+ of \d+/)
})

test("every event line carries a clock and an age", () => {
	const events = brief!.text.split("\n").filter(l => /^- \d+:\d\d \(/.test(l))
	assert.ok(events.length >= 5, "expected the real sample's kills to be listed")
	for (const line of events) assert.match(line, /^- \d+:\d\d \(\d+[ms]/)
})

test("event log is newest first", () => {
	const times = brief!.text
		.split("\n")
		.map(l => /^- (\d+):(\d\d) \(/.exec(l))
		.filter(m => m !== null)
		.map(m => Number(m![1]) * 60 + Number(m![2]))
	for (let i = 1; i < times.length; i++) assert.ok(times[i]! <= times[i - 1]!)
})

test("the enemy jungler is compared on level and build, and on nothing else", () => {
	const t = brief!.text
	assert.match(t, /ENEMY JUNGLER — Briar/)
	assert.match(t, /Build: /)
	/*
	 * The two figures that were rendered here and are audited false. `Gold he has spent on those
	 * items` summed `item.price` and recovered 0.27 of the truth; his CS is a count of what this
	 * client witnessed and read 70 against a true 183 by the end of game 5639406342.
	 */
	assert.ok(!/spent on those items/.test(t), t)
	assert.ok(!/His CS is/.test(t))
	assert.match(t, /His farm figure is deliberately NOT in this payload/)
})

/**
 * The counterpart comparison, pinned. This is the app's most expensive measured lie and the whole
 * point of the section it lives in, so the assertion is against the rendered string.
 */
test("no CS comparison against the counterpart survives in either mode", () => {
	for (const t of [brief!.text, delta!.text]) {
		assert.ok(!/at least [+-]\d+ on farm/.test(t), t)
		assert.ok(!/farm level between you/.test(t), t)
	}
})

test("names what the deltas imply he is doing", () => {
	assert.match(brief!.text, /WHAT CHANGED SINCE THE LAST LOOK/)
	assert.match(brief!.text, /Inference from those deltas:/)
})

test("says plainly when there is no previous sample", () => {
	const first = buildBrief({ raw: cur, gameTimeSec: cur.gameTime })
	assert.match(first!.text, /No previous sample/)
})

test("discloses the feed's own properties, including the CS quantum", () => {
	const t = brief!.text
	assert.match(t, /floored to a multiple of ten/)
	assert.match(t, /Levels are exact/)
	assert.match(t, /no positions anywhere in this feed/i)
	assert.match(t, /no cooldowns/)
})

test("states an absent baseline rather than leaving a gap", () => {
	const none = buildBrief({ raw: cur, gameTimeSec: 1300, previous: null, baseline: {} })
	assert.match(none!.text, /no baseline for this checkpoint/)
})

test("returns null on a torn payload rather than throwing", () => {
	assert.equal(buildBrief({ raw: null, gameTimeSec: 100 }), null)
	assert.equal(buildBrief({ raw: {}, gameTimeSec: 100 }), null)
	assert.equal(buildBrief({ raw: { data: { activePlayer: {} } }, gameTimeSec: 100 }), null)
	assert.equal(buildBrief({ raw: { data: { activePlayer: {}, allPlayers: [] } }, gameTimeSec: 100 }), null)
	assert.equal(buildBrief({ raw: "nonsense", gameTimeSec: 100 }), null)
	// A roster with no matching active player is torn too: the brief is about HIM.
	assert.equal(
		buildBrief({
			raw: { data: { activePlayer: { riotId: "Nobody#NA1" }, allPlayers: [{ championName: "Ahri" }] } },
			gameTimeSec: 100
		}),
		null
	)
})

test("clock renders game time", () => {
	assert.equal(clock(0), "0:00")
	assert.equal(clock(65.9), "1:05")
	assert.equal(clock(3599), "59:59")
})

/*
 * The schedule. This exists because its ABSENCE was measured: with grubs, herald, scuttle and Baron
 * having no spawn line, a graded run had the coach say "Voidgrubs are spawning in a minute" at 6:05
 * — the only false line in the run, and it sat in the best-informed answer of the twelve. The
 * fixture is at 5:47, so grubs are already up, herald and Baron are not, and nothing in the feed
 * can say a word about scuttle.
 */
/*
 * The four numbers here are re-derived from the 94 stored timelines by
 * `live-brief-schedule.test.ts`, which is the test that fails when a patch moves one. This one
 * asserts they reach the payload in the shape the model is asked to read.
 */
test("the objective section states the fixed spawn schedule", () => {
	const t = brief!.text
	assert.match(t, /Voidgrubs: first spawn 8:00, in \d+m\d\ds/)
	assert.match(t, /They leave the pit at 14:00 and Rift Herald arrives at 15:00/)
	assert.match(t, /Rift Herald: spawn 15:00, in \d+m\d\ds/)
	assert.match(t, /Baron Nashor: spawn 20:00, in \d+m\d\ds/)
})

/*
 * Scuttle used to print `first spawn 3:15` from a constant nothing in this repo can check — no
 * scuttle kill appears in the live feed OR in the post-game timeline. Two of the four constants
 * that WERE checkable turned out to be a patch behind, so this one was demoted to the prose
 * treatment the block already gives the grub respawn cadence. A digit here is the regression.
 */
test("the schedule puts no number on scuttle, because nothing here can check one", () => {
	const line = brief!.text.split("\n").find(l => l.startsWith("Scuttle crabs:"))!
	assert.ok(!/\d/.test(line), line)
	assert.match(line, /NOT KNOWN/)
})

test("the schedule refuses the timers it cannot know", () => {
	const t = brief!.text
	// The gap before a second grub set is a patch value; a number here would be the invented one.
	assert.match(t, /NOT stated here/)
	assert.match(t, /which crabs are up right now is NOT KNOWN/)
	const grubLine = t.split("\n").find(l => l.startsWith("Voidgrubs:"))!
	assert.ok(!/\bin \d+ (?:seconds|minutes)\b/.test(grubLine), grubLine)
})

/*
 * ---------------------------------------------------------------- situation first
 *
 * The owner's complaint, verbatim: "why is the top laner's items referenced without any context".
 * The brief's first bulleted line was `- Urgot (TOP, lvl 1) 0/0/0, 0 CS, ward score 0.0. Items: no
 * items`, and a model reading top-down was reading a table where it should have been reading a
 * situation. These assert the ORDER, because the order is the fix.
 */
test("the brief opens on the situation, not on a roster row", () => {
	const first = brief!.text.split("\n\n")[0]!
	assert.match(first, /^NOW\n/)
	assert.ok(
		first.indexOf("Lillia") < brief!.text.indexOf("Urgot"),
		"the man being coached must appear before the enemy top laner's item list"
	)
	// The situation names the clock, whether he is STANDING, him, and the counterpart, in that order.
	const now = first.split("\n")[1]!
	assert.match(now, /^\d+:\d\d\. YOU ARE (ALIVE|DEAD)/)
	assert.ok(now.indexOf("YOU ARE") < now.indexOf("Lillia (JUNGLE)"), now)
	assert.ok(now.indexOf("Lillia") < now.indexOf("Counterpart Briar"), now)
})

test("the situation carries the doing inference, which used to be the last line of the 7th section", () => {
	const now = brief!.text.split("\n\n")[0]!
	assert.match(now, /Over the last \d+s: /)
})

test("the full brief still carries everything it carried before NOW was added", () => {
	const t = brief!.text
	for (const must of [
		/GAME CLOCK \d+:\d\d\./,
		/MANA \d+% \(\d+ of \d+/,
		/Mosstomper Seedling/,
		/YOUR TEAM \(besides you\)/,
		/EVENT LOG, newest first/,
		/WHAT CHANGED SINCE THE LAST LOOK/,
		/OBJECTIVES/,
		/HIS OWN BASELINES/,
		/WHAT THIS FEED IS/
	])
		assert.match(t, must)
})

/*
 * ---------------------------------------------------------------- the delta
 *
 * Measured over the twelve graded turns of game 5635467422: the full brief sent 57,341 characters,
 * of which 43% was byte-identical to the turn immediately before. These render 723-1,221 characters
 * a turn against the same samples.
 */
/*
 * `counterpartSeenSec` is supplied because every shipped caller now supplies it — the route and the
 * bench both pass `cpSeenAt(memory)`. A fixture that omits it exercises the never-seen branch, whose
 * warning is longer than an age and evicts MOVED, so the ordering asserted below would be measuring
 * a payload no caller builds. The value is the fixture's own: Briar's row last moved 118s ago, the
 * same figure the memory test further down uses.
 */
/*
 * `deathsSeen` is supplied for the same reason and from the same place: `coach-memory.ts` now
 * records a death instant on every `observe` and the route and the bench both pass it. The value is
 * not invented — 346 is the `EventTime` of the `ChampionKill` in this fixture's own event log, the
 * one that put Lissandra on the floor with 2.8s left on her timer at 5:59.
 */
const LISSANDRA_DIED = 346

const delta = buildDelta({
	raw: cur,
	gameTimeSec: cur.gameTime,
	previous: { raw: prev, gameTimeSec: prev.gameTime },
	feedNotes: false,
	counterpartSeenSec: cur.gameTime - 118,
	deathsSeen: { Lissandra: { atSec: LISSANDRA_DIED, exact: true } },
	said: ['4:03 (1m44s ago) "Take her raptors while she is down."']
})

test("the delta is a fraction of the brief and stays inside the hard cap", () => {
	assert.ok(delta)
	assert.ok(delta.chars <= DELTA_HARD_CAP, `delta was ${delta.chars} chars`)
	assert.ok(delta.chars < brief!.chars / 3, `delta ${delta.chars} vs brief ${brief!.chars}`)
	assert.equal(delta.me, "Lillia")
	assert.equal(delta.counterpart, "Briar")
})

test("the delta's sections are in the order a decision consumes them", () => {
	const names = delta!.sections!.map(s => s.name)
	assert.equal(names[0], "NOW")
	/* NEXT is second, and it is rank 0: the prospective join is the decision, not a timer. */
	assert.ok(names[1]!.startsWith("NEXT"), names.join(" | "))
	assert.equal(names[2], "SINCE THE LAST LOOK")
	/*
	 * The three tail sections come last, in this order, and each takes only what the cap has left
	 * over from the sections that cannot yield.
	 *
	 * MOVED used to be the cheapest thing here to lose and therefore the thing that was always
	 * lost: over the 66 deltas of the recorded game 5639406342 it arrived 3 times. It does not
	 * shrink gracefully the way `said` and `narrative` do — it is whole rows or nothing — and it is
	 * where "what the enemy jungler just BOUGHT" appears, which the system prompt promises the model
	 * by name. So its own size is now RESERVED before the two that yield, capped at `MOVED_RESERVE`,
	 * and on the same replay it reaches 46 of 67 turns.
	 *
	 * The order below is the invariant; the presence of MOVED is asserted separately, on a delta
	 * built with a real age on the counterpart's row, because a payload with no age there is the
	 * defect that produced "you are two whole levels up on Kayn".
	 */
	assert.ok(names.includes("WHAT YOU HAVE ALREADY SAID THIS GAME"))
	assert.ok(names.indexOf("WHAT YOU HAVE ALREADY SAID THIS GAME") > names.indexOf("JOINS — computed here so you do not have"))
	assert.ok(names.includes("MOVED"), `MOVED is reserved for and should fit: ${names.join(" | ")}`)
	assert.equal(names.at(-1), "MOVED")
})

/*
 * THE MEMORY AND THE ENEMY'S PURCHASES BOTH SURVIVE A LONG GAP, which is the whole reason the cap
 * moved. The event schedule raises turns 40-100 seconds apart rather than every 6-20, so a delta
 * describes 5-15x as much world; at the old 1500 the rank-0 core ate all of it and the two sections
 * the round was built around — the anti-repetition memory and the counterpart's build — reached the
 * model on 16 and 3 of 66 turns. A 90-second gap is the case to pin, because it is the common one.
 */
test("a 90-second gap still carries the memory and MOVED", () => {
	const wide = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: cur.gameTime - 90 },
		feedNotes: false,
		counterpartSeenSec: cur.gameTime - 118,
		said: ['4:03 (1m44s ago) "Take her raptors while she is down."'],
		narrative: `THE GAME SO FAR\n${"0:10 a thing that happened in this game\n".repeat(6)}`
	})!
	const names = wide.sections!.map(s => s.name)
	assert.ok(names.includes("WHAT YOU HAVE ALREADY SAID THIS GAME"), names.join(" | "))
	assert.ok(names.includes("MOVED"), names.join(" | "))
	assert.ok(wide.chars <= DELTA_HARD_CAP, `${wide.chars} chars`)
})

test("a growing memory never evicts the objective clocks", () => {
	/*
	 * The blocker this ordering exists for. `said` had rank 0 and no budget, and its rows GROW as
	 * follow-through verdicts are appended, so from about 3:00 of the stored run the payload
	 * plateaued above the cap and CLOCKS was gone for the rest of the game — permanently, not
	 * transiently. The coach then improvised about grubs at 5:22 and 6:05 with the grub timer
	 * removed from its own payload.
	 */
	const crowded = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		said: Array.from({ length: 12 }, (_, i) => `${i}:00 (1m ago) "${"a long line about the game ".repeat(4)}"`),
		narrative: `THE GAME SO FAR\n${"0:10 something happened here\n".repeat(20)}`
	})!
	assert.match(crowded.text, /NEXT — what is coming/, crowded.text)
	assert.match(crowded.text, /Voidgrubs/, crowded.text)
})

/* Items are 63% of the roster's bytes and change on a median of 0 players per six-second beat. A
 * held item is never re-listed; an item appears in the turn it is BOUGHT and never again. */
test("the delta re-sends no item list and no roster table", () => {
	assert.ok(!/Items: /.test(delta!.text), delta!.text)
	assert.ok(!/ward score/i.test(delta!.text))
	assert.ok(!/YOUR TEAM/.test(delta!.text))
	assert.ok(!/Urgot/.test(delta!.text), "the enemy top laner's row is not per-turn news")
})

/* A vanishing row reads as an absent jungler, and an absent jungler is what this coach is for. */
test("the counterpart keeps a row even when nothing about him moved", () => {
	const quiet = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: cur, gameTimeSec: cur.gameTime - 6 },
		feedNotes: false
	})!
	assert.match(quiet.text, /MOVED\nBriar \(counterpart\): no change/)
})

test("the coach's own past lines are rendered as facts, with no instruction attached", () => {
	const said = delta!.text.split("WHAT YOU HAVE ALREADY SAID THIS GAME\n")[1]!.split("\n\n")[0]!
	assert.equal(said, '4:03 (1m44s ago) "Take her raptors while she is down."')
	/*
	 * NO IMPERATIVE ANYWHERE IN THE PAYLOAD, which is the property rather than a list of four
	 * phrasings. `renderSaid`'s own heading used to end "(do not say it again unless it has
	 * changed)" — an instruction about what to say, and therefore the guardrail this whole
	 * architecture removes — and none of the old four patterns matched it. It shipped nowhere only
	 * because both callers happened to strip line 1.
	 */
	assert.ok(!/vary|ignored|do not repeat|say something else/i.test(delta!.text))
	const imperative = delta!.text
		.split("\n")
		.find(l => /^(do|don't|do not|never|always|avoid|make sure|remember to)\b/i.test(l.trim()))
	assert.equal(imperative, undefined, `an instruction reached the payload: ${imperative}`)
})

test("the memory section is omitted, not printed empty, when the coach has said nothing", () => {
	const fresh = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	assert.ok(!/ALREADY SAID/.test(fresh.text))
})

test("only the tail of the event log is news, and zero lines prints no header", () => {
	const quiet = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	assert.ok(!/NEW SINCE THE LAST LOOK/.test(quiet.text), "nothing happened in the six seconds")
	const wide = buildDelta({ raw: cur, gameTimeSec: cur.gameTime, previous: { raw: prev, gameTimeSec: 0 }, feedNotes: false })!
	assert.match(wide.text, /NEW SINCE THE LAST LOOK\n- \d+:\d\d \(/)
})

/* Only timers that are actually running. The full brief's 918 characters of schedule prose are map
 * rules, and map rules are paid once at the opening. */
test("NEXT carries the live objective state and none of the schedule prose", () => {
	const next = delta!.text.split("\n\n").find(x => x.startsWith("NEXT"))!
	assert.match(next, /Voidgrubs \(top side\): up at 8:00, in \d+m\d\ds/)
	assert.match(next, /position line is a read of a PICTURE/)
	assert.ok(!/patch value/.test(delta!.text))
	assert.ok(!/NOT KNOWN/.test(delta!.text))
})

test("over the cap it truncates from the bottom, never from the top", () => {
	const huge = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		said: Array.from({ length: 40 }, (_, i) => `${i}:00 (1m ago) "${"a line about the game ".repeat(3)}"`),
		narrative: `THE GAME SO FAR\n${"0:10 a thing that happened in this game\n".repeat(40)}`
	})!
	assert.match(huge.text, /^NOW\n/)
	assert.match(huge.text, /SINCE THE LAST LOOK/)
	/*
	 * A forty-line memory can no longer take the objective timers with it: `said` is fitted to its
	 * own budget before it is ranked, and NEXT — the objective clocks joined to his position — is
	 * rank 0 and never drops. MOVED survives too, because it is reserved for rather than spent last;
	 * a memory that overruns is fitted down to its newest rows instead of eating the section that
	 * carries the counterpart's purchases.
	 */
	assert.match(huge.text, /NEXT — what is coming/)
	assert.match(huge.text, /MOVED/)
	assert.ok(huge.chars <= DELTA_HARD_CAP, `${huge.chars} chars`)
})

test("a caller's read of the picture rides in NOW, verbatim, and nowhere else", () => {
	const seen = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		where: "blue-side topside jungle, read off the minimap 2s ago, coarse"
	})!
	const now = seen.text.split("\n\n")[0]!
	assert.match(now, /Picture: blue-side topside jungle, read off the minimap 2s ago, coarse\./)
	assert.equal(seen.text.split("Picture:").length, 2)
})

/* On a socket the system instruction already states all nine of these bullets, and it is paid once.
 * The default stays ON so both stored runs and every existing caller keep what they were graded on. */
test("feedNotes defaults on and can be dropped for a caller whose setup already said it", () => {
	assert.match(brief!.text, /WHAT THIS FEED IS/)
	const lean = buildBrief({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	assert.ok(!/WHAT THIS FEED IS/.test(lean.text))
	assert.ok(brief!.chars - lean.chars > 1000, "the block was 1,190 characters a turn")
})

test("the delta returns null on a torn payload rather than throwing", () => {
	assert.equal(buildDelta({ raw: null, gameTimeSec: 100 }), null)
	assert.equal(buildDelta({ raw: { data: { activePlayer: {}, allPlayers: [] } }, gameTimeSec: 100 }), null)
})

test("with no previous sample the delta says so instead of inventing a change", () => {
	const first = buildDelta({ raw: cur, gameTimeSec: cur.gameTime, feedNotes: false })!
	assert.match(first.text, /First look at this game/)
	assert.ok(!/->/.test(first.text.split("SINCE THE LAST LOOK")[1]!.split("\n\n")[0]!))
})

/*
 * ---------------------------------------------------------------- the inference that was wrong
 *
 * Nine of twelve graded briefs ended on "gold rose with no CS, so it is passive income or a
 * kill/assist share, NOT FARMING" — including three turns whose frames show him mid-clear on the
 * Blue Sentinel, on Gromp and on a bot-side camp. CS is floored to tens, so a jungler mid-clear
 * reads a delta of 0 for most of a clear and 0 ABSOLUTE for the first two minutes. The numbers
 * cannot separate those cases, so the line no longer picks one.
 */
test("gold rising with flat CS is stated as ambiguous, not as a finding of not farming", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	raw.data.activePlayer.currentGold = (prev as any).data.activePlayer.currentGold + 120
	for (const p of raw.data.allPlayers) if (p.championName === "Lillia") p.scores.creepScore = 40
	const p2 = structuredClone(prev) as { gameTime: number; data: Record<string, any> }
	for (const p of p2.data.allPlayers) if (p.championName === "Lillia") p.scores.creepScore = 40
	const d = buildDelta({ raw, gameTimeSec: raw.gameTime, previous: { raw: p2, gameTimeSec: p2.gameTime }, feedNotes: false })!
	assert.match(d.text, /a whole camp fits inside one floored CS step/)
	assert.ok(!/not farming/.test(d.text.split("SINCE")[0]!))
})

/* At 0:36 the old branch read "he just backed and bought" for a man who had never left the fountain,
 * and the capped run said "Good back for the seedling." */
test("the starting purchase is not reported as a back", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	raw.data.activePlayer.currentGold = 50
	// Before the first wave he is holding his opening buy; the sample before it, nothing.
	const empty = structuredClone(prev) as { gameTime: number; data: Record<string, any> }
	empty.data.activePlayer.currentGold = 500
	for (const p of empty.data.allPlayers) if (p.championName === "Lillia") p.items = []
	const d = buildDelta({ raw, gameTimeSec: 36, previous: { raw: empty, gameTimeSec: 30 }, feedNotes: false })!
	assert.match(d.text, /starting purchase, not a back/)
	assert.ok(!/just backed and bought/.test(d.text))
})


/*
 * ---------------------------------------------------------------- NEXT, and the joins
 *
 * These replay the two moments of game 5639406342 the owner picked out: 13:34, where the Air drake
 * fell 7 seconds later, and 17:56, where Rift Herald fell 6 seconds later — both while his own
 * minimap icon read blue-side base. The fixture is a different game (Lillia vs Briar), so what is
 * pinned here is the SHAPE of the join rather than those clocks; the clocks are in the report.
 */

const withFix = (extra: Record<string, unknown> = {}) =>
	buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		at: { label: "blue-side base", coarse: "base", atSec: cur.gameTime - 2, enemies: ["dragon pit", "mid lane"] },
		counterpartSeenSec: cur.gameTime - 118,
		...extra
	})!

test("NEXT joins the objective, the position and the state into one section", () => {
	const next = withFix().text.split("\n\n").find(x => x.startsWith("NEXT"))!
	/* where he is, how old the read is, and that it came from a picture */
	assert.match(next, /You: blue-side base, 2s old\./)
	assert.match(next, /position line is a read of a PICTURE, not a feed value/)
	/* what he has for it */
	assert.match(next, /\d+% HP, \d+% mana, \d+g/)
	/* what is coming, with its side */
	assert.match(next, /- Voidgrubs \(top side\):/)
})

/**
 * THE RENDERED POSITION LINE, AND THE PRONOUN THAT INVERTED IT THREE TIMES IN ONE GAME.
 *
 * This payload addresses the player as "you" everywhere and names exactly one other person, the
 * enemy jungler. So a third-person referent anywhere in the position line is ambiguous BY
 * CONSTRUCTION, and on the 23-turn event-driven run of game 5639406342 the coach resolved it the
 * wrong way on three of the seven turns that carried a position:
 *
 *   6:46  "Kayn's been spotted topside"                     (Kayn was botside, at the dragon pit)
 *   15:54 "Kayn is a level up and just appeared topside"    (Kayn was river-bot, then mid)
 *   23:01 "take this Baron now while they cannot contest"   (Kayn was standing IN the Baron pit)
 *
 * Every one of those was HIS OWN position, read off the minimap and handed to the man he was racing
 * — and the last of them walks him into a Baron the enemy jungler is already at. The line is worth
 * nothing if it can name the wrong person; the reader being 17-of-18 accurate makes it worse, not
 * better.
 *
 * A WORD LIST, not a phrase check. The exact phrase that broke ("his own icon read topside") is
 * gone and the next one will be different. The counterpart clause in the same section keeps its
 * "his" — that one is ABOUT the enemy jungler and is correct — so the assertion is scoped to the
 * position line alone.
 */
const THIRD_PERSON = /\b(he|him|his|she|her|hers|they|them|their|theirs|its)\b/i

const positionLine = (text: string): string =>
	text.split("\n").find(l => /^You[: ]|^You WERE /.test(l)) ?? ""

test("the position line never uses a third-person word, in either tense", () => {
	for (const [why, extra] of [
		["fresh", {}],
		["carried", { at: { label: "blue-side base", coarse: "base", atSec: cur.gameTime - 22, asOf: "last-known" } }],
		["absent", { at: null }]
	] as const) {
		const line = positionLine(withFix(extra as Record<string, unknown>).text)
		assert.ok(line !== "", `${why}: no position line rendered`)
		const hit = THIRD_PERSON.exec(line)
		assert.equal(hit, null, `${why}: "${hit?.[0]}" in ${line}`)
	}
})

/**
 * The carried read, rendered as WHAT IT IS.
 *
 * 42% of the event-driven turns are reactive — a death, a respawn, `resource.low` — and a reactive
 * turn skips the 1.3-3.0s minimap call because it is racing. It used to see nothing at all, which
 * is the wrong answer when a read from eleven seconds ago exists. It now sees that read, in the
 * past tense, with its age, and decides for itself what an old position is worth. The present tense
 * is reserved for a read taken on the turn, where the coarse half measured 92.3% accurate over 454
 * frame-to-event pairs in the 94 stored games.
 */
test("a carried read is rendered in the past tense, with its age", () => {
	const next = withFix({
		at: { label: "blue-side base", coarse: "base", atSec: cur.gameTime - 22, asOf: "last-known" }
	})
		.text.split("\n\n")
		.find(x => x.startsWith("NEXT"))!
	assert.match(next, /You WERE at blue-side base/, next)
	assert.match(next, /22s ago/, next)
	assert.match(next, /not where you are now/, next)
	// and the state beside it is still THIS turn's, which is the whole reason the two are separable
	assert.match(next, /\d+% HP, \d+% mana, \d+g/, next)
})

test("a read taken on the turn keeps the present tense", () => {
	const next = withFix().text.split("\n\n").find(x => x.startsWith("NEXT"))!
	assert.match(next, /You: blue-side base, 2s old\./, next)
	assert.ok(!/You WERE/.test(next), next)
})

/**
 * WHERE THE ENEMY JUNGLER IS NOT — the four invented positions, and the section that answers them.
 *
 * Measured on the 38-turn run of game 5639406342: 4 of the 7 false lines are the model writing a
 * position into a silence. The two worst are pinned here because they are two DIFFERENT silences.
 *
 *   11:39  "Kayn is topside getting grubs"                    — Kayn was on the screenshot, in the
 *          bot river, beside him. The payload held `Kayn took a voidgrub` at 10:45 and
 *          `- Voidgrubs (top side)` in NEXT, and the model crossed a 54-second-old event with a
 *          PIT's side and said it in the present tense.
 *   13:28  "now that you've finished kiting towards your topside" — he was standing in his own
 *          fountain, and the payload said "no usable position" in a subordinate clause.
 *
 * So both absences are stated, every turn, in the section where the temptation is.
 */
test("the enemy jungler's position is stated as absent on every turn", () => {
	const next = withFix().text.split("\n\n").find(x => x.startsWith("NEXT"))!
	const line = next.split("\n").find(l => l.startsWith("WHERE ")) ?? ""
	assert.match(line, /^WHERE BRIAR IS: not in this payload/, next)
	/* the 11:39 join, refused by name: the side on an objective line is the PIT's */
	assert.match(line, /each objective line's side is the PIT's, not his/, line)
	/* and the icons on his own minimap read are not his either — the reader cannot name a red dot */
	assert.match(line, /enemy icons above are unlabelled/, line)
})

test("a placement of the enemy jungler is rendered in the past, with its clock and its age", () => {
	/* his counterpart takes a drake 40 seconds before the turn: the one shape that IS place-like */
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	const briar = raw.data.allPlayers.find((p: any) => p.championName === "Briar")
	raw.data.events.Events.push({
		EventID: 999,
		EventName: "DragonKill",
		EventTime: raw.gameTime - 40,
		DragonType: "Fire",
		KillerName: briar.riotIdGameName ?? briar.summonerName
	})
	const line =
		buildDelta({ raw, gameTimeSec: raw.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, feedNotes: false })!
			.text.split("\n")
			.find(l => l.startsWith("WHERE ")) ?? ""
	assert.match(line, /He WAS: \d+:\d\d \(40s ago\) at the drake pit \(bot side\), taking it/, line)
	/* the tense is the whole difference between the useful lines of that run and the false one */
	assert.ok(!/is at|he is in|right now/.test(line), line)
})

test("a placement older than the fight horizon is not rendered at all", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	const briar = raw.data.allPlayers.find((p: any) => p.championName === "Briar")
	raw.data.events.Events.push({
		EventID: 999,
		EventName: "DragonKill",
		EventTime: Math.max(0, raw.gameTime - 300),
		DragonType: "Fire",
		KillerName: briar.riotIdGameName ?? briar.summonerName
	})
	const line =
		buildDelta({ raw, gameTimeSec: raw.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, feedNotes: false })!
			.text.split("\n")
			.find(l => l.startsWith("WHERE ")) ?? ""
	assert.match(line, /Nothing has placed him anywhere in the last 2m00s/, line)
	assert.ok(!/drake pit/.test(line), line)
})

test("with no read of the picture the absence names the sentences that were written into it", () => {
	const line = positionLine(withFix({ at: null }).text)
	/* the old sentence, which was not enough on its own */
	assert.match(line, /no usable position — either nothing has read your icon this game/)
	/* and the two shapes the invention actually took: a direction, and a finished action */
	assert.match(line, /which way you are walking, or which camps you have just cleared/, line)
	assert.match(line, /^You: WHERE YOU ARE IS NOT IN THIS PAYLOAD/, line)
})

test("the enemy icons ride with the position and are never given a name", () => {
	const next = withFix().text.split("\n\n").find(x => x.startsWith("NEXT"))!
	assert.match(next, /Enemy icons on that same picture, unidentified: dragon pit, mid lane/)
	/* the minimap reader cannot tell one red dot from another, so no champion may be attached */
	assert.ok(!/Briar.*dragon pit|dragon pit.*Briar/.test(next), next)
})

/**
 * The pair a jungler actually decides on, and the reason `isDead`/`respawnTimer` earn their place
 * beside the timers: both are read straight off the feed for enemies as well as allies, and neither
 * is fog-gated.
 */
test("a dead counterpart is stated beside the objective clock, with his timer", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	for (const p of raw.data.allPlayers)
		if (p.championName === "Briar") {
			p.isDead = true
			p.respawnTimer = 24.4
		}
	const next = buildDelta({
		raw,
		gameTimeSec: raw.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		deathsSeen: { Briar: { atSec: raw.gameTime - 9, exact: true } },
		at: { label: "blue-side base", coarse: "base", atSec: raw.gameTime }
	})!.text.split("\n\n").find(x => x.startsWith("NEXT"))!
	/* BOTH CLOCKS, and they run opposite ways: 9 seconds gone, 24 to come. */
	assert.match(next, /Briar: DEAD, down 9s, back in 24s/)
	assert.match(next, /Voidgrubs \(top side\): up at 8:00/)
})

/**
 * THE ORDER, which is the whole of the second fix and is the same argument `orderStakes` was built
 * on. That file records eleven of twelve prompt variants saying "drake in forty-five seconds" while
 * a Herald stood free for 2m57s, because the drake line was written first. The 17-game corpus is
 * the wider version: 82% [78-85] of the lines raised by a pit clock were about an objective against
 * 39% [26-55] of the lines raised when there was no pit to stand at.
 *
 * The counterpart's remaining death timer is the one clock in this section that his client draws
 * NOWHERE and the one that expires, so it leads — and `fit` drops from the end, which is what makes
 * leading different from merely being present.
 */
test("a dead counterpart leads NEXT, ahead of every pit", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	for (const p of raw.data.allPlayers)
		if (p.championName === "Briar") {
			p.isDead = true
			p.respawnTimer = 24.4
		}
	const next = buildDelta({
		raw,
		gameTimeSec: raw.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		deathsSeen: { Briar: { atSec: raw.gameTime - 9, exact: true } }
	})!.text.split("\n\n").find(x => x.startsWith("NEXT"))!
	const bullets = next.split("\n").filter(l => l.startsWith("- "))
	assert.match(bullets[0]!, /^- Briar — the enemy jungler — is DEAD, down 9s, back in 24s\./, bullets.join(" | "))
	assert.match(bullets[0]!, /Nothing in his client shows him this timer/)
	/* and he is named once, not twice: the down-list below drops the man who is already the head. */
	assert.equal(bullets.filter(l => /Briar/.test(l)).length, 1, bullets.join(" | "))
})

test("a live counterpart adds no head line at all", () => {
	const next = withFix().text.split("\n\n").find(x => x.startsWith("NEXT"))!
	assert.ok(!/is DEAD, down/.test(next), next)
})

test("an objective beyond the horizon is not rendered at all", () => {
	const next = withFix().text.split("\n\n").find(x => x.startsWith("NEXT"))!
	/* 5:59, so Baron at 20:00 is 14 minutes out: a fact about the map, not a decision. */
	assert.ok(!/Baron/.test(next), next)
})

test("with no position read NEXT says so rather than guessing at one", () => {
	const next = delta!.text.split("\n\n").find(x => x.startsWith("NEXT"))!
	/*
	 * "no position read THIS TURN" was true while the only read a turn could have was its own. It is
	 * not true now: a turn with no read of its own still sees the carried one, so the only way to
	 * reach this branch is that nothing has been read this game or the last read is past
	 * `CARRY_MAX_SEC`. The sentence says which, because a model told "not this turn" can reasonably
	 * infer that a position exists somewhere and is merely not in front of it.
	 */
	assert.match(next, /no usable position — either nothing has read your icon this game or the last read is too old/)
})

test("JOINS carries the three pairings the model was not making for itself", () => {
	const joins = withFix().text.split("\n\n").find(x => x.startsWith("JOINS"))!
	/* he cannot sum his team's kills off his own screen */
	assert.match(joins, /Kill participation: you are in \d+ of your team's \d+ kills \(\d+%\)/)
	assert.match(joins, /Briar is in \d+ of their \d+/)
	/* the trade, and whether he was even in it — `fights.ts`'s live twin */
	assert.match(joins, /Last fight \d+:\d\d(-\d+:\d\d)? \(\d+[ms].*\): \d+ for you, \d+ for them, and you were (NOT in it|in it)/)
})

/**
 * The memory is SIZED to what is left rather than dropped whole.
 *
 * With NEXT and JOINS in the payload the sections that cannot yield come to about 1,200 characters,
 * so the old fixed 380-character budget for `said` no longer fit and the eviction loop deleted the
 * whole memory every turn for the rest of a game. One row of it is most of the anti-repetition
 * value; nought rows is none of it.
 */
/**
 * The compression that paid for the memory at 13:34 of game 5639406342.
 *
 * Every value is still printed; a field that did not move is simply not printed twice with a `(0)`
 * after it. At a six-second beat most of them do not move.
 */
test("SINCE prints an unmoved figure once, and a moved one as a transition", () => {
	const quiet = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	const since = quiet.text.split("\n\n").find(x => x.startsWith("SINCE"))!
	assert.match(since, /CS 40,/, since)
	assert.match(since, /gold 746->770 \(\+24\)/, since)
	assert.ok(!/->40 \(0\)/.test(since), since)
})

test("a memory section whose rows do not fit is omitted, not sent as a bare heading", () => {
	const d = withFix({
		narrative: `THE GAME SO FAR\n${"0:10 a beat that will not fit in what is left\n".repeat(20)}`
	})
	assert.ok(!/THE GAME SO FAR/.test(d.text) || /0:10 a beat/.test(d.text), d.text)
})

test("a crowded delta keeps the newest memory row instead of dropping the section", () => {
	const crowded = withFix({
		said: Array.from({ length: 12 }, (_, i) => `${i}:00 (1m ago) "${"a long line about the game ".repeat(4)}"`)
	})
	assert.match(crowded.text, /WHAT YOU HAVE ALREADY SAID THIS GAME/, crowded.text)
	assert.ok(crowded.chars <= DELTA_HARD_CAP, `${crowded.chars} chars`)
})

test("a row that has NEVER moved says so, instead of reporting no age", () => {
	/*
	 * The line this pins out of existence: at 2:06 of game 5639406342 the feed's Kayn row still
	 * read level 1, frozen since the loading screen, and the brief said "his row carries no age
	 * this turn". The coach read that beside "2 levels BELOW you" and said "you are two whole
	 * levels up on Kayn". The timeline has the gap at one.
	 */
	const path = "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson"
	if (!existsSync(path)) return
	const rows = readFileSync(path, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	const early = rows.find(r => r.gameTime >= 120 && r.gameTime <= 135)
	if (early === undefined) return

	const b = buildBrief({ raw: early.data, gameTimeSec: early.gameTime, counterpartSeenSec: null })
	assert.ok(b !== null)
	const kayn = b.text.split("\n").find(l => l.startsWith("Kayn:")) ?? ""
	assert.ok(kayn.includes("his row has NEVER moved"), kayn)
	assert.ok(!kayn.includes("carries no age this turn"), kayn)

	// Inside the grace window the quiet phrasing is still correct: nothing has had time to change.
	const opening = rows.find(r => r.gameTime >= 0 && r.gameTime <= 20)
	if (opening !== undefined) {
		const o = buildBrief({ raw: opening.data, gameTimeSec: opening.gameTime, counterpartSeenSec: null })
		const line = (o?.text ?? "").split("\n").find(l => l.startsWith("Kayn:")) ?? ""
		assert.ok(line.includes("carries no age this turn"), line)
	}

	// A row with a real age is untouched by any of this.
	const aged = buildBrief({
		raw: early.data,
		gameTimeSec: early.gameTime,
		counterpartSeenSec: early.gameTime - 20
	})
	const agedLine = (aged?.text ?? "").split("\n").find(l => l.startsWith("Kayn:")) ?? ""
	assert.ok(agedLine.includes("last moved at"), agedLine)
})

/**
 * A memory that started MID-GAME must not report the game's age as the row's age.
 *
 * `counterpartSeenSec` can only report a change the caller WATCHED happen, so it is null for two
 * opposite reasons: the row has never moved, or the watcher is new. A daemon restart or any
 * roster-triggered `newMemory()` produces the second, and the clause used to render the first —
 * verbatim, on this replay before the fix: `Kayn: alive, lvl 5 — 1 level BELOW you. 1/1/0. Build:
 * 3 to your 3 — Scorchclaw Pup, Long Sword, Long Sword. ... his row has NEVER moved in 7m23s —
 * still your client's defaults, so this level is not a gap.` Level 5 with three items is not a
 * client default, the level gap was real, and the model was told to discard it.
 */
test("a mid-game watcher does not call a live row a client default", () => {
	const path = "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson"
	if (!existsSync(path)) return
	const rows = readFileSync(path, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	const mid = rows.find(r => r.gameTime >= 440 && r.gameTime <= 450)
	if (mid === undefined) return

	const b = buildBrief({
		raw: mid.data,
		gameTimeSec: mid.gameTime,
		counterpartSeenSec: null,
		// The watch started at 400s: a daemon restart, or a roster change, a few seconds ago.
		counterpartWatchedFromSec: 400
	})!
	const kayn = b.text.split("\n").find(l => l.startsWith("Kayn:"))!
	assert.ok(!/still (?:your )?client's defaults/.test(kayn), kayn)
	assert.ok(!/loading-screen default/.test(kayn), kayn)
	assert.match(kayn, /UNKNOWN/, kayn)
	// The WATCH's age, not the game clock. 440-450s in is 7 minutes; the watch is well under one.
	assert.ok(!/in \dm\d\ds of watching/.test(kayn), `the game clock leaked into the row's age: ${kayn}`)
	assert.match(kayn, /in \d+s of watching/, kayn)
})

/*
 * And the opposite case still says the strong thing: a row that really IS at its defaults.
 * At 2:06 of the same game Kayn's row read level 1 with no items while the post-game timeline has
 * him at level 2, and the coach said "you are two whole levels up on Kayn".
 */
test("a row that really is at its defaults is still called one", () => {
	const path = "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson"
	if (!existsSync(path)) return
	const rows = readFileSync(path, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	const early = rows.find(r => r.gameTime >= 120 && r.gameTime <= 135)
	if (early === undefined) return
	const b = buildBrief({ raw: early.data, gameTimeSec: early.gameTime, counterpartSeenSec: null })!
	const kayn = b.text.split("\n").find(l => l.startsWith("Kayn:"))!
	assert.match(kayn, /has NEVER moved/, kayn)
	assert.match(kayn, /loading-screen default/, kayn)
})

/*
 * The SHORT form rides in NOW, beside the level comparison, and it is not conditional on an
 * objective being inside the prospect horizon. NEXT carries the long clause; NEXT used to be able
 * to vanish entirely (0-12.3% of delta turns across the 14 recorded games, all mid or late game),
 * and on those turns the payload carried a level comparison with no age on it anywhere.
 */
test("NOW carries the row's age beside the level comparison", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		counterpartSeenSec: cur.gameTime - 118
	})!
	const now = d.text.split("\n\n")[0]!
	assert.match(now, /Counterpart Briar:[^\n]*\(row 1m58s old\)/, now)
})

/**
 * ONE position, ONE line — the route passes both forms and only one may render.
 *
 * `pictureLine` and `pictureFix` share a gate, so `where` (prose) and `at` (data) arrive together
 * on every turn that has a read. `situation`'s comment claimed "prose wins when both arrive" and
 * nothing implemented it: the real 2:06 payload carried `Picture: his own icon read botside on the
 * minimap 0s ago …` and `You: blue-side jungle (bot), 0s old` in one brief, ~120 duplicated
 * characters inside a fixed cap that was already evicting the memory.
 */
test("a read that reaches NEXT is not also printed in NOW", () => {
	const both = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		where: "topside, read off the minimap 2s ago",
		at: { label: "own blue-side jungle (top)", coarse: "topside", atSec: cur.gameTime - 2 }
	})!
	assert.equal(both.text.split("Picture:").length, 1, both.text)
	assert.match(both.text, /You: own blue-side jungle \(top\), 2s old/)

	// With no structured read the prose still rides, because otherwise there is no position at all.
	const proseOnly = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		where: "topside, read off the minimap 2s ago"
	})!
	assert.match(proseOnly.text, /Picture: topside, read off the minimap 2s ago\./)
})

/*
 * The grub half of the death join needed a KILL check as well as a window, and was the only one of
 * the four without one. A set is cleared in pieces and this feed carries no set size, so once any
 * of it is down nothing here can say what is left — a death at 13:00 of the recorded game was
 * reported as "voidgrubs standing at the time" three minutes after three had been killed.
 */
test("a death after the grub pit was touched does not claim grubs were standing", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	const me = raw.data.allPlayers.find((p: any) => p.championName === "Lillia")
	raw.data.events.Events = [
		{ EventID: 1, EventName: "HordeKill", EventTime: 500, KillerName: "someone" },
		{ EventID: 2, EventName: "ChampionKill", EventTime: 520, KillerName: "someone", VictimName: me.riotIdGameName ?? me.summonerName }
	]
	const withKill = buildDelta({ raw, gameTimeSec: 540, previous: { raw: prev, gameTimeSec: 500 }, feedNotes: false })!
	const line = withKill.text.split("\n").find(l => l.startsWith("- Your last death")) ?? ""
	assert.ok(!/voidgrubs/.test(line), line)

	// Untouched, the claim still stands — this is a gate, not a deletion.
	raw.data.events.Events = [raw.data.events.Events[1]]
	const untouched = buildDelta({ raw, gameTimeSec: 540, previous: { raw: prev, gameTimeSec: 500 }, feedNotes: false })!
	const line2 = untouched.text.split("\n").find(l => l.startsWith("- Your last death")) ?? ""
	assert.match(line2, /voidgrubs/, line2)
})

/* ================================================================ the two invention holes this round closed
 *
 * Both were measured on game 5639406342, the 23-turn event-driven run stored at
 * `data/eval/stream-kayn-events-20260910.json`, and both are the same failure: a fact the feed does
 * not carry, filled in by a model reading a payload that said nothing about the gap.
 */

/**
 * "Drave and Lulu are low from that fight" — said at 7:47, four seconds after a kill line landed.
 *
 * There is no health for anybody but him anywhere in the Live Client Data API. `championStats` sits
 * under `activePlayer`; an `allPlayers` row carries championName, isBot, isDead, items, level,
 * position, runes, scores, summonerSpells, team and the skin fields, and no bar of any kind. The
 * fixture is a real recorded payload, so this test proves the absence rather than asserting it.
 */
test("the feed carries no condition for anybody but him, and the fixture proves it", () => {
	const players = (cur as { data: { allPlayers: Array<Record<string, unknown>> } }).data.allPlayers
	assert.ok(players.length === 10)
	for (const p of players)
		for (const key of ["championStats", "currentHealth", "maxHealth", "resourceValue", "currentGold", "health", "mana"])
			assert.ok(!(key in p), `allPlayers row carries ${key}, which this app renders as absent`)
})

test("both roster sections state that no health, mana or gold is on their rows", () => {
	const sections = brief!.text.split("\n\n")
	const ally = sections.find(s => s.startsWith("YOUR TEAM"))!
	const enemy = sections.find(s => s.startsWith("ENEMY TEAM"))!
	for (const s of [ally, enemy]) {
		assert.match(s, /No health, mana or gold for anybody but him/, s)
		assert.match(s, /NOT knowable here/, s)
	}
	// It rides on the roster sections, where the temptation is — not only in the feed notes.
	assert.ok(ally.indexOf("No health") < ally.indexOf("- Urgot"), ally)
	assert.ok(enemy.indexOf("No health") < enemy.indexOf("- Ornn"), enemy)
})

test("the feed notes cover health and mana, not only gold", () => {
	assert.match(brief!.text, /Nobody's health, mana or gold is reported except his own/)
	assert.match(brief!.text, /carry no bars at all/)
})

/**
 * The delta has NO roster section at all, and 7:47 was a delta. So the short form rides on NOW,
 * which is the only section present on every turn of both modes.
 */
test("every turn of both modes says whose HP and mana these are", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	for (const t of [brief!.text, d.text]) {
		const now = t.split("\n\n")[0]!
		assert.match(now, /Yours are the only HP, mana and gold in this feed/, now)
	}
})

/**
 * "You are all still dead" — said at 28:12 while he stood at 100% HP.
 *
 * Everything needed to refuse it was in the payload: `alive` sat four commas into NOW's first
 * sentence, `He is alive.` was the LAST line of the ninth line of the YOU section, and NEXT listed
 * four dead team-mates and the enemy jungler on one line without saying he was not among them.
 */
test("his own aliveness opens the payload in both modes", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	for (const t of [brief!.text, d.text]) {
		const now = t.split("\n\n")[0]!.split("\n")[1]!
		assert.match(now, /^\d+:\d\d\. YOU ARE ALIVE, /, now)
	}
	// And in the full brief's own section it is the first line, not the last.
	const you = brief!.text.split("\n\n").find(s => s.startsWith("YOU — Lillia"))!
	assert.equal(you.split("\n")[1], "HE IS ALIVE RIGHT NOW. The HP and mana below are exact, his own, and the only ones in this feed.")
	assert.ok(!/^He is alive\.$/m.test(you), you)
})

test("the down-list says where he is in it", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	const line = d.text.split("\n").find(l => l.startsWith("- Down right now"))!
	assert.match(line, /\(NOT you — you are ALIVE\)/, line)
	assert.ok(!/^- Down right now: /.test(line), line)
})

/**
 * At 16:55 of game 5639406342 this line named his own dead mid beside two dead enemies and said
 * nothing about whose side any of them was on. The coach counted "three enemies dead" and told him
 * to walk into the Rift Herald pit on the strength of it, while the frame showed him mid-trade with
 * the enemy jungler. Every name in that line was real; the miscount was the payload's.
 */
/**
 * Three lines of the graded run of game 5639406342 named an item he did not own — Sorcerer's Shoes,
 * Haunting Guise, Cosmic Drive — all on DELTA turns, which carry no roster section. The counterpart's
 * clause has named his items since it was written, so the payload said how many items the player had
 * and never which. A gap is an invitation.
 */
test("his own build is named on a delta, not just counted", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	const you = d.text.split("\n").find(l => l.startsWith("You:") || l.startsWith("You WERE"))!
	assert.match(you, /holding /, you)
	const me = (cur as { data: { allPlayers: { championName: string; items: { displayName: string; consumable?: boolean }[] }[] } }).data.allPlayers.find(
		p => p.championName === "Lillia"
	)!
	const first = me.items.find(i => !i.consumable && !/Trinket|Ward|Potion|Refillable|Elixir|Biscuit|Lens/i.test(i.displayName))
	if (first) assert.ok(you.includes(first.displayName), `${first.displayName} missing from ${you}`)
})

test("every name in the down-list carries the team it is on", () => {
	const line = delta!.text.split("\n").find(l => l.startsWith("- Down right now"))!
	const names = line.slice(line.indexOf(":") + 1).split("; ")
	assert.ok(names.length > 0, line)
	/* And how long each has been down, beside what is left of his timer. */
	for (const n of names) assert.match(n, /\((YOUR team|ENEMY)\) down \d+s, back in \d+s/, `${n} in ${line}`)
})

test("a dead player is announced as dead everywhere, and his corpse's bars are not printed", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	const me = raw.data.allPlayers.find((p: any) => p.championName === "Lillia")
	me.isDead = true
	me.respawnTimer = 14.2
	// A corpse really does read zero in this feed; that is why the bars come out.
	raw.data.activePlayer.championStats.currentHealth = 0
	raw.data.activePlayer.championStats.resourceValue = 0
	const seen = { Lillia: { atSec: cur.gameTime - 6, exact: true } }
	const d = buildDelta({ raw, gameTimeSec: cur.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, feedNotes: false, deathsSeen: seen })!
	const now = d.text.split("\n\n")[0]!.split("\n")[1]!
	assert.match(now, /^\d+:\d\d\. YOU ARE DEAD — down 6s, 14s until you are up\./, now)
	assert.match(now, /corpse reads 0 HP and 0 mana/, now)
	assert.ok(!/HP 0%/.test(now), now)
	assert.match(d.text, /You: [^\n]*DEAD, down 6s, 14s more/)

	const b = buildBrief({ raw, gameTimeSec: cur.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, deathsSeen: seen })!
	const you = b.text.split("\n\n").find(s => s.startsWith("YOU — Lillia"))!
	assert.match(you.split("\n")[1]!, /^HE IS DEAD RIGHT NOW — down 6s — and respawns in 14s\./)
})

/**
 * 19:16: `HP 57%, mana 28%` became "you are too hurt and have no mana left, so you must retreat".
 *
 * Both halves are a real number restated as a wrong one. 57% of his 2,714 health is 1,547 HP and
 * 28% of his 1,015 mana is 284 mana, and neither value is inside the band this app's own detector
 * fires `resource.low` on. The amount is now rendered beside every percentage, and the band is
 * named only when the value is actually in it.
 */
test("a bar carries its amount, so a percentage cannot be restated as empty", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	const now = d.text.split("\n\n")[0]!
	assert.match(now, /HP \d+% \(\d+ of \d+\)/, now)
	assert.match(now, /mana \d+% \(\d+ of \d+\)/, now)
	assert.match(brief!.text, /\nHP \d+% \(\d+ of \d+\)\. MANA \d+% \(\d+ of \d+\), regen /)
})

test("the LOW band fires at the app's own threshold and nowhere else", () => {
	const at = (hpFrac: number, manaFrac: number) => {
		const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
		const st = raw.data.activePlayer.championStats
		st.currentHealth = Math.round(st.maxHealth * hpFrac)
		st.resourceValue = Math.round(st.resourceMax * manaFrac)
		return buildDelta({ raw, gameTimeSec: cur.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, feedNotes: false })!.text.split("\n\n")[0]!
	}
	// The 19:16 state. Neither band had fired, and the coach called it a retreat.
	const unremarkable = at(0.57, 0.28)
	assert.ok(!/LOW/.test(unremarkable), unremarkable)

	const low = at(0.2, 0.1)
	assert.match(low, /HP 20% \(\d+ of \d+, LOW — under 30%\)/, low)
	assert.match(low, /mana 10% \(\d+ of \d+, LOW — under 20%\)/, low)

	// Exactly on the line is inside it, the same way the detector's `<=` reads it. Round maxima, so
	// the boundary is the boundary and not a rounding of it.
	const onTheLine = (() => {
		const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
		const st = raw.data.activePlayer.championStats
		st.maxHealth = 1000
		st.currentHealth = 1000 * HP_LOW_BAND
		st.resourceMax = 1000
		st.resourceValue = 1000 * MANA_LOW_BAND
		return buildDelta({ raw, gameTimeSec: cur.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, feedNotes: false })!.text
	})()
	assert.match(onTheLine, /HP 30% \(300 of 1000, LOW — under 30%\)/, onTheLine)
	assert.match(onTheLine, /mana 20% \(200 of 1000, LOW — under 20%\)/, onTheLine)
})

/**
 * The bands are DUPLICATED across the `shared/` → `analysis/` fence, because `shared/` may not
 * import `analysis/`. This is the same arrangement `live-brief-schedule.test.ts` makes for the
 * objective spawn constants, and it is only safe while a test fails the moment one side moves.
 */
test("the bands agree with the detector that fires resource.low", () => {
	assert.equal(HP_LOW_BAND, HP_LOW)
	assert.equal(MANA_LOW_BAND, MANA_LOW)
})

/**
 * What is NOT here, deliberately: a conversion from mana to casts or to camps.
 *
 * Ability mana costs are in no part of this feed, `knowledge/champions/lillia.md` deliberately
 * omits them ("a remembered one would be fiction"), and `champion-advice.ts` refuses any clause
 * containing a digit. So "284 mana is two more camps" has no non-inventing source, and the amount
 * plus the app's own band is the whole of what can honestly be said about a bar.
 */
test("no bar claims what the number buys", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	for (const t of [brief!.text, d.text]) {
		assert.ok(!/\d+ (?:more )?(?:casts|camps|clears)/i.test(t), t)
		assert.ok(!/enough (?:mana|health) (?:for|to)/i.test(t), t)
	}
})

/* ================================================================ the dead clock, both ways
 *
 * The payload used to state a death ONE WAY ROUND — `back in Ns`, the time remaining — and the
 * sentence a coach reaches for is the elapsed one. Measured over the 28 stored games: 153 spoken
 * lines state an elapsed death time, 71 of them contradict the client's own kill log, and the error
 * is one-sided — 101 overstate against 4 that understate, with 101 of 115 speaking a number within
 * ten seconds of the remaining figure printed beside them. The model was not inventing; it was
 * converting the only number it had, and the conversion needs a respawn length nothing here knows.
 */

/** Every line in a payload that states a respawn timer. */
const timerLines = (text: string): string[] =>
	text.split("\n").filter(l => /(?:back in|respawns in|until you are up) \d+s/.test(l))

test("every remaining-time figure in the payload has an elapsed figure beside it", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	const me = raw.data.allPlayers.find((p: any) => p.championName === "Lillia")
	me.isDead = true
	me.respawnTimer = 14.2
	raw.data.activePlayer.championStats.currentHealth = 0
	const seen = {
		Lissandra: { atSec: LISSANDRA_DIED, exact: true },
		Lillia: { atSec: raw.gameTime - 6, exact: true }
	}
	for (const payload of [
		buildDelta({ raw, gameTimeSec: raw.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, feedNotes: false, deathsSeen: seen })!,
		buildBrief({ raw, gameTimeSec: raw.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime }, deathsSeen: seen })!
	]) {
		const lines = timerLines(payload.text)
		assert.ok(lines.length > 0, "the fixture has dead men in it")
		for (const l of lines) assert.match(l, /down (?:at least )?\d+s|elapsed NOT KNOWN/, l)
	}
})

/*
 * NOT KNOWN IS A RENDERED STATE, not a gap to fill. A coach started mid-game, or a body that walked
 * into view already dead, has an unwatched death — and the only route from `respawnTimer` to an
 * elapsed figure is the respawn length, which grows with game time and is a patch value this app
 * refuses to hardcode. So the line says it does not know, and carries no second number at all.
 */
test("an unwatched death renders NOT KNOWN and no elapsed number anywhere", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false
	})!
	const line = d.text.split("\n").find(l => /Lissandra/.test(l) && /back in/.test(l))!
	assert.match(line, /Lissandra \(ENEMY\) elapsed NOT KNOWN, back in 3s/)
	assert.ok(!/down \d+s/.test(d.text), d.text)
})

test("an instant taken off the sample edge says at least, because it is a bound", () => {
	const d = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		deathsSeen: { Lissandra: { atSec: LISSANDRA_DIED, exact: false } }
	})!
	assert.match(d.text, /Lissandra \(ENEMY\) down at least 13s, back in 3s/)
})

/*
 * The record is keyed by CHAMPION, and a blind pick can put the same champion on both teams. Dating
 * one man's death by the other's is exactly the confident-wrong-number failure this whole clock was
 * built to remove, so a duplicated champion is treated as unwatched.
 */
test("a mirror matchup is NOT KNOWN rather than one man's death dating the other's", () => {
	const raw = structuredClone(cur) as { gameTime: number; data: Record<string, any> }
	raw.data.allPlayers.find((p: any) => p.championName === "Senna").championName = "Lissandra"
	const d = buildDelta({
		raw,
		gameTimeSec: raw.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime },
		feedNotes: false,
		deathsSeen: { Lissandra: { atSec: LISSANDRA_DIED, exact: true } }
	})!
	assert.match(d.text, /Lissandra \(ENEMY\) elapsed NOT KNOWN/)
})

test("the feed notes say which clock is which, once", () => {
	const b = buildBrief({ raw: cur, gameTimeSec: cur.gameTime, previous: { raw: prev, gameTimeSec: prev.gameTime } })!
	const notes = b.text.split("\n\n").find(x => x.startsWith("WHAT THIS FEED IS"))!
	assert.match(notes, /A death carries TWO clocks here and they run opposite ways/)
	assert.match(notes, /`down Ns` is how long the player has ALREADY been dead/)
})

/*
 * THE DROP IS NOT FREE, AND THE COMMENT THAT SAID IT WAS IS WHY THIS EXISTS.
 *
 * `feedNotes: false` removes 1,190 characters a turn from the payload, and both the caller in
 * `src/server/routes/live.ts` and the block itself asserted that every bullet was already in
 * `TRUSTED_PROMPT`, paid once in the system instruction.
 *
 * Checked bullet by bullet on 2026-09-12, that is true of ten of the eleven — the prompt restates
 * them in its own words, at its own length: the CS floor, the counterpart CS visibility counter,
 * enemy level accuracy, that no bar but his own is reported, that spend cannot be recovered from
 * item prices, that item lists are what is held, that the feed has no coordinates, that nobody's
 * cooldowns are knowable, that a ward score is not a ward map, and what the screenshot is.
 *
 * IT IS NOT TRUE OF THE ELEVENTH. The prompt names exactly one death clock — "every respawn timer
 * … with his timer counting down" — and never says that the payload also carries how long a man
 * has ALREADY been dead, that the two run opposite ways, or that neither can be turned into the
 * other. On the dropped path nothing anywhere distinguishes them.
 *
 * That is the standing candidate cause for the night's largest unfixed defect: the payload now
 * carries a watched elapsed figure for 129 of 129 identifiable subjects, and the coach still
 * speaks the REMAINING figure as if it were elapsed in 117 of 129 lines — 91% [84-95], UP from
 * 88% [82-93] before the payload was fixed. Fixing the input changed nothing about the output.
 *
 * These tests do not assert the gap is right. They assert what the gap IS, so that a reader asking
 * "does the model get told this?" gets the answer from the tree rather than from a comment, and so
 * that closing it fails here loudly and forces a corpus re-run rather than landing as an
 * unmeasured prompt change.
 */
test("every probe still matches its own feed note, so rewording a bullet fails here first", () => {
	const probes = [
		"floored to a multiple of ten",
		"counts only the farm your own client",
		"94.5% exact for enemies",
		"Nobody's health, mana or gold is reported except his own",
		"What anyone has SPENT is NOT knowable",
		"what a player is HOLDING now",
		"no coordinates for anyone",
		"There are no cooldowns and no summoner-spell timers",
		"TWO clocks here and they run opposite ways",
		"not a ward map",
		"a real look at his screen"
	]
	assert.equal(probes.length, FEED_NOTES.length)
	for (const probe of probes)
		assert.ok(FEED_NOTES.some(n => n.includes(probe)), `no feed note contains "${probe}" any more`)
})

test("the two-clock note is the one the trusted prompt does not restate, by every phrase it has", () => {
	/*
	 * Eight probes, not one: a single phrase could miss a restatement in the prompt's own words,
	 * which is how the other ten survive. The prompt contains NONE of these, so the explanation of
	 * the two clocks reaches the model on the payload path and on no other path at all.
	 */
	for (const phrase of [
		"TWO clocks",
		"opposite ways",
		"back in",
		"respawns in",
		"down Ns",
		"already been dead",
		"elapsed NOT KNOWN",
		"down at least"
	])
		assert.ok(
			!TRUSTED_PROMPT.includes(phrase),
			`"${phrase}" is now in TRUSTED_PROMPT — the gap is closed, so re-run the dead-clock corpus before shipping it`
		)
})

test("the prompt does name the countdown clock, which is why one number on its own reads as safe", () => {
	/*
	 * The gap is not that deaths are unmentioned — that would be obvious. It is that ONE of two
	 * opposite clocks is named and the other is not, which is the shape that produces a confident
	 * wrong number rather than a refusal.
	 */
	assert.match(TRUSTED_PROMPT, /respawn timer/)
	assert.match(TRUSTED_PROMPT, /timer counting down/)
})
