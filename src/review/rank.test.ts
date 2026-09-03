/**
 * Ranking is what turns five items into a triaged list, so its ordering properties are worth
 * pinning rather than trusting to weights that look reasonable.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { DEMOTE_BELOW, priorityBand, rankItems, scoreItem } from "./rank.ts"
import type { FeedbackItem } from "../shared/schema/domain.ts"

const item = (
  over: Partial<FeedbackItem> & Pick<FeedbackItem, "impact" | "actionability" | "confidence">
): Omit<FeedbackItem, "priority"> => ({
	id: over.title ?? "i",
	gameId: 1,
	title: over.title ?? "t",
	body: "",
	fix: "do the thing",
	severity: over.severity ?? "major",
	category: over.category,
	momentIds: [],
	mediaIds: [],
	metricKeys: [],
	tSec: over.tSec ?? null,
	...over
})

describe("scoreItem", () => {
	it("ranks a big, followable, certain item top", () => {
		strictEqual(scoreItem({ impact: "high", actionability: "high", confidence: "high" }), 1)
	})

	it("weights impact above actionability", () => {
		const bigVague = scoreItem({ impact: "high", actionability: "low", confidence: "high" })
		const smallCrisp = scoreItem({ impact: "low", actionability: "high", confidence: "high" })
		ok(bigVague > smallCrisp, `${bigVague} should beat ${smallCrisp}`)
	})

	/**
	 * Confidence multiplies rather than subtracts: a guess about something huge must not
	 * outrank a certainty about something moderate, or the review leads with its least
	 * reliable claim.
	 */
	it("lets a certain medium item beat an unsure huge one", () => {
		const unsureHuge = scoreItem({ impact: "high", actionability: "high", confidence: "low" })
		const certainMedium = scoreItem({ impact: "medium", actionability: "medium", confidence: "high" })
		ok(certainMedium > unsureHuge, `${certainMedium} should beat ${unsureHuge}`)
	})
})

describe("rankItems", () => {
	it("sorts by priority, highest first", () => {
		const out = rankItems([
			item({ title: "small", impact: "low", actionability: "low", confidence: "high" }),
			item({ title: "big", impact: "high", actionability: "high", confidence: "high" })
		])
		strictEqual(out[0]!.title, "big")
	})

	it("demotes a low-confidence correction to info instead of deleting it", () => {
		const out = rankItems([
			item({ title: "shaky", impact: "high", actionability: "high", confidence: "low", severity: "major" })
		])
		strictEqual(out.length, 1, "the observation must survive")
		strictEqual(out[0]!.severity, "info", "but it must stop reading as a correction")
	})

	it("never demotes praise — a tentative compliment is still a compliment", () => {
		const out = rankItems([
			item({
				title: "nice",
				category: "praise",
				severity: "info",
				impact: "low",
				actionability: "low",
				confidence: "low"
			})
		])
		strictEqual(out[0]!.severity, "info")
	})

	it("keeps a confident correction as a correction", () => {
		const out = rankItems([
			item({ title: "solid", impact: "high", actionability: "high", confidence: "high", severity: "major" })
		])
		strictEqual(out[0]!.severity, "major")
	})

	it("breaks ties by game time so a read follows the game", () => {
		const out = rankItems([
			item({ title: "late", tSec: 1800, impact: "medium", actionability: "medium", confidence: "medium" }),
			item({ title: "early", tSec: 300, impact: "medium", actionability: "medium", confidence: "medium" })
		])
		strictEqual(out[0]!.title, "early")
	})

	it("puts whole-game items after timestamped ones at equal priority", () => {
		const out = rankItems([
			item({ title: "whole-game", tSec: null, impact: "medium", actionability: "medium", confidence: "medium" }),
			item({ title: "at 5:00", tSec: 300, impact: "medium", actionability: "medium", confidence: "medium" })
		])
		strictEqual(out[0]!.title, "at 5:00")
	})
})

describe("priorityBand", () => {
	it("labels the three tiers", () => {
		strictEqual(priorityBand(1), "top")
		strictEqual(priorityBand(0.5), "worth-it")
		strictEqual(priorityBand(DEMOTE_BELOW - 0.01), "fyi")
	})
})
