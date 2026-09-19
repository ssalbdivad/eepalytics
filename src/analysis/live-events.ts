/**
 * WHEN the coach is asked to speak — the only decision this file makes.
 *
 * ## The problem this exists to solve
 *
 * The live coach spoke on a clock. At the shipped twenty-second beat that is 85 invitations in a
 * 28-minute game; at `TRUSTED_TURN_MS` (6s) it is 282. The post-game reviewer, graded blind against
 * the same game, picks SEVEN items out of the whole match and was scored 68% useful against the
 * live coach's 0/10 — "nothing it said was useful, generic and often hilariously wrong".
 *
 * Part of that gap is data (the counterpart-CS bug, the discarded minimap read) and part of it is
 * hindsight, which cannot be recovered. But a large part is neither: **a coach asked 85 times has
 * to produce something 85 times, and there are not 85 things worth saying in a game of League.**
 * Asked at a moment when nothing has changed, the only honest material left is what is already on
 * his screen, so it reads his HUD back to him. That is the failure, and it is a property of the
 * question, not of the answer.
 *
 * So the timer is replaced by this: **the turn fires when something happens.** The selection problem
 * the post-game reviewer solves by looking at all 28 minutes at once, the live coach solves by only
 * being asked when the feed says the game moved.
 *
 * ## THE SECOND CUT: "something happened" was not enough
 *
 * The first version of this list fired on a death, an objective, a fight resolving, a spike, an
 * item, a resource threshold and the counterpart surfacing. Replayed over the recorded samples of
 * game 5639406342 that is **68 turns in 28 minutes — one every 25 seconds, against the timer's own
 * 20.** The timer with extra steps.
 *
 * A 23-turn subsample of that schedule was then run through the real socket and read line by line
 * (`data/eval/stream-kayn-events-20260910.json`). Five lines were useful, twelve were true and
 * useless, six were false. Sorted by the event that ASKED, the twelve useless ones are not spread
 * evenly at all:
 *
 * | asked by             | useful | useless | false |
 * |----------------------|-------:|--------:|------:|
 * | `fight.resolved`     |      1 |       5 |     1 |
 * | `resource.low`       |      0 |       4 |     0 |
 * | `objective.window`   |      0 |       2 |     0 |
 * | `level.spike`        |      0 |       0 |     2 |
 * | `counterpart.seen`   |      0 |       0 |     1 |
 * | `game.start`         |      0 |       1 |     0 |
 * | `heartbeat`          |      0 |       0 |     1 |
 * | `death.counterpart`  |      1 |       1 |     1 |
 * | `respawn.self`       |      1 |       0 |     1 |
 * | `counterpart.unseen` |      1 |       0 |     0 |
 * | `objective.taken`    |      1 |       0 |     0 |
 * | `item.completed`     |      1 |       0 |     0 |
 *
 * (Three of the 23 turns carried two causes and are counted under both, so the columns sum to 26.)
 *
 * Every one of the twelve useless turns had an objective clock sitting unused in the same payload —
 * "drake in 22s", "drake untaken 39s", "drake in 14s". The material was there. The MOMENT was
 * wrong, and the moment is the only thing this file chooses.
 *
 * ## The rule the second cut is made on: CONTESTABLE FUTURE STATE
 *
 * The app's two tests for what may be SAID — not visible, not generic — applied to when it is
 * ASKED, and sharpened by what the five useful lines had in common. Four of the five were
 * PROSPECTIVE: they named something that had not happened yet and a decision that was still open.
 * The best line the app has produced live is 18:08 "Kayn just secured Herald, so path botside
 * immediately and get ready to contest this drake spawning in thirty seconds" — his position joined
 * to an objective clock, which is exactly what the post-game reviewer's best items do.
 *
 * So a thing earns a turn when it opens or closes a decision about something that has not happened
 * yet:
 *
 *   - an objective entering the window where the decision is still open, or sitting up and untaken
 *     past it;
 *   - the counterpart dying or going dark, which is what makes that window contestable;
 *   - his own capability changing — out of the fountain, an ultimate, a legendary — because that
 *     changes what he can DO about the thing that is coming.
 *
 * And a thing does NOT earn a turn when it is a reading he already has:
 *
 *   - **`resource.low` is deleted.** A health bar and a mana bar are the two things he is
 *     unambiguously looking at. Four of the twelve useless lines were his own HP or mana read back
 *     to him, and four separate "you are low, back now" turns in one game is the timer's failure
 *     reproduced. The bands survive as `HP_LOW`/`MANA_LOW` because the brief still PRINTS them; they
 *     no longer ASK anything.
 *   - **`fight.resolved` is deleted.** What a trade bought is retrospective — it is the post-game
 *     reviewer's job — and by the time the killing has stopped for eight seconds he has watched the
 *     recap on his own screen. It was the single largest source of volume (15 of 68 turns) and the
 *     worst hit rate in the graded sample: 1 useful in 6, and that one line was about his completed
 *     items and the drake clock rather than about the fight.
 *   - **`counterpart.seen` is deleted, `counterpart.unseen` is kept.** His ABSENCE is the one thing
 *     about the enemy jungler that no screen can tell him. His presence usually IS the screen
 *     telling him — the counter that detects it only moves because somebody on his team has eyes on
 *     the man.
 *   - **`death.self` no longer asks anything.** He is looking at a grey screen and cannot act for
 *     10-45 seconds; the fork in the road is the RESPAWN, and that is the turn the graded run scored
 *     useful. The killer's name is carried forward onto it rather than lost.
 *   - **`level.spike` keeps only the ultimate levels.** 2 and 3 arrive on his own clear by
 *     construction and change no route; 6, 11 and 16 unlock or rank up the ultimate.
 *
 * Two things are ADDED, both prospective:
 *
 *   - **`objective.contested`** — the objective is up and nobody has taken it. The recorded game had
 *     Baron standing for 209 seconds and Herald for 182, and the old list had no way to ask about
 *     either: it fired once, 45 seconds BEFORE the spawn, and then never again.
 *   - **grubs count as an objective taken**, as one turn per cluster rather than three. They are a
 *     jungler's objective and the old list ignored `HordeKill` entirely.
 *
 * `item.completed` is kept and its detection is repaired — see `ITEM_SPIKE_GOLD`. It was firing on
 * the wrong things: over the whole recorded game it fired exactly once, on a Needlessly Large Rod,
 * and missed both legendaries.
 *
 * Replayed over the same samples the SECOND CUT is **38 turns in 28 minutes — one every 44 seconds,
 * against the first list's 68 and the timer's 85.** (The third cut takes that to 28 — see below.)
 * The composition is the point rather than the count:
 * `objective.taken` 9, `objective.window` 7, `respawn.self` 7, `objective.contested` 5,
 * `counterpart.unseen` 3, `death.counterpart` 3, `item.completed` 3, `level.spike` 2, `game.start`
 * 1, heartbeat 0. Twelve of the 38 are an objective he has not yet decided about, where the old
 * list had seven. See `scripts/bench-events.ts`, which is where every number here comes from rather
 * than an estimate.
 *
 * Against the 23 graded lines of ROUND 1, replayed turn by turn: **9 of the 12 true-but-useless
 * turns no longer fire, 4 of the 6 false ones no longer fire, and 4 of the 5 useful ones survive.**
 * The
 * useful one lost is 17:38 "you have your Liandry's done and a Codex so finish that recall, then
 * look for a play around the drake spawning in a minute", which was asked by `fight.resolved`; the
 * drake window it is actually about now asks at 17:56, eighteen seconds later, and Liandry's
 * completing now asks its own turn at 10:32 where before it asked nothing. That is the trade, and
 * it is a trade rather than a free win.
 *
 * ## THE THIRD CUT: the WINDOW is the unit, not the event
 *
 * The second cut's 38 turns were run through the real socket and read line by line
 * (`data/eval/stream-kayn-events2-20260910.json`, 38 asks, 37 lines, one PASS). His own blinded
 * grading: **10 useful.** Every one of the ten is the same object —
 *
 *   4:20  Kayn just got Yone again so he's on the top side, which gives you a free shot to set up
 *         the drake spawning in 39 seconds.
 *   8:42  Kayn just died, so while he's off the map you have twelve seconds to finish kiting this
 *         raptor camp towards mid for a gank.
 *  21:05  Baron is still free with Kayn and Draven dead, but you are too low to take it, so back
 *         immediately, pick up your item, and then force it.
 *
 * — a WINDOW (an objective clock or a death timer), WHERE the contest will be, and WHETHER HE CAN
 * BE THERE, resolved into one action. Twenty-five of the 38 lines were prospective and only ten
 * were useful, so prospective is necessary and not sufficient. What separates them is that the ten
 * are each ONE DECISION ABOUT ONE CONTESTABLE WINDOW.
 *
 * And the dominant remaining fault, ahead of fabrication, was REPETITION: **three drake lines in
 * nineteen seconds** (18:02 off a Herald take, 18:08 off the counterpart going dark, 18:21 off
 * level 11 — all three about the drake spawning at 18:41), three herald lines in 67 seconds, three
 * wave-clear lines in 30. Twenty of the 37 lines were true and useless.
 *
 * Those are the same fact. The second cut asked PER EVENT, and several events can be about one
 * decision, so a coach with one thing to say was asked to say it three times. **The unit was
 * wrong.** So:
 *
 *   - A **contest window** is one objective INSTANCE while the decision about it is still open. It
 *     opens when the contest becomes decidable — the objective comes inside the range where he
 *     could still get there (`OBJECTIVE_LEAD_SEC`, or the reachability port's own ETA once that
 *     module lands — see `ReachFn`), it is standing untaken, or he walks out of the fountain with
 *     it as the soonest thing on the map (`RESPAWN_HORIZON_SEC`).
 *   - **ONE ASK PER WINDOW.** A second ask is paid for by `materialDiff` over a `WindowMark`: he
 *     died and came back, the counterpart died, the counterpart resurfaced, two of the enemy went
 *     down, he backed, another objective fell, or his reach flipped. Every field is a counter or a
 *     debounced verdict with its threshold declared next to it. The CLOCK is not in there, and his
 *     bars are not in there.
 *   - **A window that closes without an ask is fine**, and so is a quiet stretch. The grubs can
 *     spawn, stand and fall while he is on a grey screen and nothing is asked, because none of it
 *     was his decision.
 *   - Everything else this file detects — the item, the level, the counterpart going dark, the
 *     respawn, the resolved fight, the trip to the shop — is still DETECTED and still RIDES the
 *     turn, and none of it causes one. See `LiveEvent.asks`.
 *
 * ### What it measured, on the recorded game and not on an estimate
 *
 * Replayed over the same samples round 2 ran on (`data/live-samples/js-mtvxb5f4-f81a-t29817812`):
 * **28 asks against round 2's 38**, and against the fixed timer's 85.
 *
 *   - **ALL TEN useful moments survive.** Every one still gets an ask within 1.5s of the clock it
 *     was asked at.
 *   - **18 of the 28 turns that did not produce a useful line no longer fire** — every
 *     `counterpart.unseen` turn, both `level.spike` turns, all three `item.completed` turns, both
 *     inhibitor turns, three of the four late respawns, and the 6:04 / 9:00 / 16:00 re-asks about a
 *     window that had already been asked about.
 *   - The three drake lines in nineteen seconds become **two** (17:56 opens the window, 18:02
 *     re-asks it because Herald fell topside). Both of those two were graded useful; 18:08 and
 *     18:21 are gone.
 *   - It adds **eight asks round 2 did not make**, each with a named material cause: two
 *     heartbeats, two on the counterpart resurfacing, three on the enemy team opening up, one on
 *     him backing. Whether those are worth hearing is not something a replay can answer.
 *   - Asks per window over that game: Baron 5 across the 209 seconds it stood, Herald 5 across six
 *     minutes, grubs 5, the four drakes 1/3/4/1.
 *
 * The false/useless partition of round 2's other 27 lines is NOT in the run file — only his ten
 * useful ones were recorded — so "18 of 28 gone" counts every turn that did not produce a useful
 * line, and no claim is made here about which of them were false.
 *
 * Across all sixteen recorded sample files (482 minutes, several of them multi-game): 553 asks, 45
 * of them heartbeats, gaps median 55s, p90 164s, p95 183s. Roughly one ask a minute.
 *
 * The one thing that had to be widened rather than narrowed is `RESPAWN_HORIZON_SEC`, and the two
 * fields that were measured and replaced are written up on `WindowMark`. Both are there because the
 * first version of this cut lost a useful line and the replay said which one.
 *
 * ## THE FOURTH CUT: the queue was first-come-first-served, and attention is not
 *
 * The third cut got the UNIT right and left the ORDER alone. A window is one decision, and the
 * detector raises windows into a queue that `dueTurn` drains in the order they arrived — so two
 * decisions open at once are two turns, in whatever order the feed happened to produce them, and a
 * lull with one decision standing in it is no turns at all. Both failures are in the graded game,
 * six minutes apart, and they are the same missing idea.
 *
 * **The cluster.** 17:51 (Herald standing 171s — he backed), 17:57 (drake window opens), 18:03
 * (that drake, and Kayn has just TAKEN the Herald top side). The third is the best moment in the
 * corpus: the take both locates the enemy jungler and makes the drake free, and the ground-truth
 * block at 18:02 carried every ingredient, complete and one second old. **The coach said PASS**,
 * having spent a sentence twice in the previous twelve seconds. Three questions, one decision, and
 * the sentence was gone before the decision was worth anything.
 *
 * **The hole.** 4:21 to 7:17 — two minutes fifty-six seconds with nothing asked — and the drake
 * spawned at 5:00 and stood untaken for most of it. `materialDiff` prices a second ask on something
 * having CHANGED, and an objective standing changes nothing, so the longest open decision in the
 * first ten minutes was the one stretch the coach was never asked about.
 *
 * So the fourth cut gives the schedule a notion of what an ask is WORTH (`analysis/live-schedule.ts`)
 * and three things to do with it:
 *
 *   - **A SETTLE.** A standing ask waits up to `SETTLE_SEC` (12s) before going out, and only when
 *     the clock says another contest window is about to OPEN — an epic's spawn is the one thing
 *     about the future this feed knows exactly, so the lookahead (`nextOpeningSec`) never guesses.
 *     Everything reactive is exempt and fires on the tick it is detected.
 *   - **PREEMPTION.** A materially bigger ask (`PREEMPT_RATIO`, 1.4x what was on the table when the
 *     wait started) ends the wait immediately, so 18:03 goes out at 18:03 BECAUSE the Herald take
 *     promoted it, not because a deadline happened to land there. The heartbeat yields under the
 *     same lookahead, since a floor that asks about nothing in particular should never spend the
 *     sentence six seconds before a real window opens.
 *   - **`window.standing`.** An objective still up after `STANDING_SILENCE_SEC` (90s) of the coach
 *     being asked NOTHING, with nothing queued. Gated on the silence rather than on a clock, which
 *     is what keeps it from becoming the timer this file replaced: any turn at all resets it, so in
 *     an ordinary minute of League it is unreachable.
 *
 * ### What it measured, on both paired games and not on an estimate
 *
 * Replayed over 5639406342 (Kayn, 28:14) and 5639409343 (Fiddlesticks, 31:15) — the two games the
 * live coach was graded on — against the same schedule with the cut switched off
 * (`scripts/bench-events.ts --base`). **Five turns in an hour of play move, and every other one is
 * unchanged to the second:**
 *
 *   - **28 -> 28 turns** on Kayn. 17:51 and 17:57 are absorbed into ONE turn at 18:03 carrying all
 *     three asks, and it has **67 seconds of quiet in front of it** where round 2 gave it six.
 *     Added: 5:52, over the drake that had then been standing 52s, and 10:14, over grubs standing
 *     134s.
 *   - **29 -> 30 turns** on Fiddlesticks. Added 5:47 (the same drake shape) and 21:07 (Baron up
 *     67s); removed the 10:21 heartbeat, worth 8 and about nothing, which yielded to the drake
 *     window that opened six seconds later.
 *   - **Nine of his ten graded-useful moments still get a turn at their own clock.** The tenth,
 *     17:57, is the drake window that the settle holds for six seconds so it can go out WITH the
 *     Herald take — the same window, the same decision, asked once instead of twice.
 *     `live-events.test.ts` asserts exactly that and nothing looser.
 *
 * Across all twenty recorded sample files (565 minutes): **632 -> 661 turns (+4.6%)**, 48 -> 46
 * heartbeats, 46 standing-opportunity asks in total — about one per ten minutes of play. The gap
 * distribution moves where it was supposed to and nowhere else: median 55s -> 49s, p75 85s -> 85s,
 * **p90 171s -> 128s**, p95 183s -> 183s. It is a cut at the long tail of silence, not a faster
 * cadence.
 *
 * That +4.6% is the honest price. Two of the three mechanisms REMOVE turns and one adds them; the
 * standing ask is worth more than the settle saves, and a replay cannot say whether a line spoken
 * into a lull is worth hearing. What a replay CAN say is that the 18:02 payload now arrives at a
 * coach that has been quiet for over a minute, and that nothing his grading called useful was lost.
 *
 * `objective.window` and `objective.contested` are deleted here — see `LiveEventKind`. The third cut
 * left them detecting things the window record already knew, with `asks` false so they could not
 * reach the model and no reader for their notes.
 *
 * ## What this file is NOT
 *
 * It is not a rate limit and it is not a guardrail. It never tells the model what to say, it never
 * tells it whether it has permission to speak, and it never suppresses a line the model produced.
 * The model still decides everything about the line INCLUDING whether to take the turn at all —
 * a turn it declines is silence, exactly as today. This changes only the moment the question is
 * asked, which was always the harness's decision and was always arbitrary.
 *
 * The distinction matters because the pace floor (`analysis/speak-pace.ts`) is the other thing,
 * and it was deliberately removed under `trusted`: that one watched the OUTPUT and refused to let
 * a written line be spoken. Nothing here looks at a line. If the event-driven coach still talks too
 * much, the fix is fewer event kinds or a longer absence window — both of which are statements
 * about the game — and not a clock over the model's mouth.
 *
 * ## The heartbeat is a FLOOR, not a cadence
 *
 * `HEARTBEAT_SEC` is the longest the coach may go without being asked anything. It is a ceiling on
 * silence, and it is reset by any turn — so in a busy game it never fires at all, and in a quiet
 * one it is the only thing firing. Read as a cadence it would be a slower timer, which is the
 * design being replaced. See the constant for how the number was chosen, and for why the second cut
 * had to move it.
 *
 * The third cut did NOT move it again, and the honest figure is that it now sits AT p95 of the ask
 * gaps rather than above it: 45 of 553 asks across the corpus are heartbeats, and 2 of the 28 in
 * the graded game (3:02 and 26:53). That is a floor doing its job in a quiet stretch rather than a
 * cadence, but it is closer to the ordinary lull than it was, and it is the first number to look at
 * if the coach starts sounding like a timer again.
 *
 * ## Everything here is pure
 *
 * `analysis/` does no I/O and calls no model. `projectTick` turns one raw `allgamedata` payload
 * into the small structure the detector diffs, `observeTick` diffs two of them, and `dueTurn`
 * answers one question. That is what makes the whole policy replayable against the recorded
 * samples in `data/live-samples/` — see `scripts/bench-events.ts`, which is where the turn counts
 * quoted above and in that script's output come from.
 */
