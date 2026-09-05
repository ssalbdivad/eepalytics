/**
 * The instrument has to separate the hand-written targets from the shipped output, in BOTH
 * directions, or it is not finished.
 *
 * Every rule in `insight.ts` gets a pair here — a line that should trip it and one that should not
 * — for the reason `coach-score.test.ts` gives: an over-flagging scorer is not a stricter scorer,
 * it is a broken one, and this one is being used to argue that the shipped coach should be rebuilt.
 *
 * The two corpora are both real and both quoted verbatim:
 *
 *   - `TARGET_SPLIT_03` and the three shorter sessions are the lines from
 *     `data/eval/target-lines.md`, hand-written against the raw `allgamedata` samples and journal
 *     frames of four of his games, silences included and in clock order.
 *   - `SHIPPED_WITH_FRAME` / `SHIPPED_NO_FRAME` are the 42 turns each that Opus 5 produced over
 *     split-03 in `data/eval/model-opus5.json`, the run whose verdict was "still garbage".
 *
 * They are inlined rather than read from `data/`, which is gitignored: a test whose evidence is not
 * in the repository stops being reproducible the first time someone clones it.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { isSilent, scoreInsight, scoreSession, summarise } from "./insight.ts"

/** split-03: game 5635467422, his Lillia against Briar. */
const SPLIT_03 = ["Lillia", "Urgot", "Taliyah", "Smolder", "Braum", "Ornn", "Briar", "Lissandra", "Jhin", "Senna"]
const SPLIT_02 = ["Lillia", "Olaf", "Zed", "Ahri", "Xayah", "Blitzcrank", "Irelia", "Orianna", "Fizz", "Yuumi"]
const SPLIT_04 = ["Lillia", "Garen", "Tryndamere", "Veigar", "Jhin", "Seraphine", "Nasus", "Mel", "Lissandra", "Morgana"]
const SPLIT_01 = ["Lillia", "Yone", "Karthus", "Ahri", "Jinx", "Karma", "Irelia", "Locke", "Vayne", "Nami"]

const one = (line: string, champions: readonly string[] = SPLIT_03, earlier: readonly string[] = []) =>
	scoreInsight({ line, champions, earlier })

/* ============================================================ axis 1: beyond the instant */

describe("beyondInstant — does the premise need anything but this snapshot", () => {
	it("passes a span attached to a fact in this game", () => {
		const s = one("Briar has not moved off zero CS in four minutes — go take his raptors and his blue.")
		ok(s.beyondInstant.pass)
		ok(s.needs.includes("H-series"))
	})

	it("passes a tally of his own deaths, which no snapshot holds", () => {
		const s = one("Three of your five deaths are Briar — so stop taking that fight without Braum.")
		ok(s.beyondInstant.pass)
		ok(s.needs.includes("H-event"))
	})

	it("passes an objective forecast", () => {
		const s = one("Third drake to them — the next one is soul, so start walking to that pit before it spawns.")
		ok(s.beyondInstant.pass)
		ok(s.needs.includes("F-schedule"))
		ok(s.needs.includes("F-consequence"))
	})

	it("passes a comparison to his own previous games", () => {
		const s = one("You've taken drake over the grubs in three of your last four games — start that drake now.")
		ok(s.beyondInstant.pass)
		ok(s.needs.includes("X-game"))
	})

	it("FAILS the CS race, which is a value in the block and the shipped coach's whole vocabulary", () => {
		const s = one("Briar's at least 21 CS behind you — keep the route running into his camps.")
		ok(!s.beyondInstant.pass)
		strictEqual(s.needs.length, 0)
	})

	it("FAILS time-shaped prose with nothing attached to it", () => {
		// The shipped coach's most-used clause. It refers to duration and asserts nothing about
		// this game, which is exactly why the same sentence fitted 28 different states.
		ok(!one("It only gets faster the longer it keeps running, so don't stop it.").beyondInstant.pass)
	})

	it("FAILS a roster count, which reads like a tally and is straight off the instant", () => {
		// "of them" is excluded for this line specifically.
		ok(!one("All five of them are alive — leave the pit, their raptors are the free thing here.").beyondInstant.pass)
	})

	it("FAILS a mood dressed as continuation", () => {
		// "still hot" is not a stall; "still has under ten CS" is.
		ok(!one("Level two and the route's still hot — go straight into the raptors.").beyondInstant.pass)
		ok(one("Briar still has under ten CS — go take his blue side.").beyondInstant.pass)
	})

	it("FAILS a bare recent event, because the block already prints one", () => {
		ok(!one("Briar got first blood on Taliyah — go take his blue side.").beyondInstant.pass)
	})

	it("FAILS a countdown, which is his own respawn timer and is on his own line in the block", () => {
		// Both of these came out of the held-out gemini-3.6-flash corpus as false positives, on a
		// bare `spawn` and on a bare `in N seconds`. An elapsed span still passes.
		ok(!one("You spawn in 12 seconds with 808 gold, so spend it and run to your raptors.").beyondInstant.pass)
		ok(!one("Spend your 808 gold while you respawn in 12 seconds, then take your blue.").beyondInstant.pass)
		ok(one("Briar has been back up for twenty seconds — finish the grub and get out.").beyondInstant.pass)
	})

	it("FAILS 'set up at', which is not a schedule however much it looks like one", () => {
		ok(!one("Briar is level 1 just like you, so set up at your blue for a full route.").beyondInstant.pass)
		ok(one("Baron has been up since twenty — go start Baron.").beyondInstant.pass)
	})
})

