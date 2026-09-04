/**
 * Live screen observation: one frame, one very short piece of feedback.
 *
 * ## What this is, honestly
 *
 * Not a running commentary. A vision call takes about three to four seconds, so this observes
 * the screen periodically — a glance every N seconds, not continuous analysis. The UI says so
 * and the interval is the user's to set, because the interval IS the cost.
 *
 * ## Why the output must be one sentence
 *
 * It is read mid-game, and optionally spoken aloud. A paragraph is unusable in both cases: you
 * cannot read it while fighting, and TTS turns it into thirty seconds of talking over the game.
 * One sentence, or silence.
 *
 * ## It speaks every time
 *
 * The first design made silence the default and gave the model a `PASS` token for it. Measured
 * against a real game that produced twenty consecutive silent glances — $0.15 spent, twenty
 * calls made, not one word said — and a silent coach is indistinguishable from a broken one.
 *
 * The cost is in *looking*, not in answering: the frame is the expensive half of the call and it
 * is uploaded either way. So a glance that says nothing has already spent the money and thrown
 * the value away. It now always says its one sentence, and the interval — which the user sets —
 * is the thing that controls both noise and cost.
 *
 * This does not loosen the evidence rules. "Say something every time" is not permission to
 * invent; when a frame holds nothing dramatic, the answer is a small true thing that is legible
 * on screen, not a big invented one.
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

/**
 * Legacy silence token, kept only as a guard.
 *
 * The prompt no longer offers it and no longer wants it, but a model that emits it anyway should
 * not have the literal word "PASS" spoken aloud mid-fight.
 */
const NOTHING = "PASS"

export interface LiveObservation {
	ok: boolean
	/** Empty when there was nothing worth saying — the common and correct case. */
	text: string
	costUsd: number | null
	durationMs: number
	error?: string
}

/**
 * Ground truth for the frame, read from the Live Client Data API.
 *
 * Named `VisionState` rather than `LiveState`: `analysis/live-coach.ts` already owns that name
 * for a different thing (the overlay's own view of the game).
 *
 * This exists because the coach hallucinated without it. Asked to comment on a 1024px JPEG of a
 * 1080p screen, it named a champion who was not in the game four times in seven minutes, called
 * a TEAMMATE a threat, and contradicted itself about Baron three times. Champion portraits in the
 * HUD are about thirty pixels wide at that scale; the model was guessing, and a guess phrased in
 * Lillia's voice sounds exactly like a read.
 *
 * The fix is not a better model or a bigger image. The League client already serves every one of
 * those facts locally, in about 30ms — who is in the game, which side they are on, who is dead,
 * what the score is. So the picture is used for *where things are*, and this is used for *what is
 * true*. That is the same rule the rest of the app already follows: never derive a fact you can
 * simply be told.
 */
export interface VisionState {
	/** `mm:ss`. */
	clock: string
	me: {
		champion: string
		level?: number
		hp?: number
		maxHp?: number
		gold?: number
		k?: number
		d?: number
		a?: number
		cs?: number
		dead?: boolean
		respawnSec?: number
	}
	allies: VisionStatePlayer[]
	enemies: VisionStatePlayer[]
	/** Most recent objective/kill events, already phrased. Newest last. */
	recentEvents: string[]
}

export interface VisionStatePlayer {
	champion: string
	level?: number
	k?: number
	d?: number
	a?: number
	dead?: boolean
	respawnSec?: number
}

const line = (p: VisionStatePlayer): string =>
	`${p.champion}${p.level ? ` lv${p.level}` : ""} ${p.k ?? 0}/${p.d ?? 0}/${p.a ?? 0}${
		p.dead ? ` DEAD${p.respawnSec ? ` (${Math.round(p.respawnSec)}s)` : ""}` : ""
	}`