import { assistersAreReadable } from "../shared/schema/live.ts"
import type { LiveAllGameData } from "../shared/schema/live.ts"

/* ============================================================ the tick */

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

/** One other player, as much of them as this feed actually knows. */
export interface TickPlayer {
	/** The riotId/summoner name. The event log names participants this way, so it is the join key. */
	name: string
	champion: string
	team: string
	position: string
	level: number
	kills: number
	deaths: number
	assists: number
	/**
	 * NOT their farm. For anyone but the local player this counter only advances when HIS client
	 * witnessed the kill — measured on game 5639406342, Kayn's feed read 70 against a true 183.
	 * It is used here for exactly one thing it IS sound for: a change means somebody on his team
	 * has eyes on that player RIGHT NOW. See `counterpart.seen`.
	 */
	seenCs: number
	dead: boolean
	respawn: number
	itemCount: number
}

export interface TickMe {
	/**
	 * His BARE game name, which is the only name the event log ever uses.
	 *
	 * This field used to hold `activePlayer.riotId` — verified `"Gooskaffur#NA1"` — while the event
	 * feed names people by `riotIdGameName`, verified `"Gooskaffur"`. So `e.victim === tick.me.name`
	 * was structurally false and the `death.self` branch of the kill log was dead code: replayed
	 * over game 5639406342 the scoreboard has 7 deaths, 0 log entries match the tagged name and 7
	 * match the bare one. Every `death.self` that fired came from the `isDead` diff further down,
	 * whose own comment says it exists as a backstop for turret executes — so the highest-value
	 * moment in the game fired up to one 2-second tick late, stamped `atSec: now` instead of the
	 * event's own clock, and lost the killer's name out of its note.
	 *
	 * It is the join key for the whole file, so it is the bare name for him exactly as it is for
	 * everybody else. `riotId` is kept separately in `taggedName`, and only `projectTick` uses it —
	 * to find his row, which is the one place the tagged form is the right one.
	 */
	name: string
	/** `activePlayer.riotId`, which matches the ROSTER rows and never the event log. */
	taggedName: string
	champion: string
	team: string
	level: number
	hp: number
	maxHp: number
	/** The resource bar. `manaType` is `"MANA"` only for champions that actually have mana. */
	mana: number
	maxMana: number
	manaType: string
	/** Gold in his pocket, not gold earned. */
	gold: number
	dead: boolean
	respawn: number
	cs: number
	kills: number
	deaths: number
	assists: number
	/** Item display names in slot order, so a completion can be spotted by NAME rather than by value. */
	items: string[]
	itemPrices: number[]
}

export interface TickEvent {
	id: number
	name: string
	atSec: number
	killer: string | null
	victim: string | null
	assisters: string[]
	dragonType: string | null
	stolen: boolean
}

/** The projection of one raw `allgamedata` poll — everything the detector needs and nothing else. */
export interface LiveTick {
	gameTimeSec: number
	me: TickMe
	players: TickPlayer[]
	events: TickEvent[]
}

import { type TurnChoice, chooseTurn, FIELD_CP_MIN_SEC, SETTLE_SEC } from "./live-schedule.ts"

const readItems = (v: unknown): { names: string[]; prices: number[] } => {
	const names: string[] = []
	const prices: number[] = []
	for (const raw of arr(v)) {
		const it = rec(raw)
		if (!it) continue
		names.push(str(it.displayName) ?? "?")
		prices.push(num(it.price) ?? 0)
	}
	return { names, prices }
}

/**
 * Raw feed -> tick. Returns null when there is no game to read, which is most of the time this is
 * called: the socket is open from champion select and :2999 answers nothing until the game starts.
 */
export const projectTick = (data: LiveAllGameData | null | undefined): LiveTick | null => {
	const d = rec(data)
	if (!d) return null
	const gameTimeSec = num(rec(d.gameData)?.gameTime)
	if (gameTimeSec === null) return null
	const active = rec(d.activePlayer)
	/*
	 * TWO NAMES, because the client uses two and they are not interchangeable.
	 *
	 * `activePlayer.riotId` is TAGGED ("Gooskaffur#NA1") and matches the roster rows' `riotId` and
	 * `summonerName`. The EVENT log names participants by bare game name ("Gooskaffur"), which is
	 * the roster's `riotIdGameName`. Joining across the two was the bug this split fixes — see
	 * `TickMe.name`.
	 */
	const myTagged = str(active?.riotId) ?? str(active?.summonerName)
	if (!myTagged) return null

	const players: TickPlayer[] = []
	let mine: Record<string, unknown> | null = null
	for (const raw of arr(d.allPlayers)) {
		const p = rec(raw)
		if (!p) continue
		const name = str(p.riotIdGameName) ?? str(p.summonerName) ?? str(p.riotId) ?? ""
		const isMe = (str(p.riotId) ?? str(p.summonerName) ?? "") === myTagged
		if (isMe) mine = p
		const scores = rec(p.scores) ?? {}
		players.push({
			// HIS ROW IS NAMED LIKE EVERY OTHER ROW. It used to take the tagged form, so
			// `tick.players.find(p => p.name === e.victim)` never found him and `championOf`
			// rendered his own kills as "Gooskaffur killed Kayn" rather than "Lillia killed Kayn".
			name,
			champion: str(p.championName) ?? "?",
			team: str(p.team) ?? "?",
			position: str(p.position) ?? "",
			level: num(p.level) ?? 0,
			kills: num(scores.kills) ?? 0,
			deaths: num(scores.deaths) ?? 0,
			assists: num(scores.assists) ?? 0,
			seenCs: num(scores.creepScore) ?? 0,
			dead: p.isDead === true,
			respawn: num(p.respawnTimer) ?? 0,
			itemCount: arr(p.items).length
		})
	}
	if (!mine) return null

	const stats = rec(active?.championStats) ?? {}
	const myScores = rec(mine.scores) ?? {}
	const items = readItems(mine.items)
	const me: TickMe = {
		name: str(mine.riotIdGameName) ?? str(mine.summonerName) ?? myTagged,
		taggedName: myTagged,
		champion: str(mine.championName) ?? "?",
		team: str(mine.team) ?? "?",
		level: num(mine.level) ?? num(active?.level) ?? 0,
		hp: num(stats.currentHealth) ?? 0,
		maxHp: num(stats.maxHealth) ?? 0,
		mana: num(stats.resourceValue) ?? 0,
		maxMana: num(stats.resourceMax) ?? 0,
		manaType: str(stats.resourceType) ?? "",
		gold: num(active?.currentGold) ?? 0,
		dead: mine.isDead === true,
		respawn: num(mine.respawnTimer) ?? 0,
		cs: num(myScores.creepScore) ?? 0,
		kills: num(myScores.kills) ?? 0,
		deaths: num(myScores.deaths) ?? 0,
		assists: num(myScores.assists) ?? 0,
		items: items.names,
		itemPrices: items.prices
	}

	const events: TickEvent[] = []
	for (const raw of arr(rec(d.events)?.Events)) {
		const e = rec(raw)
		const id = e && num(e.EventID)
		const name = e && str(e.EventName)
		if (!e || id === null || !name) continue
		events.push({
			id,
			name,
			atSec: num(e.EventTime) ?? gameTimeSec,
			killer: str(e.KillerName),
			victim: str(e.VictimName),
			/* Empty on a drake, baron, herald or voidgrub: the feed's list there is everyone who
			 * damaged the monster and names the other team 22.9% of the time. See
			 * `assistersAreReadable`. Nothing downstream may launder it back in. */
			assisters:
				assistersAreReadable(name) ?
					arr(e.Assisters).map(a => str(a) ?? "").filter(a => a !== "")
				:	[],
			dragonType: str(e.DragonType),
			stolen: str(e.Stolen) !== null && str(e.Stolen) !== "False"
		})
	}

	return { gameTimeSec, me, players, events }
}

/* ============================================================ the events */

/**
 * Every kind of thing that earns the coach a question.
 *
 * The list is short on purpose and every entry answers the same question: **has a decision about
 * something that has not happened yet just opened or closed?** A fact that is merely TRUE — his
 * gold total, his health bar, the drake timer sitting where it has been for two minutes — is not on
 * it, because it was true a moment ago too and asking about it is what produced the HUD recital.
 *
 * The kinds the SECOND cut removed are in the module docblock with the numbers that removed them.
 * They are gone rather than demoted.
 *
 * The THIRD cut demoted rather than removed, and the FOURTH cut then removed what the demotion had
 * left inert. `respawn.self`, `objective.taken` and the rest are still here and still fire, because
 * a material change has to be DETECTED before it can be compared and because their notes ride the
 * turn — what changed in the third cut is that `asks` is false on all of them, so they ride a
 * turn and never cause one. Read this list with `LiveEvent.asks` next to it.
 *
 * The FIFTH cut demoted two more, on the 28-game corpus with every turn rejoined to the ask that
 * raised it, and the SIXTH change reversed half of it. `game.start` produced 0 useful lines in 28
 * games and 0 rescuable ones, and it stays demoted. `death.counterpart` was the only ask in the
 * corpus with more wrong lines than useful ones — and splitting those wrong lines by the instrument
 * that convicted them showed the judge faulting its ADVICE in 10% [4-21] of them, at the pooled
 * rate, with the rest wrong only in a death clock. Cutting it deleted 1.50 good questions per game
 * to remove 0.36 real errors, and deleted the turns any future run would need to settle the
 * question, so it asks again. The numbers are at their own fire sites.
 *
 * `objective.window` and `objective.contested` are GONE, and they are the fourth cut's deletion
 * rather than another demotion. Once the window record owned the asking they detected nothing the
 * window did not already know — the first duplicated `window.open` and the second duplicated the
 * new `window.standing` — and with `asks` false neither could reach the model, neither carried a
 * value, and nothing in the app read their notes: they appeared in a turn only as a number in
 * `describeTurn`'s "+N carried". Inert code that looks like coverage is worse than no code, because
 * the next person to read this list counts fourteen kinds of attention and there were twelve.
 */
export type LiveEventKind =
	/* ---- the three that ASK unconditionally. Every one of them is one contest window. ---- */
	| "window.open"
	| "window.changed"
	| "window.standing"
	| "heartbeat"
	/* ---- the floor under silence inside the five minutes that decide his games. See `HINGE_SILENCE_SEC`. ---- */
	| "hinge.silence"
	/* ---- the two FIELD decisions, which ask only in the open ground. See `fieldAsks`. ---- */
	| "respawn.self"
	| "level.spike"
	| "item.completed"
	/* ---- the rest are MATERIAL and CONTEXT. They ride a turn; they never cause one. ---- */
	| "game.start"
	| "death.counterpart"
	| "objective.taken"
	| "fight.resolved"
	| "shop.trip"
	| "counterpart.unseen"

export interface LiveEvent {
	kind: LiveEventKind
	/**
	 * Does this event CAUSE a turn, or merely ride one?
	 *
	 * The third cut's whole mechanism. `observeTick` still detects everything it detected before —
	 * the item, the level, the counterpart going dark — because the fault panel, the transcript and
	 * the bench all read those notes, and because a material change has to be DETECTED before it can
	 * be compared. What changed is that only four kinds answer true here, and `dueTurn` asks on
	 * nothing else. See the module docblock for the nine round-2 turns that measurement removes.
	 */
	asks: boolean
	/** The contest window this belongs to, when it belongs to one. For the bench's per-window tally. */
	windowKey: string | null
	/** The game clock at which the thing became true — NOT when it was noticed. */
	atSec: number
	/**
	 * The game clock at which the DETECTOR saw it, which is a different number and is the one the
	 * schedule runs on.
	 *
	 * `atSec` is the subject's own clock: for a window it is the SPAWN, which can be forty-five
	 * seconds in the future, and for a kill it is the log's timestamp, which can be minutes in the
	 * past. Neither answers "how long has this question been waiting", and the settle in
	 * `live-schedule.ts` is entirely a statement about how long it has been waiting.
	 */
	seenAtSec: number
	/**
	 * REACTIVE means the value of the line decays in seconds: a respawn, the counterpart dying. The
	 * caller skips the minimap read in front of these, because that read costs 1.3-3.0s and
	 * `analysis/live-facts.ts` measured reactive premises 40% stale at ONE second. Standing events
	 * (objective windows, spikes, items) are worth the read: it is what turns "drake in 45s" into
	 * "drake in 45s and you are in their topside jungle".
	 */
	reactive: boolean
	/** Fired at most once. Carries the identity of the thing, not the moment it was noticed. */
	key: string
	/** One short line, for the fault panel and the bench. Never sent to the model. */
	note: string
}

/* ------------------------------------------------------------ constants */

/**
 * The longest the coach may go without being asked ANYTHING. A floor under silence, not a cadence.
 *
 * Measured, not picked — and the second cut had to MOVE it, which is the part worth writing down.
 * Removing three quarters of the event volume stretches the gaps between the turns that remain, so
 * a floor left where it was would have quietly refilled the silence the cut had just created. At
 * the old 90 seconds the fourteen recorded games in `data/live-samples/` produce 4-14 heartbeats
 * each under the new list, which is a third of the schedule asked about nothing in particular.
 *
 * Replayed over those games, the gaps between EVENT-driven turns (n=679) are median 43s, p90 104s,
 * p95 141s, max 244s. 180 therefore sits above p95: it fires 0-2 times in a whole game, 0 times in
 * the graded game 5639406342, and every time it does fire it is a genuine lull rather than an
 * ordinary one. Below about 150 it stops being a floor and starts being a slower timer, which is
 * the design being replaced.
 *
 * 180 seconds is also the shape of the thing it protects against, which is a player concluding the
 * coach is broken. A jungle clear is about three minutes, so at worst he hears from her once while
 * doing one — and in practice something on the list fires long before that.
 */
export const HEARTBEAT_SEC = 180

/**
 * How far ahead of a spawn the coach is asked about it.
 *
 * The prospective twin of the post-game reviewer's best items. "Cloud fell at 13:41 while you were
 * in base" is hindsight and unreachable live; "Cloud in 45s, you are bot with 100g" is the same
 * join, asked in time to matter. 45s is a jungler's actual decision horizon: long enough to cross
 * the map or reset, short enough that the answer has not changed by the time he hears it.
 */
export const OBJECTIVE_LEAD_SEC = 45

/**
 * Standard respawn/spawn schedule. These MUST agree with `shared/live-brief.ts`, which owns the
 * wording sent to the model; this file only decides when to ask. Duplicated rather than imported
 * because `shared/` may not import `analysis/` and the brief keeps them private.
 *
 * RE-DERIVED, both copies, from every timeline in `data/blobs` — see
 * `shared/live-brief-schedule.test.ts`, which fails when a patch moves one. Grubs were 300 and
 * Herald 840 here as well as in the brief, from an older patch: across 279 HORDE kills the earliest
 * is 8:06 and across 89 RIFTHERALD kills the earliest is 15:27, so they spawn at 8:00 and 15:00.
 * The consequence HERE is different from the consequence in the brief and quieter: this schedule
 * decides WHEN the coach is asked, so the old numbers spent an objective turn three minutes before
 * the grubs existed and used up its `fired` key doing it, and then had no turn left for the real
 * spawn.
 */
export const DRAKE_RESPAWN_SEC = 300
/** The FIRST drake, which happens to share the respawn interval — named so the two cannot drift. */
export const DRAKE_FIRST_SPAWN_SEC = 300
export const BARON_RESPAWN_SEC = 360
export const GRUBS_SPAWN_SEC = 480
export const HERALD_SPAWN_SEC = 900
export const BARON_SPAWN_SEC = 1200

/**
 * When an objective stops being contestable because it leaves the map.
 *
 * Needed by every rule that reads a thing as STANDING — `window.open`'s standing opening, and
 * `window.standing`. Without a despawn the grubs would read as up and untaken from 8:00 until the
 * end of the game and Herald from 15:00 forever, and the coach would be asked about monsters that
 * are not there. Grubs leave at 14:00 and
 * Herald at 20:00, when Baron takes the pit.
 */
export const GRUBS_DESPAWN_SEC = 840
export const HERALD_DESPAWN_SEC = BARON_SPAWN_SEC

/**
 * The levels that unlock something rather than merely adding a point — and only the ULTIMATE ones.
 *
 * This used to include 2 and 3, which cost two turns in the graded game and produced two of its six
 * false lines. They were also the wrong question independently of the falsehood: a jungler reaches
 * 3 on his own first clear by construction, on a schedule that is not a decision, and nothing about
 * his route changes when he gets there. 6, 11 and 16 unlock or rank up the ultimate, which is the
 * one level-up that changes what he is able to do about something that is coming.
 */
export const SPIKE_LEVELS = [6, 11, 16]

/**
 * What counts as an item COMPLETING — and the repair of a rule that was firing on the wrong thing.
 *
 * The old rule was "a new item name appears whose `price` is at least 1100". Replayed over game
 * 5639406342 it fired EXACTLY ONCE in 28 minutes, at 26:22, on a **Needlessly Large Rod** — and it
 * missed Liandry's Torment at 10:32 and Riftmaker at 22:07, the only two legendaries he built. The
 * reason is in the feed: `price` on a live item row is the COMBINE cost, not the total. Liandry's
 * reads 800 and Riftmaker 950, while a bare Needlessly Large Rod reads its full 1200. The rule was
 * therefore biased against exactly the purchases that matter and towards big components.
 *
 * The signature that cannot be fooled that way is the COMBINE itself: a new name appears in the
 * same step that items LEAVE the inventory. A straight purchase adds without removing; a
 * completion consumes its parts. The value of the spike is then the new items' combine cost plus
 * the prices of what was consumed, which is a real floor under what was just assembled rather than
 * a number the feed happens to print.
 *
 * Replayed over that game, 1500 over the sum keeps the three real spikes — Liandry's at 10:32
 * (1800g assembled), Gluttonous Greaves at 15:12 (1850g) and Riftmaker at 22:06 (2450g) — and drops
 * the two things below the gap: a Seeker's Armguard at 1300g, and the free Seeker's-to-Shattered
 * upgrade at 1000g, which is a proc rather than a purchase.
 */
export const ITEM_SPIKE_GOLD = 1500

