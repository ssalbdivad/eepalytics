/**
 * ARM: **incumbent** — the SHIPPED post-game reviewer, run over one game with the latency
 * constraint removed.
 *
 * This is the daemon's own path (`src/daemon/jobs/review-game.ts`) with the same digest
 * builder, the same persona, the same prompt template and the same citation allowlist. It
 * reads the MATCH and the TIMELINE out of SQLite and nothing else: no live samples, no
 * minimap track, no journal frames, no coach transcript. That is the point — it is the
 * baseline the position-carrying pack has to beat.
 *
 * Two deliberate deviations from the daemon, both so the comparison is fair rather than
 * flattering:
 *
 *   1. **Transport.** The AI SDK on `claude-opus-5` instead of the `claude` CLI on Sonnet 5.
 *      The whole experiment is "what does whole-game analysis with no clock buy", so every
 *      arm gets the strong model. Nothing else about the prompt moves.
 *   2. **Baseline.** `baselineDuring(gameId)` — the 20 games created strictly BEFORE this one
 *      — rather than the daemon's `loadCorpus(n, {excludeGameId})`, which excludes only this
 *      game and would therefore have leaked games played AFTER it into "your average". The
 *      pack uses `baselineDuring`, so all three arms are measured against the same 20 games.
 *
 * The knowledge block is appended to the system prompt from `fullKnowledge` — the same loader
 * the trusted live arm uses, full prose with the numbers intact — because the experiment holds
 * champion knowledge constant across arms. The digest's own `CHAMPION CONTEXT` section is left
 * exactly where the shipped path puts it.
 *
 * The item count (5-8) is asked for in the USER turn, where every other per-run instruction
 * already lives. It moves the count only; the citation and hedging rules above it are the
 * persona's and are untouched.
 *
 * THE DB CONNECTION IS READ ONLY. The daemon is running and must not be disturbed: no writes,
 * no migrations, no LCU traffic, no game client.
 *
 *   node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/review-incumbent.ts [gameId]
 */
import { DatabaseSync } from "node:sqlite"
import { readFileSync, writeFileSync } from "node:fs"
import { useDb } from "../src/db/index.ts"
import { DB_PATH } from "../src/shared/constants.ts"

const GAME_ID = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 5639406342)
/**
 * `--verify` re-does everything except the model call, and runs the STORED answer through the
 * shipped parser and citation enforcement. It exists so the run can be checked — and re-checked
 * later — without paying for it twice.
 */
const VERIFY_ONLY = process.argv.includes("--verify")
const MODEL = process.env.EEPALYTICS_COACH_MODEL ?? "claude-opus-5"
const OUT = "data/eval"

// Before anything imports a query module: the singleton must be the read-only handle, or
// `getDb()` would open a writable connection and run migrations under a live daemon.
useDb(new DatabaseSync(DB_PATH, { readOnly: true }))

const { getGame, getParticipants, getMetrics, getMoments, getSettings, listMediaForGame } =
	await import("../src/db/queries.ts")
const { loadTimeline } = await import("../src/daemon/corpus.ts")
const { buildGameDigest } = await import("../src/daemon/digest.ts")
const { gamePrompt, renderDigest } = await import("../src/review/prompt.ts")
const { allowlistOf } = await import("../src/review/digest-contract.ts")
const { buildReview, seriousWarnings } = await import("../src/review/parse.ts")
const { fullKnowledge } = await import("../src/review/live-knowledge-full.ts")
const { baselineDuring } = await import("./lib/stream.ts")
const { ANALYSIS_VERSION } = await import("../src/shared/constants.ts")

const game = getGame(GAME_ID)
if (!game) throw new Error(`no game row for ${GAME_ID}`)

const participants = getParticipants(GAME_ID)
const metrics = getMetrics(GAME_ID)
const moments = getMoments(GAME_ID)
const timeline = loadTimeline(GAME_ID)
const { baseline, games: baselineGames } = baselineDuring(String(GAME_ID))
const hasFrames = listMediaForGame(GAME_ID).some(
	m => m.source === "replay" && m.kind === "screenshot"
)

