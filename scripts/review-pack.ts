/**
 * POST-GAME REVIEW OF ONE WHOLE GAME, from the game pack. NODE ONLY (it holds an API key).
 *
 * ## Why this exists
 *
 * The live coach was rated 0/10 on game 5639406342: "nothing it said was useful, it was generic
 * and often hilariously wrong". Two things caused that and neither is the model. It had ~1s and a
 * five-second window, so with nothing new to say it read his own HUD back to him; and it had NO
 * POSITIONS, so it told him to take Rift Herald eight times in six minutes without ever being able
 * to see why he was not taking it.
 *
 * This is the other end of that trade. No latency budget at all, the WHOLE game in one prompt, and
 * a position track. The question it is built to answer is the owner's: does whole-game data plus
 * positions make a different product, or the same failure with more words?
 *
 * ## The arms, and why this file has exactly one knob
 *
 * Three arms are being compared on this one game: text-only (the pack alone), pack + frames, and
 * frames-led. `--frames` is therefore the ONLY thing a caller may vary — the system prompt is
 * built here from the shipped persona and is not a parameter, for the same reason `coachTurn`
 * refuses one: a comparison between two arms must not be able to have varied the prompt as well.
 *
 * ## What it is told, and what it is forbidden
 *
 * The persona comes from `AGENTS.md` through `loadPersona`, so this coach IS the shipped coach.
 * The champion knowledge is `fullKnowledge` — Lillia's file, the counterpart's, the role file.
 * The pack replaces the digest, and the citation contract moves with it: `parse.ts` rejects a
 * moment id that is not in the digest, and the analogue here is that every figure must be findable
 * in the pack by searching for it. The rules that survive from the live path are the ones about
 * TRUTH rather than about brevity — fog-gated counterpart figures, CS floored to tens, positions
 * that carry a confidence and a silence where there is no read.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { DATA_DIR } from "../src/shared/constants.ts"
import { loadPersona } from "../src/review/prompt.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"

const arg = (name: string, fallback: string): string => {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const GAME_ID = arg("game", "5639406342")
const MODEL = arg("model", "claude-opus-5")
const PACK_TXT = arg("pack", `${DATA_DIR}/eval/pack-${GAME_ID}.txt`)
const CHAMPION = arg("champion", "Lillia")
const COUNTERPART = arg("counterpart", "Kayn")
const WITH_FRAMES = flag("frames")

if (WITH_FRAMES) {
	// The frames arm is a different experiment and deliberately not smuggled in here.
	console.error("--frames is not implemented in this file; the text-only arm is the control.")
	process.exit(2)
}

/**
 * The contract for a POST-GAME review off a pack.
 *
 * Everything here is either a truth rule (which the pack's own provenance forces) or the output
 * shape. Deliberately no voice instructions: those are the persona's job and duplicating them here
 * would mean the arm comparison ran against a prompt nobody measured.
 */