/**
 * The app's measured low bands. They no longer ask anything, and that is the point.
 *
 * `resource.low` used to fire a turn when a bar crossed one of these. Four of the twelve
 * true-but-useless lines in the graded run came from it, all four of them his own health or mana
 * read back to him, and it was the clearest case in the whole list of a fact that fails "could he
 * have got it by looking at his screen" — the bar IS his screen.
 *
 * The constants stay exported because `shared/live-brief.ts` prints these bands in the payload and
 * documents them as "the numbers `analysis/live-events.ts` fires `resource.low` on". That sentence
 * is now half true: they are still the app's own thresholds and the brief is still right to print
 * them, but nothing is fired on them. The brief keeps its own copies across the `shared` ↛
 * `analysis` fence, so deleting these would only have broken the cross-reference, not the payload.
 */
export const HP_LOW = 0.3
export const MANA_LOW = 0.2

/**
 * How long the counterpart has to be invisible before his absence is itself the news.
 *
 * "I do not know where the enemy jungler is" is the single most useful thing a jungler can be told,
 * and it is the one thing he cannot read off his own screen. The feed cannot say where anyone is —
 * but the enemy's `creepScore` is a VISIBILITY counter (see `TickPlayer.seenCs`), so a stretch in
 * which nothing about him moves is a stretch in which nobody on his team has seen him.
 *
 * 75 seconds is a little longer than a camp clear, so a jungler quietly farming his own side does
 * not trip it every time he walks between camps out of vision.
 *
 * Its twin `counterpart.seen` was cut. The same counter moving again means somebody on his team has
 * eyes on the man — very often HIM — so "he surfaced" is the screen telling him something it has
 * already told him, and its one graded line was false. The absence is asymmetric and the presence
 * is not.
 */
export const COUNTERPART_ABSENT_SEC = 75

/* ------------------------------------- the window, and what makes it move again */

/**
 * How far past the flat lead a RESPAWN may look, because a respawn is a route decision.
 *
 * The one place the third cut had to widen rather than narrow, and the measurement that forced it
 * is a single line. Round 2's 10:44 respawn produced *"now that you're fresh out of base, path
 * towards your bot side to reset and secure that drake spawning in a minute and a half"* — graded
 * useful. At 10:44 that drake was 99 seconds away, so under `OBJECTIVE_LEAD_SEC` alone no window
 * was open and the ask would simply have been lost.
 *
 * It is not a bigger lead in general: it applies only on the tick he leaves the fountain, because
 * that is the moment the next ninety seconds of pathing are actually chosen and the only moment at
 * which an objective that far out is a decision rather than a clock. 120s is about the length of
 * the commitment — base to a camp to the pit.
 *
 * Replayed over the graded game this opens exactly one extra window (10:44) and costs nothing: the
 * other five respawns in that game had no epic inside 120s and still ask nothing.
 */
export const RESPAWN_HORIZON_SEC = 120

/**
 * When a burst of killing counts as a FIGHT that has RESOLVED, and why that is a material change.
 *
 * `fight.resolved` used to be a turn of its own and was cut for the worst hit rate in the graded
 * run — 1 useful in 6, 15 of 68 turns. It comes back as CONTEXT only: it is detected, it rides a
 * turn, and it asks nothing.
 *
 * It was tried as a field of the fingerprint first, because "a fight resolving while an objective
 * stands untaken" is the obvious way to describe what round 2's useful 21:05 line turns on. Replayed,
 * it caused 7 of 30 asks over the graded game, recovered no useful line, and gave the Herald that
 * stood for six minutes an ask every time anything died anywhere on the map — so the fingerprint
 * counts BODIES instead (`ENEMIES_DOWN_FREE`), which is the half of a fight a jungle contest turns
 * on, and 21:05 is recovered by that.
 *
 * Two champion kills, because one death is a pick and two is a trade; eight seconds of quiet,
 * inherited unchanged from the rule that used to fire the turn.
 */
export const FIGHT_MIN_DEATHS = 2
export const FIGHT_QUIET_SEC = 8

/**
 * How many of the enemy have to be lying down before an objective is FREE rather than contested.
 *
 * Two, and it is the field the fingerprint actually compares — see `WindowMark.twoEnemiesDown` for
 * the measurement that put it there in place of a fight counter. The counterpart alone is covered
 * separately by `cpDeaths`, because he is the man being raced and one of him is worth the whole
 * rest of the team for a jungle contest.
 */
export const ENEMIES_DOWN_FREE = 2

/**
 * Gold spent in one go that means he was standing in the shop — i.e. that he BACKED.
 *
 * This feed reports no position, so "he backed" has to be inferred, and `currentGold` only ever
 * falls by a purchase. 300 is above a control ward (75) and below a component, so a ward on the way
 * past the shop is not a trip. Two buys in one visit are merged by `SHOP_TRIP_GAP_SEC`, which is
 * longer than the 5-second sample that can split them.
 */
export const SHOP_SPEND_GOLD = 300
export const SHOP_TRIP_GAP_SEC = 20

/**
 * How long a reachability verdict has to HOLD before the window is told its answer flipped.
 *
 * Hysteresis, and it is here rather than as a cooldown on the ask for a reason that matters to this
 * file's one standing rule: a cooldown is a rate limit over the model's mouth, and a threshold on
 * the INPUT is a statement about the game. If the port starts flapping "can"/"cannot" across a
 * boundary, this is the knob that is wrong, not the ask.
 */
export const REACH_FLIP_SEC = 10

/**
 * Slack on top of the port's own ETA when deciding an objective is still winnable.
 *
 * `OBJECTIVE_LEAD_SEC` is the fallback when the port says `unknown`, which today is always — see
 * `ReachFn`. When a real ETA arrives, the window opens at `eta + this` instead, which is what
 * "entering the range where he could still get there" actually means. 15 seconds is roughly the
 * length of a contested pit fight: he has to arrive before the fight, not before the monster dies.
 */
export const REACH_MARGIN_SEC = 15

/**
 * How long a CONTEXT event may wait for a turn before it is stale rather than news.
 *
 * Nothing that ASKS is ever dropped — that promise is the reason `dueTurn` peeks and `commitTurn`
 * spends. But a context event rides whatever turn comes next, and under the window trigger the next
 * turn can be four minutes away: round 2's Riftmaker completed at 22:06 and the next window ask is
 * at 23:50. "You just finished Riftmaker" is a lie by 104 seconds at that point, and the model has
 * no way to tell. 90 seconds is about the time it stops being the thing that just happened.
 */
export const CONTEXT_CARRY_SEC = 90

/**
 * How long the coach has to have been asked NOTHING before a standing objective becomes the news.
 *
 * The fourth cut's addition, and the failure it repairs is the mirror image of the one
 * `live-schedule.ts` was written for. `materialDiff` prices a second ask on something having CHANGED;
 * an objective standing untaken changes nothing, so the longest open decision in the first ten
 * minutes of game 5639406342 — a drake free from 5:00 to roughly 7:20 — produced not one question.
 * The detector's own log for that stretch reads 4:21, then 7:17.
 *
 * 90 seconds, and it is a gate on SILENCE rather than a cadence, which is the difference between
 * this and the 20-second timer this file exists to replace. It cannot fire while anything is queued
 * to ask, and any turn at all resets it — so it is reachable only in a genuine lull, and in an
 * ordinary minute of League it is unreachable. Measured over the two paired games it fires twice in
 * an hour of play, once into each of the two real holes.
 *
 * Below about 60 it starts to fire in ordinary play and becomes a slower timer; above about 120 it
 * misses the 5:00-7:20 drake, which is the whole thing it was built for.
 *
 * THE "IT RE-FIRES SEVEN TIMES A GAME AT A QUIET LEVEL" WARNING IS NOW A NUMBER, and it is 7.46.
 * This comment and `key-moments`'s own note used to say "about seven times a game" from a reading
 * of the mechanism rather than from a replay. Measured: `scripts/measure-asks.ts --standing` over
 * the 28-game corpus puts a 90s gate with no cap at **7.46 standing asks a game**, which takes
 * `big-calls` from 9.13 asks per 28 minutes to 15.11 — the timer this file replaced walking back in
 * through the silence door, exactly as written, and the estimate was right to two significant
 * figures. What the same replay adds is that the GATE was never the thing that needed raising: see
 * `STANDING_ASK_CAP`.
 */
export const STANDING_SILENCE_SEC = 90

/**
 * HOW MANY STANDING-OBJECTIVE QUESTIONS ONE GAME MAY RAISE — the memory a silence gate does not have.
 *
 * ## The hole this closes, and why a bigger gate could not close it
 *
 * `window.standing` is the only ask in this app that covers an objective nobody has taken, and
 * until 2026-09-19 it was a `key-moments` kind: at `big-calls`, which is the default and the
 * schedule he uses, the fire site below raised it with `asks: false` and the coach said nothing.
 * What that costs is the stretch this file's own fire-site comment names — the drake window opens
 * at 4:21 of game 5639406342, the drake spawns at 5:00 and stands untaken until roughly 7:20, no
 * field of `materialDiff`'s fingerprint moves, and the detector raises nothing between 4:21 and
 * 7:17. AGENTS.md calls those 2m57s the biggest missed counterfactual in the corpus.
 *
 * The obvious repair — put the kind in `big-calls`'s allowlist — was measured and it is wrong at
 * every gate. `scripts/measure-asks.ts --standing`, the real detector over the 28-game corpus with
 * no model in the loop, ON against the level exactly as it ships. `stand/gm` is standing asks a
 * game, `hole` is turns landing inside 4:21-7:17 of that game, and LOST is turns the level was
 * taking that it now does not:
 *
 * ```
 *   gate   cap   asks/28m   stand/gm   gained   LOST   changed   hole   where it lands
 *     60     —      19.55      12.64      345     23        16      2
 *     90     —      15.11       7.46      204     19        10      1
 *    120     —      12.75       4.64      126     14         5      1
 *    150     —      11.59       3.00       82      6         4      1
 *    180     —      10.74       2.04       57      7         5      0
 *    210     —      10.06       1.25       34      5         4      0     (the gate it shipped with)
 *     60      1     10.00       0.96       27      0         0      1     5:03-5:22, median 5:16
 *     90      1     10.00       0.96       27      0         0      1     5:04-8:54, median 5:47
 *    120      1      9.97       0.96       27      1         0      1     5:35-20:11, median 6:17
 *    150      1      9.94       0.96       27      2         1      1     6:05-21:18, median 6:47
 *    180      1      9.71       0.89       20      2         5      0
 *    210      1      9.51       0.64       15      3         4      0
 *     90      2     10.45       1.93       50      9         8      1
 * ```
 *
 * `big-calls` as it ships is 9.13 asks per 28 minutes. **Uncapped, there is no gate that closes the
 * hole and leaves the level recognisable**: every value that reaches inside 4:21-7:17 costs between
 * 2.5 and 10.4 extra asks a game, and the two that keep the volume (180, 210) cannot reach inside a
 * 176-second hole at all, because a gate longer than the hole is never satisfied in it. That is
 * arithmetic and not a measurement, and it is why the gate was the wrong knob.
 *
 * **ONE is the knob.** Capped at one question a game the hole closes at +0.87 asks per 28 minutes,
 * and at a 90s gate it takes NOTHING: zero turns lost, zero turns whose asks changed, and the
 * per-kind delta over all 28 games is `{window.standing: +27}` and nothing else. 120 costs one
 * `hinge.silence` turn and 150 costs a `window.open` — the best kind at this level, 82% [76-86]
 * clean-useful — so the sweep picks 90 rather than taste, and 90 is `STANDING_SILENCE_SEC`, which
 * the app already had.
 *
 * ## WHAT IT IS NOT: A DETECTOR. Said plainly, because the numbers say it plainly.
 *
 * At a 90s gate with a cap of one it fires in **27 of 28 games** — the one it skips is
 * `js-mtvxb5f4-f81a-t29819280`, a 3.2-minute remake that never reaches 5:00, so among games that
 * reach the first drake it is **27 of 27** — and **24 of those 27 land between 5:04 and 5:53**. It
 * is a question at roughly 5:47 about a drake that spawned at 5:00, and its silence gate is
 * measured from a `window.open` that fires at about 4:21 in every game of League. A gate counting
 * from a fixed clock is a fixed clock.
 *
 * So it is labelled the way `hinge.silence` is labelled: ONE GUARANTEED QUESTION, here about the
 * early objective ledger, and not a detector of a rare standing opportunity. Two things are still
 * true of it that are not true of a timer — it cannot fire while any other ask is queued or raised
 * on the same tick, and it cannot fire unless the objective is genuinely still standing — and this
 * corpus simply never exercises either, because the drake was still free at 5:47 in all 27.
 *
 * ## WHY ONE AND NOT SIX, when each of the six is as good as the first
 *
 * The tempting story is that the first standing ask of a game is the good one and the repeats are
 * noise. **It is false, and the corpus already contained the refutation.** `commentary` asks with no
 * cap, and splitting its 56 graded `window.standing` turns by how many that game had already had
 * (`--standing`, no model consulted, nothing re-run):
 *
 * ```
 *   1st of the game    24 spoke    21% [9-40] wrong    71% [51-85] clean-useful
 *   2nd                18 spoke    22% [9-45] wrong    78% [55-91] clean-useful
 *   3rd or later       14 spoke    21% [8-48] wrong    71% [45-88] clean-useful
 * ```
 *
 * Flat. The cap therefore has NO quality argument and must not be given one: the 6.5 questions a
 * game it declines are, as far as this instrument can see, exactly as good as the one it keeps.
 * The argument is the level's own and it is about VOLUME — the same argument AGENTS.md makes for
 * `big-calls` itself, which "removes four good lines for every bad one" and is justified by the
 * owner's 0/10 on the chatty schedule rather than by a quality win. Uncapped at 90 this one kind
 * would add 7.46 asks a game to a level that has 8.5.
 *
 * ## WHAT IS NOT KNOWN
 *
 * Nothing here says the added question produces a good sentence. 27 turns are gained and 14 of them
 * sit at a clock a stored `commentary` line happens to occupy, graded 12 useful to 1 wrong — but
 * that alignment exists BECAUSE `commentary`'s own standing gate is 90 seconds, so it is a property
 * of the corpus and not evidence for this gate, and 14 lines is not a rate. The honest comparable
 * is the kind's own corpus figure: `window.standing` is 21% [13-34] wrong and 73% [60-83]
 * clean-useful over 56 turns, better than the 25%/69% pooled rate and beaten only by `window.open`,
 * `level.spike` and `item.completed`, which are the three kinds `big-calls` already had.
 */
export const STANDING_ASK_CAP = 1

/* ------------------------------------------------- THE HINGE, AND THE ASK IT IS NOT */

/**
 * The five minutes of his own games that decide them — and the one stretch this schedule could
 * pass over in complete silence.
 *
 * `scripts/what-wins.ts` over 138 ranked solo games, 69 won and 69 lost, AUC with a seeded
 * bootstrap, Mann-Whitney, BH across 78 rows: **nothing he personally does before 10:00 separates
 * his wins from his losses** — not CS at 10 (0.56 [0.46-0.66], q 0.34), not gold, xp, level or
 * gold against the counterpart, not deaths by 10:00, not his first back, not first blood, not early
 * enemy-half presence. The first thing of his that separates arrives in this window and it is
 * deaths: **no death between 10:00 and 15:00 wins 70% [56-80] over 53 games against 38% [28-48]
 * over 85**, and it is the only personal metric at any checkpoint that survives the two-term
 * logistic with team gold at 10:00 in the model (OR 0.63 per SD [0.43-0.93], p 0.018).
 *
 * The bounds are the finding's own and are not tuned here. Deaths BY 10:00 do not separate and
 * deaths after 20:00 are consequence; it is this window, so this is the window.
 */
export const HINGE_FROM_SEC = 600
export const HINGE_TO_SEC = 900

