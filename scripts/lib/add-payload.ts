/**
 * THREE CANDIDATE ADDITIONS to the payload, applied after it is rendered so they can be measured
 * before anything is written into `live-brief.ts`.
 *
 * Same discipline as `trim-payload.ts` and for the same reason: the shipped brief is what every
 * stored measurement was taken on, and a candidate that has not beaten it is a guess. Each preset
 * states the demand it was nominated by, from `data/eval/context-feed-20260918.md` (3,649
 * blind-judged lines, five corpora).
 *
 * **None of them tells the model what to say.** Two are arithmetic the app can do exactly and the
 * model cannot do from prose; the third is a statement about what the feed does NOT contain, which
 * is the one kind of editorial `live-brief.ts` already carries and the only one that has ever
 * measurably stopped an invention (the enemy-CS refusal).
 */

import { nextSpike } from "../../src/shared/items.ts"
import { dragonName } from "../../src/shared/dragons.ts"
import type { LiveAllGameData, LivePlayer } from "../../src/shared/schema/live.ts"

export interface Add {
	id: string
	what: string
	/** The demand that nominated it, so a run file carries its own justification. */
	why: string
	spend: boolean
	buffs: boolean
	spells: boolean
}

export const ADDS: Record<string, Add> = {
	spend: {
		id: "spend",
		what: "WHAT YOUR GOLD BUYS — the recipe join, from item-table.ts",
		why: "gold/recall is the 2nd-largest subject at 1,225 graded lines and item/build runs 20% false [17-23]; on 21% of sampled turns he could already afford a finished item and the payload never says so. `nextSpike` already feeds the board and `live-brief.ts` does not import `items.ts` at all.",
		spend: true,
		buffs: false,
		spells: false
	},
	buffs: {
		id: "buffs",
		what: "OBJECTIVE BUFFS — who took Baron/Elder and when, and that the buff itself is not in the feed",
		why: "85 graded lines assert a Baron or Elder buff, 32% of them false, and every `buff` string in every stored payload is the memory section quoting the coach back to itself.",
		spend: false,
		buffs: true,
		spells: false
	},
	spells: {
		id: "spells",
		what: "one clause saying a summoner-spell cooldown is in this feed for nobody",
		why: "smite is the worst subject in the corpus — 71 lines, 42% false [31-54], 27% [17-40] after the death-phrasing correction — and every false one claims a cooldown. The spell NAME is rendered on 750 of 851 payloads; nothing says the cooldown is not.",
		spend: false,
		buffs: false,
		spells: true
	},
	all: {
		id: "all",
		what: "all three candidate additions",
		why: "the whole recommended addition set, so one arm prices the package",
		spend: true,
		buffs: true,
		spells: true
	}
}

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

const age = (sec: number): string =>
	sec < 60 ? `${Math.round(sec)}s ago` : `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, "0")}s ago`

const meOf = (data: LiveAllGameData): LivePlayer | null => {
	const id = data.activePlayer?.riotId ?? data.activePlayer?.summonerName ?? ""
	if (id === "") return null
	return data.allPlayers?.find(p => (p.riotId ?? p.summonerName ?? "") === id) ?? null
}

/**
 * What he is closest to finishing and what is left to pay.
 *
 * `nextSpike` keeps only finished items and boots, and orders by what he has already SUNK rather
 * than by what is left — both measured decisions that live in `shared/items.ts` with the games they
 * were made on. Nothing here decides whether that is worth a sentence.
 */
export const spendBlock = (data: LiveAllGameData): string | null => {
	const me = meOf(data)
	if (me === null) return null
	const ids = (me.items ?? []).map(i => i.itemID).filter((n): n is number => typeof n === "number")
	const gold = Math.round(data.activePlayer?.currentGold ?? 0)
	const best = nextSpike(ids)
	if (best === null)
		return [
			"WHAT YOUR GOLD BUYS — from Riot's own recipes, not from the item rows' price",
			`Gold in hand ${gold}. Nothing he is holding feeds a finished item or boots, so there is no part-paid recipe to name.`
		].join("\n")
	const short = best.remaining - gold
	return [
		"WHAT YOUR GOLD BUYS — from Riot's own recipes, not from the item rows' price",
		`Gold in hand ${gold}. Closest finished item by what he has already sunk into it: ${best.name}, ${best.remaining}g left to pay of ${best.total}g. ${short <= 0 ? "HE CAN AFFORD IT NOW." : `He is ${short}g short.`}`,
		`Already inside that recipe: ${best.have.join(", ") || "nothing yet"}. Still to buy: ${best.missing.join(", ") || "nothing — it completes on purchase"}.`,
		"This is the only gold arithmetic in this payload. What he has SPENT is still not knowable from this feed, and no enemy's gold exists in it at all."
	].join("\n")
}