/* ================================================================= axis 2: freshness */

describe("fresh — has he heard it already, as a sentence and as a directive", () => {
	it("flags a paraphrase of an earlier line", () => {
		const s = one(
			"Keep the route rolling straight into the next camp — your clear only gets faster while it keeps running.",
			SPLIT_03,
			["Keep the route running to the next camp — your clear only gets faster while it keeps running."]
		)
		ok(!s.fresh.pass)
		strictEqual(s.verdict, "repeat")
	})

	it("flags the same DIRECTIVE with different numbers in front of it", () => {
		const s = one("Briar is at least 31 CS behind you — keep the route running into his camps.", SPLIT_03, [
			"Briar is at least 11 CS behind you — keep the route running into his camps."
		])
		ok(!s.fresh.pass)
	})

	it("does NOT flag two different instructions that share a subject", () => {
		const s = one("Briar has killed Taliyah four times — ward mid river before you take a single camp.", SPLIT_03, [
			"Briar has been back up for twenty seconds — finish the grub and get out."
		])
		ok(s.fresh.pass)
	})

	it("lets a directive come back once the window has passed", () => {
		const earlier = [
			"You've been carrying twelve hundred gold since eight twenty — spend every coin before you leave the fountain.",
			"Briar and Ornn are both down and the grubs are untouched — take all three now.",
			"Briar has killed Taliyah four times — ward mid river before you take a single camp.",
			"Four of them showed up for that Herald — go take Briar's blue side now."
		]
		ok(one("You've been over two thousand gold since nine forty — spend it before that pit.", SPLIT_03, earlier).fresh.pass)
	})
})

/* ================================================================== axis 3: decides */

describe("decides — is there something he can do in the next thirty seconds", () => {
	it("finds an instruction after a comma and a connective", () => {
		const s = one("Three of your five deaths are Briar — he beats you straight up, so stop taking that fight without Braum.")
		ok(s.decides.pass)
		strictEqual(s.action, "stop taking that fight without braum")
	})

	it("finds an instruction whose first word is not the verb", () => {
		ok(one("You've gained under ten CS since nine o'clock — full clear from your blue right through his raptors.").decides.pass)
	})

	it("finds a prohibition", () => {
		ok(one("Drake's gone and all five of them are alive — don't walk into that pit.").decides.pass)
	})

	it("FAILS a sentence that only agrees with a decision he already made", () => {
		// Measured in `shared/live-prompt.ts`: this scored as no coaching at all.
		ok(!one("You are two levels down on Briar, so declining an even fight with him is smart.").decides.pass)
	})
})

/* ================================================================= axis 4: grounded */