const CONTRACT = `
---

# THIS REVIEW — a POST-GAME review of one whole game, from a GAME PACK

Everything above about your voice still holds. What changes is the input and the deadline.

## The input replaces the digest

You are given a GAME PACK: one chronological timeline of a single game — his state, his position,
the events, and what the live coach said in that minute — then the objectives joined to where he
was, the full event log, the position track, his own baselines, the live coach transcript, and a
section on the feed's properties.

**The pack is the digest.** Every figure you cite must be findable in the pack by searching for it.
There are no momentIds and no metricKeys here; instead every item carries an \`evidence\` string
that names WHERE in the pack the claim comes from, precisely enough that someone can go and check
it (a clock, a section, a quoted line). An item whose evidence cannot be checked is worthless.

## You cannot see the pictures

340 frame paths are listed in the pack. **You were not given any of them.** Do not describe a
frame, do not say what a screenshot shows, and do not use a frame path as evidence for anything
except "a frame exists at this clock".

## What the feed can and cannot say — these are not style rules, they are the truth

1. **The counterpart's figures are FOG-GATED and frozen at LAST SEEN.** Kayn's level, CS, KDA and
   items are readings with an age, never present-tense facts. Every counterpart line in the pack
   states how long each has been unchanged. Never write "Kayn is level 11" or "Kayn has 50 CS".
   Either say the age with the figure ("Kayn was last seen on 50 CS, and that reading was already
   two minutes old") or do not use it. An unchanged reading means EITHER he did not farm OR nobody
   saw him, and nothing in this data can tell you which.
2. **CS is floored to tens for everyone, including him.** A CS gap of 10 in the feed is anywhere
   from 1 to 19. Never quote a small CS difference as exact. His END-OF-GAME figures are the
   exception: the ingested-match line at the top is exact.
3. **Positions come from the minimap track and carry a confidence.** "high" is a read within ~3s.
   "low" means the nearest read is most of a rotation away — a neighbourhood, not a position, and
   your language must say so. Where the pack says NO READ within 20s, **you do not know where he
   was**, and you may not reason about where he should have been either.
4. **The counterpart's position is UNKNOWN at every instant of this game.** The reader returns
   unlabelled red rings and cannot say a ring is Kayn. Never place Kayn anywhere.
5. **Baselines are COPIED from HIS BASELINES, verbatim, and every one is a MEAN — call it an
   average.** Never derive a baseline by subtracting a delta, never round one.
6. **An objective the enemy took is a fact about the game, not automatically a fault.** You cannot
   see his cooldowns, his team's calls, or the lane states. Where he was when it fell is real and
   citable; "he should have been there instead" usually is not.

## The bar every item must clear

The live coach failed this game on exactly two things, and this review is the answer to both:

- **Not visible.** Could he have known it by looking at his own screen during the game? His gold,
  his own CS, a respawn timer and an objective timer were all on his HUD. If the item is one of
  those, cut it.
- **Not generic.** Would the item read identically pasted onto a different game of his? If yes,
  cut it. A join the live path could not make — where he was when a specific objective fell, a
  stretch of the map he never appeared in, a pattern across the whole 28 minutes — is the product.

Do not repeat a point the live coach already made in-game; the transcript is in the pack and he
rated all 62 lines 0/10.

## Output — JSON only, no prose outside the object, no markdown fences

{
  "headline": string,          // one true line, carrying a real number
  "encouragement": string,     // sincere, never sarcastic
  "items": [                   // 5 to 8 of them, best first
    {
      "title": string,         // < 70 chars, carries its real number
      "fix": string,           // ONE imperative sentence, < 140 chars
      "body": string | null,   // < 500 chars, optional — the joke and the reasoning, never the number he needs
      "tSec": number,          // the game clock this points at, in SECONDS
      "severity": "info" | "minor" | "major",
      "category": string,      // pathing | tempo | objectives | vision | farming | teamfight | deaths | praise
      "impact": "high" | "medium" | "low",
      "actionability": "high" | "medium" | "low",
      "confidence": "high" | "medium" | "low",
      "evidence": string,      // WHERE in the pack this rests — clock, section, quoted figures. < 400 chars
      "usedPositions": boolean // true only if the minimap track or a whereHeWas join is load-bearing for THIS item
    }
  ],
  "goals": [string]            // 1 to 3, checkable by a human next game
}
`.trim()

const persona = loadPersona()
const knowledge = fullKnowledge({ champion: CHAMPION, counterpart: COUNTERPART })
const pack = readFileSync(PACK_TXT, "utf8")

const system = [
	persona.text,
	"---\n\n# CHAMPION KNOWLEDGE\n\n" + knowledge,
	CONTRACT
].join("\n\n")

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12)

const keyPath = `${DATA_DIR}/anthropic.key`
const key = readFileSync(keyPath, "utf8").trim()

const stripFences = (t: string): string => {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
	if (fenced?.[1] !== undefined) return fenced[1].trim()
	const first = t.indexOf("{")
	const last = t.lastIndexOf("}")
	return first === -1 || last <= first ? t.trim() : t.slice(first, last + 1)
}

const main = async () => {
	const { createAnthropic } = await import("@ai-sdk/anthropic")
	const { generateText } = await import("ai")
	const handle = createAnthropic({ apiKey: key })(MODEL)

	console.error(`model ${MODEL} · persona ${persona.source} (${persona.text.length}c) · knowledge ${knowledge.length}c · pack ${pack.length}c`)
	if (persona.warnings.length > 0) console.error("persona warnings:", persona.warnings)

	const started = Date.now()
	const result = await generateText({
		model: handle,
		system,
		messages: [{ role: "user", content: [{ type: "text" as const, text: pack }] }],
		maxOutputTokens: 16000
	})
	const latencyMs = Date.now() - started

	const text = (result.text ?? "").trim()
	let parsed: unknown = null
	let parseError: string | null = null
	try {
		parsed = JSON.parse(stripFences(text))
	} catch (e) {
		parseError = e instanceof Error ? e.message : String(e)
	}

	const out = {
		arm: "text-only",
		gameId: GAME_ID,
		model: MODEL,
		latencyMs,
		usage: result.usage ?? null,
		finishReason: result.finishReason ?? null,
		personaSource: persona.source,
		hashes: { system: sha(system), pack: sha(pack), persona: sha(persona.text), knowledge: sha(knowledge) },
		sizes: { systemChars: system.length, packChars: pack.length, knowledgeChars: knowledge.length },
		packPath: PACK_TXT,
		framesSent: 0,
		parseError,
		review: parsed,
		rawText: text
	}
	const outPath = `${DATA_DIR}/eval/review-textonly-${GAME_ID}.json`
	writeFileSync(outPath, JSON.stringify(out, null, "\t"))
	console.error(`wrote ${outPath} — ${latencyMs}ms, ${text.length} chars, parse ${parseError ?? "ok"}`)
}

await main()
