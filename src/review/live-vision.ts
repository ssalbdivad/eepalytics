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
const CLI_TIMEOUT_MS = Number((process.env.FAWNSEI_LIVE_VISION_TIMEOUT_MS ?? process.env.CSK_LIVE_VISION_TIMEOUT_MS) ?? 45_000)

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
	/** The frame itself, base64. Never written to disk — see the header. */
	imageBase64: string
	/** Defaults to image/jpeg. */
	mediaType?: string
	championName?: string | null
	/** Game clock, when known, so the advice can be phase-appropriate. */
	gameTimeSec?: number | null
	/** What the player is working on, from their own review history. */
	focus?: readonly string[]
	/** Recent observations, so it does not repeat itself every tick. */
	recent?: readonly string[]
	/**
	 * A spoken question from the player, when there is one.
	 *
	 * This flips the whole call: an unprompted glance should almost always stay quiet, but
	 * someone who just asked deserves an answer. Same evidence rules either way.
	 */
	question?: string | null
}

const prompt = (input: LiveVisionInput): string => {
	const clock =
		input.gameTimeSec === null || input.gameTimeSec === undefined ?
			"unknown"
		:	`${Math.floor(input.gameTimeSec / 60)}:${String(Math.floor(input.gameTimeSec % 60)).padStart(2, "0")}`

	const asked = (input.question ?? "").trim()

	/*
	 * A question changes the contract completely. Unprompted, silence is almost always right;
	 * asked directly, silence is just unhelpful. The evidence rules do not move either way.
	 */
	if (asked !== "")
		return `The image attached to this message is a screenshot of a live League of
Legends game${input.championName ? `, played by the ${input.championName} player` : ""}. Game
clock: ${clock}.

They just asked you, out loud, mid-game:

> ${asked}

Answer it. Two short sentences at most — it will be read or spoken while they are playing.

- **Answer from what is visible in this frame.** If the screen does not show what they asked
  about, say so in a few words rather than guessing. "Can't see their jungler on this screen" is
  a real answer and a useful one.
- No preamble, no restating the question, no markdown. Just the answer.
- If it is a judgement call, give your actual opinion — they asked for it.
${input.focus && input.focus.length > 0 ? `\nThey are working on: ${input.focus.join("; ")}\n` : ""}`

	return `The image attached to this message is a screenshot of a live League of
Legends game${input.championName ? `, played by the ${input.championName} player` : ""}. Game
clock: ${clock}.

You are their coach, watching over their shoulder. Say AT MOST one short sentence.

## Say nothing most of the time

Reply with exactly \`${NOTHING}\` unless there is something genuinely worth interrupting them
for. That is the expected answer. A coach who speaks every fifteen seconds becomes noise inside
a minute, and noise gets muted.

**Worth speaking for — a warning:** an objective about to spawn or being taken, a lane visibly
overextended and about to die, an obvious free play on screen, a recall they should take now, a
fight starting they are not in position for.

**Worth speaking for — a genuinely sick play.** If the frame SHOWS something went well, say so:
a multi-kill, a steal, a save, surviving what should have killed them, a fight they had no
business winning. A coach who only ever warns is a coach you mute.

Be warm and a little unhinged about it — you are Lillia, so dreams, sleep, pollen and prancing
are yours to use. "That was CRIMINAL, they need a nap after that." "Bough down." Never force a
pun, never reuse one, and never fake it for something ordinary: praise spent on a normal recall
is praise that means nothing when the real moment comes. If you cannot tell it was impressive,
stay quiet.

**Not worth speaking for:** anything they can already see, general advice, vague encouragement
with nothing behind it, observations about the score, or anything you said recently.

## Rules

- **Only what is legible in this frame.** You cannot see cooldowns you cannot read, what happened
  before, or what they intend. Do not guess at any of it.
- **One sentence, under 100 characters.** It may be spoken aloud while they are playing.
- **Imperative and immediate** when it is a warning: "Back off, three missing top" — not "you
  might consider". When it is praise, just be delighted; there is nothing to instruct.
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
	const bin = process.env.FAWNSEI_CLAUDE_BIN ?? process.env.CSK_CLAUDE_BIN ?? "claude"
	// Deliberately the small model: this runs every N seconds and the task is "look and mostly
	// say nothing", which does not need the expensive one.
	const model =
		process.env.FAWNSEI_LIVE_VISION_MODEL ??
		process.env.CSK_LIVE_VISION_MODEL ??
		"claude-haiku-4-5-20251001"

	return await new Promise<LiveObservation>(resolve => {
		let proc
		try {
			proc = spawn(
				bin,
				[
					"--print",
					// stream-json BOTH ways: the input format is what allows an image content
					// block, and the CLI refuses stream-json input without it (and without
					// --verbose). No Read tool, no --add-dir, no file on disk.
					"--input-format",
					"stream-json",
					"--output-format",
					"stream-json",
					"--verbose",
					"--model",
					model,
					// No tools at all. The picture arrives in the message; there is nothing to fetch.
					"--tools",
					"",
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
		// The CLI can close stdin before we finish writing a large frame; that is not an error
		// worth surfacing, and without a handler it becomes an unhandled EPIPE that kills us.
		proc.stdin.on("error", () => {})
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

			// stream-json emits one JSON object per line; the `result` line carries the answer.
			let raw = ""
			let costUsd: number | null = null
			for (const line of stdout.split("\n")) {
				if (line.trim() === "") continue
				let o: { type?: string; result?: unknown; total_cost_usd?: unknown }
				try {
					o = JSON.parse(line)
				} catch {
					continue
				}
				if (o.type === "result") {
					if (typeof o.result === "string") raw = o.result
					if (typeof o.total_cost_usd === "number") costUsd = o.total_cost_usd
				}
			}

			const cleaned = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim()
			const nothing = cleaned === "" || cleaned.toUpperCase().startsWith(NOTHING)
			resolve({
				ok: true,
				text: nothing ? "" : cleaned,
				costUsd,
				durationMs: Date.now() - started
			})
		})

		proc.stdin.end(
			`${JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: input.mediaType ?? "image/jpeg", data: input.imageBase64 }
						},
						{ type: "text", text: prompt(input) }
					]
				}
			})}\n`
		)
	})
}

export { prompt as liveVisionPrompt }