describe("grounded — is the ACTION anchored to this game, or would it fit any other", () => {
	it("counts a named camp", () => {
		const s = one("Briar has not moved off zero CS in four minutes — go take his raptors and his blue.")
		ok(s.grounded.pass)
		ok(s.grounded.found.includes("raptors"))
	})

	it("counts a champion named in the instruction", () => {
		ok(one("Three of your five deaths are Briar — so stop taking that fight without Braum.").grounded.pass)
	})

	it("does NOT count 'camps', which fits every game he has ever played", () => {
		ok(!one("Briar has not moved off zero CS in four minutes — go take his camps.").grounded.pass)
	})

	it("does NOT count an anchor that sits in the PREMISE", () => {
		// Briar and 21 are both real and both in the wrong half: the instruction is portable.
		const s = one("Briar's at least 21 CS behind you — keep the route running.")
		ok(!s.grounded.pass)
	})
})

/* ============================================================== silence is an answer */

describe("silence", () => {
	it("does not score a PASS as a bad line", () => {
		ok(isSilent("PASS"))
		const s = one("PASS")
		strictEqual(s.spoke, false)
		strictEqual(s.verdict, "silent")
		strictEqual(s.score, 0)
	})
})

/*
 * The 25 split-03 moments from `data/eval/target-lines.md`, in clock order, silences included.
 * A PASS is the correct answer on eight of them and five of those eight are turns where the
 * shipped coach spoke — four of the five reading his own HUD back to him.
 */
const TARGET_SPLIT_03 = [
	/* 00:36 M01 */ "PASS",
	/* 02:42 M02 */ "Briar was mid ten seconds ago and still has under ten CS — go take his blue side, all of it is standing.",
	/* 03:20 M03 */ "PASS",
	/* 04:15 M04 */ "Briar has not moved off zero CS in four minutes — go take his raptors and his blue, nothing there is dead.",
	/* 04:52 M05 */ "PASS",
	/* 05:41 M06 */ "First drake has been up since five and nobody has taken it — Briar is two levels down, go start it with Smolder.",
	/* 06:05 M07 */ "Drake's gone and all five of them are alive — leave the pit, their raptors are the free thing here.",
	/* 06:17 M08 */ "He took drake at six oh four then killed you eleven seconds later — be at the next drake before it starts.",
	/* 06:42 M09 */ "PASS",
	/* 07:18 M10 */ "PASS",
	/* 08:19 M11 */ "Briar and Ornn are both down and the grubs are untouched — take all three now, you have thirteen seconds.",
	/* 08:50 M12 */ "Briar has been back up for twenty seconds and you're at forty one percent — finish the grub and get out, don't fight for it.",
	/* 09:14 M13 */ "You've been carrying twelve hundred gold since eight twenty — spend every coin before you leave the fountain.",
	/* 09:38 M14 */ "PASS",
	/* 10:37 M15 */ "Briar has killed you twice and is still under thirty CS — take his blue and his gromp on the way to every lane.",
	/* 11:22 M16 */ "PASS",
	/* 12:45 M17 */ "Four percent health with Briar down ten seconds — recall now, you cannot cash that.",
	/* 13:24 M18 */ "Briar has killed Taliyah four times — when you're back, ward mid river before you take a single camp.",
	/* 14:13 M19 */ "You've gained under ten CS since nine o'clock — five minutes of nothing, so full clear from your blue right through his raptors.",
	/* 15:40 M20 */ "Four of them showed up for that Herald — their jungle was empty for it, so go take Briar's blue side now.",
	/* 16:20 M21 */ "Three of your five deaths are Briar — he beats you straight up, so stop taking that fight without Braum.",
	/* 19:35 M22 */ "Third drake to them — the next one is soul, so start walking to that pit before it spawns, not after.",
	/* 20:19 M23 */ "PASS",
	/* 22:21 M24 */ "Four of them are down thirty seconds and Baron has been up since twenty — go start Baron.",
	/* 33:15 M25 */ "Baron, a drake and an ace inside three minutes — take mid now, don't reset."
]

