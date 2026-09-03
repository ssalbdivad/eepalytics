/**
 * Coach chat — a conversation about one game, held to the same evidence rules as a review.
 *
 * A review is a monologue the app fully controls: it is parsed, its citations are checked, and
 * anything invented is dropped before the user sees it. A chat is the user steering, and that
 * makes it the easier place to fabricate — "was I too far from my team at 20 minutes?" invites
 * a confident yes whether or not the digest can answer it.
 *
 * So the chat gets the SAME digest, the SAME persona and the SAME citation allowlist, and its
 * replies run through the same baseline check. Two rules are added on top, because a question
 * can ask for something a review never would:
 *
 *   1. The honest answer to a question the data cannot settle is "the data doesn't show that",
 *      followed by what it does show. That is a good answer, not a failure.
 *   2. Citations are how the UI attaches the map image and the metric to a reply — an answer
 *      about a moment that does not cite it renders as unsourced prose.
 *
 * Pure: no I/O, no database. `src/server/routes/chat.ts` owns both.
 */

import type { Digest } from "./digest-contract.ts"
import type { ChatMessage } from "../shared/schema/domain.ts"
import type { JsonSchema } from "./claude.ts"
import { loadPersona, renderDigest } from "./prompt.ts"
import type { Persona } from "./prompt.ts"

/** How many prior turns to replay. Older context is dropped, the digest never is. */
export const CHAT_HISTORY_TURNS = 12

export const CHAT_JSON_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["reply", "momentIds", "metricKeys"],
	properties: {
		reply: {
			type: "string",
			description:
				"The answer, in prose. Cite real figures from the digest. If the data cannot " +
				"answer, say so plainly and pivot to what it can show."
		},
		momentIds: {
			type: "array",
			items: { type: "string" },
			description: "Moment ids from the digest that this answer is about, copied verbatim."
		},
		metricKeys: {
			type: "array",
			items: { type: "string" },
			description: "Metric keys from the digest that this answer cites, copied verbatim."
		}
	}
}

const CHAT_RULES = `## YOU ARE ANSWERING A QUESTION, NOT WRITING A REVIEW

**The output contract in your persona does not apply here.** That contract describes a review —
\`headline\`, \`encouragement\`, \`items[]\`, \`goals[]\`. Do not return any of those fields. This
turn returns exactly three: \`reply\`, \`momentIds\`, \`metricKeys\`. Everything else in the
persona — the voice, the T1 references, the hedging, and every rule about not inventing a
number — still applies in full.

He has the review already. He is asking a follow-up about this specific game. Answer THAT.

- **Be short.** A couple of paragraphs. He asked one thing; do not deliver a second review.
- **Every rule about numbers still holds.** Only figures that appear in the digest above. Copy
  baselines verbatim from the metric's own line. No invented ward counts, item timings, build
  paths, skill orders or enemy positions.
- **"The data doesn't show that" is a real answer, and often the right one.** The timeline has
  no items, no wards, no skill order, no summoner timers, and positions only once per minute.
  When he asks for one of those, say the data isn't there and then give him the nearest thing
  that IS measured. Never guess to be helpful.
- **Cite what you are talking about.** Put the moment ids in \`momentIds\` and the metric keys
  in \`metricKeys\`, copied exactly. The app renders the map image and the metric beside your
  answer using those ids — an answer with no citation appears as bare opinion, and an id you
  invent is dropped.
- **Hedge low-confidence reads the same way.** Anything between frames is an interpolation.
- **If he asks you to show him something, cite the moments** — that is how the pictures appear.
- **If he disagrees with a number, re-read the digest before defending it.** He can see his own
  game; you can only see the digest. If it turns out the digest does not support what you said,
  say so plainly.
- Stay in character, keep the jokes proportionate to the question, and never get mean.

Return a single JSON object with exactly these three keys and nothing else:

\`\`\`
{ "reply": "<your answer as prose>", "momentIds": [...], "metricKeys": [...] }
\`\`\``

export interface ChatPromptInput {
	digest: Digest
	history: readonly ChatMessage[]
	question: string
	intensity?: number
	persona?: Persona
}

export interface BuiltChatPrompt {
	system: string
	user: string
	schema: JsonSchema
	approxChars: number
}

const transcript = (history: readonly ChatMessage[]): string => {
	const turns = history.filter(m => m.status === "ok").slice(-CHAT_HISTORY_TURNS)
	if (turns.length === 0) return ""
	return `## THE CONVERSATION SO FAR

${turns.map(m => `**${m.role === "user" ? "Him" : "You"}:** ${m.content}`).join("\n\n")}
`
}

/**
 * The digest is repeated in full on every turn rather than summarised.
 *
 * It is the only thing standing between a follow-up question and an invented answer, and it is
 * the part of the prompt that gets cached — dropping it to save tokens would trade the app's
 * one guarantee for a saving it does not need to make.
 */
export const chatPrompt = (input: ChatPromptInput): BuiltChatPrompt => {
	const persona = input.persona ?? loadPersona()
	const user = [
		renderDigest(input.digest),
		transcript(input.history),
		`## HIS QUESTION\n\n${input.question.trim()}`,
		CHAT_RULES
	]
		.filter(s => s !== "")
		.join("\n\n---\n\n")

	return {
		system:
			`${persona.text}\n\n---\n\n` +
			`YOU ARE IN CONVERSATION MODE. He is asking a follow-up about a game you already ` +
			`reviewed. The "Output contract" section above describes the REVIEW format and is ` +
			`SUSPENDED for this turn — do not emit headline, encouragement, items or goals. ` +
			`Return exactly {"reply": string, "momentIds": string[], "metricKeys": string[]}. ` +
			`Every rule about citing real numbers, hedging low-confidence reads and never ` +
			`fabricating a stat remains in force.`,
		user,
		schema: CHAT_JSON_SCHEMA,
		approxChars: user.length
	}
}
