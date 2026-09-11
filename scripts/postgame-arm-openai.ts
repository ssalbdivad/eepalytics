/**
 * POST-GAME REVIEW ARM — openai / gpt-5, from the frozen bundle.
 *
 * One arm of a blind comparison: every model gets the SAME bytes — `data/eval/bundle-<game>/`,
 * whose manifest pins a sha256 per file and per image — and the owner grades the reviews without
 * knowing which model wrote which. So nothing about the context is chosen here: the prompt, the
 * pack, the knowledge, the position track, the live transcript and the 16 frames are read off
 * disk in the order `frames.json` lists and sent whole.
 *
 * The provider handle comes from `modelHandleFor`, which is exported for exactly this: it shares
 * the vendor plumbing WITHOUT inheriting `coachTurn`'s system prompt. That prompt is the LIVE
 * coach's — one spoken sentence under a one-second budget — and using it for a post-game review
 * would be measuring the wrong thing.
 *
 * The one deviation from `prompt.txt`, stated because a frozen bundle deserves it: the bundle's
 * OUTPUT section asks for prose, and this arm asks for the same review as JSON so every arm can
 * be scored field by field. Nothing else about the ask is changed.
 *
 * `maxOutputTokens` is enormous on purpose. gpt-5 spends this budget REASONING before it writes,
 * and this repo has already been fooled once by a truncated reasoning model looking like a bad
 * one ("Kayn is 2", stopped mid-number, at a 200-token cap).
 *
 * NODE ONLY — it reads an API key. It touches no LCU endpoint and no daemon state.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"

const BUNDLE = "/home/ssalb/eepalytics/data/eval/bundle-5639406342"
const OUT = "/home/ssalb/eepalytics/data/eval/postgame-openai-gpt5.json"
const MODEL = process.env.ARM_MODEL ?? "gpt-5"

const read = (name: string): string => readFileSync(`${BUNDLE}/${name}`, "utf8")

interface BundleFrame {
	tSec: number
	clock: string
	path: string
	frameId: string
	chosenBecause: string
	whatThePackSays: string
}

/**
 * The output contract, appended to the frozen prompt rather than replacing it.
 *
 * `usedPositions` and `couldNotHaveSeenLive` are the two questions this whole experiment turns
 * on — the position track is the channel the live coach never had, and "he could have read that
 * off his own HUD" is the failure that earned the live coach its 0/10 — so they are asked per
 * item and asked as booleans the model has to commit to.
 */
const OUTPUT_CONTRACT = `
OUTPUT FORMAT FOR THIS RUN — this REPLACES the "Plain prose or markdown; no JSON" line in the
OUTPUT section above. Nothing else about the ask changes: same review, same truth rules, same
standard for what an item is.

Return ONE JSON object and nothing else — no markdown fence, no prose outside it:

{
  "headline": "one line, carrying a real number from the pack",
  "items": [
    {
      "tSec": 480,                       // game clock in SECONDS this item points at. Use the
                                         // pack's own clock. null ONLY for a genuinely
                                         // whole-game point.
      "title": "short claim carrying its real number",
      "fix": "ONE imperative sentence with a trigger he can notice mid-game",
      "body": "the reasoning, the shape, the thing he could not see. A short paragraph.",
      "evidence": "which pack lines / position reads / frames this rests on, quoted or named
                   precisely enough that a human can go check it",
      "usedPositions": true,             // did this item depend on the minimap track?
      "couldNotHaveSeenLive": true       // was this UNAVAILABLE to him on his own screen
                                         // during the game? false = he could have read it off
                                         // his HUD, which is the live coach's failure.
    }
  ],
  "goals": ["at most three, each checkable by a human"]
}

Write 6 to 10 items, best first. Be honest with the two booleans: an item marked
couldNotHaveSeenLive=true that he plainly could have seen is worse than one marked false.
`

const main = async () => {
	const p = providerById("openai")
	if (!p) throw new Error("no openai provider in PROVIDERS")
	const key = providerKey(p)
	if (!key) throw new Error(`no key — put one in data/${p.keyFile}`)

	const prompt = read("prompt.txt")
	const pack = read("pack.txt")
	const knowledge = read("knowledge.txt")
	const positions = read("positions.txt")
	const heard = read("heard.txt")
	const framesJson = read("frames.json")
	const frames: BundleFrame[] = JSON.parse(framesJson).frames

	// Text first, whole and unedited, then the images in frames.json's own order. Each image is
	// preceded by a one-line label so a model that answers about "the 8:00 frame" cannot have
	// been guessing which picture that was.
	const content: any[] = [
		{ type: "text", text: `===== pack.txt =====\n${pack}` },
		{ type: "text", text: `===== knowledge.txt =====\n${knowledge}` },
		{ type: "text", text: `===== positions.txt =====\n${positions}` },
		{ type: "text", text: `===== heard.txt =====\n${heard}` },
		{ type: "text", text: `===== frames.json =====\n${framesJson}` },
		{
			type: "text",
			text: `===== THE ${frames.length} FRAMES =====\nThey follow in the order frames.json lists, each preceded by its clock.`
		}
	]
	for (const f of frames) {
		content.push({ type: "text", text: `FRAME ${f.clock} (t=${f.tSec}s) — ${f.chosenBecause} — ${f.frameId}` })
		content.push({ type: "image", image: readFileSync(f.path), mediaType: "image/jpeg" })
	}

	const { generateText } = await import("ai")
	const handle = await modelHandleFor(p, key, MODEL)
	const started = Date.now()
	let raw = ""
	let usage: unknown = null
	let failed: string | null = null
	let finishReason: string | null = null
	try {
		const result = await generateText({
			model: handle,
			system: `${prompt}\n${OUTPUT_CONTRACT}`,
			messages: [{ role: "user", content }],
			maxOutputTokens: 32000
		})
		raw = (result.text ?? "").trim()
		usage = result.usage ?? null
		finishReason = result.finishReason ?? null
	} catch (err) {
		failed = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
	}
	const latencyMs = Date.now() - started

	// Parse leniently: a fence or a stray sentence must not cost the whole run, because the
	// expensive part has already been paid for and the raw text is stored either way.
	let parsed: unknown = null
	let parseError: string | null = null
	if (raw !== "") {
		const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
		const from = fenced.indexOf("{")
		const to = fenced.lastIndexOf("}")
		try {
			parsed = JSON.parse(from >= 0 && to > from ? fenced.slice(from, to + 1) : fenced)
		} catch (err) {
			parseError = err instanceof Error ? err.message : String(err)
		}
	}

	writeFileSync(
		OUT,
		`${JSON.stringify(
			{
				arm: "openai-gpt5",
				provider: "openai",
				modelRequested: MODEL,
				bundle: BUNDLE,
				bundleManifestSha: JSON.parse(read("manifest.json")).files,
				framesSent: frames.length,
				frameIds: frames.map(f => f.frameId),
				latencyMs,
				usage,
				finishReason,
				failed,
				parseError,
				raw,
				parsed
			},
			null,
			"\t"
		)}\n`
	)
	console.log(JSON.stringify({ latencyMs, usage, finishReason, failed, parseError, rawLen: raw.length }, null, 2))
	console.log(`→ ${OUT}`)
}

main()