/**
 * How long nothing may have been asked before the hinge window gets its one guaranteed question.
 *
 * ## THIS IS NOT A DEATH PREDICTOR, AND THE FOUR CANDIDATES FOR ONE ARE REFUTED HERE
 *
 * The obvious reading of the finding above is to fire a turn when a death is coming. Four shapes
 * were proposed for that — he is low and the counterpart is unaccounted for, he is deep with no
 * vision, two enemies are unlocated while he is in their half, his escape is on cooldown — and
 * every one of them was checked against the feed before anything was designed on it. Two are not
 * computable at all and two are measured NULL or backwards. All four are written down rather than
 * left for the next person to re-draft.
 *
 * **NOT COMPUTABLE.** `allPlayers` carries no coordinates for anyone, so "deep", "in their half"
 * and "unlocated" have no referent in this feed; the minimap read that does carry a position lives
 * in `daemon/minimap-watch.ts`, on the far side of the `analysis/` no-I/O fence, is refused on 44%
 * of frames, and exists on no text-only game in the corpus. Summoner spell COOLDOWNS are not in the
 * feed either — `allPlayers` carries spell names and nothing else — which is the one thing
 * `AGENTS.md` records the HUD band as genuinely knowing that the Live Client Data API does not. So
 * three of the four candidate joins cannot be built, and saying so is the answer rather than a gap.
 *
 * **MEASURED, on the 28-game corpus** (`scripts/measure-hinge.ts`, no model in the loop): 1,271
 * alive ticks inside 10:00-15:00, 15 of his deaths in the window, base hazard of dying within 25
 * seconds 4.7%.
 *
 * ```
 *   predicate at a tick                     ticks   hazard(25s)    else   deaths caught
 *   his HP under 40%                           68   18% [10-28]    4.0%      10 of 15
 *     ... and his bar is FALLING (>=10%/12s)   31   35% [21-53]    4.0%      10 of 15
 *     ... and his bar is STEADY                37    3% [ 0-14]    4.8%       1 of 15
 *     ... and he has been low 10s or more      23    0% [ 0-14]    4.8%       0 of 15
 *   counterpart's row stale 45s or more       226    4% [ 2- 8]    3.4%
 *   counterpart's row stale 75s or more        68    3% [ 1-10]    3.7%
 *   four or more enemies off a respawn clock 1163    5% [ 4- 6]    3.7%
 * ```
 *
 * **The whole of the low-HP signal is the fight he is already losing.** Split by whether his bar is
 * moving, the actionable half — low, steady, the decision still open — is at 3% [0-14] against a
 * base of 4.8%, and low for ten seconds or more caught NONE of the fifteen deaths while firing 0.46
 * times a game. A coach asked there is asked about a moment he is if anything SAFER in, about the
 * one number on his screen he cannot miss, and the answer would land after the fight either way:
 * the shipped turn path reaches its first syllable at 1.6-3.7s. The counterpart going dark, the
 * best fact this app owns, predicts nothing here at all.
 *
 * **And the one ingredient a previous design was built on is a BASE RATE.**
 * `data/eval/CLIMB-COACH-20260918.md` proposed `window.contested` — an objective window open, the
 * clock in this window, and four or more enemies not on a respawn clock — on the finding that 87%
 * of his 125 post-game deaths in the window happen with four or five enemies up. On the live
 * samples **92% of ALL window ticks have four or more enemies up**, against 93% of the ticks within
 * ten seconds of a death. It carries no information. The full conjunction fires **3.68 times a
 * game** inside the window, which would nearly triple what the window already gets, at a hazard of
 * 6% [4-8] against 3.8%. It is not built, and it should not be rebuilt without a different
 * ingredient.
 *
 * POWER, before any of that is read as settled: fifteen deaths in the window across 28 games. A
 * predicate flagging ~5% of ticks needs a hazard ratio of roughly three before this instrument
 * separates it from the base rate. What is claimed is narrow and is what the table supports — the
 * actionable predicates point the WRONG WAY or catch no deaths at all, and the only one with a
 * ratio describes the death rather than preceding it.
 *
 * ## SO WHAT THIS IS: A FLOOR UNDER SILENCE, SCOPED TO THE HINGE, ONCE
 *
 * `big-calls` deleted the floor under silence outright (`heartbeatSec: Infinity`) and that is still
 * the right default for the other 25 minutes — the board renders the standing state with no model
 * in it. This gives back exactly one question, inside the only five minutes his own 138 games say
 * are his to decide, and only when nothing else has asked for `HINGE_SILENCE_SEC`.
 *
 * The evidence that an ask into silence is worth making is the corpus's own: over the 879-turn
 * table, `heartbeat` — an ask with no subject whatever — is 68% [53-80] clean-useful at 10% [4-23]
 * wrong, the LOWEST wrong rate of any kind in the app, under `window.open`'s 17%. Asking into a
 * lull is not where this coach goes wrong.
 *
 * ## THE SILENCE IS MEASURED INSIDE THE WINDOW, AND THAT IS THE WHOLE DIFFERENCE
 *
 * The first version of this counted silence from the last turn wherever it was. Replayed, it fired
 * between 10:45 and 10:55 in three quarters of the games — because at `big-calls` the coach has
 * ALREADY been quiet for about 160 seconds by the time 10:00 arrives, so a gate of any ordinary
 * size is satisfied on the first tick of the window and the ask is a clock ask wearing a silence
 * gate. The claim being acted on is that THIS WINDOW should not pass in silence, so the clock runs
 * from `max(last turn, 10:00)` and a lull that happened at 8:00 buys nothing.
 *
 * 150 seconds, measured that way with the real detector over the 28-game corpus
 * (`scripts/measure-hinge.ts --trade --gate N`, no model in the loop). Asks a game, where it lands,
 * and what `big-calls` gets inside the window before and after:
 *
 * ```
 *   gate   asks/game   it lands        in-window 2.11 ->   turns LOST
 *    90s      0.96     11:33-13:11           3.11            0
 *   120s      0.93     12:03-14:20           3.00            1
 *   150s      0.71     12:33-14:19           2.81            0
 *   180s      0.50     13:04-14:00           2.59            0
 *   210s      0.32     13:30-14:00           2.44            0
 * ```
 *
 * The median gap between asks INSIDE this window is 51 seconds at `big-calls` and the longest in
 * the corpus is 259, so 150 is about three times an ordinary lull and well under the worst one: it
 * is a hole rather than a pause. It lands where the window actually is — 12:33 to 14:19, median
 * 12:41 — and it costs under one ask a game. Ninety fires in all but one game and lands in a
 * 98-second band at the front of the window, which is a cadence wearing a gate; 210 covers a third
 * of them and only the last thirty seconds.
 *
 * It yields to everything with a subject. It cannot fire while any ask is queued or raised on the
 * same tick, so a window opening, a standing objective, a spike or an item always takes the turn
 * instead. What it CANNOT yield to is an ask that has not happened yet, and that is the one cost,
 * measured rather than asserted:
 *
 * ```
 *   level         whole game /28min   in-window/game   what moved
 *   big-calls      8.51 -> 9.13        2.11 -> 2.81    hinge.silence +20, and NOTHING else
 *   key-moments    9.97 -> 10.52       2.37 -> 3.00    hinge.silence +20, standing -1, heartbeat -2
 *   commentary    27.54 -> 27.54       5.48 -> 5.48    nothing; the gate is unreachable there
 * ```
 *
 * THE `big-calls` ROW'S TWO ABSOLUTE FIGURES MOVED ON 2026-09-19 AND NOTHING ELSE IN THIS BLOCK
 * DID. That level gained a standing-objective ask (`STANDING_ASK_CAP`), so re-running
 * `--trade` today prints `9.39 -> 10.00` for the same +0.61. Everything this table was written to
 * establish reproduces to the digit: hinge.silence +20 over 28 games, 0 turns lost, 1 turn's asks
 * changed, in-window 2.11 -> 2.81, landing 12:33 to 14:19 with a median of 12:41. The two schedule
 * changes do not interact, and the reason is in the gate — this one counts silence from
 * `max(last turn, 10:00)` and the standing question lands at a median 5:47, so it cannot spend a
 * lull that has not started yet.
 *
 * At `big-calls` — the default, and the one he uses — it adds 20 asks over 28 games and removes
 * none: not one existing turn disappears and not one moves. At `key-moments` it costs THREE asks
 * over the same 28 games, one standing-objective ask and two heartbeats, because those two also
 * fire into silence and there is only so much silence to go round. That is the same trap the
 * heartbeat-against-standing ordering was found in; it is smaller here and it is stated rather than
 * designed away, because the fix — a longer gate — was measured at every value from 90 to 210 and
 * does not remove it.
 *
 * NOTHING HERE SAYS THE ADDED QUESTION PRODUCES A GOOD SENTENCE. Every one of those 20 asks lands
 * at an instant no stored run ever took, so there is no line to grade and none is estimated. What
 * is known is the nearest comparable: an ask into silence with no subject at all is the app's
 * least-wrong kind.
 */
export const HINGE_SILENCE_SEC = 150

/* ------------------------------------------------- HOW OFTEN SHE SPEAKS AT ALL */

/**
 * WHICH ASKS FIRE — the only knob in this app that changes how much the coach talks.
 *
 * It changes WHEN she is asked and nothing else. No prompt moves, no topic is forbidden, no
 * sentence is suppressed and nothing here ever sees a line. That distinction is the repo's
 * standing rule (`AGENTS.md`, "what is NOT in the brief is the whole of the design") and this
 * mechanism is deliberately on the legitimate side of it: a question not asked is not a thing
 * unsaid, it is a moment the coach was left alone.
 *
 * ## Why a level exists at all
 *
 * The shipped schedule asks about 30 times in a 28-minute game and roughly 21 of those lines are
 * graded clean-useful. That is not a wrongness problem — `scripts/measure-asks.ts` spent a whole
 * corpus establishing that volume and wrongness are different defects — it is a VOLUME problem,
 * and it is the one complaint that has survived every architecture this app has shipped. The
 * owner's own verdict on the live coach is 0/10 and "overwhelming" is the word he used, not
 * "wrong".
 *
 * ## The table these levels are cut from
 *
 * 28 real games, 879 turns, every turn joined to the ask that raised it and graded by the two
 * instruments in `scripts/measure-asks.ts` whose union lands on the independently adjudicated 28%
 * false (`data/eval/integrate3-corpus-20260912.json` and the judged file beside it):
 *
 * ```
 *   ask kind            turns   wrong          clean-useful    asks/game
 *   window.changed        440   29% [25-34]    71% [66-75]       15.71
 *   window.open           221   17% [13-23]    82% [76-87]        7.89
 *   window.standing        56   21% [13-34]    73% [60-83]        2.00
 *   death.counterpart      52   60% [46-72]    40% [28-54]        1.86
 *   respawn.self           43   20% [10-35]    75% [60-86]        1.54
 *   heartbeat              41   10% [4-23]     68% [53-80]        1.46
 *   item.completed         29   18% [8-36]     79% [60-90]        1.04
 *   level.spike            18    6% [1-27]     94% [73-99]        0.64
 *   ALL                   879   25% [22-28]    69% [66-72]       30.39
 * ```
 *
 * `window.open` at 82% clean-useful and 7.9 asks a game is about six good lines on its own, and
 * `level.spike` is the most precise kind in the corpus at 0.64 asks a game. `window.changed` is
 * the volume: 15.7 asks a game, half of everything, at the second-worst precision in the table.
 * So the cut is not "say less of what is wrong", it is "keep the kinds whose hit rate is high and
 * whose count is small".
 *
 * ## The numbers on each level are REPLAYED, not arithmetic
 *
 * Every figure in `SPEAK_LEVELS` comes from stepping the real detector — `observeTick` / `dueTurn`
 * / `commitTurn`, the same three calls the browser makes — over the same 28 games under that
 * level, and joining each replayed turn to the stored line at the same game clock. That matters
 * because the quiet levels are not a subtraction: `window.standing` and the heartbeat both fire
 * INTO SILENCE, so removing `window.changed` makes them fire more often, and adding up rows of the
 * table above would have missed it. See `standingSilenceSec` below for the one that bit.
 *
 * A turn at a clock the stored run never took has no line to grade. Those are counted and reported
 * as UNGRADED rather than guessed at in either direction, and the table below then counts them at
 * the level's own measured speak and grade rates — which is a convention, so it is stated here and
 * the raw count travels in its own column.
 *
 * ```
 *   level               asks/g   spoken/g   clean-useful/g   wrong/g   longest silence   ungraded
 *   commentary            27.5       26.2             18.9       6.8             3.0m       0/851
 *   key-moments           10.5        9.8              7.9       1.8             4.3m      52/325
 *   big-calls             10.0        9.3              7.6       1.5             5.3m      33/309
 * ```
 *
 * Per 28-minute game, scaled from the corpus's own mean of 30.9 minutes. Re-derive any row with
 * `scripts/measure-asks.ts --level <id>` for the grades and `--standing` for the asks and the
 * silences; neither needs a model.
 *
 * TWO OF THESE ROWS MOVED ON 2026-09-19 AND ONLY PART OF IT IS A BEHAVIOUR CHANGE, which is worth
 * separating because a reader comparing against the previous printing will otherwise credit the
 * whole difference to the new ask. `big-calls` genuinely gained two questions a game — the
 * 10:00-15:00 floor and the standing-objective ask — and that is +1.5 asks. The rest is a counting
 * fix: the old rows priced `asks/g` on JOINED turns only while pricing `spoken/g` on all of them,
 * so every quiet level's ask count was reported below its own spoken count's basis, and
 * `key-moments` moved from 10.0/9.4/6.6 to 10.5/9.8/7.9 without one line of its schedule changing.
 * `commentary` is unaffected by the fix because it has 0 ungraded turns, and it reproduces to the
 * tenth — which is the check that the fix is a fix.
 *
 * The shape of the cut is the point: `big-calls` removes two thirds of the talking and one third
 * of the good lines, because the kinds it drops are the ones with the most turns and the worst hit
 * rate. It is still not free — 18.8 clean-useful lines a game become 6.4 — and calling it free
 * would be the flattering version of this table. The bet is the owner's stated one: the good lines
 * exist today and are buried, and a coach that says six good things is worth more than one that
 * says nineteen good things inside twenty-six.
 */
export type SpeakLevel = "commentary" | "key-moments" | "big-calls"

/**
 * What a level does, mechanically. Three fields, and all three move together.
 *
 * `kinds` is the allowlist of ask kinds — an event of any other kind still FIRES, still carries its
 * note and still rides the next turn as context, it just cannot summon one. That is the third
 * cut's mechanism (`LiveEvent.asks`) reused: demote, never delete, because a material change has to
 * be detected before anything can compare it and because deleting a detector deletes the evidence
 * that would settle the question later.
 */
export interface AskPolicy {
	kinds: readonly LiveEventKind[]
	/** The floor under silence, in seconds. `Infinity` means the coach is never asked about nothing. */
	heartbeatSec: number
	/** How long nothing may have been asked before a standing objective becomes the news. */
	standingSilenceSec: number
	/** How many standing-objective questions one game may raise here. See `STANDING_ASK_CAP`. */
	standingAskCap: number
}

/**
 * The default, and it is the quiet one.
 *
 * The chatty schedule is the one he rated 0/10 and asked to be turned down in every session since
 * the first. A default that has to be found in Settings before the product is bearable is not a
 * default.
 */
export const DEFAULT_SPEAK_LEVEL: SpeakLevel = "big-calls"

/**
 * The picker's own copy, kept beside the mechanism rather than in the page — exactly as
 * `LIVE_COACH_MODES` is kept beside the prompts, and for the same reason. `evidence` carries the
 * numbers because he distrusts a claim about this coach that arrives without one, and he is right
 * to.
 */
export const SPEAK_LEVELS: {
	id: SpeakLevel
	label: string
	blurb: string
	/** Spoken lines in a 28-minute game, replayed over the 28-game corpus. */
	linesPerGame: number
	evidence: string
	policy: AskPolicy
}[] = [
	{
		id: "big-calls",
		label: "Big calls only",
		blurb:
			"An objective window opening, a spike level, a finished legendary — plus one question about an objective standing free that nobody has taken, and one inside 10:00-15:00 if that stretch would otherwise pass in silence. Nothing else opens her mouth, and the board on the live page keeps showing the standing state with no model in it.",
		linesPerGame: 9.3,
		evidence:
			"28 real games replayed: 10.0 asks and about 9.3 spoken lines in a 28-minute game — 82% [77-86] clean-useful and 16% [12-21] wrong over the 257 of 276 joined turns that spoke, so about 7.6 good lines a game and 1.5 bad ones, against 18.8 good and 6.8 bad when she reacts to everything. Two of those asks are floors rather than detectors and are counted at the same rates as the rest: the 10:00-15:00 question (+0.6) and one question a game about a free objective (+0.9), which closes the 2m57s of silence over an untaken drake that was the biggest missed counterfactual in the corpus. Median longest silence 5.3 minutes.",
		policy: {
			/*
			 * THREE KINDS, and the third is the one to argue about. `item.completed` costs 1.0 asks
			 * a game at 79% [60-90] clean-useful; dropping it lands this level at 7.0 spoken lines
			 * in a 28-minute game instead of 7.8, which is the strict reading of the six-lines
			 * target. It is kept because the trade is 0.8 lines for 0.8 good ones. `level.spike`
			 * is not the place to economise either way: it is the most precise kind in the corpus
			 * (94% [72-99]) and it costs 0.6 asks a game.
			 */
			/*
			 * THE FOURTH IS THE ONLY THING THIS LEVEL ASKS THAT IS NOT AN EVENT, and it is one
			 * question a game. This level has no floor under silence anywhere else (below), and
			 * measured over the 28-game corpus the five minutes his own 138 games say decide them
			 * could pass with a 259-second gap in them. See `HINGE_SILENCE_SEC` — it costs +1.00
			 * asks a game, it fires only into a lull, and it displaces nothing.
			 */
			/*
			 * THE FIFTH IS THE FREE OBJECTIVE NOBODY TOOK, and it is capped at one question a game.
			 *
			 * This level asked nothing about a standing objective until 2026-09-19, which is what
			 * left 4:21-7:17 of game 5639406342 silent over a drake that stood free from 5:00 — the
			 * biggest missed counterfactual in the corpus. Adding the kind without the cap is the
			 * obvious repair and it is measured wrong at every gate: see `STANDING_ASK_CAP` for the
			 * whole sweep. Capped at one at a 90s gate it costs +0.87 asks per 28 minutes, closes
			 * the hole, and takes nothing — zero turns lost, zero changed, `{window.standing: +27}`
			 * over 28 games and no other kind moved.
			 */
			kinds: [
				"window.open",
				"window.standing",
				"level.spike",
				"item.completed",
				"hinge.silence"
			],
			/*
			 * NO FLOOR UNDER SILENCE. The heartbeat is the ask that exists because nothing else did,
			 * and this level's whole premise is that nothing else did is an acceptable answer — the
			 * board on the live page renders the standing state continuously with no model in it, so
			 * a quiet coach is not an empty screen.
			 */
			heartbeatSec: Infinity,
			/*
			 * 90 AND ONE, and the pair is the finding. The gate shipped at 210 here for a year on the
			 * reading that a 90s gate re-fires about seven times a game at a quiet level — which the
			 * replay confirms at 7.46 — so the gate was raised and the kind was vetoed instead. Both
			 * were the wrong lever: a gate longer than a 176-second hole can never be satisfied
			 * inside it, so 210 cannot reach the thing the ask exists for. The cap is the memory the
			 * gate never had, and with it in place the gate can go back to the value the rest of the
			 * app uses. See `STANDING_ASK_CAP`.
			 */
			standingSilenceSec: STANDING_SILENCE_SEC,
			standingAskCap: STANDING_ASK_CAP
		}
	},
	{
		id: "key-moments",
		label: "Key moments",
		blurb:
			"Everything above, plus him coming back up, an objective that has stood free for a while, and a floor under long silences. Still no running commentary on a window that is already open.",
		linesPerGame: 9.8,
		evidence:
			"10.5 asks and about 9.8 spoken lines in a 28-minute game, 80% [75-84] clean-useful — 7.9 good lines a game and 1.8 bad ones. 8.8 of the asks are joined to a real stored line and 1.7 land at instants no recorded run ever took, counted at the same speak and grade rates rather than assumed silent. The 10:00-15:00 floor adds 0.6 and costs 0.1: over 28 games it takes one standing-objective ask and two heartbeats, because those fire into silence too. This level keeps EVERY standing-objective ask, 1.25 a game, where the quiet one keeps one.",
		policy: {
			kinds: [
				"window.open",
				"window.standing",
				"respawn.self",
				"level.spike",
				"item.completed",
				/*
				 * It costs LESS here than at `big-calls` — 0.93 asks a game against 1.00 — because
				 * this level has an uncapped standing ask and a 360s floor to break a lull with, and
				 * both of them reset the same silence clock. See `HINGE_SILENCE_SEC`. `big-calls`
				 * gained a standing ask on 2026-09-19 and that did NOT change its hinge count: its
				 * one question lands at a median 5:47, and the hinge's clock runs from
				 * `max(last turn, 10:00)`, so an ask before the window cannot spend the lull inside
				 * it. Measured: the per-kind delta of that change over all 28 games is
				 * `{window.standing: +27}` and nothing else.
				 */
				"hinge.silence"
			],
			/*
			 * 360 AND 210, IN THAT ORDER, and the order is load-bearing.
			 *
			 * Both fire into silence, so the shorter one reaches every lull first. At the shipped
			 * 180s the heartbeat takes every silence before the 210s standing gate can, and
			 * `window.standing` — the only ask that covers a free objective nobody has taken — never
			 * fires at all. Measured: the first replay of this level reported zero standing asks in
			 * 28 games, and the fix was the floor, not the gate.
			 *
			 * 210 rather than the shipped 90 because the shipped figure was measured while the coach
			 * was noisy, where anything at all resets the silence clock. With `window.changed` gone
			 * the same 90s gate re-fires 7.46 times a game — measured, `--standing` — which is the
			 * timer this whole file replaced walking back in through the silence door.
			 *
			 * UNCAPPED, AND `big-calls` IS NOT. That asymmetry is deliberate and it is measured
			 * rather than assumed. `big-calls` takes the cap because a 210s gate cannot reach inside
			 * the 176-second hole the ask exists for and a shorter gate without a cap is the timer
			 * above; here the same swap is a bad trade. From the `--standing` table: this level
			 * ships at 210 uncapped for 10.52 asks per 28 minutes with a median longest silence of
			 * 4.3 minutes, and 90-capped-at-one is 10.55 asks — no volume saved at all — for a median
			 * longest silence of 5.3 minutes. It buys the drake hole and sells back every later lull,
			 * because at this level the standing ask is also the thing covering an objective standing
			 * free at 24:00 and the cap spends its one question at 5:47. `key-moments` is the level
			 * for someone who wants more of them, so it keeps all of them.
			 */
			heartbeatSec: 360,
			standingSilenceSec: 210,
			standingAskCap: Infinity
		}
	},
	{
		id: "commentary",
		label: "Running commentary",
		blurb:
			"Every development: a window re-asked each time the board under it moves, the enemy jungler dying, and a heartbeat every three minutes. This is the schedule every stored measurement in this repo was taken on.",
		linesPerGame: 26.2,
		evidence:
			"27.5 asks and 26.2 spoken lines in a 28-minute game, 72% [69-75] clean-useful — 18.8 good lines a game and 6.8 wrong ones, with a median longest silence of 2.9 minutes. Every number elsewhere in this app was measured here, and this is the schedule he scored 0/10.",
		policy: {
			kinds: [
				"window.open",
				"window.changed",
				"window.standing",
				"death.counterpart",
				"respawn.self",
				"level.spike",
				"item.completed",
				/*
				 * `game.start` has not asked since the fifth cut — 0 useful lines in 28 games — and it
				 * is listed here because `asksBeforeFifthCut` puts the question back for a replay, and
				 * an allowlist that quietly vetoed it would make the 879-turn table unreproducible.
				 * The fire site decides; this only declines to overrule it.
				 */
				"game.start"
				/*
				 * `hinge.silence` IS DELIBERATELY ABSENT, and it is the one place in this file where
				 * a level is decided by something other than the level's own argument.
				 *
				 * This schedule is the one every stored measurement in `data/eval/` was taken on, and
				 * it stays byte-identical or those runs stop being re-derivable. The kind's own gate
				 * would not reach it anyway — 210s of total silence never happens inside 10:00-15:00
				 * on any of the 28 games at this cadence — so the allowlist and the clock agree, and
				 * the allowlist is what makes it a guarantee rather than a coincidence.
				 */
			],
			heartbeatSec: HEARTBEAT_SEC,
			standingSilenceSec: STANDING_SILENCE_SEC,
			/*
			 * UNCAPPED, and this is the one field in this level that had to be argued rather than
			 * copied. Every stored measurement in `data/eval/` was taken with no cap here, so a cap
			 * would make them unre-derivable — and the cap is not even tempting: this schedule's
			 * standing ask is 2.00 a game, not the 7.46 a 90s gate produces at a quiet level, because
			 * at this cadence something else has almost always asked inside the last 90 seconds.
			 * Measured, `--standing`: 27.54 asks per 28 minutes with the ask, 25.92 without.
			 */
			standingAskCap: Infinity
		}
	}
]

