/**
 * backfill-reviews — run the shipped post-game reviewer over games that never got one.
 *
 * ## Why this exists
 *
 * `autoReviewNewGames` has been stored false since 2026-09-04, so the only part of this product
 * a human has ever graded good — 68% useful over 37 blinded items — produced nothing for eight
 * days. 110 of 123 stored games sit below `REVIEW_VERSION`. The library is the asset; this is how
 * it gets filled in without waiting for him to play 110 more games.
 *
 * ## It is the daemon's own path, not a copy of it
 *
 * It calls `runGameReviewJob` with a synthesized `JobContext`. Nothing about the digest, the
 * pack, the frame choice, the prompt hash, the citation allowlist or the stored row is
 * re-implemented here — a backfill that reviewed games slightly differently from the daemon
 * would poison the library it is supposed to fill. This file chooses WHICH games, in what order,
 * how fast, and what to print.
 *
 * That also means the cheap arm is used exactly where the daemon would use it: `gemini-3.6-flash`
 * over HTTPS when `data/gemini.key` exists, with the `claude` CLI as the same fallback. Measured
 * on four recent games: model call median 18.8 s against the CLI path's 57.8 s and $0.121.
 *
 * ## Resumability, which is the point
 *
 * There is no state file, because a state file can disagree with the database. The DATABASE is
 * the state: a game is done when its `reviewVersion` reaches `REVIEW_VERSION`, which
 * `runGameReviewJob` sets itself, and which this script re-reads on every pass. Kill it at any
 * point — Ctrl-C, a reboot, the daemon restarting under it — and running the identical command
 * again picks up exactly where it stopped and re-bills nothing. The in-flight game is the only
 * one that can be lost, and it is simply retried.
 *
 * A run also appends one line per game to `data/eval/backfill-<stamp>.jsonl` so the cost and
 * latency of the whole pass can be re-derived later. That file is a measurement: it is written
 * once and never rewritten.
 *
 * ## Rate limiting
 *
 * Sequential, one game at a time, with a sleep between games. Not because the provider has
 * complained, but because this is an unattended pass over a hundred paid calls running next to a
 * live daemon he might be playing behind — the failure mode of "too fast" is a rate-limit storm
 * mid-game, and the failure mode of "too slow" is that it finishes in twelve minutes instead of
 * eight.
 *
 *   node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/backfill-reviews.ts --limit 25
 *
 *     --limit <n>      how many games to review this pass (default 25)
 *     --delay-ms <n>   sleep between games (default 4000)
 *     --oldest         oldest first; the default is newest first, because the newest game is the
 *                      one he might actually open tonight
 *     --game <id>      review exactly this game, ignoring the selection rules
 *     --dry-run        print the selection and the estimated cost, call nothing
 *
 * NODE ONLY. It WRITES: reviews, `game.reviewVersion`, review digest/pack blobs, and one
 * `media-generate` job per reviewed game — all of it through the daemon's own job handler.
 * It never touches the LCU and never launches the game client.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { ANALYSIS_VERSION, DATA_DIR, REVIEW_VERSION } from "../src/shared/constants.ts"
import { uncoachableReason } from "../src/shared/coachable.ts"
import { getGame, getReview, getSettings, listGames } from "../src/db/queries.ts"
import { makeLogger } from "../src/daemon/log.ts"
import { runGameReviewJob } from "../src/daemon/jobs/review-game.ts"
import { POSTGAME_MODEL, postgameArmAvailable } from "../src/review/postgame-call.ts"
import type { Job } from "../src/shared/schema/domain.ts"

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}

const limit = Number(arg("limit", "25"))
const delayMs = Number(arg("delay-ms", "4000"))
const oldestFirst = flag("oldest")
const dryRun = flag("dry-run")
const onlyGame = arg("game", "")

const log = makeLogger("backfill")

/* ----------------------------------------------------------------- selection */

/**
 * What is worth a call, in the order it will be made.
 *
 * Re-read on every game rather than computed once: the daemon is running beside this, and a game
 * it reviewed while this pass was walking the list must not be paid for twice.
 */
const pending = (): number[] => {
	const games = listGames(500)
	const eligible = games.filter(
		g =>
			g.reviewVersion < REVIEW_VERSION &&
			g.analysisVersion >= ANALYSIS_VERSION &&
			uncoachableReason(g) === null
	)
	eligible.sort((a, b) =>
		oldestFirst ? a.gameCreationMs - b.gameCreationMs : b.gameCreationMs - a.gameCreationMs
	)
	return eligible.map(g => g.gameId)
}

/* -------------------------------------------------------------- the fake job */

/** A job row that was never enqueued. The handler reads `id`, `gameId` and nothing else. */
const jobFor = (gameId: number): Job => ({
	id: -1,
	kind: "review-game",
	gameId,
	state: "leased",
	intrusive: false,
	attempts: 1,
	maxAttempts: 1,
	priority: 0,
	lastError: null,
	notBeforeMs: 0,
	deadlineMs: null,
	createdMs: Date.now(),
	updatedMs: Date.now()
})

