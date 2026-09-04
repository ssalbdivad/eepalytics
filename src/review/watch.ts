/**
 * The visual pass: look at the replay frames and coach the EXECUTION.
 *
 * ## Why this exists at all
 *
 * Every other review in this app is built from the timeline, which carries positions once a
 * minute, kill events and objective events. That supports coaching about *where* and *when* —
 * pathing, tempo, death locations — and it cannot support coaching about *how*. Ability casts,
 * kiting, spacing, fight entry angle: none of it is in any data stream this app can read. The
 * `.rofl` chunk payloads contain it and need the game engine to decode.
 *
 * So the frames are not "more data". They are the only evidence of execution that exists here,
 * which is why the extra seeks and the extra model call are worth paying for.
 *
 * ## Why this uses the CLI's Read tool rather than the API
 *
 * There is no `ANTHROPIC_API_KEY` on this machine; the app drives the authenticated `claude`
 * CLI. The CLI's Read tool renders images, so pointing it at the directory holding them is how
 * a model gets to see them. Verified against a real generated map SVG before this was written.
 *
 * ## What it is NOT allowed to do
 *
 * A model looking at a screenshot will happily invent a health bar reading or a cooldown it
 * cannot make out. So the rules below draw a hard line: describe only what is legible in the
 * frame, and when a frame does not settle the question, say so. The numeric claims still come
 * from the digest, which the parser can check; the visual claims cannot be checked by anything,
 * which is exactly why they must be hedged rather than asserted.
 *
 * NODE ONLY — spawns the CLI.
 */

import { spawn } from "node:child_process"
import type { Moment } from "../shared/schema/domain.ts"
import { fmtClock } from "../shared/time.ts"
import { errText, makeLogger } from "../daemon/log.ts"

const log = makeLogger("watch")

const CLI_TIMEOUT_MS = Number((process.env.EEPALYTICS_WATCH_TIMEOUT_MS ?? process.env.CSK_WATCH_TIMEOUT_MS) ?? 300_000)

export interface WatchFrame {
	/** Absolute path the CLI will Read. */
	path: string
	tSec: number
}

export interface WatchInput {
	championName: string
	role: string
	moment: Moment
	frames: readonly WatchFrame[]
	/** The metric lines relevant to this moment, verbatim from the digest. */
	context: readonly string[]
	/** Champion notes, when we have them. Shapes the fix; never becomes a claim. */
	championNotes?: string | null
	mediaDir: string
}

export interface WatchResult {
	ok: boolean
	/** The coaching text, already short. */
	text: string
	error?: string
	costUsd?: number | null
	durationMs: number
}

const buildPrompt = (input: WatchInput): string => {
	const { moment, frames, championName, role } = input
	return `You are reviewing REPLAY FRAMES from one moment of a League of Legends game, to coach
execution — the thing the game's own data cannot tell us.

The player is **${championName}** (${role}). The moment is **${moment.title}** at
**${fmtClock(moment.tSec)}** (${moment.kind}).

## Read these frames in order

${frames.map(f => `- \`${f.path}\` — ${f.tSec >= moment.tSec ? "+" : ""}${Math.round(f.tSec - moment.tSec)}s (game clock ${fmtClock(f.tSec)})`).join("\n")}

Read every one of them before answering. They are seconds apart, so the sequence is the point:
what changed between frames is the evidence, not any single picture.

## What was measured (use these figures; do not invent others)

${input.context.length > 0 ? input.context.map(c => `- ${c}`).join("\n") : "- (no metric lines attached to this moment)"}

${input.championNotes ? `## How this champion works\n\n${input.championNotes}\n\nUse this to shape the fix. Never quote it, never attribute it, and never let it override what you can see.\n` : ""}
## What to coach

Look for the things only a frame can show:

- **Ability usage** — what was on cooldown, what was available and unused, whether a cast landed
  or whiffed, whether the ultimate was held too long or thrown away.
- **Kiting and spacing** — was the camp or the enemy being kited, or stood still and traded with?
  Was there room to back off, and was it used?
