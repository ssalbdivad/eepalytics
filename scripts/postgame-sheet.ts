/**
 * postgame-sheet — one blinded grading sheet for the three POST-GAME review arms of 5639406342.
 *
 * The live coach was graded 0/10 for this game, so three whole-game reviews were written against
 * the same match and the question is whether any of them is worth reading. The three arms differ
 * only in what they were allowed to look at:
 *
 *   incumbent    the shipped digest — post-game timeline only, positions INTERPOLATED between
 *                once-per-minute frames, no live feed, no pictures.
 *   text-only    the review pack — the 5s live feed, the event log, and the MINIMAP POSITION
 *                TRACK, as text. No pictures.
 *   with-frames  the same pack, plus twelve journal JPEGs the model asked for by name.
 *
 * Blinding is the whole point and is done exactly the way `bench-stream` does it: `renderSheet`
 * shuffles on a seed derived from the ids alone, the arm lives only in the key file, and latency
 * — which is an arm label written in milliseconds, since one arm made two round trips — never
 * reaches the page.
 *
 * The card's block is NOT the prompt the arm saw. It is the ground truth for that instant,
 * assembled from three channels that disagree on purpose: the live feed's own 5s sample, the
 * minimap track's reads, and the post-game timeline's EXACT positions (which no arm was given,
 * and which is the only channel that can settle a claim about where he stood). The frame is the
 * journal shot nearest the item's own timestamp.
 *
 * Writes to `data/eval/` only. Reads nothing else; touches no daemon, no LCU, no game client.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { shuffled } from "./blind-judge.ts"
import { renderKey, renderSheet } from "./lib/sheet.ts"
import type { SheetLine } from "./lib/sheet.ts"

const ROOT = "/home/ssalb/eepalytics"
const GAME = 5639406342
const SESSION = "js-mtvxb5f4-f81a"
const MAP_W = 14870
const MAP_H = 14980

const clockOf = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

const read = (p: string): any => JSON.parse(readFileSync(p, "utf8"))

const pack = read(`${ROOT}/data/eval/pack-${GAME}.json`)
const timeline = JSON.parse(gunzipSync(readFileSync(`${ROOT}/data/blobs/${GAME}/timeline.json.gz`)).toString())

/* ------------------------------------------------------------------ the items */

interface Item {
	arm: string
	title: string
	fix: string
	body: string | null
	tSec: number | null
	severity: string
	category: string
	cites: string[]
	latencyMs: number
}

const incumbentRaw = read(`${ROOT}/data/eval/incumbent-raw-${GAME}.json`)
const incumbent = JSON.parse(incumbentRaw.text)
const textOnly = read(`${ROOT}/data/eval/review-textonly-${GAME}.json`)
const withFrames = read(`${ROOT}/data/eval/postgame-with-frames-final.json`)

const items: Item[] = [
	...incumbent.items.map((it: any) => ({
		arm: "incumbent",
		title: it.title,
		fix: it.fix,
		body: it.body ?? null,
		tSec: it.tSec,
		severity: it.severity,
		category: it.category,
		cites: [...(it.momentIds ?? []), ...(it.metricKeys ?? [])],
		latencyMs: incumbentRaw.latencyMs
	})),
	...textOnly.review.items.map((it: any) => ({
		arm: "text-only",
		title: it.title,
		fix: it.fix,
		body: it.body ?? null,
		tSec: it.tSec,
		severity: it.severity,
		category: it.category,
		cites: [...(it.momentIds ?? []), ...(it.metricKeys ?? [])],
		latencyMs: textOnly.latencyMs
	})),
	...withFrames.review.items.map((it: any) => ({
		arm: "with-frames",
		title: it.title,
		fix: it.fix,
		body: it.body ?? null,
		tSec: it.tSec,
		severity: it.severity,
		category: it.category,
		cites: [...(it.momentIds ?? []), ...(it.metricKeys ?? [])],
		latencyMs: withFrames.totalMs
	}))
]

/* ------------------------------------------------------------- the block text */

const spineAt = (t: number): any =>
	pack.spine.reduce((best: any, s: any) => (Math.abs(s.tSec - t) < Math.abs(best.tSec - t) ? s : best))

/** Rows from the pack are read back as `any` — this filter is a join on the clock, not a schema. */
const near = (rows: readonly any[], t: number, span: number): any[] =>
	rows.filter(r => Math.abs(r.tSec - t) <= span)

/** Exact once-per-minute positions from the post-game timeline. No arm was shown these. */
const truePositions: { tSec: number; x: number; y: number }[] = timeline.frames.map((f: any) => ({
	tSec: Math.round(f.timestamp / 1000),
	x: f.participantFrames["2"].position.x,
	y: f.participantFrames["2"].position.y
}))