/* ---------------------------------------------------------------------- run */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
const logPath = `${DATA_DIR}/eval/backfill-${stamp}.jsonl`

const controller = new AbortController()
let stopping = false
const stop = (sig: string) => {
	if (stopping) process.exit(130)
	stopping = true
	controller.abort()
	console.log(`\n${sig} — finishing the game in flight, then stopping. Re-run to resume.`)
}
process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))

const main = async (): Promise<void> => {
	const settings = getSettings()
	const arm = postgameArmAvailable()
	const model = arm ? POSTGAME_MODEL : settings.model

	const queue = onlyGame !== "" ? [Number(onlyGame)] : pending()
	const planned = queue.slice(0, limit)

	console.log(
		`backfill-reviews — ${planned.length} game(s) this pass of ${queue.length} pending, ` +
			`${arm ? `cheap arm: ${model}` : `NO cheap arm key — falling back to the CLI on ${model}`}, ` +
			`${delayMs}ms between games`
	)
	console.log(`measurements → ${logPath}`)
	if (planned.length === 0) return

	if (dryRun) {
		for (const gameId of planned) {
			const g = getGame(gameId)
			console.log(
				`  ${gameId}  ${g?.championName ?? "?"}  ${g === null || g === undefined ? "" : new Date(g.gameCreationMs).toISOString().slice(0, 16)}  rv${g?.reviewVersion ?? "?"}`
			)
		}
		console.log("dry run — nothing called")
		return
	}

	mkdirSync(`${DATA_DIR}/eval`, { recursive: true })

	const startedAll = Date.now()
	let ok = 0
	let skipped = 0
	let failed = 0
	let costUsd = 0
	let inTok = 0
	let outTok = 0
	const durations: number[] = []

	for (const [i, gameId] of planned.entries()) {
		if (stopping) break

		// Re-check rather than trust the plan: the daemon may have reviewed this one meanwhile.
		const before = getGame(gameId)
		if (before === null || before === undefined) {
			console.log(`[${i + 1}/${planned.length}] ${gameId} — gone from the database, skipped`)
			skipped++
			continue
		}
		if (onlyGame === "" && before.reviewVersion >= REVIEW_VERSION) {
			console.log(`[${i + 1}/${planned.length}] ${gameId} — already at v${REVIEW_VERSION}, skipped`)
			skipped++
			continue
		}

		const started = Date.now()
		let note = ""
		let error: string | null = null
		try {
			const outcome = await runGameReviewJob({
				job: jobFor(gameId),
				settings,
				log,
				signal: controller.signal,
				progress: (n: string) => console.log(`    · ${n}`)
			})
			note = outcome?.note ?? ""
			if (outcome?.defer) {
				note = `deferred: ${outcome.defer.reason}`
				skipped++
			} else ok++
		} catch (err) {
			error = err instanceof Error ? err.message : String(err)
			failed++
		}
		const ms = Date.now() - started
		durations.push(ms)

		const review = getReview(gameId)
		const thisCost = review?.costUsd ?? null
		if (error === null && thisCost !== null && thisCost !== undefined) costUsd += thisCost
		/*
		 * Tokens, because the cheap arm reports no price.
		 *
		 * `runPostgameCoach` sets `costUsd: null` deliberately — the AI SDK path has no price table
		 * and a guessed dollar figure would read like a measurement. So the honest total is the
		 * token count, printed beside whatever cost the row actually carries (the CLI fallback does
		 * report one).
		 */
		if (error === null) {
			inTok += review?.inputTokens ?? 0
			outTok += review?.outputTokens ?? 0
		}

		console.log(
			`[${i + 1}/${planned.length}] ${gameId} ${before.championName} — ` +
				`${error === null ? note || "done" : `FAILED: ${error}`} · ${(ms / 1000).toFixed(1)}s` +
				`${thisCost === null || thisCost === undefined ? "" : ` · $${thisCost.toFixed(4)}`}`
		)

		appendFileSync(
			logPath,
			`${JSON.stringify({
				atMs: Date.now(),
				gameId,
				champion: before.championName,
				model,
				ms,
				costUsd: thisCost ?? null,
				inputTokens: review?.inputTokens ?? null,
				outputTokens: review?.outputTokens ?? null,
				items: review?.items.length ?? null,
				ok: error === null,
				note,
				error
			})}\n`
		)

		if (i < planned.length - 1 && !stopping) await sleep(delayMs)
	}

	const wallSec = (Date.now() - startedAll) / 1000
	const sorted = [...durations].sort((a, b) => a - b)
	const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
	const left = pending().length

	console.log("")
	console.log(
		`${ok} reviewed · ${skipped} skipped · ${failed} failed · ${wallSec.toFixed(0)}s wall · ` +
			`${(median / 1000).toFixed(1)}s median per game · ` +
			`${(inTok / 1000).toFixed(0)}k in / ${(outTok / 1000).toFixed(0)}k out tokens · ` +
			`${costUsd > 0 ? `$${costUsd.toFixed(4)} billed` : "no price reported by this provider path"}`
	)
	console.log(`${left} game(s) still below reviewVersion ${REVIEW_VERSION} — re-run to continue.`)
}

await main()
process.exit(0)
