/**
 * The four things "the coach said nothing" can mean — and whether the record of it survives.
 *
 * ## Why this test exists
 *
 * On 2026-09-18 the transcript file had not been appended to since the 10th, over five games and
 * eight days, and nothing on the machine could say which of four situations that was. The whole
 * value of `judgeCoverage` is that it refuses to collapse them, so the test is the four cases and
 * the one distinction that actually decides what a person does next: frames WITHOUT lines is the
 * only outcome where the product was demonstrably in front of him and produced nothing.
 *
 * It is a pure function of two integers on purpose. A coverage check that needed a game, a socket
 * and a disk to exercise would be tested the day it was written and never again.
 *
 * On 2026-09-22 the file grew three more jobs and the same rule applies to all of them: the log
 * PARSER, the game-start RECOVERY and the SENTENCE a person reads are each pure, so each one is
 * exercised here without a daemon. The recovery's fixture is not hand-written — it is the real
 * `data/live-samples/` listing and the real phase log from this machine, because a hand-written
 * one would have agreed with whatever the code did.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
	clampToPreviousGame,
	describeCoverage,
	gameStartFromSampleNames,
	judgeCoverage,
	parseCoverageLog
} from "./coach-coverage.ts"
import type { CoachCoverage, CoverageVerdict } from "./coach-coverage.ts"

describe("judgeCoverage", () => {
	it("frames and lines is the coach working", () => {
		assert.equal(judgeCoverage({ frames: 300, lines: 9 }).verdict, "coached")
	})

	it("FRAMES WITH NO LINES is the one that is our fault", () => {
		const got = judgeCoverage({ frames: 300, lines: 0 })
		assert.equal(got.verdict, "heard-nothing")
		/*
		 * The share was up, so the page was open, the gate was armed and every frame reached the
		 * daemon — and he still heard nothing all game. A socket that cannot be opened (an expired
		 * key, a depleted prepaid balance, a model id the endpoint refuses) looks exactly like
		 * this, and so does a coach that PASSed every turn. Both are worth a person's attention;
		 * neither is "he did not use it".
		 */
		assert.match(got.note, /NOT ONE LINE/)
	})

	it("lines with no frames is a coach running without a picture, which is not fatal", () => {
		assert.equal(judgeCoverage({ frames: 0, lines: 12 }).verdict, "unwatched")
	})

	it("neither is the coach never having started, and it must not read as a failure of the coach", () => {
		const got = judgeCoverage({ frames: 0, lines: 0 })
		assert.equal(got.verdict, "absent")
		assert.match(got.note, /not open, not sharing, or could not start/)
	})

	it("every verdict carries its own counts, so a log line is readable without the record", () => {
		assert.match(judgeCoverage({ frames: 300, lines: 9 }).note, /9/)
		assert.match(judgeCoverage({ frames: 300, lines: 0 }).note, /300/)
	})
})

/* ------------------------------------------------------------------------------ RECORDED DATA */

/**
 * Every file in `data/live-samples/` on 2026-09-22, exactly as `ls` printed it.
 *
 * 95 names, 66 of them `g-`keyed — the key `live-sampler.ts` uses when there is NO journal session,
 * i.e. when he played with the coach page closed, which is the case this recovery exists for.
 * Committed as data rather than read off the disk so the test keeps working on a machine that has
 * never played a game, and so the fixture cannot quietly change under the assertions.
 */