/**
 * The policy for a level. Unknown or absent falls back to the default rather than to the chattiest
 * thing available, because the failure mode of a typo should be a quiet coach and not the one he
 * switched off.
 */
export const askPolicy = (level?: SpeakLevel | null): AskPolicy =>
	(SPEAK_LEVELS.find(l => l.id === level) ?? SPEAK_LEVELS.find(l => l.id === DEFAULT_SPEAK_LEVEL)!)
		.policy

/* --------------------------------------------------- the reachability port */

/**
 * What the reachability module answers, as this file needs it. **The port, not the module.**
 *
 * A separate piece of work is building the thing that reads his position off the minimap and says
 * how long he would need to be at a pit. This file does not own that and must not guess at it, so
 * the dependency is one function, injected, defaulting to `unknown` — and `unknown` is a real answer
 * that behaves correctly rather than a stub that behaves like `can`. Until the module lands, every
 * window opens on `OBJECTIVE_LEAD_SEC` exactly as it does today and `mark.reach` never flips, so
 * nothing here is waiting on anything.
 *
 * The shape is deliberately narrow so it can be satisfied by whatever that module turns out to be:
 * a verdict, and the seconds behind it when they exist. It must never return `"can"` on a guess —
 * this app's whole design is that a gap is stated rather than filled, and a reachability module
 * that answers confidently from a stale position read is the minimap fence's failure mode wearing
 * a different hat.
 */
export interface ReachRead {
	verdict: "can" | "cannot" | "unknown"
	/** Seconds he would need to be at the pit, or null when the module cannot say. */
	etaSec: number | null
}

export type ReachFn = (tick: LiveTick, objective: ObjectiveState) => ReachRead

/** The honest default: it does not know, so the flat lead decides and `reach` never moves. */
export const REACH_UNKNOWN: ReachFn = () => ({ verdict: "unknown", etaSec: null })

/* ------------------------------------------------- the material fingerprint */

/**
 * The state of the game that a decision about a contest window actually depends on.
 *
 * Every field is a MONOTONE COUNTER or a debounced verdict, and that is what makes "did something
 * material change" a comparison rather than a judgement: the window remembers the fingerprint it
 * was last asked under, and any field differing is a second ask. Counters rather than booleans
 * because a boolean that goes out and comes back between two asks reads as no change at all — his
 * death and his respawn would cancel, which is exactly the ask the graded run scored useful.
 *
 * What is deliberately NOT in here, with its reason:
 *
 *   - **the clock.** A window ticking from "in 40s" to "up 20s" is not news; it is the thing that
 *     was already asked about, one sample later. Round 2 asked about the same drake at 4:20 and
 *     again at 6:04 for no other reason than that it had spawned in between, and the second line
 *     was true and useless.
 *   - **his HP, mana and gold totals.** The bars are his screen. This is the same cut that deleted
 *     `resource.low`, applied to the re-ask.
 *   - **the counterpart going DARK.** Absence is still detected and still rides the turn, but it
 *     does not re-open a window: all three `counterpart.unseen` turns in round 2 produced either a
 *     useless line or a verbatim repeat of the window ask 6 seconds earlier (18:02, then 18:08).
 *     His coming BACK is in here, because that is the counter moving from "nobody can see him" to
 *     "somebody does", which genuinely re-prices a contest.
 */
export interface WindowMark {
	/** His own deaths. A death and the respawn after it are two different numbers, on purpose. */
	myDeaths: number
	/** The counterpart's deaths — the thing that makes something standing in a pit free. */
	cpDeaths: number
	/** Times the counterpart has come back into view after `COUNTERPART_ABSENT_SEC` of nothing. */
	cpReappearances: number
	/**
	 * How many times the enemy team has been OPENED UP — see `ENEMIES_DOWN_FREE`.
	 *
	 * This slot has been measured three times and each reading is written down, because each one
	 * changed the answer:
	 *
	 *   1. **A count of RESOLVED fights**, which is the shape the task's own list suggested. It
	 *      caused 7 of 30 asks over the graded game, recovered no useful line, and gave the Herald
	 *      that stood for six minutes an ask every time anything died anywhere on the map.
	 *   2. **A boolean "two or more are down right now"**, which recovered round 2's 21:05 — *"Baron
	 *      is still free with Kayn and Draven dead, but you are too low to take it"*, the ask twelve
	 *      seconds after the previous one, which nothing else in the fingerprint can see. It also
	 *      FLAPPED: three asks in thirteen seconds at 11:57 / 12:04 / 12:10, down then up then down,
	 *      which is the exact fault this cut exists to remove.
	 *   3. **A ratchet**, which is what is here. A spell opens the first time two of them are down
	 *      and does not close until they are ALL back up, so a fight that trades bodies back and
	 *      forth is one spell and one ask. Monotone, so the enemy respawning is never itself news.
	 */
	enemiesOpened: number
	/** Trips to the shop, inferred from gold spent — see `SHOP_SPEND_GOLD`. */
	shopTrips: number
	/** Epics taken this game. A take re-prices every window still open, and says where he just was. */
	takes: number
	/** The reachability port's verdict for THIS window, after `REACH_FLIP_SEC` of hysteresis. */
	reach: "can" | "cannot" | "unknown"
}

/** Which fields of the fingerprint moved. Empty means nothing material happened. */
export const materialDiff = (was: WindowMark, now: WindowMark): string[] => {
	const out: string[] = []
	if (now.myDeaths !== was.myDeaths) out.push("he died and is back")
	if (now.cpDeaths !== was.cpDeaths) out.push("counterpart died")
	if (now.cpReappearances !== was.cpReappearances) out.push("counterpart resurfaced")
	if (now.enemiesOpened !== was.enemiesOpened) out.push("two enemies are down")
	if (now.shopTrips !== was.shopTrips) out.push("he backed")
	if (now.takes !== was.takes) out.push("another objective fell")
	if (now.reach !== was.reach) out.push(`reach ${was.reach} -> ${now.reach}`)
	return out
}

/** One contest window: an objective instance, while the decision about it is still open. */
export interface WindowRecord {
	key: string
	what: string
	spawnSec: number
	openedAtSec: number
	/** Why it became decidable — the flat lead, it standing untaken, or him leaving the fountain. */
	opening: "lead" | "standing" | "respawn"
	/** How many times the coach has been asked about this window. */
	asks: number
	/** The fingerprint under which the last ask was RAISED. Null until the opening ask is raised. */
	askedMark: WindowMark | null
	/** The reach verdict currently being held, and since when — `REACH_FLIP_SEC`'s hysteresis. */
	reach: "can" | "cannot" | "unknown"
	reachPending: "can" | "cannot" | "unknown"
	reachPendingSince: number
}

/* ------------------------------------------------------------ memory */

export interface EventWatch {
	prev: LiveTick | null
	/** Event log ids already turned into events. The log is cumulative, so this is what dedupes it. */
	seenEventIds: Set<number>
	/** Keys already fired. One entry per THING, so a truth that stays true does not re-fire. */
	fired: Set<string>
	/** Last game clock at which anything about the counterpart moved. */
	counterpartSeenAtSec: number | null
	counterpartMissing: boolean
	/**
	 * Who killed him last, carried so the RESPAWN turn can say it.
	 *
	 * His death no longer asks anything — he is watching a grey screen and cannot act on an answer
	 * for 10-45 seconds — but the kill log is the only place the killer's champion exists, and the
	 * fault panel reading "respawn.self (he is back up)" with no idea what happened is worse than the
	 * two-turns-per-death it replaces. So the death is REMEMBERED and spent on the turn that can use
	 * it.
	 */
	lastDeathNote: string | null
	/** When a turn was last TAKEN. The heartbeat measures from here, not from the last event. */
	lastTurnAtSec: number | null
	/**
	 * Events detected but not yet carried by a turn.
	 *
	 * Nothing that ASKS is ever dropped from here — see `dueTurn` and `commitTurn`. Context events
	 * ARE dropped once they go stale, because the window trigger can leave minutes between turns and
	 * a four-minute-old item completion carried into a Baron ask is a false premise. See
	 * `CONTEXT_CARRY_SEC`.
	 */
	pending: LiveEvent[]

	/* ------------------------------------------- the third cut: windows and the fingerprint */

	/** Every contest window that is currently open, by objective instance key. */
	windows: Map<string, WindowRecord>
	/** Instance keys whose window has already opened and closed. Stops a take re-opening one. */
	closedWindows: Set<string>
	/** The live fingerprint. `markFor` snapshots it per window by adding that window's reach. */
	counters: Omit<WindowMark, "reach">
	/** Fights detected. Context only — the fingerprint counts bodies, not fights. See `WindowMark`. */
	fightsSeen: number
	/** Whether an "enemies opened up" spell is currently running. See `WindowMark.enemiesOpened`. */
	enemiesOpen: boolean
	/** The kill cluster in progress: when the last champion kill landed, and how many it has. */
	clusterKills: number
	lastKillAtSec: number | null
	/** When gold was last seen to fall by `SHOP_SPEND_GOLD` — the merge window for one visit. */
	lastShopAtSec: number | null
	/** Bumped per ask so a second `window.changed` on the same window gets its own dedupe key. */
	askSeq: number

	/* ------------------------------------------- the fourth cut: the settle clock */

	/**
	 * When the oldest un-sent ASK was detected, or null when the queue holds none.
	 *
	 * The settle in `live-schedule.ts` is a statement about how long a question has been waiting, so
	 * somebody has to remember when the waiting started. It is here rather than in `dueTurn` because
	 * `dueTurn` has never mutated and must not start: `observeTick` sets this when the first ask
	 * after a send arrives, and `commitTurn` clears it when the turn leaves.
	 */
	settleSinceSec: number | null
	/** Standing-opportunity asks raised this game. Their dedupe keys, the cap's counter, and the
	 * bench's tally. */
	standingAsks: number
	/** When a standing-opportunity ask was last RAISED — the gate's own clock. */
	lastStandingAskAtSec: number | null
	/**
	 * When the next contest window is due to open, as of the last tick — `nextOpeningSec`.
	 *
	 * Cached on the watch because `dueTurn` is handed a clock and not a tick, and the heartbeat needs
	 * the same lookahead the settle uses. Null when nothing is scheduled to open.
	 */
	nextOpeningSec: number | null
}

export const newEventWatch = (): EventWatch => ({
	prev: null,
	seenEventIds: new Set(),
	fired: new Set(),
	counterpartSeenAtSec: null,
	counterpartMissing: false,
	lastDeathNote: null,
	lastTurnAtSec: null,
	pending: [],
	windows: new Map(),
	closedWindows: new Set(),
	counters: {
		myDeaths: 0,
		cpDeaths: 0,
		cpReappearances: 0,
		enemiesOpened: 0,
		shopTrips: 0,
		takes: 0
	},
	fightsSeen: 0,
	enemiesOpen: false,
	clusterKills: 0,
	lastKillAtSec: null,
	lastShopAtSec: null,
	askSeq: 0,
	settleSinceSec: null,
	standingAsks: 0,
	lastStandingAskAtSec: null,
	nextOpeningSec: null
})

/**
 * The enemy jungler, found the same way `shared/live-brief.ts` finds him: the live feed's own
 * `position`, which is a different and trustworthy source from the post-game `timeline.lane` this
 * repo refuses. No Smite fallback here, because this file only ever uses the counterpart to decide
 * whether to ASK — a wrong guess costs a question, not a claim.
 */
export const counterpartOf = (tick: LiveTick): TickPlayer | null =>
	tick.players.find(p => p.team !== tick.me.team && p.position === "JUNGLE") ?? null

const championOf = (tick: LiveTick, name: string | null): string | null => {
	if (name === null) return null
	return tick.players.find(p => p.name === name)?.champion ?? null
}

/* ------------------------------------------------------------ the objectives */

/** One epic monster, as it stands right now. */
export interface ObjectiveState {
	/** Unique per INSTANCE — the drake at 12:23 is a different thing from the drake at 17:23. */
	key: string
	/** The plain noun — "drake", "voidgrubs", "rift herald", "baron". The notes add the verb. */
	what: string
	/** The clock at which this instance spawns, past or future. */
	spawnSec: number
	/** How long it has been standing untaken, or null when it has not spawned or is already gone. */
	upForSec: number | null
}

/**
 * Every epic that still has a next instance, from the schedule plus this game's observed takes.
 *
 * A take that was never logged produces no window at all — assuming one from the clock would be
 * inventing a timer, which is the rule `GET /api/live` already follows for the same numbers. Grubs
 * and Herald are ONE instance each and disappear once taken or once they leave the map; drake and
 * Baron always have a next one.
 */
export const objectiveStates = (tick: LiveTick): ObjectiveState[] => {
	const now = tick.gameTimeSec
	let lastDrake: number | null = null
	let lastBaron: number | null = null
	let heraldTaken = false
	let grubsTaken = false
	for (const e of tick.events) {
		if (e.name === "DragonKill") lastDrake = Math.max(lastDrake ?? 0, e.atSec)
		if (e.name === "BaronKill") lastBaron = Math.max(lastBaron ?? 0, e.atSec)
		if (e.name === "HeraldKill") heraldTaken = true
		if (e.name === "HordeKill") grubsTaken = true
	}
	const out: ObjectiveState[] = []
	const add = (name: string, what: string, spawnSec: number, goneSec: number | null): void => {
		out.push({
			key: `${name}:${Math.round(spawnSec)}`,
			what,
			spawnSec,
			upForSec:
				now >= spawnSec && (goneSec === null || now < goneSec) ? now - spawnSec : null
		})
	}
	add(
		"drake",
		"drake",
		lastDrake === null ? DRAKE_FIRST_SPAWN_SEC : lastDrake + DRAKE_RESPAWN_SEC,
		null
	)
	if (!grubsTaken && now < GRUBS_DESPAWN_SEC)
		add("grubs", "voidgrubs", GRUBS_SPAWN_SEC, GRUBS_DESPAWN_SEC)
	if (!heraldTaken && now < HERALD_DESPAWN_SEC)
		add("herald", "rift herald", HERALD_SPAWN_SEC, HERALD_DESPAWN_SEC)
	add(
		"baron",
		"baron",
		lastBaron === null ? BARON_SPAWN_SEC : lastBaron + BARON_RESPAWN_SEC,
		null
	)
	return out
}

/**
 * The soonest epic he could still act on — up and untaken, or spawning inside the travel lead.
 *
 * This is the gate on `death.counterpart`, and it is the difference between "the enemy jungler is
 * dead" and "the enemy jungler is dead AND there is something to take with the time that buys". In
 * the graded game the counterpart died three times inside the sampled turns: at 20:53 with Baron
 * standing (useful), at 25:39 while HE was also dead (useless), and at 28:12 with the next drake
 * and the next Baron both more than a minute away (false). Only the first had a window.
 */
export const contestableObjective = (tick: LiveTick): ObjectiveState | null => {
	const now = tick.gameTimeSec
	let best: ObjectiveState | null = null
	for (const o of objectiveStates(tick)) {
		if (o.upForSec === null && o.spawnSec - now > OBJECTIVE_LEAD_SEC) continue
		if (best === null || o.spawnSec < best.spawnSec) best = o
	}
	return best
}

