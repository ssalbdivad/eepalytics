/**
 * The POST-GAME review, with-frames arm.
 *
 * ## What this is measuring
 *
 * The live coach scored 0/10 on game 5639406342: it spoke every ~20s off a snapshot of the
 * client with no positions in it, so with nothing new to say it read his own HUD back to him
 * and told him to take Rift Herald eight times without ever knowing why he was not taking it.
 *
 * This is the opposite arm in every dimension that failure had: the WHOLE game at once, no
 * latency budget, and the one channel the live path never had — WHERE HE WAS, from the minimap
 * reader, joined to every objective and every death.
 *
 * ## Two round trips, on purpose
 *
 * The frame index in the pack lists 340 screenshots. Handing over a fixed set chosen by this
 * script would measure the script's taste in moments, not the reviewer's — so round one sends
 * the pack alone and asks which moments it wants to LOOK at, and round two sends exactly those
 * frames back. What it asks for is itself a result worth keeping, so both rounds are stored.
 *
 * ## The prompt is the shipped one
 *
 * System = the Coach Lillia section of AGENTS.md, read off disk through the same markers
 * `src/review/prompt.ts` uses, plus `fullKnowledge` — his champion's file and the role file,
 * complete, the same text the trusted live arm gets. Nothing about the persona is retyped here;
 * a comparison between arms must not have varied it.
 *
 * NODE ONLY — it holds an API key. Nothing here touches the LCU or the daemon: it reads the
 * pack, the frames on disk, and the network.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"

const MODEL = process.env.ARM_MODEL ?? "claude-opus-5"
const PACK_TXT = process.env.ARM_PACK ?? "/home/ssalb/eepalytics/data/eval/pack-5639406342.txt"
const OUT = process.env.ARM_OUT ?? "/home/ssalb/eepalytics/data/eval/postgame-with-frames.json"
const MAX_FRAMES = 12

/** The persona, from the same markers the shipped reviewer reads. Loud failure, never silence. */
const persona = (): string => {
	const raw = readFileSync("/home/ssalb/eepalytics/AGENTS.md", "utf8")
	const from = raw.indexOf("<!-- COACH:BEGIN -->")
	const to = raw.indexOf("<!-- COACH:END -->")
	if (from === -1 || to === -1) throw new Error("AGENTS.md has lost its COACH markers")
	return raw.slice(from + "<!-- COACH:BEGIN -->".length, to).trim()
}

/**
 * What this arm is, said to the model once.
 *
 * Every rule below is about TRUTH rather than about voice — the voice is the persona's job. The
 * fog rule and the position-confidence rule are the two the live coach broke in this exact game
 * ("Kayn is still level 1" was a 213-second-old reading spoken as news).
 */
const ARM_BRIEF = `
You are writing a POST-GAME review of one finished game, not a live line. You have the whole
game at once and no time limit.

WHAT IS NEW HERE, and what the review has to earn its place with: POSITIONS. The pack carries a
minimap track — where he was, with a confidence and the age of the read — and every objective is
joined to where he was when it fell. The live coach in this game had none of that, spoke every
20 seconds, and he rated it 0/10 for being generic and often wrong. An item that could have been
written without the position track, or without his own baselines, is an item that arm already
failed with.

THE TRUTH RULES, which are not stylistic:
- Every figure must appear in the pack. No arithmetic that invents a number, no rounding a
  baseline, no recalling a stat.
- Baselines are COPIED from HIS BASELINES verbatim. They are means over 20 games. Never derive
  one by subtracting a delta.
- The counterpart's CS, level and items are FOG-GATED and frozen at last seen. Never state one
  as current. If you use one, say its age or say nothing. His CS is floored to tens for everyone,
  so a 10-CS gap is anywhere from 1 to 19.
- Positions come from the minimap track and carry its confidence. A "low" read is a
  neighbourhood, not a position — hedge it in the sentence. Where the track says UNKNOWN you do
  not know where anybody was, and you may not fill it in from a screenshot's minimap either
  unless you are describing what you can literally see in the frame and you say so.
- The counterpart's POSITION is unknown at every instant in this game. The reader returns
  unlabelled red rings; a ring is not Kayn.
- An objective the enemy took is a fact about the game, not automatically a fault. Coach what he
  was doing instead and what it bought.

THE BAR, and it is high: an item must be something he COULD NOT have known by looking at his own
screen during the game, and it must not be true of every game he has ever played. If an item
would survive being pasted onto a different game, cut it and find a better one.
`.trim()

const ROUND_1 = `
${ARM_BRIEF}

Below is the whole pack. Read it, then — before writing anything — say which moments you want to
SEE. Pick up to ${MAX_FRAMES} frames from the FRAME INDEX at the bottom: deaths, objectives,
fights, whatever you actually want to check with your eyes. The frame is a full 1536x864
screenshot of his monitor, so it carries the minimap, the scoreboard and the fight.

Answer with nothing but lines of the form:

FRAME <full path> — <what you want to check in it>

No preamble, no review yet.
`.trim()