const SAMPLE_DIR_20260922 = [
	"g-29829506-t29829506.ndjson",
	"g-29829538-t29829538.ndjson",
	"g-29829541-t29829541.ndjson",
	"g-29829542-t29829542.ndjson",
	"g-29829696-t29829696.ndjson",
	"g-29830490-t29830490.ndjson",
	"g-29830590-t29830590.ndjson",
	"g-29830778-t29830778.ndjson",
	"g-29830808-t29830808.ndjson",
	"g-29830848-t29830848.ndjson",
	"g-29830883-t29830883.ndjson",
	"g-29830921-t29830921.ndjson",
	"g-29831014-t29831014.ndjson",
	"g-29831050-t29831050.ndjson",
	"g-29831091-t29831091.ndjson",
	"g-29831133-t29831133.ndjson",
	"g-29831134-t29831134.ndjson",
	"g-29831140-t29831140.ndjson",
	"g-29831164-t29831164.ndjson",
	"g-29831174-t29831174.ndjson",
	"g-29831201-t29831201.ndjson",
	"g-29831202-t29831202.ndjson",
	"g-29831220-t29831220.ndjson",
	"g-29831221-t29831221.ndjson",
	"g-29831271-t29831271.ndjson",
	"g-29831315-t29831315.ndjson",
	"g-29831316-t29831316.ndjson",
	"g-29831345-t29831345.ndjson",
	"g-29831346-t29831346.ndjson",
	"g-29831379-t29831379.ndjson",
	"g-29831380-t29831380.ndjson",
	"g-29831580-t29831580.ndjson",
	"g-29831581-t29831581.ndjson",
	"g-29831584-t29831584.ndjson",
	"g-29831593-t29831593.ndjson",
	"g-29831644-t29831644.ndjson",
	"g-29831645-t29831645.ndjson",
	"g-29831707-t29831707.ndjson",
	"g-29831756-t29831756.ndjson",
	"g-29831757-t29831757.ndjson",
	"g-29831796-t29831796.ndjson",
	"g-29832038-t29832038.ndjson",
	"g-29832039-t29832039.ndjson",
	"g-29832040-t29832040.ndjson",
	"g-29832081-t29832081.ndjson",
	"g-29832082-t29832082.ndjson",
	"g-29832083-t29832083.ndjson",
	"g-29832117-t29832117.ndjson",
	"g-29832174-t29832174.ndjson",
	"g-29832207-t29832207.ndjson",
	"g-29832208-t29832208.ndjson",
	"g-29832273-t29832273.ndjson",
	"g-29832274-t29832274.ndjson",
	"g-29832304-t29832304.ndjson",
	"g-29832369-t29832369.ndjson",
	"g-29832427-t29832427.ndjson",
	"g-29832428-t29832428.ndjson",
	"g-29832517-t29832517.ndjson",
	"g-29832587-t29832587.ndjson",
	"g-29832655-t29832655.ndjson",
	"g-29832656-t29832656.ndjson",
	"g-29832713-t29832713.ndjson",
	"g-29834998-t29834998.ndjson",
	"g-29834999-t29834999.ndjson",
	"g-29835030-t29835030.ndjson",
	"g-29835109-t29835109.ndjson",
	"js-mtvxb5f4-f81a-t29819368.ndjson",
	"js-mtvxb5f4-f81a-t29819418.ndjson",
	"js-mtvxb5f4-f81a-t29819464.ndjson",
	"js-mtvxb5f4-f81a-t29819502.ndjson",
	"js-mtvxb5f4-f81a-t29819649.ndjson",
	"js-mtvxb5f4-f81a-t29819686.ndjson",
	"js-mtvxb5f4-f81a-t29819710.ndjson",
	"js-mtvxb5f4-f81a-t29819739.ndjson",
	"js-mtvxb5f4-f81a-t29819773.ndjson",
	"js-mtvxb5f4-f81a-t29819823.ndjson",
	"js-mtvxb5f4-f81a-t29820889.ndjson",
	"js-mtvxb5f4-f81a-t29820926.ndjson",
	"js-mtvxb5f4-f81a-t29820958.ndjson",
	"js-mtvxb5f4-f81a-t29821025.ndjson",
	"js-mtvxb5f4-f81a-t29821059.ndjson",
	"js-mtvxb5f4-f81a-t29821082.ndjson",
	"js-mtvxb5f4-f81a-t29821115.ndjson",
	"js-mtvxb5f4-f81a-t29821144.ndjson",
	"js-mtvxb5f4-f81a-t29821174.ndjson",
	"js-mtvxb5f4-f81a-t29821264.ndjson",
	"js-mtvxb5f4-f81a-t29829015.ndjson",
	"js-mtvxb5f4-f81a-t29829197.ndjson",
	"js-mtvxb5f4-f81a-t29829320.ndjson",
	"js-mtvxb5f4-f81a-t29829325.ndjson",
	"js-mtvxb5f4-f81a-t29829331.ndjson",
	"js-mtvxb5f4-f81a-t29829369.ndjson",
	"js-mtvxb5f4-f81a-t29829422.ndjson",
	"js-mtvxb5f4-f81a-t29829442.ndjson",
	"js-muain099-d6d9-t29832517.ndjson",
]

