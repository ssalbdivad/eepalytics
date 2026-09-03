/**
 * Coach chat about one game.
 *
 *   GET    /api/games/:gameId/chat  -> ChatHistoryResponse
 *   POST   /api/games/:gameId/chat  -> ChatTurnResponse    (asks Claude, awaits the answer)
 *   DELETE /api/games/:gameId/chat  -> { cleared: n }
 *
 * WHY THIS ONE IS SYNCHRONOUS. Every other Claude call in this app is a queued job, because a
 * review is background work nobody is waiting on. A chat is the opposite: the user is looking
 * at a cursor. The reason side effects go through the queue is the GATE — the League client
 * must not be touched while he is playing — and a chat touches only Claude and SQLite. So it
 * runs inline, and the queue keeps its meaning: it guards the client, not the network.
 *
 * A failed turn still writes a row, the same way a failed review does, so the question does not
 * vanish and the user can see what went wrong.
 */

import { Hono } from "hono"
import {
	clearChat,
	getGame,
	getMetrics,
	getMoments,
	getParticipants,
	insertChatMessage,
	listChatMessages,
	listMediaForGame,
	getSettings
} from "../../db/queries.ts"
import { baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { loadCorpus, loadTimeline } from "../../daemon/corpus.ts"
import { buildGameDigest } from "../../daemon/digest.ts"
import { allowlistOf } from "../../review/digest-contract.ts"
import { chatPrompt } from "../../review/chat.ts"
import { runCoach } from "../../review/claude.ts"
import { ANALYSIS_VERSION } from "../../shared/constants.ts"
import { ChatHistoryResponse, ChatTurnResponse } from "../../shared/schema/api.ts"
import type { ChatMessage } from "../../shared/schema/domain.ts"
import { chatBaselineWarnings } from "../../review/parse.ts"
import { makeLogger } from "../../daemon/log.ts"
import { publish } from "../events.ts"
import { fail, intParam, notFound, send } from "../respond.ts"

/** Long enough for a considered answer, short enough that a hung call does not hold the tab. */
const log = makeLogger("chat")

const CHAT_TIMEOUT_MS = 120_000
const MAX_QUESTION_CHARS = 4000

const newId = (gameId: number, role: string): string =>
	`cm-${gameId}-${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const asStrings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/**
 * Models asked for JSON sometimes emit the two characters `\` `n` inside a string rather than a
 * real newline. The review path never saw this because its prose fields are short; a chat reply
 * is multi-paragraph, so the escapes show up on screen as literal `\n`.
 */
const unescapeNewlines = (text: string): string =>
	text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t").trim()

export const createChatRoutes = (): Hono => {
	const app = new Hono()

	app.get("/games/:gameId/chat", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")
		if (!getGame(gameId)) return notFound(c, `game ${gameId}`)
		return send(
			c,
			ChatHistoryResponse,
			{ messages: listChatMessages(gameId) },
			`GET /api/games/${gameId}/chat`
		)
	})

	app.delete("/games/:gameId/chat", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")
		if (!getGame(gameId)) return notFound(c, `game ${gameId}`)
		return c.json({ cleared: clearChat(gameId) })
	})

	app.post("/games/:gameId/chat", async c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")

		const game = getGame(gameId)
		if (!game) return notFound(c, `game ${gameId}`)

		const body = (await c.req.json().catch(() => null)) as {
			message?: unknown
			model?: unknown
		} | null
		const question = typeof body?.message === "string" ? body.message.trim() : ""
		if (question === "") return fail(c, 400, "message must be a non-empty string", "bad-message")
		if (question.length > MAX_QUESTION_CHARS)
			return fail(c, 400, `message must be under ${MAX_QUESTION_CHARS} characters`, "bad-message")

		// Analysis has to have run, or there is no digest to hold the answer to.
		if (game.analysisVersion < ANALYSIS_VERSION)
			return fail(
				c,
				409,
				"this game has not been analysed yet — open it once and let analysis finish, then ask again",
				"not-analysed"
			)

		const settings = getSettings()
		const model = typeof body?.model === "string" && body.model !== "" ? body.model : settings.model
		const nowMs = Date.now()

		const userTurn: ChatMessage = {
			id: newId(gameId, "user"),
			gameId,
			role: "user",
			content: question,
			model: null,
			costUsd: null,
			citedMomentIds: [],
			citedMetricKeys: [],
			status: "ok",
			error: null,
			createdMs: nowMs
		}
		insertChatMessage(userTurn)

		const digest = buildGameDigest({
			game,
			participants: getParticipants(gameId),
			metrics: getMetrics(gameId),
			moments: getMoments(gameId),
			timeline: loadTimeline(gameId),
			baseline: baselineFromRows(perGameMetrics(loadCorpus(settings.gamesForTrends, { excludeGameId: gameId }))),
			analysisVersion: ANALYSIS_VERSION
		})

		const prompt = chatPrompt({
			digest,
			// The turn we just stored is the question itself, not history.
			history: listChatMessages(gameId).filter(m => m.id !== userTurn.id),
			question,
			intensity: settings.coachIntensity
		})

		const result = await runCoach({
			system: prompt.system,
			user: prompt.user,
			model,
			schema: prompt.schema,
			timeoutMs: CHAT_TIMEOUT_MS,
			// Chat has one shot in front of a waiting user and the persona pulls hard toward the
			// review shape, so pay for server-side schema validation on the first attempt.
			schemaMode: "always",
			label: `chat:${gameId}`
		})

		const allowed = allowlistOf(digest)
		const data = result.ok ? (result.data as Record<string, unknown> | null) : null
		const replyText =
			typeof data?.reply === "string" && data.reply.trim() !== "" ? unescapeNewlines(data.reply)
			: result.ok ? unescapeNewlines(result.text)
			: ""

		// The reply is prose the user reads. Hold it to the same baseline rule as a review: a
		// figure presented as "your usual X" has to be a baseline of a metric the answer cites.
		const baselineIssues = chatBaselineWarnings(replyText, asStrings(data?.metricKeys), allowed)
		if (baselineIssues.length > 0)
			log.warn("chat answer cited a baseline it did not earn", {
				gameId,
				issues: baselineIssues
			})

		const coachTurn: ChatMessage = {
			id: newId(gameId, "coach"),
			gameId,
			role: "coach",
			content:
				replyText !== "" ? replyText : (
					"The coach didn't return an answer that could be read. Try asking again."
				),
			model,
			costUsd: result.meta.usage.costUsd ?? null,
			// Drop invented ids here rather than at render time, so a stored turn is always
			// citable — the same rule `parse.ts` applies to a review.
			citedMomentIds: asStrings(data?.momentIds).filter(id => allowed.momentIds.has(id)),
			citedMetricKeys: asStrings(data?.metricKeys).filter(k => allowed.metricKeys.has(k)),
			status: result.ok && replyText !== "" ? "ok" : "failed",
			error: result.ok ? (replyText === "" ? "the model returned no reply text" : null) : result.error,
			createdMs: Date.now()
		}
		insertChatMessage(coachTurn)
		publish("chat", { gameId, id: coachTurn.id, status: coachTurn.status }, gameId)

		const media = listMediaForGame(gameId).filter(
			m => m.momentId !== null && coachTurn.citedMomentIds.includes(m.momentId)
		)

		return send(
			c,
			ChatTurnResponse,
			{ user: userTurn, coach: coachTurn, media },
			`POST /api/games/${gameId}/chat`
		)
	})

	return app
}