/* ------------------------------------------------------------ the item spike */

/** The multiset of real (priced, non-trinket) items he is holding, as name -> count and price. */
const heldItems = (me: TickMe): Map<string, { count: number; price: number }> => {
	const out = new Map<string, { count: number; price: number }>()
	me.items.forEach((name, i) => {
		const price = me.itemPrices[i] ?? 0
		if (price <= 0) return
		const row = out.get(name)
		if (row) row.count += 1
		else out.set(name, { count: 1, price })
	})
	return out
}

/**
 * Did something COMBINE between these two ticks, and was it worth a turn? See `ITEM_SPIKE_GOLD`.
 *
 * Returns the headline item and the gold the assembly is worth, or null. Names are compared as a
 * multiset because he can hold two Amplifying Tomes, and a 5-second sample can catch a back in
 * which a legendary and its next components are all bought at once — which is exactly what happened
 * at 22:07 in the recorded game, and is why a rule watching the SLOT COUNT instead would have
 * missed Riftmaker.
 */
export const itemSpike = (
	prev: TickMe,
	now: TickMe
): { name: string; gold: number } | null => {
	const before = heldItems(prev)
	const after = heldItems(now)
	let addedGold = 0
	let removedGold = 0
	let headline: { name: string; price: number } | null = null
	for (const [name, row] of after) {
		const had = before.get(name)?.count ?? 0
		const gained = row.count - had
		if (gained <= 0) continue
		addedGold += gained * row.price
		if (headline === null || row.price > headline.price) headline = { name, price: row.price }
	}
	if (headline === null) return null
	for (const [name, row] of before) {
		const kept = after.get(name)?.count ?? 0
		const lost = row.count - kept
		if (lost > 0) removedGold += lost * row.price
	}
	// A straight purchase adds without consuming. Only an assembly is a spike.
	if (removedGold === 0) return null
	const gold = addedGold + removedGold
	return gold >= ITEM_SPIKE_GOLD ? { name: headline.name, gold } : null
}

/**
 * When the NEXT contest window will open, on the clock alone — the schedule's only honest lookahead.
 *
 * A jungler's future is mostly unknowable from this feed: nobody can say whether a fight is about to
 * break out or whether the enemy jungler is walking into a pit. Exactly one thing is certain, and it
 * is the thing contest windows are made of — an epic that has not spawned yet spawns at a known
 * second, and its window opens `OBJECTIVE_LEAD_SEC` before that. So "something bigger is seconds
 * away" is a question this file can answer without guessing, and the settle in `live-schedule.ts` is
 * gated on the answer.
 *
 * Only instances with no window record yet, because a window that has already opened has already
 * asked and is not about to arrive. The FLAT lead is used rather than the reach-adjusted one: the
 * reachability port answers `unknown` for every objective today, so the two are identical, and
 * reading a per-window ETA here would make the lookahead depend on which window happens to be open.
 */
export const nextOpeningSec = (
	watch: EventWatch,
	objectives: readonly ObjectiveState[],
	nowSec: number
): number | null => {
	let soonest: number | null = null
	for (const o of objectives) {
		if (o.upForSec !== null) continue
		if (watch.windows.has(o.key) || watch.closedWindows.has(o.key)) continue
		const opensAt = o.spawnSec - OBJECTIVE_LEAD_SEC
		if (opensAt <= nowSec) continue
		if (soonest === null || opensAt < soonest) soonest = opensAt
	}
	return soonest
}

/* ------------------------------------------------------------ detection */

/**
 * Diff one tick against the last and return the events that just became true.
 *
 * Mutates the watch. Returns only what is NEW — the caller appends it to `watch.pending`, which is
 * drained by a turn. Nothing is dropped on the floor here: an event detected while a turn is in
 * flight waits for the next one rather than vanishing, because a death nobody was asked about is
 * the failure this whole file is replacing.
 */