/** Exact event positions for anything he was credited on — the only unambiguous anchors. */
const trueEvents: { tSec: number; x: number; y: number; what: string }[] = []
for (const f of timeline.frames)
	for (const e of f.events)
		if (
			e.position &&
			(e.killerId === 2 || e.victimId === 2 || (e.assistingParticipantIds ?? []).includes(2))
		)
			trueEvents.push({
				tSec: Math.round(e.timestamp / 1000),
				x: e.position.x,
				y: e.position.y,
				what: e.victimId === 2 ? "HE DIED here" : e.killerId === 2 ? "HIS kill/take here" : "his assist here"
			})

const asPct = (x: number, y: number): string =>
	`${((x / MAP_W) * 100).toFixed(1)}% from the left, ${((1 - y / MAP_H) * 100).toFixed(1)}% from the top`

const blockFor = (it: Item): string => {
	const out: string[] = []
	if (it.tSec === null) {
		out.push("WHOLE-GAME ITEM — no single clock to check it at.")
		out.push("")
		out.push("END OF GAME, from the ingested match (exact):")
		out.push(
			`  Lillia ${pack.game.hisLine.kda}, ${pack.game.hisLine.cs} CS (${pack.game.hisLine.csDetail}), ` +
				`${pack.game.hisLine.gold}g, vision ${pack.game.hisLine.visionScore}, level ${pack.game.hisLine.champLevel}, ` +
				`${pack.game.hisLine.damageToChampions} damage, ${pack.game.durationClock}, ${pack.game.result}.`
		)
	} else {
		const t = it.tSec
		const s = spineAt(t)
		out.push(`THE LIVE FEED'S OWN SAMPLE nearest ${clockOf(t)} (it is at ${s.clock}, floored CS, fog-gated enemy):`)
		out.push(
			`  him: lvl ${s.me.level}, ${s.me.cs} CS (${s.me.csPerMin}/min), ${s.me.kills}/${s.me.deaths}/${s.me.assists}, ` +
				`HP ${s.me.hp} (${s.me.hpPct}%), mana ${s.me.mana} (${s.me.manaPct}%), ${s.me.goldInHand}g in hand, ` +
				`ward score ${s.me.wardScore}${s.me.dead ? `, DEAD (back in ${s.me.respawnSec}s)` : ""}`
		)
		out.push(`  his items: ${s.me.items.map((i: any) => i.name).join(", ") || "(none)"}`)
		out.push(
			`  Kayn AS LAST SEEN: lvl ${s.counterpart.level}, ${s.counterpart.cs} CS, ` +
				`${s.counterpart.kills}/${s.counterpart.deaths}/${s.counterpart.assists} — ` +
				`that CS reading is ${Math.round(s.counterpart.csUnchangedSec)}s old, so it is a reading with an age, not a fact`
		)
		if (s.position)
			out.push(
				`  minimap track says: ${s.position.label} (${s.position.confidence} confidence, nearest read ` +
					`${s.position.gapSec.toFixed(1)}s away, activity "${s.position.activity}")`
			)
		else out.push("  minimap track: NO READ within range of this clock.")

		const anchor = truePositions.reduce((b, p) => (Math.abs(p.tSec - t) < Math.abs(b.tSec - t) ? p : b))
		out.push("")
		out.push("EXACT POSITION, from the post-game timeline — NO arm was given this:")
		out.push(
			`  at ${clockOf(anchor.tSec)} (${(anchor.tSec - t).toFixed(0)}s from this item) he was at (${anchor.x}, ${anchor.y}) — ` +
				`${asPct(anchor.x, anchor.y)}. Blue base is bottom-left.`
		)
		for (const e of near(trueEvents, t, 40))
			out.push(`  ${clockOf(e.tSec)} ${e.what}: (${e.x}, ${e.y}) — ${asPct(e.x, e.y)}`)

		const reads = near(pack.positionTrack.reads, t, 60)
		out.push("")
		out.push(`MINIMAP READS within 60s (model-read, ${pack.positionTrack.meta.ok}/${pack.positionTrack.meta.reads} passed the fence):`)
		if (reads.length === 0) out.push("  (none — the track is blind here)")
		for (const r of reads)
			out.push(
				`  ${r.clock} ${r.label} (${r.pct.left}%, ${r.pct.top}%) ${r.activity}` +
					`${r.handChecked ? ` — hand-checked, ${r.handErrorPct}% of the map off the human label` : ""}`
			)

		const evs = near(pack.events, t, 45).filter((e: any) => e.name !== "MinionsSpawning")
		out.push("")
		out.push("EVENTS within 45s:")
		if (evs.length === 0) out.push("  (none)")
		for (const e of evs)
			out.push(
				`  ${e.clock} ${e.name} ${e.killer ?? ""}${e.victim ? ` -> ${e.victim}` : ""}` +
					`${e.dragonName ? ` ${e.dragonName}` : ""}${e.turret ? " (a turret)" : ""}` +
					`${e.assisters.length ? ` [assists: ${e.assisters.join(", ")}]` : ""}${e.involvesHim ? "  <- HIM" : ""}`
			)
	}

	out.push("")
	out.push("HIS OWN 20-GAME AVERAGES (every figure is a mean, this game excluded):")
	for (const k of [
		"cs@10",
		"cs@14",
		"cs@20",
		"csPerMin",
		"deaths",
		"visionPerMin",
		"eliteControlPct",
		"elitesSecuredByUser",
		"goldLostToDeaths",
		"enemyJungleShare",
		"enemyHalfPct",
		"xpDelta@10"
	]) {
		const b = pack.baselines.stats[k]
		out.push(`  ${k}: ${Number(b.mean.toFixed(2))} (n=${b.n})`)
	}
	out.push("")
	out.push(
		"WHAT NO CHANNEL HERE KNOWS: who was in vision of whom, whether smite was up, what his team " +
			"was calling, where the enemy jungler was at any instant (the minimap reader returns unlabelled " +
			"red rings), or his cooldowns except where a frame shows the bar."
	)
	return out.join("\n")
}

