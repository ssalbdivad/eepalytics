/**
 * THE OBJECTIVES BLOCK, RENDERED — every row shape, over recorded games.
 *
 * `digest.objectives.test.ts` proves the ROWS are right. This proves the BLOCK is, because the
 * defect this whole section exists for was never a wrong row: it was a review reading a row that
 * said `8:17 — HORDE taken by the enemy` and writing "Cho'Gath took drake and 3 grubs". The row
 * was correct and the prose around it decided what the row meant.
 *
 * So the two things asserted here are (1) that a row can only render in one of three forms, and
 * (2) that the header saying what a champion on a row MEANS is present whenever a champion is.
 * A block that names Kayn without the last-hit sentence is the 2026-09-19 fabrication with a name
 * attached, which is strictly worse than the gap it replaced.
 *
 * The rows come from `src/analysis/__fixtures__` through the real `digestObjectives`, so the three
 * shapes are recorded data rather than three hand-written cases: 446 named rows, 15 buildings with
 * no champion credited and 2 killer-less Heralds across the 20 games.
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/review/prompt.objectives.test.ts
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, test } from "node:test"
import { loadAll } from "../analysis/__fixtures__/index.ts"
import { USER_PUUID } from "../shared/constants.ts"
import type { TeamId } from "../shared/map.ts"
import { digestObjectives } from "../daemon/digest.ts"
import type { DigestObjective, GameDigest } from "./digest-contract.ts"
import { gamePrompt } from "./prompt.ts"

const persona = { text: "PERSONA", source: "fallback" as const, path: "", warnings: [] as string[] }

/**
 * A SHAPE digest — gameId 1, no metrics, no moments — carrying real objective rows. Nothing here
 * is a plausible match statistic, on purpose: this file must never be mistakable for a real game.
 */
const digestWith = (objectives: readonly DigestObjective[]): GameDigest =>
	({
		kind: "game",
		schemaVersion: 3,
		game: {
			gameId: 1,
			teamId: 100,
			queue: "test-queue",
			patch: "0.0",
			durationSec: 600,
			win: true,
			championName: "test-champion",
			role: "JGL",
			roleConfidence: "high",
			kills: 0,
			deaths: 0,
			assists: 0,
			cs: 0,
			jungleCs: 0,
			gold: 0,
			visionScore: 0,
			champLevel: 1,
			damageToChampions: 0
		},
		players: [],
		metrics: [],
		moments: [],
		dataGaps: ["test gap"],
		objectives: [...objectives]
	}) as unknown as GameDigest

const blockOf = (objectives: readonly DigestObjective[]): string => {
	const user = gamePrompt(digestWith(objectives), { persona }).user
	const block = user.split("\n## ").find(s => s.startsWith("OBJECTIVES"))
	ok(block, "the block should render when there are rows")
	return block
}

const rowsOf = (block: string): string[] => block.split("\n").filter(l => l.startsWith("- "))

const allRows = (): DigestObjective[] =>
	loadAll().flatMap(f => {
		const id = f.match.participantIdentities.find(i => i.player?.puuid === USER_PUUID)
		ok(id)
		const p = f.match.participants.find(q => q.participantId === id.participantId)
		ok(p)
		return digestObjectives(
			f.timeline,
			p.participantId,
			p.teamId as TeamId,
			f.match.participants.map(q => ({
				participantId: q.participantId,
				teamId: q.teamId,
				championName: `C${q.participantId}`
			}))
		)
	})

describe("the OBJECTIVES block", () => {
	test("every recorded row renders in exactly one of the three forms", () => {
		const objectives = allRows()
		strictEqual(objectives.length, 463)
		const rows = rowsOf(blockOf(objectives))
		strictEqual(rows.length, objectives.length)

		let named = 0
		let noChampion = 0
		let noKiller = 0
		for (const line of rows) {
			if (/ taken by (your team|the enemy), last hit by C\d+;/.test(line)) named++
			else if (/ taken by (your team|the enemy), no champion credited;/.test(line)) noChampion++
			else if (/ — NO KILLER RECORDED;/.test(line)) noKiller++
			else ok(false, `a row rendered in none of the three forms: ${line}`)
			// The failure mode this replaced: a row that names a champion and no side at all.
			ok(!/last hit by C\d+/.test(line) || /taken by (your team|the enemy)/.test(line), line)
		}
		strictEqual(named, 446)
		strictEqual(noChampion, 15)
		strictEqual(noKiller, 2)
	})

	test("a champion never appears in the block without the sentence saying what it means", () => {
		const named = allRows().filter(o => o.takenByChampion)
		ok(named.length > 0)
		const block = blockOf(named)
		ok(block.includes("LAST HIT and nothing else"), "the last-hit fence is missing")
		ok(/23% of assisted takes/.test(block), "the reason no row can name a second player is missing")
		ok(/you let him have it/.test(block), "the refuted reading is not named")
	})

	test("the block is silent about the killer when no row has one", () => {
		/*
		 * A game whose rows are all killer-less — a pruned or ancient timeline — must not carry a
		 * paragraph about champion names it never prints. The header adapts; the rows do not lie.
		 */
		const rows = allRows()
			.filter(o => o.takenBy === "unattributed" || !o.takenByChampion)
			.map(o => ({ ...o, takenByChampion: null }))
		ok(rows.length > 0)
		const block = blockOf(rows)
		ok(!block.includes("LAST HIT and nothing else"), "the last-hit fence should not ship with no names")
		ok(block.includes("NO KILLER RECORDED"), "the killer-less rows still need their sentence")
	})

	test("a position on a row always says how stale it is, and which side of the objective", () => {
		/*
		 * 228 of the 463 recorded rows take their position from AFTER the objective fell (median
		 * 14s, max 30s), so a bare "you were around the dragon pit" is as likely to be where he
		 * walked to next as where he was standing. The row carries the gap; this asserts it reaches
		 * the rendered line, with the direction in words rather than a sign a reader has to decode.
		 */
		const objectives = allRows().filter(o => o.userZone)
		const rows = rowsOf(blockOf(objectives))
		let later = 0
		let earlier = 0
		let sameSecond = 0
		for (const line of rows) {
			const m = /\(sampled (\d+)s (later|earlier)\)/.exec(line)
			if (m) {
				ok(Number(m[1]) > 0 && Number(m[1]) <= 30, line)
				if (m[2] === "later") later++
				else earlier++
			} else {
				// A zone name carries its own parentheses ("own blue-side jungle (top)"), so the
				// absence of a gap is tested by the phrase, not by the punctuation.
				ok(!line.includes("(sampled ") && line.includes("you were around "), line)
				sameSecond++
			}
		}
		strictEqual(later, 228)
		strictEqual(earlier, 226)
		strictEqual(sameSecond, 9)
		ok(blockOf(objectives).includes("nearest per-minute position sample"))
	})

	test("no rows, no block", () => {
		const user = gamePrompt(digestWith([]), { persona }).user
		ok(!user.includes("## OBJECTIVES"))
	})
})