export const observeTick = (
	watch: EventWatch,
	tick: LiveTick,
	/**
	 * `standingSilenceSec` is an INSTRUMENT knob, exactly like `dueTurn`'s `heartbeatSec`: passing
	 * `Infinity` turns the standing-opportunity ask off, so a bench can replay the schedule as it
	 * stood before the fourth cut and the comparison stays re-derivable from the same samples
	 * forever. It is never passed by the app.
	 *
	 * `asksBeforeFifthCut` is the same idea for the fifth: it puts the opening look back as a
	 * QUESTION. The fifth cut removed it on a table of 879 stored turns, and a table nobody can
	 * reproduce next month is a table nobody should have believed — so
	 * `scripts/measure-asks.ts --before` replays the schedule as it stood, from the same samples,
	 * and the before column stays derivable rather than quoted. Also never passed by the app.
	 *
	 * It restored the counter-jungle window too until the sixth change put that ask back for real,
	 * which is why the knob now moves ONE thing and the 879-turn table still reproduces exactly.
	 * The name is kept: it names the schedule it reproduces, not the number of asks it touches.
	 */
	opts: {
		reach?: ReachFn
		standingSilenceSec?: number
		asksBeforeFifthCut?: boolean
		/**
		 * `hingeSilenceSec` is the third instrument knob of the same family: `Infinity` turns the
		 * hinge ask off, so a bench can replay the schedule as it stood before it and the before/after
		 * comparison stays derivable from the same samples forever. Never passed by the app.
		 */
		hingeSilenceSec?: number
		/**
		 * `standingAskCap` is the fifth, and it is a knob because the value shipped at `big-calls`
		 * was chosen from a sweep of it — see `STANDING_ASK_CAP`. `Infinity` is the uncapped
		 * schedule, which is what `key-moments` and `commentary` have and what every stored
		 * measurement in `data/eval/` was taken under.
		 */
		standingAskCap?: number
		/**
		 * `alsoAsk` is the fourth instrument knob, and it is the only one that points the other way:
		 * the three above turn an ask OFF, and this one puts a kind the LEVEL vetoes back, so a
		 * bench can ask what a level WOULD get from a kind it does not currently allow.
		 *
		 * It can only ADD. A bench cannot use it to take a kind away from `commentary`, which is the
		 * schedule every stored measurement in `data/eval/` was taken on — subtraction already has a
		 * knob per kind and each of those names the arm it reproduces. Adding is the missing
		 * direction: before `scripts/measure-asks.ts --standing`, the only way to price
		 * "what if `big-calls` allowed `window.standing`" was to ship it and measure afterwards,
		 * which is exactly the order this repo refuses.
		 *
		 * Never passed by the app, on the same footing as the three knobs above: nothing enforces
		 * that but review, which is why it can only widen a level and never narrow one — the worst a
		 * forgotten `alsoAsk` can do is ask more, loudly, where a forgotten subtraction would make
		 * the coach quieter and look like nothing at all.
		 */
		alsoAsk?: readonly LiveEventKind[]
		/**
		 * HOW OFTEN SHE IS ASKED — see `SPEAK_LEVELS`. Absent means `DEFAULT_SPEAK_LEVEL`, which is
		 * the quiet one, so a caller that forgets gets the shipped default rather than the schedule
		 * the owner rated 0/10. Every replay that means the OLD schedule therefore has to say
		 * `level: "commentary"` out loud, which is the right way round: a bench that does not name
		 * the schedule it is replaying is the bug.
		 */
		level?: SpeakLevel
	} = {}
): LiveEvent[] => {
	const out: LiveEvent[] = []
	const now = tick.gameTimeSec
	const policy = askPolicy(opts.level)
	/*
	 * `asks` and `windowKey` default to "no" and "none", so no detector can cause a turn by accident.
	 * The kinds that DO ask pass it explicitly, and there are two families of them: the three
	 * CONTEST WINDOWS at the foot of this function (`window.open`, `window.changed`,
	 * `window.standing`), and the FIELD decisions above it — him coming back up, and a spike, level
	 * or item. See the `fieldAsks` block for the corpus measurement that added the second family,
	 * and the `death.counterpart` fire site for the one the fifth cut took out and the sixth
	 * change put back.
	 */
	const fire = (
		e: Omit<LiveEvent, "asks" | "windowKey" | "seenAtSec"> & {
			asks?: boolean
			windowKey?: string | null
		}
	): boolean => {
		if (watch.fired.has(e.key)) return false
		watch.fired.add(e.key)
		out.push({
			...e,
			/*
			 * TWO GATES, AND THIS IS THE SECOND. The fire site decides whether this kind of thing is
			 * a question at all — that is the third and fifth cuts, measured, and it is not a
			 * setting. The LEVEL then decides whether the user wants to be asked that kind of
			 * question today. An event the level vetoes is not dropped: it keeps its note, rides the
			 * next turn as context, and is still there for the bench to count. See `AskPolicy`.
			 */
			asks:
				e.asks === true &&
				(policy.kinds.includes(e.kind) || (opts.alsoAsk?.includes(e.kind) ?? false)),
			windowKey: e.windowKey ?? null,
			/*
			 * NOW, not `atSec`. A window's `atSec` is its spawn and a kill's is the log's own clock;
			 * the settle needs the moment the question appeared. See `LiveEvent.seenAtSec`.
			 */
			seenAtSec: now
		})
		return true
	}

	/*
	 * A NEW GAME resets everything, and it happens BEFORE `prev` is read.
	 *
	 * The clock going backwards is the only signal available — one journal session held 715 frames
	 * across two games and the second restarted at tSec 2. Carrying game N-1's fired keys into game
	 * N would suppress game N's first death; carrying its counterpart would name a champion who is
	 * not in the game, which is the hallucination this app's design exists to fight.
	 *
	 * Reading `prev` first is how the first draft of this got it wrong and the test caught it:
	 * everything was reset, and then every diff below ran against the PREVIOUS GAME's final tick,
	 * so game two opened with no `game.start` and with a level, item and resource diff taken across
	 * a loading screen.
	 */
	if (watch.prev !== null && now < watch.prev.gameTimeSec - 5) {
		const fresh = newEventWatch()
		watch.prev = null
		watch.seenEventIds = fresh.seenEventIds
		watch.fired = fresh.fired
		watch.counterpartSeenAtSec = null
		watch.counterpartMissing = false
		watch.lastDeathNote = null
		watch.lastTurnAtSec = null
		watch.pending = []
		watch.windows = fresh.windows
		watch.closedWindows = fresh.closedWindows
		watch.counters = fresh.counters
		watch.fightsSeen = 0
		watch.enemiesOpen = false
		watch.clusterKills = 0
		watch.lastKillAtSec = null
		watch.lastShopAtSec = null
		watch.askSeq = 0
		watch.settleSinceSec = null
		watch.standingAsks = 0
		watch.lastStandingAskAtSec = null
		watch.nextOpeningSec = null
	}
	const prev = watch.prev

	/* -------------------------------------------------- the event log */
	for (const e of tick.events) {
		if (watch.seenEventIds.has(e.id)) continue
		watch.seenEventIds.add(e.id)
		/*
		 * The FIRST tick of a session adopts the log without firing it. The page can be opened at
		 * 14:00, and a log replayed from GameStart would fire nine deaths and four drakes at once —
		 * every one of them minutes old, and the newest of them the only one worth a question.
		 */
		if (prev === null) continue

		if (e.name === "ChampionKill") {
			/*
			 * EVERY champion kill feeds the cluster, including his own and his team's. A fight is a
			 * fact about the map — who is standing near a pit — and it does not care who was in it.
			 * Resolution is checked once per tick, further down, because it is the QUIET that ends a
			 * fight and quiet is not an event.
			 */
			watch.clusterKills += 1
			watch.lastKillAtSec = Math.max(watch.lastKillAtSec ?? e.atSec, e.atSec)
			const victimIsMe = e.victim === tick.me.name
			const victim = tick.players.find(p => p.name === e.victim) ?? null
			const cp = counterpartOf(tick)
			/*
			 * A KILL IS NOT A TURN, and this is where the first version of this file went wrong.
			 *
			 * The recorded game caught it. 5639406342's live log carries 62 champion kills across 28
			 * minutes (the post-game match counts 69), and firing on each one produced 105 turns — MORE than the 85 the timer it replaces produces, and
			 * for exactly the same reason. A coach asked about every corpse is as mechanical as a
			 * coach asked every twenty seconds.
			 *
			 * The rule that survives is the app's own test for WHAT may be said, applied to WHEN it
			 * is asked: not visible, and not generic — sharpened, by the graded run, to "is a
			 * decision about something that has not happened yet open or closed by this".
			 *
			 *   - HIS death closes every decision for the next 10-45 seconds. He is looking at a grey
			 *     screen and cannot act on an answer, so it no longer asks anything; it is remembered
			 *     and spent on `respawn.self`, which is the fork in the road and which is the turn
			 *     the graded run actually scored useful.
			 *   - THE COUNTERPART's death is the one death he very likely did not see, and it OPENS a
			 *     window — but only if there is something standing in that window to take. See
			 *     `contestableObjective` for the three graded cases that settled the gate.
			 *   - Everyone else's death he watched happen, on the minimap or in the recap. It is
			 *     visible by construction, and what the exchange as a whole bought is retrospective —
			 *     the post-game reviewer's job. `fight.resolved` tried to ask it live and was the
			 *     largest single source of true-but-useless lines in the graded run.
			 */
			if (victimIsMe) {
				watch.lastDeathNote = `${championOf(tick, e.killer) ?? e.killer ?? "someone"} killed ${
					tick.me.champion
				} at ${Math.round(e.atSec)}s`
				continue
			}
			if (cp === null || victim === null || victim.name !== cp.name) continue
			if (tick.me.dead) continue
			/*
			 * THE COUNTER-JUNGLE WINDOW, and it used to be gated behind a pit.
			 *
			 * `contestableObjective(tick)` returned null and this whole event was dropped, so the
			 * best fact this app has — the man he is racing is off the map, for a number of seconds
			 * drawn nowhere in his client — existed only while a drake or the grubs happened to be
			 * inside their own lead. Over the 17-game corpus that is 61% of the clock, and the
			 * consequence is in `FIELD_CP_DOWN`'s docblock: 79% of everything the coach said was
			 * about an objective, because an objective was the only thing it was ever asked about.
			 *
			 * So the objective is now the NOTE and no longer the gate. A death with a pit beside it
			 * still says which pit; a death with nothing beside it says how long he is down, which
			 * is a decision about his camps whether or not anything is standing.
			 *
			 * `FIELD_CP_MIN_SEC` is the one thing that can still drop it: a window he cannot act
			 * inside is not a window. The remaining timer is read off the ROSTER row rather than
			 * assumed from the kill, because the roster is audited exact for deaths and respawns and
			 * because a kill seen two ticks late has already spent some of it.
			 *
			 * AND IT NO LONGER ASKS AT ALL — the fifth cut, and the one that cost a real line.
			 *
			 * With a pit already open it never did: the counterpart's death is an input to that pit's
			 * decision, `materialDiff` re-asks the pit on exactly this counter, and asking twice for
			 * one moment is the three-turns-in-twelve-seconds failure the third cut removed. What is
			 * new is the OPEN GROUND, where this was the whole question — and where it was measured
			 * to be the worst ask in the app.
			 *
			 * Over the 28-game corpus (`data/eval/integrate3-corpus-20260912.json`), every turn
			 * rejoined to the ask that raised it and graded by TWO instruments — the blind judge
			 * beside the run, and `scripts/lib/payload-claims.ts`, which subtracts the payload's own
			 * death clocks out of the sentence in code:
			 *
			 * ```
			 *   death.counterpart   47 turns   wrong 66% [52-78]   clean-useful 34% [22-48]
			 *   every ask pooled   879 turns   wrong 25% [22-28]   clean-useful 69% [66-72]
			 * ```
			 *
			 * Both intervals are separated from the pooled rate, and it is the ONLY ask kind in the
			 * corpus that produces more wrong lines than useful ones — 31 against 16.
			 *
			 * AND THE SIXTH CHANGE PUT THE ASK BACK, because the fifth read that table the wrong way.
			 *
			 * The fifth cut concluded the ask was STRUCTURALLY bad: that in the open ground the death
			 * clock is the entire sentence, so a model that reads the clock backwards has nothing
			 * left to be right about, while every other ask survives on a second fact. The same
			 * corpus refutes that, once each wrong line is split by WHICH of the two instruments
			 * convicted it — `why()` in `scripts/measure-asks.ts`, re-derivable with `--before`:
			 *
			 * ```
			 *   cause                          spoke   wrong        clock ONLY   judge ONLY   resc
			 *   changed:counterpart died         118   55% [46-64]  44% [35-53]   3% [1-8]      52
			 *   death.counterpart                 52   60% [46-72]  40% [28-54]  10% [4-21]     21
			 *   window.open                      204   17% [13-23]   3% [2-7]    13% [9-18]      7
			 *   ALL                              837   25% [22-28]  11% [9-14]   11% [9-13]     96
			 * ```
			 *
			 * `judge ONLY` is the column that asks whether the QUESTION was worth asking — the blind
			 * judge reading the advice, with no view of any clock — and on this premise it is the
			 * lowest in the app: 3% [1-8] on the 118-turn twin, 10% [4-21] here, both at or under the
			 * pooled 11%. As coaching, "the man you are racing is off the map for the next 25
			 * seconds" is the best question this app asks. It is wrecked by one number read
			 * backwards and by nothing else.
			 *
			 * The second-fact theory fails on its own evidence too. `changed:counterpart died` IS
			 * this premise with a pit beside it — the second fact that was said to rescue every other
			 * ask — and it comes out 55% wrong at 44% clock-only, no better than the open ground.
			 * `window.changed`'s healthy 71% clean is pooled over six causes; split, the
			 * counterpart's death is its worst by a distance and `he backed` its best at 13%. A pit
			 * does not save the sentence, because the model still reaches for the clock.
			 *
			 * SO THE TRADE WAS MISREAD, AND THE NUMBER THAT MISREAD IT IS THE RATIO. Deleting this
			 * ask removes 1.11 wrong lines per game against 0.75 useful — 1.48, a healthy-looking
			 * cut. But 0.75 of those 1.11 are RESCUABLE: wrong only in a death clock, with advice the
			 * judge graded useful. Counted honestly the cut removes 0.36 real errors per game and
			 * 1.50 good questions, a ratio of 0.24, which is a bad trade by this repo's own rule.
			 * `scripts/measure-asks.ts --cuts` now prints `resc` beside every ratio for exactly this
			 * reason.
			 *
			 * AND THE CUT WAS SELF-SEALING, which is what settles it rather than leaving it a
			 * judgement call. `asksBeforeFifthCut` restores the ask for a REPLAY over lines already
			 * stored; it cannot make a model answer a turn the shipped schedule never took. With the
			 * ask off, the corpus run that measures the death-clock fix would hold zero of these
			 * turns, and whether to restore it could never be answered from evidence — the cut
			 * deletes the only thing that could overturn it.
			 *
			 * The cost of being wrong is stated and is one re-run away: if the clock fix does not
			 * work, this ask is +1.11 wrong lines per game, and flipping `asks` to false here with
			 * `scripts/measure-asks.ts --vs` re-derives every figure above.
			 */
			const window = contestableObjective(tick)
			/*
			 * `respawn` is what is LEFT of his timer, and this line used to render it `down Ns`.
			 *
			 * `down Ns` was this app's word for the ELAPSED half — `live-brief.ts` states both
			 * clocks in one breath (`DEAD, died 2s ago, respawns in 14s`) and the prompt's feed note
			 * says in terms that neither can be turned into the other. So the note that names WHY a
			 * turn fired was printing the remaining figure under the elapsed figure's name, in the
			 * one vocabulary this repo spent three waves making unambiguous. It now uses the feed's
			 * own word for the remaining clock, so the two cannot drift apart again in silence.
			 *
			 * Nothing the model reads was affected — `describeTurn` goes to the fault panel and the
			 * transcript, never into a payload — so this is not the 44% clock-only wrongness
			 * measured on the counterpart-death premise. It is worse in a smaller way: it is the
			 * inversion sitting inside the instrument used to audit the inversion. Every row
			 * `scripts/measure-asks.ts` writes carries this note, and a reviewer checking a spoken
			 * "dead for 24 seconds" against a cause reading `down 24s` would have marked the line
			 * correct.
			 */
			const backInSec = victim.dead ? victim.respawn : 0
			if (window === null && backInSec < FIELD_CP_MIN_SEC) continue
			fire({
				kind: "death.counterpart",
				atSec: e.atSec,
				reactive: true,
				asks: window === null,
				key: `kill:${e.id}`,
				note: `${championOf(tick, e.killer) ?? e.killer ?? "someone"} killed ${cp.champion}${
					backInSec > 0 ? `, respawns in ${Math.round(backInSec)}s` : ""
				}${
					window === null ? ""
					: window.upForSec === null ?
						`, ${window.what} in ${Math.round(window.spawnSec - now)}s`
					:	`, ${window.what} up ${Math.round(window.upForSec)}s`
				}`
			})
			continue
		}

		/*
		 * EPIC MONSTERS AND INHIBITORS, and deliberately not turrets.
		 *
		 * This is a jungler's coach. Drakes, Baron, Herald and grubs are his job and his call, and
		 * an inhibitor changes what the whole map is allowed to do. Turret plates and towers are a
		 * laner's outcome — he can see them on his own minimap, they are the definition of a fact
		 * that fails the "could he have got it by looking at his screen" test, and there are up to
		 * 22 of them in a game. In the recorded game they were 11 of the 23 objective events, which
		 * is a fifth of the coach's whole voice spent narrating towers.
		 *
		 * GRUBS COUNT, which they did not before — `HordeKill` was not in this list at all, so the
		 * one objective that is most exclusively a jungler's was the one the coach never mentioned.
		 * They come in threes and the recorded game logged its cluster across 23 seconds, so the key
		 * buckets them: one turn for the set, not three for the same thirty seconds of map.
		 */
		if (
			e.name === "DragonKill" ||
			e.name === "BaronKill" ||
			e.name === "HeraldKill" ||
			e.name === "HordeKill" ||
			e.name === "InhibKilled"
		) {
			/*
			 * The take is a MATERIAL CHANGE on every other window still open, and it is the only
			 * thing in this feed that says where the enemy jungler just was. Both of round 2's
			 * useful `objective.taken` lines are that join and nothing else — 7:23 "Kayn just took
			 * that drake bot side, so he's there, making those grubs free" and 18:02 "Kayn just got
			 * Herald topside, so path bot to secure this drake". Neither is about the thing that
			 * fell; both are about the thing that has not.
			 *
			 * An inhibitor is counted as context and NOT as a take: it changes no jungle contest,
			 * and both of round 2's inhibitor turns were useless.
			 */
			const isEpic = e.name !== "InhibKilled"
			/*
			 * WHOSE take it was, because that is the whole weight of the note. An enemy take locates
			 * the enemy jungler and makes the next thing free; an ally take only re-prices the map.
			 * See `CARRY_ENEMY_TAKE`.
			 */
			const takerTeam =
				e.killer === null ? null : (tick.players.find(p => p.name === e.killer)?.team ?? null)
			const byEnemy = takerTeam !== null && takerTeam !== tick.me.team
			if (
				fire({
					kind: "objective.taken",
					atSec: e.atSec,
				/*
				 * NOT reactive. A drake that just fell is worth the 1.3-3.0s minimap read in front
				 * of the turn, because "where was he when it fell" is the entire content of the
				 * post-game reviewer's best objective items and the only half of it this feed has.
				 */
				reactive: false,
				key:
					e.name === "HordeKill" ?
						`obj:horde:${Math.floor(e.atSec / 60)}`
					:	`obj:${e.id}`,
					note: `${e.name}${e.dragonType !== null ? ` (${e.dragonType})` : ""}${e.stolen ? " STOLEN" : ""}`
				}) &&
				isEpic
			)
				watch.counters.takes += 1
			continue
		}
	}

	/* -------------------------------------------------- the fingerprint's own counters */
	/*
	 * The material state of the game, kept as running counters so `materialDiff` is a comparison
	 * rather than a judgement. See `WindowMark` for what is deliberately not here.
	 *
	 * Both death counts come off the SCOREBOARD rather than off the kill log, because the scoreboard
	 * is monotone by construction and survives a page opened at 14:00 — a log replayed from
	 * GameStart is explicitly not read on the first tick (see above), so a counter built from it
	 * would start at zero mid-game and then jump.
	 */
	watch.counters.myDeaths = tick.me.deaths
	const cpNow = counterpartOf(tick)
	if (cpNow !== null) watch.counters.cpDeaths = cpNow.deaths

	/*
	 * HE BACKED, inferred from the only thing in this feed that can only happen in the shop. See
	 * `SHOP_SPEND_GOLD`.
	 */
	if (prev !== null) {
		const spent = prev.me.gold - tick.me.gold
		if (
			spent >= SHOP_SPEND_GOLD &&
			(watch.lastShopAtSec === null || now - watch.lastShopAtSec >= SHOP_TRIP_GAP_SEC)
		) {
			watch.lastShopAtSec = now
			watch.counters.shopTrips += 1
			fire({
				kind: "shop.trip",
				atSec: now,
				reactive: false,
				key: `shop:${watch.counters.shopTrips}`,
				note: `spent ${Math.round(spent)}g`
			})
		}
	}

	/*
	 * A FIGHT RESOLVES on the QUIET, which is why it is checked here on every tick rather than in
	 * the event loop. See `FIGHT_MIN_DEATHS`.
	 */
	/*
	 * TWO ENEMIES DOWN is the half of a fight a contest window turns on — see `WindowMark`. It is
	 * read off the roster rather than off the log, so it is true while they are down and false the
	 * moment they are not, with no cluster to keep.
	 */
	const enemiesDown = tick.players.filter(p => p.team !== tick.me.team && p.dead).length
	if (!watch.enemiesOpen && enemiesDown >= ENEMIES_DOWN_FREE) {
		watch.enemiesOpen = true
		watch.counters.enemiesOpened += 1
	} else if (watch.enemiesOpen && enemiesDown === 0) watch.enemiesOpen = false

	if (
		watch.lastKillAtSec !== null &&
		now - watch.lastKillAtSec >= FIGHT_QUIET_SEC &&
		watch.clusterKills >= FIGHT_MIN_DEATHS
	) {
		watch.fightsSeen += 1
		fire({
			kind: "fight.resolved",
			atSec: watch.lastKillAtSec,
			reactive: false,
			key: `fight:${watch.fightsSeen}`,
			note: `${watch.clusterKills} champions died, quiet since ${Math.round(watch.lastKillAtSec)}s`
		})
		watch.clusterKills = 0
		watch.lastKillAtSec = null
	} else if (watch.lastKillAtSec !== null && now - watch.lastKillAtSec >= FIGHT_QUIET_SEC) {
		// A single pick is not a fight. Drop the cluster rather than letting it accumulate all game.
		watch.clusterKills = 0
		watch.lastKillAtSec = null
	}

	/* -------------------------------------------------- his own state */
	/*
	 * THE OPEN GROUND: is there a pit in play at all right now?
	 *
	 * The field decisions below ask only when there is not. Not a rate limit and not a cooldown —
	 * it is what makes them a separate UNIT rather than a second opinion about the same moment. A
	 * spike, a respawn or a counterpart's death while a drake sits inside its own lead is an input
	 * to the drake decision, it already rides that turn as context, and `materialDiff` re-asks the
	 * window on two of the three. Replayed over the 17-game corpus the gate is the difference
	 * between +15% turns and +1%: without it the field asks add 29 turns to the 61% of the clock
	 * that was already the chattiest, which is volume with no change of subject.
	 *
	 * The counterpart's death USED to be the third of these and is no longer any of them — see its
	 * own fire site above. It was the one field decision whose entire sentence was a death clock,
	 * and it was measured wrong 66% [52-78] of the time it opened the coach's mouth.
	 */
	const fieldAsks = contestableObjective(tick) === null
	if (prev !== null) {
		if (prev.me.dead && !tick.me.dead)
			/*
			 * Out of the fountain, which is the fork in the road — path back to a camp, walk to the
			 * objective, or reset again. This is the only turn a death now produces, and in the
			 * graded run it is the one that produced "that death at dragon was tough but we can't
			 * change it, so let's reset and run straight to those Voidgrubs while Kayn is resetting
			 * too": a line about the next thirty seconds rather than the last ten.
			 */
			/*
			 * AND IT ASKS, which it could not do before except by proxy.
			 *
			 * `respawnTarget` below already lets a respawn OPEN an objective window when one sits
			 * inside `RESPAWN_HORIZON_SEC` — so the fork in the road reached the model only when the
			 * fork happened to have a pit at the end of it. Priced at `FIELD_RESPAWN_SELF`, well
			 * under every objective, so a respawn that DOES open a window still rides that window's
			 * value rather than competing with it: both asks land on the same turn.
			 */
			fire({
				kind: "respawn.self",
				atSec: now,
				reactive: true,
				asks: fieldAsks,
				key: `respawn:${tick.me.deaths}`,
				note: watch.lastDeathNote === null ? "he is back up" : `back up — ${watch.lastDeathNote}`
			})

		/*
		 * THE SPIKE WINDOW. Both halves of it ask, and they are the cheapest asks in the file.
		 *
		 * A spike level or an assembled legendary changes what he may contest for the next minute,
		 * and unlike the counterpart's death timer it is a fact he CAN see — so it is priced lowest
		 * of the three field decisions and loses to every pit. What it buys is the stretch where
		 * nothing is open: over the corpus, 189 of 485 minutes carried no objective window at all
		 * and the coach was asked once every 166 seconds in it.
		 */
		for (const lv of SPIKE_LEVELS)
			if (prev.me.level < lv && tick.me.level >= lv)
				fire({
					kind: "level.spike",
					atSec: now,
					reactive: false,
					asks: fieldAsks,
					key: `level:${lv}`,
					note: `level ${lv}`
				})

		/*
		 * An item COMPLETING, spotted by the combine rather than by a price. See `ITEM_SPIKE_GOLD`
		 * for the measurement that replaced the old rule, which fired once in 28 minutes and missed
		 * both legendaries.
		 */
		const spike = itemSpike(prev.me, tick.me)
		if (spike !== null)
			fire({
				kind: "item.completed",
				atSec: now,
				reactive: false,
				asks: fieldAsks,
				key: `item:${spike.name}`,
				note: `finished ${spike.name} (${spike.gold}g assembled)`
			})
	}

	/* -------------------------------------------------- the counterpart */
	/*
	 * Where the enemy jungler is, inferred from the only thing this feed can honestly say about
	 * him: whether anything about him moved. See `COUNTERPART_ABSENT_SEC`.
	 *
	 * Both directions are still TRACKED, because the absence clock needs the sightings to run. Only
	 * the absence is fired.
	 */
	const cp = counterpartOf(tick)
	if (cp !== null) {
		const cpPrev = prev === null ? null : counterpartOf(prev)
		const moved =
			cpPrev === null ||
			cp.level !== cpPrev.level ||
			cp.seenCs !== cpPrev.seenCs ||
			cp.itemCount !== cpPrev.itemCount ||
			cp.dead !== cpPrev.dead ||
			cp.kills !== cpPrev.kills ||
			cp.deaths !== cpPrev.deaths ||
			cp.assists !== cpPrev.assists
		if (moved) {
			// HE IS BACK IN SOMEBODY'S VISION. The transition, not the state — see `WindowMark`.
			if (watch.counterpartMissing) watch.counters.cpReappearances += 1
			watch.counterpartSeenAtSec = now
			watch.counterpartMissing = false
		} else if (
			!watch.counterpartMissing &&
			watch.counterpartSeenAtSec !== null &&
			now - watch.counterpartSeenAtSec >= COUNTERPART_ABSENT_SEC
		) {
			watch.counterpartMissing = true
			fire({
				kind: "counterpart.unseen",
				atSec: now,
				reactive: false,
				key: `cp-gone:${Math.round(watch.counterpartSeenAtSec)}`,
				note: `${cp.champion} unseen for ${Math.round(now - watch.counterpartSeenAtSec)}s`
			})
		}
		if (watch.counterpartSeenAtSec === null) watch.counterpartSeenAtSec = now
	}

	/* -------------------------------------------------- the contest windows */
	/*
	 * THE UNIT. Everything above this point detects; this is the only block that ASKS.
	 *
	 * A contest window is one objective instance while the decision about it is still open. The two
	 * events the second cut used — `objective.window` 45s before a spawn and `objective.contested`
	 * once it had stood a minute — are gone, because the window subsumes both and the fourth cut
	 * removed what was left of them. What asks is the WINDOW: once when it opens, again when
	 * `materialDiff` says the game moved underneath it, and — see `STANDING_SILENCE_SEC` — once more
	 * if it is still standing after a real lull.
	 *
	 * That is the whole of the third cut, and the reason for it is one number. Round 2 asked 38
	 * times and produced three separate drake lines inside nineteen seconds (18:02, 18:08, 18:21)
	 * from three different event kinds — a Herald take, the counterpart going dark and a level 11 —
	 * all three of them about the same drake, spawning at 18:41. Three events, one decision. Asking
	 * per event is how a coach with one thing to say says it three times.
	 *
	 * BOTH HALVES ARE GATED ON HIM BEING ALIVE, and the reason is unchanged from the second cut. At
	 * 13:16 in the graded run a herald window fired while he was 12 seconds into a 21-second death
	 * and the model answered "you are dead so that is generic" — a turn spent, out loud, saying it
	 * had nothing. A window he is dead for is not a decision he has. The record is not created, so
	 * it opens on the first tick he is back up and still inside the window, and is simply lost if
	 * the whole window passes while he is down, which is the truth.
	 */
	const liveObjectives = objectiveStates(tick)

	const reach = opts.reach ?? REACH_UNKNOWN
	const liveByKey = new Map(liveObjectives.map(o => [o.key, o]))

	/*
	 * A WINDOW THAT CLOSES WITHOUT AN ASK IS FINE. `objectiveStates` stops returning an instance the
	 * moment it is taken or leaves the map, and the drake/Baron key carries its own spawn clock, so
	 * the next instance is a different window and never inherits this one's asks.
	 */
	for (const key of [...watch.windows.keys()])
		if (!liveByKey.has(key)) {
			watch.windows.delete(key)
			watch.closedWindows.add(key)
		}

	const respawnedNow = prev !== null && prev.me.dead && !tick.me.dead
	/*
	 * THE SOONEST ONE ONLY, and this is measured rather than tidy.
	 *
	 * The first version let a respawn open every window inside `RESPAWN_HORIZON_SEC`, and replayed
	 * over the graded game that opened Herald at 13:28 — 92 seconds before it spawned, off the back
	 * of a death that had nothing to do with it — which spent the window's opening ask and DESTROYED
	 * round 2's useful 14:17 line, "you're a level up on Kayn and Rift Herald spawns in forty
	 * seconds so start pathing top to contest it". He walks out of the fountain towards one thing.
	 */
	const soonest =
		liveObjectives
			.filter(o => !watch.closedWindows.has(o.key))
			.sort((a, b) => a.spawnSec - b.spawnSec)[0] ?? null
	const respawnTarget =
		(
			respawnedNow &&
			soonest !== null &&
			!watch.windows.has(soonest.key) &&
			soonest.spawnSec - now <= RESPAWN_HORIZON_SEC
		) ?
			soonest.key
		:	null

	if (!tick.me.dead)
		for (const o of liveObjectives) {
			if (watch.closedWindows.has(o.key)) continue
			const untilSpawn = o.spawnSec - now
			const standing = o.upForSec !== null
			const read = reach(tick, o)
			/*
			 * "The range where he could still get there." With no reachability module the flat lead
			 * decides, exactly as before; with one, the window opens when the objective comes inside
			 * his own travel time plus the length of the fight he has to arrive for.
			 */
			const lead =
				read.etaSec === null ? OBJECTIVE_LEAD_SEC : read.etaSec + REACH_MARGIN_SEC
			const inLead = untilSpawn <= lead
			const record = watch.windows.get(o.key) ?? null

			if (record === null) {
				// See `RESPAWN_HORIZON_SEC` — the one opening that looks further than the lead.
				const onRespawn = respawnTarget === o.key
				if (!standing && !inLead && !onRespawn) continue
				const opened: WindowRecord = {
					key: o.key,
					what: o.what,
					spawnSec: o.spawnSec,
					openedAtSec: now,
					opening: standing ? "standing" : inLead ? "lead" : "respawn",
					asks: 1,
					askedMark: { ...watch.counters, reach: read.verdict },
					reach: read.verdict,
					reachPending: read.verdict,
					reachPendingSince: now
				}
				watch.windows.set(o.key, opened)
				fire({
					kind: "window.open",
					atSec: o.spawnSec,
					// A window opened by him leaving the fountain decays in seconds; a clock does not.
					reactive: opened.opening === "respawn",
					asks: true,
					windowKey: o.key,
					key: `w-open:${o.key}`,
					note:
						standing ?
							`${o.what} up ${Math.round(o.upForSec ?? 0)}s and untaken`
						:	`${o.what} in ${Math.round(untilSpawn)}s (${opened.opening})`
				})
				continue
			}

			/*
			 * ONE ASK PER WINDOW — the second one has to be paid for.
			 *
			 * `materialDiff` is the price, and every field it compares is a counter or a debounced
			 * verdict declared in `WindowMark` with the threshold that moves it. Nothing here looks
			 * at the clock, at his bars, or at the line the model wrote: this is not a rate limit and
			 * a turn it declines to raise is a question that is not asked, never a sentence that is
			 * suppressed.
			 */
			if (read.verdict !== record.reachPending) {
				record.reachPending = read.verdict
				record.reachPendingSince = now
			}
			if (
				read.verdict !== record.reach &&
				now - record.reachPendingSince >= REACH_FLIP_SEC
			)
				record.reach = read.verdict

			const markNow: WindowMark = { ...watch.counters, reach: record.reach }
			const moved = materialDiff(record.askedMark ?? markNow, markNow)
			if (moved.length === 0) {
				/*
				 * THE OPPOSITE FAILURE, and it cost this app its biggest missed moment.
				 *
				 * `materialDiff` prices the SECOND ask on something having changed, which is correct
				 * and is also blind to the case where the news is that nothing has. Game 5639406342:
				 * the drake window opens at 4:21 on the lead, the drake spawns at 5:00 and stands
				 * untaken until roughly 7:20, and in all that time not one field of the fingerprint
				 * moves — so the detector raises nothing between 4:21 and 7:17. Two minutes fifty-six
				 * seconds of silence over a free drake, which is the largest counterfactual in the
				 * corpus and the exact inverse of the three-turns-in-twelve-seconds cluster.
				 *
				 * The gate is the SILENCE, not the clock, and that is what stops it becoming the
				 * timer this file replaced. It can only fire when the coach has been asked nothing
				 * for `STANDING_SILENCE_SEC` AND nothing is already queued to ask — so any ordinary
				 * game, where something is always moving, never reaches it. Over the two paired games
				 * it fires twice in an hour.
				 *
				 * THE CAP STOPS THE DETECTOR, not just the ask, and that is the one place in this
				 * file that departs from "demote, never delete". The rule exists so a kind a LEVEL
				 * does not want still carries its note as context; a spent per-game budget is a
				 * different thing, because the note a demoted standing event carries reads "drake
				 * still up 51s, nothing asked for 90s" — a sentence about a question that cannot
				 * now be asked, which is payload noise rather than context. The order of magnitude is
				 * the uncapped fire rate at this level, 7.46 a game against the capped 0.96 — so
				 * roughly six notes a game about a question that cannot be asked. That figure is the
				 * uncapped arm's, not a replay of a fire-uncapped-ask-capped variant, which was
				 * never built. The bench keeps the full picture by passing
				 * `standingAskCap: Infinity`, which is what that knob is for.
				 */
				const nothingQueued =
					!watch.pending.some(e => e.asks) && !out.some(e => e.asks)
				if (
					standing &&
					nothingQueued &&
					watch.standingAsks < (opts.standingAskCap ?? policy.standingAskCap) &&
					watch.lastTurnAtSec !== null &&
					now - watch.lastTurnAtSec >= (opts.standingSilenceSec ?? policy.standingSilenceSec) &&
					(watch.lastStandingAskAtSec === null ||
						now - watch.lastStandingAskAtSec >=
							(opts.standingSilenceSec ?? policy.standingSilenceSec))
				) {
					watch.lastStandingAskAtSec = now
					watch.standingAsks += 1
					record.asks += 1
					fire({
						kind: "window.standing",
						atSec: o.spawnSec,
						/*
						 * NOT reactive. A thing that has stood for a minute is the definition of a
						 * standing premise, and it is exactly the kind of turn the 1.3-3.0s minimap
						 * read pays for: "drake up 51s" becomes "drake up 51s and you are top side".
						 */
						reactive: false,
						asks: true,
						windowKey: o.key,
						key: `w-stand:${o.key}:${watch.standingAsks}`,
						note: `${o.what} still up ${Math.round(o.upForSec ?? 0)}s, nothing asked for ${Math.round(
							now - watch.lastTurnAtSec
						)}s`
					})
				}
				continue
			}
			record.askedMark = markNow
			record.asks += 1
			watch.askSeq += 1
			fire({
				kind: "window.changed",
				atSec: o.spawnSec,
				reactive:
					moved.includes("he died and is back") ||
					moved.includes("counterpart died") ||
					moved.includes("two enemies are down"),

				asks: true,
				windowKey: o.key,
				key: `w-chg:${o.key}:${watch.askSeq}`,
				note: `${o.what} ${
					standing ? `up ${Math.round(o.upForSec ?? 0)}s` : `in ${Math.round(untilSpawn)}s`
				} — ${moved.join(", ")}`
			})
		}

	/* -------------------------------------------------- the hinge window */
	/*
	 * ONE GUARANTEED QUESTION INSIDE THE FIVE MINUTES THAT DECIDE HIS GAMES — see
	 * `HINGE_SILENCE_SEC` for the four death-predictor shapes this is NOT, each with the
	 * measurement that refuted it, and `HINGE_FROM_SEC` for where the bounds come from.
	 *
	 * Everything about it yields. It is checked after the contest windows so that `out` already
	 * holds anything they raised; an ask queued or raised on this tick takes the turn instead and
	 * this never fires. He has to be ALIVE, on the same rule the windows follow — a stretch he is
	 * watching a grey screen through is not a decision he has. Once per game, by the dedupe key,
	 * because the claim being acted on is that the window should not pass in silence and not that it
	 * wants a cadence.
	 *
	 * It is DETECTED at every level and asks only where the level allows it, exactly as everything
	 * else here does. Under `commentary` the gate is unreachable on all 28 games of the corpus
	 * anyway, which is the second of the two reasons that schedule replays byte for byte.
	 */
	const hingeSilenceSec = opts.hingeSilenceSec ?? HINGE_SILENCE_SEC
	/*
	 * FROM THE WINDOW'S OWN START, never from a lull that happened before it — see
	 * `HINGE_SILENCE_SEC`. `lastTurnAtSec` is non-null from the first tick of any game, because the
	 * opening look seeds it even though it no longer asks anything.
	 */
	const quietSince = Math.max(watch.lastTurnAtSec ?? HINGE_FROM_SEC, HINGE_FROM_SEC)
	if (
		!tick.me.dead &&
		now >= HINGE_FROM_SEC &&
		now < HINGE_TO_SEC &&
		watch.lastTurnAtSec !== null &&
		now - quietSince >= hingeSilenceSec &&
		!watch.pending.some(e => e.asks) &&
		!out.some(e => e.asks)
	)
		fire({
			kind: "hinge.silence",
			atSec: now,
			/*
			 * NOT reactive. Nothing about it decays — it is a stretch of the clock and a lull — so it
			 * is worth the 1.3-3.0s minimap read that turns a question about the next two minutes
			 * into a question about the next two minutes FROM WHERE HE IS STANDING.
			 */
			reactive: false,
			asks: true,
			key: "hinge",
			note: `10:00-15:00 decides his games, nothing asked inside it for ${Math.round(
				now - quietSince
			)}s`
		})

	/* -------------------------------------------------- the opening look */
	/*
	 * THE FIRST LOOK STARTS THE SILENCE FLOOR. IT IS NOT A QUESTION — the fifth cut.
	 *
	 * It asked until 2026-09-12, and what it bought was one line per game at 0:00 that could have
	 * been written before the game was drafted. Over the 28-game corpus in
	 * `data/eval/integrate3-corpus-20260912.json`, joined turn-for-turn to the blind verdicts
	 * beside it, `game.start` raised 28 turns and produced:
	 *
	 * ```
	 *   clean-useful   0 of 28   0% [0-12]      against 69% [66-72] pooled over every other ask
	 *   generic       26 of 28
	 * ```
	 *
	 * Verbatim, and these are four different games: *"Buy your jungle item and head out to guard
	 * your entrance"*, *"Grab your jungle item and trinket, then head out to set up your full
	 * clear"*, *"Buy your starter item and head out to start a full clear"*, *"Buy your jungle pet
	 * and ward, then head out so we can set up your full clear on tempo"*. At 0:00 the feed holds a
	 * roster, two level ones and no gold spent, so there is nothing to say that is about THIS game
	 * — which is the one test a line has to pass. It is the HUD recital in its purest form: the
	 * ask was empty, so the model filled it from nowhere in particular.
	 *
	 * Zero useful lines is the cheapest cut in this file: nothing measurable is lost.
	 *
	 * `lastTurnAtSec` is seeded here BECAUSE the event stops asking. The heartbeat measures silence
	 * from the last turn and reads `null` as "forever", so an opening look that no longer raises a
	 * turn would hand the floor an infinite silence and fire a HEARTBEAT on the first tick instead
	 * — the same 0:00 line with less material in front of it. Seeded, the floor runs from the
	 * game's own start, and the first heartbeat lands where it already lands today (3:01 in 29 of
	 * the corpus's turns) rather than at the loading screen.
	 *
	 * The event still fires and still rides the first turn that goes out, because the fault panel
	 * and the bench read its note and because a thing that is DETECTED can be compared later.
	 */
	if (prev === null && now > 0) {
		fire({
			kind: "game.start",
			atSec: now,
			reactive: false,
			asks: opts.asksBeforeFifthCut === true,
			key: "start",
			note: "first look"
		})
		// The floor is seeded only when the look is silent. Under the knob the look takes a turn of
		// its own and `commitTurn` sets this, exactly as it did before the cut.
		if (opts.asksBeforeFifthCut !== true && watch.lastTurnAtSec === null) watch.lastTurnAtSec = now
	}

	/*
	 * DROP CONTEXT THAT HAS GONE STALE — see `CONTEXT_CARRY_SEC`.
	 *
	 * Only context. An event with `asks` stays queued until a turn actually carries it, because
	 * "a death nobody was asked about is the failure this whole file is replacing" and because
	 * `dueTurn` peeks rather than spends. The pruning is here rather than in `dueTurn` so that
	 * `dueTurn` stays free of side effects.
	 *
	 * SPLICED IN PLACE, NOT REASSIGNED, and this cost an hour. Every caller is written
	 * `watch.pending.push(...observeTick(watch, tick))`, and JS evaluates the member expression
	 * BEFORE the arguments — so replacing this array mid-call pushes the events that call just
	 * returned into the array nobody holds any more. It is the same bug `geminiLive.ts` documents
	 * against the new-game branch, and it presents identically: the whole game replays as nothing
	 * but heartbeats, because `game.start` and every window ask are pushed into the orphan.
	 */
	for (let i = watch.pending.length - 1; i >= 0; i -= 1) {
		const e = watch.pending[i]!
		if (!e.asks && now - e.atSec > CONTEXT_CARRY_SEC) watch.pending.splice(i, 1)
	}

	/*
	 * START THE SETTLE CLOCK, and only when there is something to wait FOR.
	 *
	 * See `live-schedule.ts` for what the wait buys and `EventWatch.settleSinceSec` for why the clock
	 * is kept here rather than in `dueTurn`. What is decided at THIS line is narrower and it is the
	 * difference between a scheduler and a delay: an ask waits only when another contest window is
	 * provably about to open, which is knowable because **an objective's spawn clock is the one thing
	 * about the future this app knows exactly.**
	 *
	 * Measured, and the first version of this was wrong in a way worth keeping written down. Settling
	 * EVERY standing ask for `SETTLE_SEC` coalesces the 17:51-18:03 cluster correctly and also pushes
	 * four of round 2's ten graded-useful asks a full twelve seconds later — 4:21, 14:17, 19:16 and
	 * 23:50 — every one of them a lone window opening with nothing whatever coming to join it. Twelve
	 * seconds of a forty-five second lead, spent waiting for nothing. Gated on the lookahead the same
	 * cluster still merges and those four fire on the tick they are detected, because at each of them
	 * the next scheduled opening is 174, 298, 109 and 195 seconds away.
	 *
	 * The queue is read as `pending` plus `out` because the caller has not appended this call's events
	 * yet — every call site is written `watch.pending.push(...observeTick(watch, tick))`, so at this
	 * line the two halves are still separate.
	 */
	watch.nextOpeningSec = nextOpeningSec(watch, liveObjectives, now)
	if (watch.settleSinceSec === null && out.some(e => e.asks)) {
		const opening = watch.nextOpeningSec
		if (opening !== null && opening - now <= SETTLE_SEC) watch.settleSinceSec = now
	}

	watch.prev = tick
	return out
}