const digest = buildGameDigest({
	game,
	participants,
	metrics,
	moments,
	timeline,
	baseline: baseline ?? undefined,
	hasFrames,
	analysisVersion: ANALYSIS_VERSION
})

const settings = getSettings()
const prompt = gamePrompt(digest, { intensity: settings.coachIntensity, model: MODEL })

const counterpart =
	participants.find(p => p.teamId !== game.teamId && p.role === game.role)?.championName ?? null

const system =
	`${prompt.system}\n\n---\n\n# CHAMPION & ROLE KNOWLEDGE\n\n` +
	"Absorb this. It shapes the FIX, never a number and never a claim about what happened.\n\n" +
	fullKnowledge({ champion: game.championName, counterpart })

const user =
	`${prompt.user}\n\n---\n\nFor this run, return between 5 and 8 items rather than three. ` +
	"Every one still has to clear the bar: a real figure copied from this digest, a timestamp " +
	"wherever the data supports one, one imperative fix, and it must not be a sentence that would " +
	"read identically pasted onto a different game. If you cannot find eight that clear that bar, " +
	"return five. Padding is worse than a short review."

writeFileSync(`${OUT}/incumbent-digest-${GAME_ID}.txt`, renderDigest(digest))
writeFileSync(`${OUT}/incumbent-system-${GAME_ID}.txt`, system)

console.error(
	`digest ${prompt.user.length} chars · knowledge ${system.length - prompt.system.length} chars · ` +
		`baseline ${baselineGames} games · hasFrames ${hasFrames} · ` +
		`${moments.length} moments · ${metrics.length} metrics · counterpart ${counterpart}`
)

if (VERIFY_ONLY) {
	const stored = JSON.parse(readFileSync(`${OUT}/incumbent-raw-${GAME_ID}.json`, "utf8"))
	const built = buildReview({
		raw: stored.text,
		kind: "game",
		gameId: GAME_ID,
		model: stored.model,
		promptHash: stored.promptHash,
		allowed: allowlistOf(digest),
		durationSec: game.gameDurationSec,
		analysisVersion: ANALYSIS_VERSION
	})
	console.log(
		JSON.stringify(
			{
				ok: built.ok,
				items: built.ok ? built.value.items.length : 0,
				goals: built.ok ? built.value.goals.length : 0,
				warnings: built.warnings,
				serious: seriousWarnings(built.warnings)
			},
			null,
			2
		)
	)
	process.exit(0)
}

const key = readFileSync("data/anthropic.key", "utf8").trim()
const { createAnthropic } = await import("@ai-sdk/anthropic")
const { streamText } = await import("ai")

/*
 * STREAMING, not `generateText`. Opus 5 runs adaptive thinking by default and a whole-game
 * review at a 32k ceiling is exactly the shape that hits an HTTP idle timeout on a single
 * non-streaming request.
 *
 * NO provider-specific thinking options. `live-providers.ts` records what that cost the last
 * time: an unknown thinking key is not ignored, it is rejected, and twenty minutes looked like
 * a model producing nothing. Opus 5 thinks adaptively without being asked.
 */
const started = Date.now()
const stream = streamText({
	model: createAnthropic({ apiKey: key })(MODEL),
	system,
	messages: [{ role: "user", content: [{ type: "text", text: user }] }],
	maxOutputTokens: 32000
})
const text = await stream.text
const latencyMs = Date.now() - started

writeFileSync(
	`${OUT}/incumbent-raw-${GAME_ID}.json`,
	JSON.stringify(
		{
			arm: "incumbent",
			gameId: GAME_ID,
			model: MODEL,
			latencyMs,
			usage: await stream.usage,
			finishReason: await stream.finishReason,
			baselineGames,
			hasFrames,
			promptHash: prompt.promptHash,
			digestChars: prompt.user.length,
			systemChars: system.length,
			allowed: allowlistOf(digest),
			text
		},
		null,
		2
	)
)
console.error(`latency ${latencyMs}ms · finish ${await stream.finishReason}`, await stream.usage)
console.log(text)