/** The authoritative block. Everything in it came from the client, not from the picture. */
const renderState = (s: VisionState): string => {
	const me = s.me
	const hp = me.hp !== undefined && me.maxHp !== undefined ? `${Math.round(me.hp)}/${Math.round(me.maxHp)} HP` : ""
	return `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock ${s.clock}.

You: ${me.champion}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${me.a ?? 0}${
		me.cs !== undefined ? `, ${me.cs} CS` : ""
	}${hp ? `, ${hp}` : ""}${me.gold !== undefined ? `, ${Math.round(me.gold)}g` : ""}${
		me.dead ? `, DEAD${me.respawnSec ? ` (respawn ${Math.round(me.respawnSec)}s)` : ""}` : ""
	}

Your team: ${s.allies.map(line).join(" · ") || "unknown"}

Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}
${s.recentEvents.length > 0 ? `
Just happened: ${s.recentEvents.join("; ")}` : ""}

**The ten champions above are the only champions in this game.** Never name any other. Never
give a number that is not in this block — you cannot read health bars, gold or scores off a
downscaled screenshot accurately, and you do not need to, because they are right here.

Use the screenshot for **where things are** — positions, who is grouped, what is happening on
screen. Use this block for **what is true**.`
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
	/** Ground truth from the game client. Without it the model invents champions — see `LiveState`. */
	state?: VisionState | null
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

	const scene = `The image attached to this message is a screenshot of a live League of
Legends game${input.championName ? `, played by the ${input.championName} player` : ""}. Game
clock: ${clock}.`

	const working =
		input.focus && input.focus.length > 0 ?
			`\n## What they are working on\n\n${input.focus.map(f => `- ${f}`).join("\n")}\n`
		:	""

	const asked = (input.question ?? "").trim()

	/*
	 * A question changes the shape of the answer — two sentences instead of one, and answering
	 * the thing asked rather than choosing what is worth saying. The evidence rules do not move.
	 */
	if (asked !== "")
		return `${scene}
${input.state ? `\n${renderState(input.state)}\n` : ""}
They just asked you, out loud, mid-game:

> ${asked}

Answer it. Two short sentences at most — it will be read or spoken while they are playing.

- **Answer from what is visible in this frame.** If the screen does not show what they asked
  about, say so in a few words rather than guessing. "Can't see their jungler on this screen" is
  a real answer and a useful one.
- No preamble, no restating the question, no markdown. Just the answer.
- If it is a judgement call, give your actual opinion — they asked for it.
${working}`

	return `${scene}
${input.state ? `\n${renderState(input.state)}\n` : ""}
You are their coach, watching over their shoulder. Say exactly ONE short sentence. You speak on
every glance — there is no option to stay quiet, so always have something.

## What to say, in priority order

1. **A warning, if this frame shows one.** An objective spawning or being taken, someone
   overextended and about to die, a fight starting they are out of position for, a recall they
   should take now. This beats everything below it.
2. **Hype, if this frame shows something good.** A multi-kill, a steal, a save, surviving what
   should have killed them, a fight they had no business winning. Be delighted about it.
3. **Otherwise, the most useful concrete thing you can actually read.** A number off the HUD, an
   objective timer, their health or gold, where someone is standing. Small and true beats big and
   invented — a quiet frame gets a quiet observation, not a manufactured emergency.

Not in a game at all? Say what is genuinely on screen — shop, loading, death cam, menu — in one
warm line. That is a real answer, not a failure.

## Voice

You are Lillia: dreamy, warm, slightly unhinged, and dreams, sleep, pollen and prancing are all
yours. "Bough down." "They need a nap after that." Never force a pun, never reuse one listed
below, and never fake enthusiasm for something ordinary — praise spent on a normal recall is
praise that means nothing when the real moment comes.

## Rules

- **Never name a champion that is not in the ground-truth roster above.** If no roster was given,
  do not name champions at all — say "their jungler", "the one chasing you". A champion who is
  not in the game is the single most obvious way to prove you are making things up, and it
  discredits every true thing you said.
- **Numbers come from the ground truth, never from reading the screenshot.** You cannot read a
  health bar or a gold count off a downscaled JPEG, and you do not have to.
- **Only what is legible in this frame**, for everything else: not cooldowns you cannot see, not
  what happened before it, not what they intend. Speaking every time is not permission to invent.
- **If nothing is happening, say that.** "Clearing raptors, nobody near you" is a real and useful
  observation. Do not manufacture a fight to have something dramatic to say.
- **One sentence, under 100 characters.** It may be spoken aloud while they are fighting.
- **Imperative and immediate** for a warning: "Back off, three missing top". For praise, just be
  delighted; there is nothing to instruct.
- No preamble, no markdown, no quotes. Just the sentence.
${working}${
		input.recent && input.recent.length > 0 ?
			`\n## You just said these — do not repeat them\n\n${input.recent.map(r => `- ${r}`).join("\n")}\n`
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
	/*
	 * Sonnet, not Haiku — measured, against the intuition that a small task wants a small model.
	 *
	 * On one real 1024px game frame with this prompt, three runs each:
	 *
	 *   haiku-4-5   median 15.3s   ~1551 output tokens   $0.0113   misread the drake timer
	 *   fable-5-1   median  4.7s     ~36 output tokens   $0.0361   correct
	 *   sonnet-5    median  3.9s     ~34 output tokens   $0.0058   correct
	 *
	 * Haiku is slower AND dearer AND wrong here. It spends 1500 tokens deliberating its way to
	 * one sentence, and on this frame it read "Chemtech Drake in 7s" as a teammate respawning.
	 * Sonnet answers in ~34 tokens because it simply reads the screen. Output tokens are the
	 * latency on this path, so the model that thinks least is the fastest one.
	 */
	const model =
		process.env.FAWNSEI_LIVE_VISION_MODEL ??
		process.env.CSK_LIVE_VISION_MODEL ??
		"claude-sonnet-5"

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
			/*
			 * Exact match, deliberately not a prefix.
			 *
			 * `startsWith` swallowed any real sentence that happened to open with the word —
			 * "Pass on this fight, you are down two" is advice, and it silently became silence.
			 * The trailing-period form is the only variant worth tolerating.
			 */
			const upper = cleaned.toUpperCase()
			const nothing = cleaned === "" || upper === NOTHING || upper === `${NOTHING}.`
			/*
			 * Log every glance, including the silent ones.
			 *
			 * This path built a logger and never called it, so a coach that had said nothing for
			 * twenty consecutive calls looked exactly like a coach that was working. An empty
			 * answer is now unexpected, which makes it worth a line.
			 */
			log.info(
				`glance ${Date.now() - started}ms $${(costUsd ?? 0).toFixed(4)} -> ${
					nothing ? "(empty)" : JSON.stringify(cleaned.slice(0, 120))
				}`
			)
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