/* ============================================================ the decision */

export interface TurnReason {
	/**
	 * Everything that has happened since the last turn, newest last — the window asks that CAUSED
	 * it and the context riding along with them. A heartbeat can carry context and usually does.
	 */
	events: LiveEvent[]
	/** True when nothing ASKED and the floor under silence is what raised the turn. */
	heartbeat: boolean
	/**
	 * Whether the caller should pay for the minimap read before building this turn. False as soon
	 * as ANY pending event is reactive: the read costs 1.3-3.0s and would land the line after the
	 * moment it is about.
	 *
	 * The second cut moved this number a long way without touching the rule. Only two surviving
	 * kinds are reactive — `respawn.self` and `death.counterpart` — where before it was those plus
	 * every death and every resource threshold. On the recorded game that takes the share of turns
	 * declining the read from 42% to 26%, which matters because the reactive turns were the ones
	 * reaching the model with no position at all.
	 *
	 * The third cut inherits the rule unchanged, and the reactive flag now travels with the WINDOW
	 * event rather than with the thing that changed it: a window opened by him leaving the fountain
	 * is reactive, and a re-ask bought by a death — his, the counterpart's, or two of the enemy
	 * team's — is reactive. A window opened by a clock is not, and it is exactly the kind that turns
	 * "drake in 45s" into "drake in 45s and you are in their topside jungle".
	 */
	readMinimap: boolean
	/** One word naming why it fired now rather than later. `TurnChoice.why`. */
	why: TurnChoice["why"]
}

/**
 * Is a turn due? Drains the pending queue when the answer is yes.
 *
 * Called on every tick. Answering `null` is the normal case and it is the entire point: the coach
 * is not asked, so she says nothing, and nothing about her is rate-limited to achieve that.
 *
 * `inFlight` defers rather than drops. A turn already awaiting an answer means the socket's thread
 * is mid-exchange, and interleaving a second one is a correctness problem rather than a volume one
 * — the events stay queued and go out with the next turn, carrying their own timestamps, so nothing
 * that happened is lost.
 *
 * ## IT PEEKS. `commitTurn` is what spends the queue
 *
 * This used to do `watch.pending = []` and `watch.lastTurnAtSec = nowSec` itself, before the caller
 * had any idea whether the turn went out. The caller's next line is `const sent = await sendTurn()`,
 * and `sendTurn` returns false on an empty ground-truth block, on a fetch that hits its 4-second
 * timeout, and on a refused WebSocket send. In every one of those the detected events were already
 * gone AND the silence floor had been reset — so a death detected during a daemon hiccup was never
 * asked about at all, in a design whose stated premise is that "a death nobody was asked about is
 * the failure this file is replacing". The docblock's promise that the events "stay queued and go
 * out with the next turn" was true only of the `inFlight` path.
 *
 * So the decision and the spend are two calls. Nothing here mutates; the caller calls `commitTurn`
 * once the payload has actually left, and a failed send leaves the queue exactly as it found it.
 */
export const dueTurn = (
	watch: EventWatch,
	nowSec: number,
	opts: {
		inFlight?: boolean
		heartbeatSec?: number
		settleSec?: number
		/** See `SPEAK_LEVELS`. Here it decides the floor under silence, and `heartbeatSec` overrides it. */
		level?: SpeakLevel
	} = {}
): TurnReason | null => {
	if (opts.inFlight === true) return null
	const heartbeatSec = opts.heartbeatSec ?? askPolicy(opts.level).heartbeatSec
	const events = watch.pending
	/*
	 * THE ONE LINE THE THIRD CUT CHANGED HERE. It used to be `events.length === 0`, so anything
	 * `observeTick` detected caused a turn. Now only an event that ASKS does — which is a contest
	 * window opening, a contest window whose fingerprint moved, and the first look at a new game.
	 * Everything else `observeTick` found is still in this array and still goes out WITH the turn;
	 * it simply does not summon one.
	 */
	const asks = events.filter(e => e.asks)
	const silentFor = watch.lastTurnAtSec === null ? Infinity : nowSec - watch.lastTurnAtSec
	if (asks.length === 0 && silentFor < heartbeatSec) return null
	/*
	 * THE FOURTH CUT. Everything above this line answers "is there a question"; `chooseTurn` answers
	 * "is this the question, and is now the moment" — see `live-schedule.ts` for the two failures
	 * that made it necessary and for why it is not a rate limit.
	 *
	 * Still pure. The settle clock it reads is written by `observeTick` and cleared by `commitTurn`,
	 * and a turn it declines is a turn whose events are all still in `watch.pending`.
	 */
	const choice = chooseTurn({
		pending: events,
		nowSec,
		settleSinceSec: watch.settleSinceSec,
		heartbeat: asks.length === 0,
		nextOpeningSec: watch.nextOpeningSec,
		settleSec: opts.settleSec
	})
	if (!choice.fire) return null
	return {
		// A COPY, so a caller that never commits cannot hand the queue's own array to something that
		// keeps it — and so `commitTurn` below can drop exactly what was asked about and no more.
		events: events.slice(),
		heartbeat: asks.length === 0,
		readMinimap: !events.some(e => e.reactive),
		why: choice.why
	}
}

/**
 * The turn LEFT. Drop what it carried and restart the silence floor.
 *
 * Called only after the send succeeded — see `dueTurn`. It removes the events the reason actually
 * carried rather than emptying the queue, because `observeTick` may have detected another one in
 * the milliseconds between the decision and the send, and that one has not been asked about.
 */
export const commitTurn = (watch: EventWatch, reason: TurnReason, nowSec: number): void => {
	const spent = new Set(reason.events.map(e => e.key))
	watch.pending = watch.pending.filter(e => !spent.has(e.key))
	watch.lastTurnAtSec = nowSec
	/*
	 * THE WAIT IS OVER because the question was asked. Cleared rather than restarted: the next ask
	 * starts its own settle when it arrives, so an empty queue never sits on a stale deadline. An
	 * ask detected in the milliseconds between the decision and the send survives in `pending` and
	 * `observeTick` starts a fresh clock for it on the next tick, which is the correct reading — it
	 * has not been waiting, it has just arrived.
	 */
	watch.settleSinceSec = null
}

/** One line naming why the coach was asked. For the panel and the transcript, never for the model. */
export const describeTurn = (reason: TurnReason): string => {
	/*
	 * The ASKS are what this line is for — "why was she asked" is now a different question from
	 * "what had happened", and printing all of them made a window ask look like six causes. The
	 * context is counted rather than named so the panel still shows that it went out.
	 */
	const asks = reason.events.filter(e => e.asks)
	const carried = reason.events.length - asks.length
	const head =
		asks.length === 0 ? "heartbeat" : asks.map(e => `${e.kind} (${e.note})`).join("; ")
	return carried === 0 ? head : `${head} [+${carried} carried]`
}