/**
 * Every game this machine played on 2026-09-20 and 2026-09-22, with the two wall clocks journald
 * recorded for it:
 *
 *     journalctl --user -u eepalytics --since "14 days ago" -o short-iso \
 *       | grep -E "gameflow phase|live coach"
 *
 * `inProgressMs` is the `to=InProgress` line and `endedMs` is the `InProgress to=...` line that
 * closed it, both converted from America/New_York. These are the eight games the fixture listing
 * above has sample files for; every one of them entered `InProgress` from `ChampSelect`, which is
 * why the restart case this recovery handles has never been seen in a log on this machine and why
 * reading `setPhase` was the only way to find it.
 */
const RECORDED_GAMES = [
	{ gameId: 5645932967, inProgressMs: 1789945602000, endedMs: 1789947297000 }, // 19:06:42 -> 19:34:57
	{ gameId: 5645995390, inProgressMs: 1789951012000, endedMs: 1789952814000 }, // 20:36:52 -> 21:06:54
	{ gameId: 5646051543, inProgressMs: 1789955184000, endedMs: 1789956426000 }, // 21:46:24 -> 22:07:06
	{ gameId: 5646109709, inProgressMs: 1789959319000, endedMs: 1789961174000 }, // 22:55:19 -> 23:26:14
	{ gameId: 5646163495, inProgressMs: 1789962764000, endedMs: 1789964555000 }, // 23:52:44 -> 00:22:35
	{ gameId: 5647002759, inProgressMs: 1790099885000, endedMs: 1790101597000 }, // 13:58:05 -> 14:26:37
	{ gameId: 5647008005, inProgressMs: 1790101788000, endedMs: 1790104037000 }, // 14:29:48 -> 15:07:17
	{ gameId: 5647036219, inProgressMs: 1790106537000, endedMs: 1790108465000 } // 15:48:57 -> 16:21:05
]

/** The slack `recoverGameStartMs` subtracts. Repeated rather than exported: see the assertion. */
const SLACK_MS = 2 * 60_000

describe("gameStartFromSampleNames — recovering a start the daemon did not watch", () => {
	it("dates all eight recorded games from their own sample filenames", () => {
		for (const g of RECORDED_GAMES) {
			const got = gameStartFromSampleNames(SAMPLE_DIR_20260922, g.endedMs)
			assert.notEqual(got, null, `no stamp recovered for ${g.gameId}`)
		}
	})

	it("lands within -19s and +36s of the phase transition, over 8 of 8", () => {
		/*
		 * The stamp is the minute the GAME CLOCK read zero; the phase line is when the client said
		 * the game had started. Two things separate them and they pull opposite ways: the loading
		 * screen puts clock-zero AFTER the transition, and rounding to the minute can put the
		 * stamp up to 30s before whatever the sampler saw. So the offset is bounded BELOW by
		 * construction at -30s and above by the loading screen plus the same 30s.
		 *
		 * This assertion first read "8-78s AFTER the phase transition, never before it", which was
		 * eyeballed off a table of local times and was WRONG: game 5646109709 entered InProgress at
		 * 22:55:19 and its stamp is 22:55:00, i.e. 19 SECONDS EARLIER. The test caught it, which is
		 * the argument for pinning a measured range rather than a remembered one. Measured offsets,
		 * in seconds, in fixture order: 18, 8, 36, -19, 16, -5, 12, 3.
		 */
		const offsets = RECORDED_GAMES.map(
			g => gameStartFromSampleNames(SAMPLE_DIR_20260922, g.endedMs)! - g.inProgressMs
		)
		assert.deepEqual(
			offsets.map(o => o / 1000),
			[18, 8, 36, -19, 16, -5, 12, 3]
		)
		for (const off of offsets) {
			// The rounding floor. Anything below it means the key stopped being a start time.
			assert.ok(off >= -30_000, `stamp landed ${off}ms before the phase transition`)
			// Headroom over the measured +36s. The slack below has to cover whatever this is.
			assert.ok(off <= 60_000, `stamp landed ${off}ms after the phase transition`)
		}
	})

	it("the slack makes the recovered window cover the whole game, in 8 of 8", () => {
		/*
		 * THE ASYMMETRY IS THE POINT. A window that starts too late hides frames and lines that
		 * exist and turns a coached game into `absent`; one that starts too early can only reach
		 * back into the same game's champion select. So the assertion is one-sided: the recovered
		 * start must be at or before the moment the client entered `InProgress`.
		 */
		for (const g of RECORDED_GAMES) {
			const recovered = gameStartFromSampleNames(SAMPLE_DIR_20260922, g.endedMs)! - SLACK_MS
			assert.ok(
				recovered <= g.inProgressMs,
				`${g.gameId}: recovered start is ${g.inProgressMs - recovered}ms after InProgress`
			)
		}
	})

	it("collapses the rolled twins one game writes, rather than taking the later half", () => {
		/*
		 * `sampleLive` rolls its key whenever `round((now - gameTime*1000)/60_000)` changes, so one
		 * game routinely writes two files a minute apart. Game 5647002759 wrote `g-29834998` and
		 * `g-29834999`; the earlier of the two is its real start and the later one is the rounding
		 * drifting. Nineteen such pairs exist in the fixture and every one of them is exactly one
		 * minute; the smallest gap between two DIFFERENT games is three (a 2026-09-19 remake
		 * sequence), which is what makes a one-minute cluster safe.
		 */
		const g = RECORDED_GAMES.find(r => r.gameId === 5647002759)!
		assert.equal(gameStartFromSampleNames(SAMPLE_DIR_20260922, g.endedMs), 29834998 * 60_000)
	})

	it("refuses a stamp too old to be the game that just ended", () => {
		// The newest fixture stamp is 15:49 on the 22nd. Asked about a game that ended two days
		// later, there is no file that can date it and the honest answer is that there is none.
		const twoDaysOn = 1790108465000 + 2 * 24 * 60 * 60_000
		assert.equal(gameStartFromSampleNames(SAMPLE_DIR_20260922, twoDaysOn), null)
	})

	it("never dates a game from a file a human put there", () => {
		/*
		 * `split-01..04` were one multi-game capture cut into its four games and were read by name
		 * by six tests until a 2026-09-12 prune deleted them. Files like that come back whenever
		 * measurement work needs a fixed corpus, and dating a real game from one would be silently
		 * wrong, so the stamp pattern is the recorder's own naming and nothing else.
		 */
		const withFixtures = [...SAMPLE_DIR_20260922, "split-01.ndjson", "split-02.ndjson"]
		const g = RECORDED_GAMES[RECORDED_GAMES.length - 1]!
		assert.equal(
			gameStartFromSampleNames(withFixtures, g.endedMs),
			gameStartFromSampleNames(SAMPLE_DIR_20260922, g.endedMs)
		)
	})

	it("says nothing when the directory is empty rather than guessing", () => {
		assert.equal(gameStartFromSampleNames([], Date.now()), null)
	})
})