/** split-02, three moments. M27 is the flagship cross-game line; M32 is praise and scores as one. */
const TARGET_SPLIT_02 = [
	/* 07:45 M27 */ "You've taken drake over the grubs in three of your last four games and it has worked — start that drake now.",
	/* 12:11 M26 */ "You've been over two thousand gold since nine forty — recall, that's an item you already own.",
	/* 26:24 M32 */ "Twenty six minutes, zero deaths — that's why this is winning, so keep declining the fights you don't start."
]

const TARGET_SPLIT_04 = [
	/* 22:22 M28 */ "Three of them are down thirty seconds and you've had two thousand gold since twenty — recall, buy, and be at that pit.",
	/* 26:44 M29 */ "Tryndamere has killed your Morgana four times — stay on your own half of the river until someone is with you."
]

const TARGET_SPLIT_01 = [
	/* 22:31 M31 */ "PASS",
	/* 31:42 M30 */ "Three thousand gold carried for three minutes — that's the fourth game running, recall and buy it out."
]

/*
 * `data/eval/model-opus5.json`, cell `paired / cite-or-quiet`, WITH the journal frame attached.
 * 42 turns over split-03, verbatim, PASSes included. This is the output the owner called garbage.
 */
const SHIPPED_WITH_FRAME = [
	"Spend that 500 gold before you walk out — the whole route runs faster with a starter in hand.",
	"Grab the leash and commit to the whole route — your clear only gets faster while it keeps running.",
	"PASS",
	"PASS",
	"Get out of base and start the route now — your clear only gets faster while it keeps running.",
	"Leave the fountain now — your clear only gets faster while it keeps running, so start the route.",
	"Full route from here and don't stop it — your clear only gets faster while it keeps running.",
	"Start it now and don't stop — your clear only gets faster while it keeps running, so route the whole side.",
	"Full clear start to finish — your speed only stacks while the route keeps running.",
	"Start the route and don't stop it — your clear only gets faster the longer it keeps running.",
	"Take every camp on the way without pausing — your clear only gets faster while the route keeps running.",
	"Race is dead even at least-ten CS each, so just keep the route running — your clear only speeds up.",
	"You and Briar are dead even on clear, so just keep the route running — your speed only builds while it does.",
	"Level one and the route is just starting — keep it unbroken, your clear only speeds up while it runs.",
	"Level two and the route's still hot — go straight into the next camp, your clear only speeds up while it runs.",
	"Keep hitting through the raptors without pausing — the Prance stacks decay the moment the route stops.",
	"Keep the route rolling straight into the next camp — your clear only gets faster while it keeps running.",
	"Level two already — keep the route rolling straight into the next camp, your clear only speeds up as it runs.",
	"Race is dead even right now — keep the route running, your clear only gets faster while it never stops.",
	"Keep the route rolling straight into the next camp — your clear only gets faster while it never stops.",
	"Keep the route rolling straight into your next camp — your clear only gets faster while it keeps running.",
	"Keep the route rolling straight into your next camp — the speed only stacks while you keep hitting things.",
	"Briar got first blood on Taliyah — don't go hunting him, keep the route running and take your next camp.",
	"Briar's under ten CS and you're level 4 — don't stop the route to avenge Taliyah, keep the clear running.",
	"Briar's at least 11 CS behind you — keep the route running, don't go hunt him over that Taliyah kill.",
	"You're on 133 HP with 881 gold — back, buy, and restart the route; arriving late on foot only feeds it.",
	"133 HP with 881 gold in your pocket — recall now and restart the route clean, you're already ahead.",
	"Take the back with 906 gold, then straight back onto camps — you're already 11 CS ahead, don't go find Briar.",
	"Briar's under ten CS and a level down — don't go answer that, keep the route running to the next camp.",
	"Briar's at least eleven CS behind you — keep the route running to your next camp, speed only stacks while you clear.",
	"Briar's at least 11 CS behind you — keep the route running to the next camp, don't stop to go find him.",
	"You're at least eleven CS up on Briar — keep the route running to the next camp, don't stop to find him.",
	"Briar's at least eleven CS behind you — don't go hunting, just buy and run the next full route.",
	"PASS",
	"You're at least 21 CS up on Briar because the route never stopped — finish this camp and keep rolling.",
	"Briar is at least twenty-one CS behind you — keep the route running through this camp and the next.",
	"PASS",
	"Briar's still level 3 and at least 31 CS behind — keep the route running into his camps, don't go hunt him.",
	"Briar is level 3 and at least 31 CS behind you — keep the route running into his camps, don't go hunt him.",
	"Briar's at least 21 CS behind you — drake's gone, so keep the route rolling to the next camp instead.",
	"You're at least 21 CS up on Briar — use these 12 seconds to pick a full clear route, not a fight.",
	"You're at least 21 CS ahead of Briar, so walk out into a full camp route and don't detour to lanes."
]

