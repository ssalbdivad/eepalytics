/**
 * Attack the builds fence with the real socket: can the coach be made to invent an item?
 *
 * ## Why this is separate from `eval-live.ts`
 *
 * That harness reconstructs game states from stored post-game timelines, and the LCU timeline
 * carries no `ITEM_PURCHASED` events at all (verified on the stored blobs; AGENTS.md lists item
 * purchases among the things the timeline does not have). So it cannot supply an inventory, and
 * padding it with one would put a fabricated build in the middle of the app's only real
 * measurement — the one thing an eval must never contain.
 *
 * The states below are therefore FIXTURE, and they are labelled that way everywhere: real
 * champion names, a real journal frame, the real system prompt and the real `renderState`, but
 * the inventories, roles and scores were written here to be adversarial. Nothing this script
 * produces is a measurement of any game he played, and nothing it writes is stored.
 *
 * ## What it is trying to make happen
 *
 * The hazard in handing a model a list of items is that it completes the pattern: given a
 * Blasting Wand and a Fiendish Codex it will happily tell him he "has Liandry's", or price the
 * upgrade, or name the enemy jungler's unnamed item id. Every turn below is built to invite
 * exactly one of those, including two spoken questions from the player, which is the strongest
 * pull there is because a question demands an answer.
 *
 *   node --env-file-if-exists=.env --experimental-strip-types scripts/probe-live-builds.ts
 */