- **Fight entry** — the angle he came in from, whether anyone followed up, whether he was in
  range of more enemies than he could handle.
- **What the HUD shows** — health and mana at the decision point, items visible on the bar,
  level, who is on the minimap.

## The rules, and they are the whole point

1. **Describe only what is legible in the frame.** If you cannot read a health bar, a cooldown or
   an item, say so and move on. A confident guess about a pixel you cannot resolve is worse than
   silence: it is unverifiable, so nobody can ever catch it being wrong.
2. **Say which frame each observation comes from** — "at -3s", "in the last frame". That is what
   makes it checkable by a human who can open the same picture.
3. **Numbers come from the measured lines above**, never from reading the screen. You may say
   "he looks to be around half health"; you may not state a figure.
4. **If the frames do not settle the question, say that.** "I can't tell from these whether his E
   was up" is a real, useful answer, and far better than inventing one.
5. This is about EXECUTION. Do not re-coach the pathing and objective timing — he has that
   already from the data review.

## Answer format

Plain prose, no JSON, no markdown headings. Under 900 characters total.

Two short paragraphs at most: what you can actually see him do, then the one thing to do
differently — phrased as something he could execute next time this situation appears. If the
frames genuinely show nothing worth coaching, say that in one sentence instead of padding.`
}

/**
 * Run the visual pass. Never throws — a failed look degrades the review, it does not break it.
 */
export const watchMoment = async (input: WatchInput, signal?: AbortSignal): Promise<WatchResult> => {
	const started = Date.now()
	const bin = (process.env.EEPALYTICS_CLAUDE_BIN ?? process.env.CSK_CLAUDE_BIN) ?? "claude"
	const model = (process.env.EEPALYTICS_COACH_MODEL ?? process.env.CSK_COACH_MODEL) ?? "claude-sonnet-5"

	if (input.frames.length === 0)
		return { ok: false, text: "", error: "no frames to look at", durationMs: 0 }

	const args = [
		"--print",
		"--output-format",
		"json",
		"--model",
		model,
		// Read is what renders the images. Nothing else is needed, and nothing else is granted.
		"--tools",
		"Read",
		"--add-dir",
		input.mediaDir,
		"--disable-slash-commands",
		"--strict-mcp-config",
		"--no-session-persistence",
		"--safe-mode",
		"--effort",
		"medium"
	]

	return await new Promise<WatchResult>(resolve => {
		let proc
		try {
			proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], signal })
		} catch (err) {
			resolve({ ok: false, text: "", error: errText(err), durationMs: Date.now() - started })
			return
		}

		const timer = setTimeout(() => proc.kill("SIGKILL"), CLI_TIMEOUT_MS)
		let stdout = ""
		let stderr = ""
		proc.stdout.on("data", d => (stdout += String(d)))
		proc.stderr.on("data", d => (stderr += String(d)))
		proc.on("error", err => {
			clearTimeout(timer)
			resolve({ ok: false, text: "", error: errText(err), durationMs: Date.now() - started })
		})
		proc.on("close", code => {
			clearTimeout(timer)
			if (code !== 0) {
				resolve({
					ok: false,
					text: "",
					error: `${bin} exited ${code}: ${stderr.slice(0, 300)}`,
					durationMs: Date.now() - started
				})
				return
			}
			try {
				const envelope = JSON.parse(stdout) as {
					result?: unknown
					total_cost_usd?: unknown
					is_error?: unknown
				}
				const text = typeof envelope.result === "string" ? envelope.result.trim() : ""
				resolve({
					ok: text !== "" && envelope.is_error !== true,
					text,
					costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
					durationMs: Date.now() - started,
					...(text === "" ? { error: "the model returned no text" } : {})
				})
			} catch (err) {
				resolve({
					ok: false,
					text: "",
					error: `could not read the CLI envelope: ${errText(err)}`,
					durationMs: Date.now() - started
				})
			}
		})

		proc.stdin.end(buildPrompt(input))
	})
}

export { buildPrompt as watchPrompt }
