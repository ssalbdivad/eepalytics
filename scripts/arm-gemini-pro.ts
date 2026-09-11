/**
 * ARM: gemini-pro. One post-game review of game 5639406342 from the frozen bundle.
 *
 * The whole bundle goes in — prompt, pack, knowledge, positions, heard, frames.json and all
 * 16 images. Nothing is summarised on the way in: an arm that sends less is a different
 * experiment than the one being run.
 *
 * `modelHandleFor` rather than `coachTurn`, because `coachTurn`'s system prompt is the LIVE
 * coach's — one spoken sentence under a clock — and would be exactly the wrong instruction
 * for a review that has the whole game and no clock.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { generateText } from "ai"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"

const BUNDLE = "/home/ssalb/eepalytics/data/eval/bundle-5639406342"
const OUT = "/home/ssalb/eepalytics/data/eval/postgame-gemini-pro.json"
const MODEL = process.env.ARM_MODEL ?? "gemini-3.1-pro-preview"

const read = (name: string) => readFileSync(`${BUNDLE}/${name}`, "utf8")

const framesIndex = JSON.parse(read("frames.json")) as {
	frames: { tSec: number; clock: string; path: string; frameId: string; chosenBecause: string }[]
}

/*
 * The bundle prompt ends "plain prose or markdown; no JSON". The harness needs fields it can
 * score, so this addendum — and ONLY this — is appended, identically for every arm. It changes
 * the CONTAINER, never the truth rules and never what to coach.
 */
const OUTPUT_ADDENDUM = `
---
OUTPUT FORMAT FOR THIS RUN (this replaces the "plain prose or markdown" line above; everything
else in this prompt stands unchanged).

Return ONE JSON object and nothing else — no markdown fence, no prose outside it:

{
  "headline": string,            // one line, carries a real number from the pack
  "items": [                     // 6 to 10 of them, best first
    {
      "tSec": number,            // game clock in SECONDS that this item points at
      "title": string,           // the claim WITH its real number, short
      "fix": string,             // ONE imperative sentence
      "body": string,            // short — the reasoning, the joke, the context. Not the fix.
      "evidence": string,        // where in the pack this rests: the lines/sections/figures you used
      "usedPositions": boolean,  // true if this item rests on the minimap position track
      "couldNotHaveSeenLive": boolean // true if he could NOT have got this by looking at his own screen mid-game
    }
  ],
  "goals": [string]              // at most 3, each checkable by a human
}

Rate "couldNotHaveSeenLive" honestly — an item that would have been just as true said out loud
at the time is a false one here, and marking it true does not make it a better item.
`

const main = async () => {
	const p = providerById("gemini-http")!
	const key = providerKey(p)
	if (!key) throw new Error("no key at data/gemini.key")
	const handle = await modelHandleFor(p, key, MODEL)

	const textParts = [
		read("prompt.txt") + OUTPUT_ADDENDUM,
		"\n\n===== pack.txt =====\n" + read("pack.txt"),
		"\n\n===== knowledge.txt =====\n" + read("knowledge.txt"),
		"\n\n===== positions.txt =====\n" + read("positions.txt"),
		"\n\n===== heard.txt =====\n" + read("heard.txt"),
		"\n\n===== frames.json =====\n" + read("frames.json"),
		`\n\nThe ${framesIndex.frames.length} images follow, in the order frames.json lists them.`
	]

	const content = [
		...textParts.map(text => ({ type: "text" as const, text })),
		...framesIndex.frames.map(f => ({
			type: "image" as const,
			image: readFileSync(f.path),
			mediaType: "image/jpeg" as const
		}))
	]

	const started = Date.now()
	let result: Awaited<ReturnType<typeof generateText>> | null = null
	let failed: string | null = null
	try {
		result = await generateText({
			model: handle,
			messages: [{ role: "user", content }],
			// Generous on purpose: a truncated reasoning model reads as a bad reviewer, and this
			// repo has already been fooled by that once at 200 tokens.
			maxOutputTokens: 32000
		})
	} catch (err) {
		failed = err instanceof Error ? err.message : String(err)
	}
	const latencyMs = Date.now() - started

	const raw = result?.text ?? ""
	let parsed: unknown = null
	let parseError: string | null = null
	if (raw.trim() !== "") {
		const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
		const start = stripped.indexOf("{")
		const end = stripped.lastIndexOf("}")
		try {
			parsed = JSON.parse(start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped)
		} catch (err) {
			parseError = err instanceof Error ? err.message : String(err)
		}
	}

	const out = {
		arm: "gemini-pro",
		provider: "gemini-http",
		modelRequested: "gemini-3-pro",
		modelUsed: MODEL,
		modelNote:
			"gemini-3-pro 404s on this key ('Model is not found: models/gemini-3-pro for api version v1beta'). gemini-3.1-pro-preview is the strongest Gemini pro the API serves here; pinned rather than the moving gemini-pro-latest alias.",
		bundle: BUNDLE,
		framesSent: framesIndex.frames.length,
		latencyMs,
		usage: result?.usage ?? null,
		finishReason: result?.finishReason ?? null,
		failed,
		parseError,
		raw,
		parsed
	}
	writeFileSync(OUT, JSON.stringify(out, null, "\t"))
	console.log(
		JSON.stringify(
			{
				latencyMs,
				usage: out.usage,
				finishReason: out.finishReason,
				failed,
				parseError,
				rawLen: raw.length,
				items: (parsed as { items?: unknown[] } | null)?.items?.length ?? null
			},
			null,
			2
		)
	)
}

await main()
