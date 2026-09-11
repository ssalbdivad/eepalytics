/**
 * ONE ARM of the blind post-game comparison: Anthropic, claude-opus-5.
 *
 * ## What is being compared, and why the bundle is frozen
 *
 * The live coach scored 0/10 on game 5639406342 — it spoke every ~20s off a snapshot with no
 * positions in it, so it read his own HUD back to him. The post-game pass has the opposite
 * budget: the whole game at once, a minimap track, and no clock. He wants to grade the MODELS,
 * blind, so every arm must read the same bytes: `data/eval/bundle-5639406342/`, whose manifest
 * carries a sha256 for every file and every image. Nothing is composed here except the output
 * addendum below, which is the harness's contract and is the same for every arm.
 *
 * ## Why `modelHandleFor` and not `coachTurn`
 *
 * `coachTurn`'s invariant is that the system prompt is NOT a parameter — it is the LIVE coach's
 * prompt, sized for one spoken sentence, and it is exactly wrong for a written review. So this
 * shares the provider plumbing (one place decides how each vendor is reached) and supplies the
 * bundle's own `prompt.txt` as the system prompt.
 *
 * ## Two settings that have fooled this repo before
 *
 * - `maxOutputTokens` is generous. A tight cap does not shorten a reasoning model, it TRUNCATES
 *   it; a truncated model looks like a bad reviewer.
 * - NO provider-specific thinking options. Opus 5 thinks by default when `thinking` is omitted,
 *   and sending an option a provider refuses looks exactly like a model producing nothing.
 *
 * Streaming, not a single POST: 80K in and up to 32K out can outlive undici's 300s headers
 * timeout, and a transport timeout would be recorded as a model failure.
 *
 * NODE ONLY — it reads an API key. It touches no LCU endpoint and nothing the daemon owns.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"

const BUNDLE = "/home/ssalb/eepalytics/data/eval/bundle-5639406342"
const OUT = process.env.ARM_OUT ?? "/home/ssalb/eepalytics/data/eval/postgame-anthropic-opus.json"
const PROVIDER = "anthropic"
const MODEL = process.env.ARM_MODEL ?? "claude-opus-5"

const read = (name: string): string => readFileSync(`${BUNDLE}/${name}`, "utf8")

/**
 * The harness's output contract, and the ONE thing added to the frozen bundle.
 *
 * `prompt.txt` asks for prose because prose is what he reads; the comparison also needs the items
 * as data, so a re-score never has to pay the model again. Both are asked for: the review first,
 * exactly as the bundle specifies it, then the same items repeated as JSON. Asking for JSON only
 * would change what every arm writes, which is a different experiment.
 */
const ADDENDUM = `
HOW TO RETURN IT — this is the harness speaking, not the brief.

Write the review first, exactly as the brief above asks: a headline carrying a real number, then
the items best first, then at most three goals. Markdown. Aim for 6-10 items; fewer if fewer earn
their place.

Then, after the review, emit ONE fenced json block (\`\`\`json ... \`\`\`) repeating the same items as
data, so they can be scored without paying for this turn again. Shape:

{
  "headline": "one line, carries a real number",
  "items": [
    {
      "tSec": 480,                      // game clock in SECONDS this item points at; null if whole-game
      "title": "the claim with its number",
      "fix": "ONE imperative sentence",
      "body": "the short reasoning, or \\"\\" if the title and fix say enough",
      "evidence": "which lines of which file this rests on — the pack section, the position read and its confidence, the frame's clock",
      "usedPositions": true,            // does this item depend on the minimap track?
      "couldNotHaveSeenLive": true      // could he have got this by looking at his own screen during the game? false means he could
    }
  ],
  "goals": ["checkable by a human", "..."]
}

Set the two booleans honestly per item — an item he could have read off his own HUD is the failure
this whole comparison is about, and marking it \`false\` is more useful than hiding it. The JSON
items must be the same items as the prose, in the same order.
`.trim()

const main = async () => {
	const p = providerById(PROVIDER)
	if (!p) throw new Error(`no provider ${PROVIDER}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key — expected data/${p.keyFile}`)

	const frames = JSON.parse(read("frames.json")) as {
		frames: { tSec: number; clock: string; path: string; frameId: string }[]
	}
	const images = frames.frames.map(f => ({
		type: "image" as const,
		image: readFileSync(f.path).toString("base64"),
		mediaType: "image/jpeg" as const
	}))

	const parts = [
		{ type: "text" as const, text: `=== pack.txt ===\n${read("pack.txt")}` },
		{ type: "text" as const, text: `=== knowledge.txt ===\n${read("knowledge.txt")}` },
		{ type: "text" as const, text: `=== positions.txt ===\n${read("positions.txt")}` },
		{ type: "text" as const, text: `=== heard.txt ===\n${read("heard.txt")}` },
		{ type: "text" as const, text: `=== frames.json ===\n${read("frames.json")}` },
		{
			type: "text" as const,
			text: `The ${images.length} frames follow, in the order frames.json lists them: ${frames.frames.map(f => f.clock).join(", ")}.`
		},
		...images,
		{ type: "text" as const, text: ADDENDUM }
	]

	const { streamText } = await import("ai")
	const handle = await modelHandleFor(p, key, MODEL)
	const started = Date.now()
	const result = streamText({
		model: handle,
		system: read("prompt.txt"),
		messages: [{ role: "user", content: parts }],
		maxOutputTokens: 32000
	})
	let text = ""
	for await (const chunk of result.textStream) text += chunk
	const latencyMs = Date.now() - started
	const usage = await result.usage
	const finishReason = await result.finishReason
	let reason: string | null = null
	try {
		await result.response
	} catch (err) {
		reason = err instanceof Error ? err.message : String(err)
	}

	const out = {
		arm: "anthropic-opus",
		provider: PROVIDER,
		model: MODEL,
		bundle: BUNDLE,
		framesSent: images.length,
		latencyMs,
		usage,
		finishReason,
		error: reason,
		ranAtMs: Date.now(),
		text
	}
	writeFileSync(OUT, `${JSON.stringify(out, null, "\t")}\n`)
	console.log(
		JSON.stringify({ latencyMs, usage, finishReason, chars: text.length, frames: images.length, error: reason })
	)
}

await main()