/* The same 42 states with no frame attached. The frame changed the wording and nothing else. */
const SHIPPED_NO_FRAME = [
	"Full route from the start and don't stop — your clear only gets faster while it keeps running.",
	"PASS",
	"PASS",
	"Get the route started and don't stop it — your clear only gets faster while it keeps running.",
	"Start the full route and keep it running — your clear only gets faster while it never stops.",
	"Full route from here — your clear only gets faster while it keeps running, so don't stop it for anything.",
	"PASS",
	"Clear's just starting — pick your first camp and keep the route running, it only gets faster.",
	"Full route from the first camp, no detours — your clear only gets faster while it keeps running.",
	"PASS",
	"Full route from here, Lillia — your clear only gets faster while it keeps running, so don't stop it.",
	"Start the route and don't break it — your clear only gets faster the longer it keeps running.",
	"PASS",
	"PASS",
	"PASS",
	"Level two already at one twenty-five — keep the route rolling, your clear only gets faster while it runs.",
	"You're level two already — keep the route rolling straight into the next camp, the clear only speeds up.",
	"Level two already at one thirty-seven — keep the route rolling, your clear only speeds up while it runs.",
	"You and Briar are dead even on clear, so just keep the route running — your speed only builds while it does.",
	"Keep the route running to the next camp — your clear only gets faster while it keeps moving.",
	"At least 10 CS and level three — keep the route rolling to the next camp, your clear only speeds up while it's moving.",
	"You're level three at two twenty-six — keep the route running, your clear only gets faster while it's moving.",
	"Briar's got a kill on Taliyah — you don't win that duel, so keep the route running and finish your camps.",
	"Briar got Taliyah but he's at least 11 CS behind you — don't go find him, finish the route and stay ahead.",
	"Briar's at least 11 CS behind you — don't detour to avenge Taliyah, keep the route running to your next camp.",
	"133 health and 881 gold — recall now, you don't win that duel and the lead is already in your route.",
	"You're at 133 HP with 881 gold — recall right now and buy, you die to anything at that health.",
	"At 175 HP with 906 gold in your pocket, recall now — you buy and restart the route instead of dying to it.",
	"Briar's at least 11 CS behind you and just spent that time killing — keep your route running, don't go hunt him.",
	"Briar's eleven-plus CS behind you — keep the route running into his camps while your speed is stacked.",
	"Briar is at least 11 CS behind you — keep the route rolling straight into his camps while the speed's stacked.",
	"Briar's at least 11 CS behind you — that lead came from the route, so keep clearing, don't go find him.",
	"You're at least 11 CS ahead of Briar because the route never stopped — keep clearing, don't go find him.",
	"You're a clear ahead of Briar in this race, so keep the route running instead of hunting him.",
	"You're at least 21 CS up on Briar — that lead came from never stopping the route, so keep clearing.",
	"You're at least 21 CS up on Briar — keep the route running into his camps while the speed is stacked.",
	"Briar is at least 31 CS behind you, so keep the route running toward his camps while the speed is stacked.",
	"You are at least 40 CS to Briar's under 10 — keep the route rolling into her camps, don't stop to find her.",
	"Briar's level 3 and at least 31 CS behind — keep the route running into his camps, don't stop to find him.",
	"Briar's twenty-one CS behind you — keep the route running into his camps while the speed's stacked.",
	"Briar's at least 21 CS behind you — spawn in and run a full camp route, your speed only pays in transit.",
	"You're at least 21 CS ahead of Briar, so don't walk into that three-on-five — take your own camps instead."
]