describe("clampToPreviousGame — the fence on widening", () => {
	/*
	 * Widening the window by two minutes is safe against the ordinary case (the tightest gap
	 * between two games' clock-zeros on this machine is 3 minutes) and NOT against the sequence
	 * that produced that 3: the 2026-09-19 remakes at 21:36, 21:39 and 21:40. A remake can end
	 * inside the next game's slack, and its frames are not evidence about the game after it — they
	 * would report a game as `coached` that nobody watched, which is the same silent lie as
	 * reporting a watched game `absent`, facing the other way.
	 */
	const start = 1790106537000
	const ended = 1790108465000

	it("moves the window forward to the moment the previous game ended", () => {
		assert.equal(clampToPreviousGame(start, ended, start + 30_000), start + 30_000)
	})

	it("leaves a window alone when the previous game ended before it", () => {
		assert.equal(clampToPreviousGame(start, ended, start - 60_000), start)
	})

	it("refuses a previous end that is inside or after THIS game, which cannot be true", () => {
		// A record whose end is after this game's end is a clock that moved or a row out of order.
		// Trusting it would collapse the window to nothing and report `absent` on any game.
		assert.equal(clampToPreviousGame(start, ended, ended + 1), start)
	})

	it("stands on the slack when nothing has been recorded yet", () => {
		// First game after this shipped, or a game whose predecessor this module declined to guess
		// at. No record is not a reason to invent a bound.
		assert.equal(clampToPreviousGame(start, ended, null), start)
	})
})

/* --------------------------------------------------------------------------------- the record */

const row = (
	gameId: number | null,
	verdict: CoverageVerdict,
	over: Partial<CoachCoverage> = {}
): CoachCoverage => ({
	gameId,
	startedMs: 1790106537000,
	endedMs: 1790108465000,
	frames: verdict === "coached" || verdict === "heard-nothing" ? 353 : 0,
	lines: verdict === "coached" || verdict === "unwatched" ? 9 : 0,
	verdict,
	note: "",
	...over
})