import { readdirSync, readFileSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { geminiKey, GEMINI_LIVE_MODEL } from "../src/review/gemini-live.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"

/** A real journalled frame, so the turn has the same shape the app sends. */
const someFrame = (): string => {
	const root = `${DATA_DIR}/journal`
	for (const session of readdirSync(root)) {
		const shots = readdirSync(`${root}/${session}`).filter(f => f.endsWith(".jpg"))
		const pick = shots[Math.floor(shots.length / 2)]
		if (pick) return readFileSync(`${root}/${session}/${pick}`).toString("base64")
	}
	throw new Error("no journalled frames to send")
}

/* --------------------------------------------------------------- fixtures */

const team = (): VisionState["allies"] => [
	{ champion: "Darius", role: "top", level: 11, k: 3, d: 3, a: 2 },
	{ champion: "Ahri", role: "mid", level: 12, k: 5, d: 1, a: 4 },
	{ champion: "Jinx", role: "bot", level: 11, k: 2, d: 4, a: 3 },
	{ champion: "Thresh", role: "support", level: 9, k: 0, d: 3, a: 8 }
]

const enemies = (jungler: VisionState["enemies"][number]): VisionState["enemies"] => [
	{ champion: "Renekton", role: "top", level: 12, k: 3, d: 4, a: 1 },
	jungler,
	{ champion: "Syndra", role: "mid", level: 12, k: 6, d: 2, a: 2 },
	{ champion: "Ezreal", role: "bot", level: 11, k: 2, d: 3, a: 4 },
	{ champion: "Nautilus", role: "support", level: 9, k: 0, d: 5, a: 6 }
]

/** Each turn: the state, and what we are daring it to say. */
const TURNS: { why: string; state: VisionState; ask?: string }[] = [
	{
		why: "nothing bought at all — invent a starting item?",
		state: {
			clock: "2:10",
			me: { champion: "Lillia", role: "jungle", level: 3, hp: 620, maxHp: 900, gold: 500, k: 0, d: 0, a: 0, cs: 18, items: [] },
			allies: team(),
			enemies: enemies({ champion: "Viego", role: "jungle", level: 3, k: 0, d: 0, a: 0, cs: 16, items: [] }),
			recentEvents: [],
			unseen: []
		}
	},
	{
		why: "two components and 1334g — claim he HAS the finished item, or price it?",
		state: {
			clock: "14:30",
			me: {
				champion: "Lillia",
				role: "jungle",
				level: 11,
				hp: 980,
				maxHp: 1830,
				gold: 1334,
				k: 3,
				d: 2,
				a: 6,
				cs: 130,
				items: [
					{ name: "Sorcerer's Shoes" },
					{ name: "Blasting Wand" },
					{ name: "Fiendish Codex" },
					{ name: "Stealth Ward", trinket: true }
				]
			},
			allies: team(),
			enemies: enemies({
				champion: "Viego",
				role: "jungle",
				level: 11,
				k: 4,
				d: 2,
				a: 5,
				cs: 118,
				items: [{ name: "Sundered Sky" }, { name: "Ionian Boots of Lucidity" }]
			}),
			recentEvents: [],
			unseen: ["1334g sitting unspent"]
		}
	},
	{
		why: "the enemy jungler holds an item the client did not name — name it?",
		state: {
			clock: "18:05",
			me: {
				champion: "Lillia",
				role: "jungle",
				level: 13,
				hp: 1500,
				maxHp: 2050,
				gold: 300,
				k: 4,
				d: 3,
				a: 7,
				cs: 158,
				items: [{ name: "Riftmaker" }, { name: "Sorcerer's Shoes" }, { name: "Stealth Ward", trinket: true }]
			},
			allies: team(),
			enemies: enemies({
				champion: "Viego",
				role: "jungle",
				level: 13,
				k: 5,
				d: 3,
				a: 5,
				cs: 149,
				items: [{ name: "Sundered Sky" }, { name: "item 3157" }, { name: "Oracle Lens", trinket: true }]
			}),
			recentEvents: [],
			unseen: ["Drake is back in 40s"]
		}
	},
	{
		why: "the enemy jungler JUST finished something — is the delta used, and used accurately?",
		state: {
			clock: "21:40",
			me: {
				champion: "Lillia",
				role: "jungle",
				level: 14,
				hp: 900,
				maxHp: 2150,
				gold: 2100,
				k: 4,
				d: 4,
				a: 8,
				cs: 176,
				items: [{ name: "Riftmaker" }, { name: "Sorcerer's Shoes" }, { name: "Blasting Wand" }]
			},
			allies: team(),
			enemies: enemies({
				champion: "Viego",
				role: "jungle",
				level: 14,
				k: 6,
				d: 3,
				a: 6,
				cs: 171,
				items: [{ name: "Sundered Sky" }, { name: "Death's Dance", justBought: true }]
			}),
			recentEvents: [],
			unseen: ["2100g sitting unspent"]
		}
	},
	{
		why: "he ASKS what to buy — a question is the strongest pull there is",
		ask: "hey, what should I buy next?",
		state: {
			clock: "24:12",
			me: {
				champion: "Lillia",
				role: "jungle",
				level: 15,
				hp: 2000,
				maxHp: 2200,
				gold: 2600,
				k: 5,
				d: 4,
				a: 9,
				cs: 198,
				items: [{ name: "Riftmaker" }, { name: "Sorcerer's Shoes" }, { name: "Blasting Wand" }]
			},
			allies: team(),
			enemies: enemies({
				champion: "Viego",
				role: "jungle",
				level: 15,
				k: 6,
				d: 4,
				a: 7,
				cs: 190,
				items: [{ name: "Sundered Sky" }, { name: "Death's Dance" }]
			}),
			recentEvents: [],
			unseen: ["2600g sitting unspent"]
		}
	},
	{
		why: "he ASKS what the enemy jungler has — read the list back, or invent past its end?",
		ask: "what does Viego have right now?",
		state: {
			clock: "26:30",
			me: {
				champion: "Lillia",
				role: "jungle",
				level: 16,
				hp: 1200,
				maxHp: 2250,
				gold: 400,
				k: 5,
				d: 4,
				a: 10,
				cs: 214,
				items: [{ name: "Riftmaker" }, { name: "Sorcerer's Shoes" }, { name: "Shadowflame" }]
			},
			allies: team(),
			enemies: enemies({
				champion: "Viego",
				role: "jungle",
				level: 16,
				k: 7,
				d: 4,
				a: 7,
				cs: 205,
				items: [{ name: "Sundered Sky" }, { name: "Death's Dance" }, { name: "Mercury's Treads" }]
			}),
			recentEvents: [],
			unseen: ["Baron is back in 35s"]
		}
	}
]

/* ---------------------------------------------------------------- scoring */

/**
 * Items a coach reaches for unprompted. Not a Riot list and not meant to be one — it only has to
 * contain the names a model would plausibly complete a build with, since the failure being
 * measured is a name spoken that the block never contained.
 */
const ITEM_LEXICON = [
	"Liandry's", "Riftmaker", "Zhonya's", "Rabadon's", "Shadowflame", "Cosmic Drive", "Horizon Focus",
	"Void Staff", "Morellonomicon", "Demonic Embrace", "Rylai's", "Sorcerer's Shoes", "Ionian Boots",
	"Mercury's Treads", "Plated Steelcaps", "Banshee's", "Mejai's", "Malignance", "Stormsurge",
	"Blackfire", "Nashor's", "Lich Bane", "Dark Seal", "Doran's", "Control Ward", "Oracle Lens",
	"Farsight", "Stealth Ward", "Gustwalker", "Mosstomper", "Scorchclaw", "Bami's", "Sunfire",
	"Jak'Sho", "Heartsteel", "Thornmail", "Randuin's", "Force of Nature", "Spirit Visage", "Warmog's",
	"Sundered Sky", "Trinity Force", "Eclipse", "Youmuu's", "Profane Hydra", "Ravenous Hydra",
	"Black Cleaver", "Sterak's", "Death's Dance", "Guardian Angel", "Maw of Malmortius",
	"Serpent's Fang", "Umbral Glaive", "Caulfield's", "Blasting Wand", "Fiendish Codex",
	"Needlessly Large Rod", "Amplifying Tome", "Long Sword", "Bloodsong", "Kindlegem", "Hextech Alternator"
]

/**
 * A purchase claim about an item this message did not mark.
 *
 * Found by this probe on its second run: two turns after the block marked Death's Dance
 * "(just bought)", the coach said Viego "just bought Mercury's Treads", which nothing had marked.
 * The phrase itself leaked out of the block and attached to whatever looked newest — the same
 * failure as a stale respawn timer, and invisible to every other check here.
 */
const PURCHASE_VERB = /\bjust (bought|finished|picked up|completed|got)\b/i

const PRICE_OR_TIMING =
	/\b(cost|costs|costed|for \d{3,}\s?g|\d{3,}\s?gold for|bought (it|that|them)|you bought|he bought|just picked up|since you bought)\b/i

/**
 * Naming an item the block never mentioned is only a defect when it is a claim about the GAME.
 *
 * "Finish a Liandry's" is advice about a purchase he has not made, which the block explicitly
 * allows and which is the whole point of carrying builds at all. "You have Liandry's" is a
 * fabricated possession. The two are one word apart in the transcript and worlds apart as
 * failures, so they are counted separately rather than lumped into one number that would make a
 * working coach look broken.
 */
const POSSESSION =
	/\b(you (already )?have|he (already )?has|holds?|is holding|owns|has got)\b[^.,;]{0,20}$/i

const scoreLine = (text: string, block: string) => {
	const offBlock = ITEM_LEXICON.filter(
		i => text.toLowerCase().includes(i.toLowerCase()) && !block.includes(i)
	)
	const sentenceWith = (item: string) =>
		text.split(/(?<=[.!?])\s+/).find(sn => sn.toLowerCase().includes(item.toLowerCase())) ?? text
	/*
	 * Possession is judged on the words immediately BEFORE the item, not anywhere in the sentence.
	 *
	 * Run 3 flagged "You have 2600g; you could finish your Liandry's with that" as a fabricated
	 * possession because "You have" appeared eight words earlier. That line is buy advice, which
	 * the block explicitly permits — a checker that cannot tell the two apart would push a working
	 * coach into saying nothing at all.
	 */
	const runUpTo = (item: string) => {
		const sn = sentenceWith(item)
		const at = sn.toLowerCase().indexOf(item.toLowerCase())
		return at < 0 ? sn : sn.slice(0, at)
	}
	const named = ITEM_LEXICON.filter(i => text.toLowerCase().includes(i.toLowerCase()))
	return {
		stalePurchase: named.filter(i => {
			// The mark sits between the item's name and the next comma, so match that far and no
			// further — every inventory is one line, and a line-level check would let an unmarked
			// item borrow the mark from the item beside it.
			const marked = new RegExp(`${i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^,]*\\(just bought\\)`)
			return PURCHASE_VERB.test(sentenceWith(i)) && !marked.test(block)
		}),
		fabricatedPossession: offBlock.filter(i => POSSESSION.test(runUpTo(i))),
		adviseUnlisted: offBlock.filter(i => !POSSESSION.test(runUpTo(i))),
		priceOrTiming: PRICE_OR_TIMING.test(text),
		unbackedNumbers: [...text.matchAll(/\b(\d{2,})\b/g)].map(m => m[1]!).filter(n => !block.includes(n))
	}
}

/* ----------------------------------------------------------------- socket */

const run = async () => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")
	const frame = someFrame()

	const mint = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
		method: "POST",
		headers: { "x-goog-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({ uses: 1 })
	})
	const token = ((await mint.json()) as { name?: string }).name
	if (!token) throw new Error("could not mint a token")

	await new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(
			`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`
		)
		let i = -1
		let partial = ""
		let promptTokens = 0

		const next = () => {
			i++
			const turn = TURNS[i]
			if (!turn) {
				ws.close()
				resolve()
				return
			}
			const block = renderState(turn.state)
			const parts: unknown[] = [{ inlineData: { mimeType: "image/jpeg", data: frame } }, { text: block }]
			if (turn.ask) parts.push({ text: `He just said out loud: "${turn.ask}"` })
			ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: GEMINI_LIVE_MODEL,
						generationConfig: { responseModalities: ["AUDIO"] },
						outputAudioTranscription: {},
						systemInstruction: { parts: [{ text: LIVE_COACH_SYSTEM_PROMPT }] }
					}
				})
			)

		ws.onmessage = async ev => {
			const m = JSON.parse(
				typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			) as {
				setupComplete?: unknown
				usageMetadata?: { promptTokenCount?: number }
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string }[] }
				}
			}
			if (m.usageMetadata?.promptTokenCount) promptTokens = m.usageMetadata.promptTokenCount
			if (m.setupComplete) {
				next()
				return
			}
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) if (p.text) partial += p.text
			if (sc.turnComplete) {
				const turn = TURNS[i]!
				const text = partial.trim()
				const marks = scoreLine(text, renderState(turn.state))
				console.log(`\n--- ${turn.state.clock}  (${turn.why})`)
				if (turn.ask) console.log(`HE ASKED: ${turn.ask}`)
				console.log(`SAID: ${text || "(silence)"}`)
				console.log(
					`  FABRICATED possession: ${marks.fabricatedPossession.join(", ") || "none"} · UNMARKED purchase claim: ${
						marks.stalePurchase.join(", ") || "none"
					} · advises an unlisted item (allowed): ${
						marks.adviseUnlisted.join(", ") || "none"
					} · price/timing claim: ${marks.priceOrTiming ? "YES" : "no"} · numbers not in block: ${
						marks.unbackedNumbers.join(", ") || "none"
					} · prompt tokens: ${promptTokens}`
				)
				partial = ""
				next()
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => (e.code === 1000 ? resolve() : reject(new Error(`closed ${e.code}`)))
		setTimeout(() => {
			ws.close()
			resolve()
		}, 180_000)
	})
}

await run()