const ROUND_2 = `
Here are the frames you asked for, in clock order, each labelled with its game clock.

Now write the review. Return JSON ONLY — no prose outside it, no markdown fence:

{
  "headline": "one true line carrying a real number",
  "encouragement": "sincere, never sarcastic",
  "items": [
    {
      "tSec": <game clock in seconds, or null for a whole-game point>,
      "title": "the claim WITH its number, under 70 characters",
      "fix": "ONE imperative sentence, under 140 characters",
      "body": "optional, under 500 characters — the joke, the reference, the reasoning",
      "severity": "info" | "minor" | "major",
      "category": "pathing" | "tempo" | "objectives" | "vision" | "farming" | "teamfight" | "deaths" | "praise",
      "impact": "high" | "medium" | "low",
      "actionability": "high" | "medium" | "low",
      "confidence": "high" | "medium" | "low",
      "evidence": "the exact lines from the pack this rests on — quote the figures and say where they came from (spine minute, objective join, position track, baseline table, frame path)",
      "usedPositions": true | false,
      "usedFrames": ["<frame paths you actually looked at for this item>"]
    }
  ],
  "goals": ["1-3 checkable things for the next games"]
}

5 to 8 items. Set "usedPositions" honestly: true only when the item genuinely rests on the
minimap track or a position join, false when the numbers alone carry it. At least one item must
be praise. Rate impact/actionability/confidence honestly — marking everything high destroys the
ordering.
`.trim()

const main = async () => {
	const key = readFileSync("/home/ssalb/eepalytics/data/anthropic.key", "utf8").trim()
	const pack = readFileSync(PACK_TXT, "utf8")
	const system = `${persona()}\n\n---\n\nCHAMPION CONTEXT\n\n${fullKnowledge({ champion: "Lillia", counterpart: "Kayn" })}`

	const { createAnthropic } = await import("@ai-sdk/anthropic")
	const { generateText } = await import("ai")
	const model = createAnthropic({ apiKey: key })(MODEL)

	const startedAll = Date.now()

	// ── round 1: which moments does it want to look at ────────────────────────────
	const t1 = Date.now()
	const ask = await generateText({
		model,
		system,
		messages: [{ role: "user", content: [{ type: "text", text: `${ROUND_1}\n\n${pack}` }] }],
		maxOutputTokens: 4000
	})
	const round1Ms = Date.now() - t1

	// Only paths the pack actually lists are honoured — a hallucinated frame path must not become
	// a silently missing image the review then describes anyway.
	const known = new Set(pack.match(/\/home\/ssalb\/eepalytics\/data\/journal\/[^\s]+\.jpg/g) ?? [])
	const wanted: string[] = []
	for (const line of ask.text.split("\n")) {
		const m = line.match(/(\/home\/ssalb\/eepalytics\/data\/journal\/[^\s]+\.jpg)/)
		const path = m?.[1]
		if (!path) continue
		if (!known.has(path)) continue
		if (wanted.includes(path)) continue
		wanted.push(path)
		if (wanted.length >= MAX_FRAMES) break
	}
	if (wanted.length === 0) throw new Error("round 1 named no frame this pack lists")

	// Clock order, so what it sees runs forward like the game did.
	const clockOf = (p: string): number => {
		const id = p.split("/").pop()!.replace(".jpg", "")
		const row = pack.split("\n").find(l => l.includes(`${id} `) && l.includes("KB"))
		const c = row?.trim().match(/^(\d+):(\d+)/)
		return c ? Number(c[1]) * 60 + Number(c[2]) : 0
	}
	wanted.sort((a, b) => clockOf(a) - clockOf(b))

	const frameParts = wanted.flatMap(p => [
		{ type: "text" as const, text: `frame ${p} — game clock ${Math.floor(clockOf(p) / 60)}:${String(clockOf(p) % 60).padStart(2, "0")}` },
		{
			type: "image" as const,
			image: readFileSync(p).toString("base64"),
			mediaType: "image/jpeg"
		}
	])

	// ── round 2: the review, with the frames it chose ─────────────────────────────
	const t2 = Date.now()
	const review = await generateText({
		model,
		system,
		messages: [
			{ role: "user", content: [{ type: "text", text: `${ROUND_1}\n\n${pack}` }] },
			{ role: "assistant", content: [{ type: "text", text: ask.text }] },
			{ role: "user", content: [...frameParts, { type: "text", text: ROUND_2 }] }
		],
		maxOutputTokens: 16000
	})
	const round2Ms = Date.now() - t2
	const totalMs = Date.now() - startedAll

	const stripped = review.text.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
	let parsed: unknown = null
	try {
		parsed = JSON.parse(stripped)
	} catch {
		parsed = null
	}

	const out = {
		arm: "with-frames",
		model: MODEL,
		pack: PACK_TXT,
		framesRequested: wanted,
		round1Text: ask.text,
		round1Ms,
		round2Ms,
		totalMs,
		usage: { round1: ask.usage, round2: review.usage },
		reviewRaw: review.text,
		review: parsed
	}
	writeFileSync(OUT, JSON.stringify(out, null, 2))
	console.log(`round1 ${round1Ms}ms · round2 ${round2Ms}ms · total ${totalMs}ms`)
	console.log(`frames: ${wanted.length}`)
	console.log(`wrote ${OUT}`)
	if (!parsed) console.log("WARNING: round 2 did not parse as JSON")
}

await main()