const jsonl = (rows: CoachCoverage[]): string => rows.map(r => `${JSON.stringify(r)}\n`).join("")

describe("parseCoverageLog", () => {
	it("returns newest first, because every question asked of it is about the recent past", () => {
		const text = jsonl([row(1, "absent"), row(2, "absent"), row(3, "coached")])
		assert.deepEqual(
			parseCoverageLog(text).map(r => r.gameId),
			[3, 2, 1]
		)
	})

	it("survives the torn last line of a killed daemon", () => {
		const text = `${jsonl([row(1, "coached")])}{"gameId":2,"verdi`
		assert.deepEqual(
			parseCoverageLog(text).map(r => r.gameId),
			[1]
		)
	})

	it("drops a line that parses but is not a record", () => {
		const text = `${jsonl([row(1, "coached")])}{"hello":"world"}\n`
		assert.equal(parseCoverageLog(text).length, 1)
	})

	it("counts a game once even when it left InProgress twice", () => {
		/*
		 * `onGameEnded` fires on every departure from `InProgress`, and the phase log shows that is
		 * not always once per game: on 2026-09-19 at 21:39 a game left to `None`, came back through
		 * `ChampSelect` and left again. A duplicate in the history is a duplicate in "your last N
		 * games", so the newest row wins and the older one is dropped on READ — never on write,
		 * where refusing the append would throw away the better-informed second measurement.
		 */
		const text = jsonl([row(7, "absent"), row(7, "coached")])
		const got = parseCoverageLog(text)
		assert.equal(got.length, 1)
		assert.equal(got[0]!.verdict, "coached")
	})

	it("never merges two rows the client could not name", () => {
		// A null gameId is "the client did not tell us", not "the same game as the other null".
		assert.equal(parseCoverageLog(jsonl([row(null, "absent"), row(null, "absent")])).length, 2)
	})

	it("honours the limit AFTER de-duplication, so a short page is not padded with duplicates", () => {
		const text = jsonl([row(1, "absent"), row(1, "absent"), row(2, "absent"), row(3, "absent")])
		assert.deepEqual(
			parseCoverageLog(text, 2).map(r => r.gameId),
			[3, 2]
		)
	})
})

describe("describeCoverage — the sentence he would actually see", () => {
	it("says nothing at all when there is no history, rather than blaming him", () => {
		const got = describeCoverage([])
		assert.equal(got.sentence, null)
		assert.equal(got.games, 0)
	})

	it("names the streak when he has been playing with the page closed", () => {
		/*
		 * This is his real state as of 2026-09-22: five of his six most recent games logged
		 * `live coach absent: no frames and no lines`, 37 such warnings in the journal. The point
		 * of the sentence is that it is a number on a page he already opens — nothing here may pop
		 * a window or fire while he is playing. See the capture post-mortem in AGENTS.md.
		 */
		const got = describeCoverage([
			row(5, "absent"),
			row(4, "absent"),
			row(3, "absent"),
			row(2, "absent"),
			row(1, "absent"),
			row(0, "coached")
		])
		assert.equal(got.quietStreak, 5)
		assert.equal(got.spoke, 1)
		assert.match(got.sentence!, /last 5 games/)
		assert.match(got.sentence!, /not open or not sharing/)
	})

	it("takes the blame when the frames were arriving and it still said nothing", () => {
		const got = describeCoverage([row(2, "heard-nothing"), row(1, "heard-nothing")])
		assert.equal(got.heardNothing, 2)
		assert.match(got.sentence!, /fault on our side/)
	})

	it("keeps the two apart in one streak, because they want different fixes", () => {
		const got = describeCoverage([row(3, "heard-nothing"), row(2, "absent"), row(1, "absent")])
		assert.equal(got.quietStreak, 3)
		assert.match(got.sentence!, /last 3 games/)
		assert.match(got.sentence!, /1 of them/)
	})

	it("counts a coach that spoke without a picture as having run", () => {
		// `unwatched` is a turn provider with no frames stored. He HEARD it; the streak is over.
		const got = describeCoverage([row(2, "unwatched"), row(1, "absent")])
		assert.equal(got.quietStreak, 0)
		assert.equal(got.spoke, 1)
		assert.match(got.sentence!, /ran in your last game/)
	})

	it("uses the singular for one game, because a wrong plural reads as a bug", () => {
		assert.match(describeCoverage([row(1, "absent")]).sentence!, /last 1 game —/)
	})
})
