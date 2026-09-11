/**
 * One post-game review arm: the frozen bundle, one model, one call.
 *
 * Everything under `data/eval/bundle-<gameId>/` goes out in a single user turn — prompt, pack,
 * knowledge, positions, transcript, frame index, and every frame as an image part in the order
 * frames.json lists. The bundle is the experiment's constant; this file only chooses the model.
 *
 * It goes through `modelHandleFor` rather than `coachTurn` on purpose: `coachTurn`'s invariant is
 * that its system prompt is not a parameter, and that prompt is the LIVE coach's — one spoken
 * sentence, a clock, no positions. A post-game review under it would be measuring the wrong prompt.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`)
	return i === -1 ? fallback : (args[i + 1] ?? fallback)
}

const bundleDir = argOf("bundle", "data/eval/bundle-5639406342")
const providerId = argOf("provider", "gemini-http")
const model = argOf("model", "gemini-3.6-flash")
const outPath = argOf("out", "data/eval/postgame-gemini-flash.json")
const arm = argOf("arm", "gemini-flash")

const read = (f: string) => readFileSync(`${bundleDir}/${f}`, "utf8")

const prompt = read("prompt.txt")
const pack = read("pack.txt")
const knowledge = read("knowledge.txt")
const positions = read("positions.txt")
const heard = read("heard.txt")
const framesRaw = read("frames.json")
const frames = JSON.parse(framesRaw) as {
	frames: { tSec: number; clock: string; path: string; frameId: string; chosenBecause: string }[]
}

/*
 * The one thing added to the frozen bundle, and it is added identically for every arm: the bundle
 * asks for prose, and he is grading the arms side by side, so the items have to come back in the
 * same shape from all of them. It changes the CONTAINER, never the question — the four tests for
 * what an item is are the bundle's, quoted back rather than restated.
 */
const OUTPUT_ADDENDUM = `
---
OUTPUT FORMAT — this replaces the "plain prose or markdown" line above, and nothing else.

Return ONE JSON object and nothing else. No markdown fence, no prose outside it.

{
  "headline": "one line, carrying a real number from the pack",
  "items": [
    {
      "tSec": 480.3,
      "title": "the claim WITH its real number, under 80 chars",
      "fix": "ONE imperative sentence, with a trigger he can notice mid-game",
      "body": "the reasoning, under 600 chars. Optional but usually worth it.",
      "evidence": "which lines of which file this rests on — quote the figures you used",
      "usedPositions": true,
      "couldNotHaveSeenLive": true
    }
  ],
  "goals": ["at most three, each checkable by a human"]
}

6 to 10 items, best first. Every item still has to pass all four tests above.
"usedPositions" is true only if the item leans on the minimap track.
"couldNotHaveSeenLive" is true only if the item is something he could NOT have got by looking
at his own screen during the game. Set both honestly; an item marked false for the second one
is admitting it is the live coach's failure repeated.
`.trim()

const p = providerById(providerId)
if (!p) throw new Error(`no provider called ${providerId}`)
const key = providerKey(p)
if (!key) throw new Error(`no key — put one in data/${p.keyFile}`)

const imageParts = frames.frames.map(f => ({
	type: "image" as const,
	image: readFileSync(f.path),
	mediaType: "image/jpeg"
}))

const textPart = (label: string, body: string) => ({
	type: "text" as const,
	text: `===== ${label} =====\n${body}`
})

const started = Date.now()
let raw = ""
let usage: unknown = null
let finishReason = ""
let failed: string | null = null

try {
	const { generateText } = await import("ai")
	const handle = await modelHandleFor(p, key, model)
	const result = await generateText({
		model: handle,
		messages: [
			{
				role: "user",
				content: [
					textPart("PROMPT", `${prompt}\n\n${OUTPUT_ADDENDUM}`),
					textPart("PACK", pack),
					textPart("KNOWLEDGE", knowledge),
					textPart("POSITIONS", positions),
					textPart("HEARD — THE LIVE COACH'S 62 LINES", heard),
					textPart("FRAMES INDEX (the images follow, in this order)", framesRaw),
					...imageParts
				]
			}
		],
		// Generous on purpose. A tight cap does not shorten a reasoning model, it truncates one,
		// and this repo has scored a truncated model as a bad one before.
		maxOutputTokens: 32000
	})
	raw = result.text
	usage = result.usage
	finishReason = result.finishReason
} catch (e) {
	failed = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
const latencyMs = Date.now() - started

const parseItems = (text: string) => {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
	// fenced[1] is optional under noUncheckedIndexedAccess even though the group is
	// non-optional in the pattern; fall back to the raw text rather than asserting.
	const body = fenced?.[1] ?? text
	const start = body.indexOf("{")
	const end = body.lastIndexOf("}")
	if (start === -1 || end === -1) return null
	try {
		return JSON.parse(body.slice(start, end + 1))
	} catch {
		return null
	}
}

const parsed = raw ? parseItems(raw) : null

writeFileSync(
	outPath,
	`${JSON.stringify(
		{
			arm,
			provider: providerId,
			modelRequested: model,
			bundleDir,
			framesSent: imageParts.length,
			latencyMs,
			usage,
			finishReason,
			failed,
			ranAt: new Date().toISOString(),
			parsed,
			raw
		},
		null,
		"\t"
	)}\n`
)

console.log(
	JSON.stringify({
		failed,
		latencyMs,
		finishReason,
		usage,
		framesSent: imageParts.length,
		rawChars: raw.length,
		items: parsed?.items?.length ?? null,
		headline: parsed?.headline ?? null
	})
)
