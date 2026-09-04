/**
 * Live screen observation: one frame, one very short piece of feedback.
 *
 * ## What this is, honestly
 *
 * Not a running commentary. A vision call takes ten to thirty seconds, so this observes the
 * screen periodically — a glance every N seconds, not continuous analysis. The UI says so and
 * the interval is the user's to set, because the interval IS the cost.
 *
 * ## Why the output must be one sentence
 *
 * It is read mid-game, and optionally spoken aloud. A paragraph is unusable in both cases: you
 * cannot read it while fighting, and TTS turns it into thirty seconds of talking over the game.
 * One sentence, or silence.
 *
 * ## Silence is the default, not the fallback
 *
 * Most frames of most games contain nothing worth interrupting someone for. A coach that speaks
 * every fifteen seconds becomes noise within a minute, and noise gets muted. The prompt makes
 * saying nothing the expected outcome and gives an explicit token for it.
 *
 * ## The same evidence rule as everywhere else
 *
 * The model sees a screenshot and nothing else — no game state, no history beyond what is
 * passed in. So it may describe what is legible on screen and may not infer intent, cooldowns it
 * cannot see, or what happened before the frame.
 *
 * NODE ONLY — spawns the CLI.
 */

import { spawn } from "node:child_process"
import { errText, makeLogger } from "../daemon/log.ts"

const log = makeLogger("live-vision")

/** Short: a stale observation is worse than none, and the caller is on a timer. */
const CLI_TIMEOUT_MS = Number(process.env.CSK_LIVE_VISION_TIMEOUT_MS ?? 45_000)

/** The model says this when there is nothing worth saying. Cheaper than a sentence about nothing. */
export const NOTHING = "PASS"

export interface LiveObservation {
	ok: boolean
	/** Empty when there was nothing worth saying — the common and correct case. */
	text: string
	costUsd: number | null
	durationMs: number
	error?: string
}

export interface LiveVisionInput {
	/** Absolute path to the frame. */
	framePath: string
	/** Directory the CLI is allowed to read. */
	dir: string
	championName?: string | null
	/** Game clock, when known, so the advice can be phase-appropriate. */
	gameTimeSec?: number | null
	/** What the player is working on, from their own review history. */
	focus?: readonly string[]
	/** Recent observations, so it does not repeat itself every tick. */
	recent?: readonly string[]
}

const prompt = (input: LiveVisionInput): string => {
	const clock =
		input.gameTimeSec === null || input.gameTimeSec === undefined ?
			"unknown"
		:	`${Math.floor(input.gameTimeSec / 60)}:${String(Math.floor(input.gameTimeSec % 60)).padStart(2, "0")}`

	return `Read the image at \`${input.framePath}\`. It is a screenshot of a live League of
Legends game${input.championName ? `, played by the ${input.championName} player` : ""}. Game
clock: ${clock}.

You are their coach, watching over their shoulder. Say AT MOST one short sentence.

## Say nothing most of the time

Reply with exactly \`${NOTHING}\` unless there is something genuinely worth interrupting them
for. That is the expected answer. A coach who speaks every fifteen seconds becomes noise inside
a minute, and noise gets muted.

Worth speaking for: an objective about to spawn or being taken, a lane visibly overextended and
about to die, an obvious free play on screen, a recall they should take now, a fight starting
they are not in position for.

Not worth speaking for: anything they can already see, general advice, encouragement,
observations about the score, or anything you said recently.

## Rules

- **Only what is legible in this frame.** You cannot see cooldowns you cannot read, what happened
  before, or what they intend. Do not guess at any of it.
- **One sentence, under 100 characters.** It may be spoken aloud while they are playing.
- **Imperative and immediate.** "Back off, three missing top" — not "you might consider".
- No preamble, no markdown, no quotes. The sentence or \`${NOTHING}\`.
${input.focus && input.focus.length > 0 ? `\n## What they are working on\n\n${input.focus.map(f => `- ${f}`).join("\n")}\n` : ""}${
		input.recent && input.recent.length > 0 ?
			`\n## You recently said — do not repeat these\n\n${input.recent.map(r => `- ${r}`).join("\n")}\n`
		:	""
	}`
}

/** Never throws: a failed glance must not disturb a running game. */
export const observeFrame = async (
	input: LiveVisionInput,
	signal?: AbortSignal
): Promise<LiveObservation> => {
	const started = Date.now()
	const bin = process.env.CSK_CLAUDE_BIN ?? "claude"
	// Deliberately the small model: this runs every N seconds and the task is "look and mostly
	// say nothing", which does not need the expensive one.
	const model = process.env.CSK_LIVE_VISION_MODEL ?? "claude-haiku-4-5-20251001"

	return await new Promise<LiveObservation>(resolve => {
		let proc
		try {
			proc = spawn(
				bin,
				[
					"--print",
					"--output-format",
					"json",
					"--model",
					model,
					"--tools",
					"Read",
					"--add-dir",
					input.dir,
					"--disable-slash-commands",
					"--strict-mcp-config",
					"--no-session-persistence",
					"--safe-mode",
					"--effort",
					"low"
				],
				{ stdio: ["pipe", "pipe", "pipe"], signal }
			)
		} catch (err) {
			resolve({ ok: false, text: "", costUsd: null, durationMs: 0, error: errText(err) })
			return
		}

		const timer = setTimeout(() => proc.kill("SIGKILL"), CLI_TIMEOUT_MS)
		let stdout = ""
		proc.stdout.on("data", d => (stdout += String(d)))
		proc.stderr.on("data", () => {})
		proc.on("error", err => {
			clearTimeout(timer)
			resolve({ ok: false, text: "", costUsd: null, durationMs: Date.now() - started, error: errText(err) })
		})
		proc.on("close", code => {
			clearTimeout(timer)
			if (code !== 0) {
				resolve({
					ok: false,
					text: "",
					costUsd: null,
					durationMs: Date.now() - started,
					error: `${bin} exited ${code}`
				})
				return
			}
			try {
				const env = JSON.parse(stdout) as { result?: unknown; total_cost_usd?: unknown }
				const raw = typeof env.result === "string" ? env.result.trim() : ""
				// Strip the quotes and trailing period a model adds to a one-liner.
				const cleaned = raw.replace(/^["'`]+|["'`]+$/g, "").trim()
				const nothing = cleaned === "" || cleaned.toUpperCase().startsWith(NOTHING)
				resolve({
					ok: true,
					text: nothing ? "" : cleaned,
					costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null,
					durationMs: Date.now() - started
				})
			} catch (err) {
				resolve({
					ok: false,
					text: "",
					costUsd: null,
					durationMs: Date.now() - started,
					error: `unreadable CLI envelope: ${errText(err)}`
				})
			}
		})

		proc.stdin.end(prompt(input))
	})
}

export { prompt as liveVisionPrompt }
