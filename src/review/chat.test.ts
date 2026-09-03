/**
 * The chat prompt has one job the review prompt does not: overriding the persona.
 *
 * `AGENTS.md` ends with an output contract for a REVIEW — headline, encouragement, items,
 * goals — and it is emphatic. The first live chat call returned exactly that shape, and every
 * citation was lost because the fields the app reads were not there. These tests pin the
 * override, and pin that the digest and the evidence rules still reach the model.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { CHAT_HISTORY_TURNS, CHAT_JSON_SCHEMA, chatPrompt } from "./chat.ts"
import type { ChatMessage } from "../shared/schema/domain.ts"
import type { GameDigest } from "./digest-contract.ts"

const persona = { text: "PERSONA BODY", path: "test", hash: "h" } as never

const digest = {
	kind: "game",
	schemaVersion: 2,
	game: {
		gameId: 42,
		queue: "Ranked Solo/Duo",
		patch: "16.17",
		championName: "Lillia",
		role: "JGL",
		win: true,
		durationSec: 1800,
		kills: 1,
		deaths: 2,
		assists: 3,
		cs: 10,
		jungleCs: 100,
		gold: 1,
		visionScore: 1,
		champLevel: 1,
		damageToChampions: 1,
		teamKills: 1,
		enemyKills: 1
	},
	players: [],
	metrics: [],
	moments: [],
	dataGaps: ["NO ITEM PURCHASES"],
	generatedMs: 0,
	analysisVersion: 1
} as unknown as GameDigest

const turn = (role: ChatMessage["role"], content: string, i: number): ChatMessage => ({
	id: `m${i}`,
	gameId: 42,
	role,
	content,
	model: null,
	costUsd: null,
	citedMomentIds: [],
	citedMetricKeys: [],
	status: "ok",
	error: null,
	createdMs: i
})

describe("chatPrompt", () => {
	it("suspends the persona's review output contract in the system prompt", () => {
		const p = chatPrompt({ digest, history: [], question: "why did I lose?", persona })
		ok(p.system.includes("PERSONA BODY"), "persona must still be present")
		ok(/SUSPENDED/i.test(p.system), "the review contract must be explicitly suspended")
		ok(p.system.includes("momentIds"), "the chat shape must be named in the system prompt")
	})

	it("names the three chat fields and forbids the review fields in the user prompt", () => {
		const p = chatPrompt({ digest, history: [], question: "why?", persona })
		for (const field of ["reply", "momentIds", "metricKeys"])
			ok(p.user.includes(field), `missing chat field ${field}`)
		ok(/do not return any of those fields/i.test(p.user))
	})

	it("carries the digest, so the answer has something to be checked against", () => {
		const p = chatPrompt({ digest, history: [], question: "why?", persona })
		ok(p.user.includes("Lillia"))
		ok(p.user.includes("NO ITEM PURCHASES"), "data gaps must survive into the chat prompt")
	})

	it("puts the question in, verbatim and trimmed", () => {
		const p = chatPrompt({ digest, history: [], question: "  was 8:12 avoidable?  ", persona })
		ok(p.user.includes("was 8:12 avoidable?"))
	})

	it("replays history oldest-first and labels the speakers", () => {
		const history = [turn("user", "first question", 1), turn("coach", "first answer", 2)]
		const p = chatPrompt({ digest, history, question: "follow up", persona })
		ok(p.user.indexOf("first question") < p.user.indexOf("first answer"))
		ok(p.user.includes("**Him:** first question"))
		ok(p.user.includes("**You:** first answer"))
	})

	it("drops the oldest turns past the window but never the digest", () => {
		const history = Array.from({ length: CHAT_HISTORY_TURNS + 6 }, (_, i) =>
			turn(i % 2 === 0 ? "user" : "coach", `turn-${i}`, i)
		)
		const p = chatPrompt({ digest, history, question: "q", persona })
		ok(!p.user.includes("turn-0"), "oldest turn should have been dropped")
		ok(p.user.includes(`turn-${CHAT_HISTORY_TURNS + 5}`), "newest turn must survive")
		ok(p.user.includes("Lillia"), "the digest is never what gets dropped")
	})

	it("omits failed turns — a failed answer is not context", () => {
		const bad = { ...turn("coach", "SHOULD NOT APPEAR", 3), status: "failed" as const }
		const p = chatPrompt({ digest, history: [bad], question: "q", persona })
		ok(!p.user.includes("SHOULD NOT APPEAR"))
	})

	it("has no conversation section at all when there is no history", () => {
		const p = chatPrompt({ digest, history: [], question: "q", persona })
		ok(!p.user.includes("THE CONVERSATION SO FAR"))
	})

	it("tells the model that 'the data cannot answer that' is a valid reply", () => {
		const p = chatPrompt({ digest, history: [], question: "q", persona })
		ok(/doesn't show that|data isn't there|cannot answer/i.test(p.user))
	})

	it("requires exactly the three fields in its schema", () => {
		strictEqual(JSON.stringify(CHAT_JSON_SCHEMA.required), '["reply","momentIds","metricKeys"]')
		strictEqual(CHAT_JSON_SCHEMA.additionalProperties, false)
	})
})