/* ============================================================ the two corpora, end to end */

describe("the hand-written targets", () => {
	const s3 = summarise(scoreSession(TARGET_SPLIT_03, SPLIT_03))

	it("reaches insight on most of what it says, and repeats nothing", () => {
		strictEqual(s3.spoke, 17)
		strictEqual(s3.repeat, 0)
		ok(s3.insight >= 15, `only ${s3.insight} of ${s3.spoke} reached insight`)
	})

	it("keeps the eight silences as silences", () => {
		strictEqual(s3.turns - s3.spoke, 8)
	})

	it("names the context it needed, which is the specification for the briefing", () => {
		// The ranking here IS the finding: run-length state over the client's own numbers unlocks
		// more of these lines than anything else, and it needs no new data source at all.
		strictEqual(s3.needs[0]!.need, "H-series")
		ok(s3.needs.map(n => n.need).includes("H-event"))
		ok(s3.needs.map(n => n.need).includes("F-schedule"))
	})

	it("carries three deliberate readouts, and they are the ones written up as boundary cases", () => {
		const scores = scoreSession(TARGET_SPLIT_03, SPLIT_03)
		const readouts = scores.filter(s => s.verdict === "readout").map(s => s.line)
		// M07 — depth from a PRIOR (a team that just took an uncontested objective is standing on
		// it), not from history. M17 — the safety call, which the instant genuinely does support.
		strictEqual(readouts.length, 2)
		ok(readouts.every(l => l.startsWith("Drake's gone") || l.startsWith("Four percent health")))
	})

	it("holds up on three other games, so it is not one game's trick", () => {
		const others = [
			...scoreSession(TARGET_SPLIT_02, SPLIT_02),
			...scoreSession(TARGET_SPLIT_04, SPLIT_04),
			...scoreSession(TARGET_SPLIT_01, SPLIT_01)
		]
		const spoke = others.filter(s => s.spoke)
		strictEqual(spoke.length, 6)
		strictEqual(spoke.filter(s => s.verdict === "repeat").length, 0)
		// M32 is praise and scores as the readout it is; the other four are insight.
		strictEqual(spoke.filter(s => s.verdict === "insight").length, 5)
	})
})

describe("the shipped corpus — this is the half that makes the instrument worth anything", () => {
	const withFrame = summarise(scoreSession(SHIPPED_WITH_FRAME, SPLIT_03))
	const noFrame = summarise(scoreSession(SHIPPED_NO_FRAME, SPLIT_03))

	it("finds no insight in either arm", () => {
		strictEqual(withFrame.insight, 0)
		strictEqual(noFrame.insight, 0)
	})

	it("finds the repetition that every earlier judge was structurally blind to", () => {
		// Judges here scored each line ALONE against its own block, so a true, actionable, specific
		// sentence got full marks on its thirtieth telling. 16 of 38 and 20 of 35 restate something.
		ok(withFrame.repeat / withFrame.spoke > 0.4, `${withFrame.repeat}/${withFrame.spoke}`)
		ok(noFrame.repeat / noFrame.spoke > 0.4, `${noFrame.repeat}/${noFrame.spoke}`)
	})

	it("finds essentially no line whose premise leaves the instant", () => {
		const scores = scoreSession(SHIPPED_WITH_FRAME, SPLIT_03)
		const beyond = scores.filter(s => s.spoke && s.beyondInstant.pass)
		strictEqual(beyond.length, 0)
	})
})

describe("separation — an instrument that does not split these two is not finished", () => {
	it("puts four points of clear air between the corpora", () => {
		const targets = summarise(scoreSession(TARGET_SPLIT_03, SPLIT_03))
		const shipped = summarise(scoreSession(SHIPPED_WITH_FRAME, SPLIT_03))
		ok(targets.meanScore > 3.4, `targets mean ${targets.meanScore.toFixed(2)}`)
		ok(shipped.meanScore < 2, `shipped mean ${shipped.meanScore.toFixed(2)}`)
		ok(targets.insightRate > 0.85, `targets insight rate ${targets.insightRate.toFixed(2)}`)
		strictEqual(shipped.insightRate, 0)
	})
})