/* ------------------------------------------------------------------- the frame */

const frameFor = (t: number | null): { b64: string | null; skewMs: number | null } => {
	if (t === null) return { b64: null, skewMs: null }
	const f = pack.frames.reduce((b: any, x: any) => (Math.abs(x.tSec - t) < Math.abs(b.tSec - t) ? x : b))
	try {
		return { b64: readFileSync(f.path).toString("base64"), skewMs: Math.round((f.tSec - t) * 1000) }
	} catch {
		return { b64: null, skewMs: null }
	}
}

/* -------------------------------------------------------------------- the sheet */

/**
 * The ids are assigned AFTER the shuffle, not before.
 *
 * `renderSheet` shuffles for display, but the id is printed on the card and travels into the
 * exported verdicts. Numbering the arms in the order they were loaded would have made L01-L07 one
 * arm and L15-L22 another, recoverable by anyone who sorted the export — a blind that only holds
 * while nobody looks at it is not a blind. The seed is the game id, so a re-render of the same
 * game produces the same numbering and a half-finished grading session still lines up.
 */
const lines: SheetLine[] = shuffled(items, GAME).map((it, n) => {
	const { b64, skewMs } = frameFor(it.tSec)
	return {
		id: `L${String(n + 1).padStart(2, "0")}`,
		armKey: it.arm,
		clock: it.tSec === null ? "whole game" : clockOf(it.tSec),
		atSec: it.tSec ?? 0,
		text:
			`${it.title}\n\n` +
			`FIX — ${it.fix}\n` +
			(it.body ? `\nWHY — ${it.body}\n` : "") +
			`\n[the review filed this as ${it.severity} · ${it.category}]`,
		latencyMs: it.latencyMs,
		block: blockFor(it),
		offered: it.cites.length
			? [`this item cited, by id, from what it was given: ${it.cites.join(", ")}`]
			: ["this item cited no moment or metric id — the pack it was written from does not require them"],
		frameB64: b64,
		windowId: SESSION,
		skewMs
	}
})

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const storeKey = `postgame-${GAME}-${stamp}`
const sheetPath = `${ROOT}/data/eval/${storeKey}-sheet.html`
const keyPath = `${ROOT}/data/eval/${storeKey}-key.json`

writeFileSync(
	sheetPath,
	renderSheet(lines, {
		storeKey,
		title: `post-game review · ${GAME} · ${lines.length} items`,
		note:
			`Every card below is ONE feedback item from a whole-game review of ${GAME} (Lillia jungle vs Kayn, ` +
			`28:14, loss) — the game the live coach scored 0/10 on. Three reviews wrote them; which one wrote ` +
			`which is not on this page, and neither is how long any of them took. Open the block (b) for the ` +
			`ground truth at that clock — the live feed's sample, the minimap track, AND the post-game ` +
			`timeline's exact position, which none of the three was given. The picture is the journal frame ` +
			`nearest the item's own timestamp. Grade what the item is worth to you between games.`
	})
)
writeFileSync(keyPath, renderKey(lines, storeKey))

const withF = lines.filter(l => l.frameB64 !== null).length
console.log(`wrote ${sheetPath}  (${lines.length} items, ${withF} carry a journal frame)`)
console.log(`wrote ${keyPath}  (the key — do not open it before grading)`)
for (const arm of ["incumbent", "text-only", "with-frames"])
	console.log(`  ${arm}: ${items.filter(i => i.arm === arm).length} items`)