/**
 * Who took Baron or Elder and when — and, in the same breath, that the BUFF is not in this feed.
 *
 * The duration is deliberately not stated. `objective-stakes.ts` commits to standard RESPAWN times
 * because the events that start them are in the log and can be checked against it; a buff's length
 * is a patch value with nothing in this app that can verify it, which is the same reason the grub
 * respawn cadence is refused in `objectiveBlock`.
 */
export const buffBlock = (data: LiveAllGameData, nowSec: number): string | null => {
	const me = meOf(data)
	const mine = me?.team ?? null
	const named = (who: string | undefined): LivePlayer | undefined =>
		who === undefined ? undefined
		:	data.allPlayers?.find(p => p.riotIdGameName === who || p.riotId === who || p.summonerName === who)
	const lines: string[] = []
	for (const kind of ["Baron", "Elder"] as const) {
		const hits = (data.events?.Events ?? []).filter(e =>
			kind === "Baron" ?
				e.EventName === "BaronKill"
			:	e.EventName === "DragonKill" && dragonName(e.DragonType) === "Elder"
		)
		const last = hits[hits.length - 1]
		if (last === undefined || typeof last.EventTime !== "number") continue
		const killer = named(last.KillerName)
		const side =
			killer === undefined || mine === null ? "a side this feed will not resolve"
			: killer.team === mine ? "YOUR team"
			: "THEIR team"
		lines.push(`${kind} was taken by ${side} at ${clock(last.EventTime)} (${age(nowSec - last.EventTime)}).`)
	}
	if (lines.length === 0) return null
	return [
		"OBJECTIVE BUFFS",
		...lines,
		"This feed reports no buff on anybody, so whether either of those is still running is NOT in this payload, and how long one lasts is a patch value this app cannot check. Do not put a clock on it."
	].join("\n")
}

export const SPELL_NOTE =
	"Summoner spell COOLDOWNS are in this feed for nobody, him included. The names above are what he PICKED, never what he has up: nothing here says whether his Smite or his Flash is available, and nothing anywhere in this payload does."

/** The payload with `add` applied. `null` returns it untouched, so control and shipped path agree. */
export const addToPayload = (text: string, add: Add | null, data: LiveAllGameData, nowSec: number): string => {
	if (add === null || text === "") return text
	const out: string[] = []
	let placedSpend = false
	let placedBuffs = false
	for (const section of text.split("\n\n")) {
		const head = section.split("\n")[0] ?? ""
		if (add.spells && head.startsWith("ENEMY JUNGLER —") && section.includes("Summoners:"))
			out.push(`${section}\n${SPELL_NOTE}`)
		else out.push(section)
		/* The gold join sits directly under the section that carries the gold figure it joins. */
		if (add.spend && head.startsWith("YOU —")) {
			const block = spendBlock(data)
			if (block !== null) out.push(block)
			placedSpend = true
		}
		/* The buff block sits with the rest of the map's schedule. */
		if (add.buffs && head.startsWith("OBJECTIVES")) {
			const block = buffBlock(data, nowSec)
			if (block !== null) out.push(block)
			placedBuffs = true
		}
	}
	/*
	 * A DELTA payload has neither anchor, and an addition that silently vanishes on the turns the
	 * app actually sends would make the arm a different schedule rather than a different payload.
	 * So an unplaced block goes at the end rather than nowhere.
	 */
	if (add.spend && !placedSpend) {
		const block = spendBlock(data)
		if (block !== null) out.push(block)
	}
	if (add.buffs && !placedBuffs) {
		const block = buffBlock(data, nowSec)
		if (block !== null) out.push(block)
	}
	return out.join("\n\n")
}

/** The addition named by an arm modifier such as `add-spend`, or null when the arm carries none. */
export const addFromMods = (mods: readonly string[]): Add | null => {
	for (const mod of mods) {
		if (!mod.startsWith("add-")) continue
		const add = ADDS[mod.slice(4)]
		if (add === undefined) throw new Error(`unknown addition ${mod} — one of ${Object.keys(ADDS).map(k => "add-" + k).join(", ")}`)
		return add
	}
	return null
}
