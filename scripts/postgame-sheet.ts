/**
 * postgame-sheet — ONE blinded grading sheet for the five whole-game reviews of 5639406342.
 *
 * The live coach scored 0/10 on this game ("nothing it said was useful, it was generic and often
 * hilariously wrong"). Five models were then given the SAME pack — the same 5s live feed, the same
 * event log, the same minimap position track, the same sixteen journal frames — and asked for a
 * whole-game review. The only thing that varied between the five is the model. This file turns
 * their thirty-seven feedback items into one page he can grade card by card, without knowing which
 * model wrote which.
 *
 * WHAT IS DELIBERATELY NOT ON THE CARD:
 *
 *   - the arm and the model. They live in the key file and nowhere else.
 *   - the latency. One arm took 5m30s and another 43s; printed on a card that is a model label
 *     written in milliseconds, and every card from that arm carries it.
 *   - the automated verification's verdict on the item. A machine pass already read all
 *     thirty-seven and flagged nine; putting that on the card tells him which ones an automated
 *     check liked and turns his grading into agreement with a checker whose own accuracy is the
 *     thing in question. His number is the measurement. The checker's is a second opinion, and it
 *     is read AFTER, from the key.
 *   - the model's own `usedPositions` / `couldNotHaveSeenLive` self-report. A model's claim about
 *     its own work is not evidence and it groups cards by arm.
 *
 * WHAT IS ON THE CARD: the item's clock, its title, its fix, its reasoning, and the journal frame
 * nearest its own timestamp — big, because the frame is how a claim about that instant is checked
 * by eye. Behind the disclosure: what the item said it was citing, the pack's own state at that
 * clock (the live feed's sample, the minimap reads, the events, what the live coach was saying),
 * his twenty-game averages, and the EXACT position from the ingested post-game timeline, which is
 * the only channel here that can settle "he was standing in X" and which no review was given.
 *
 * Reads `data/eval/` and `data/blobs/`, writes two files into `data/eval/`. Touches no LCU
 * endpoint, no daemon, no game client.
 *
 * Usage:
 *   node --experimental-strip-types scripts/postgame-sheet.ts
 *   node --experimental-strip-types scripts/postgame-sheet.ts --reveal <key.json> <verdicts.json>
 */

import { readFileSync, writeFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { shuffled } from "./blind-judge.ts"
import { renderKey, renderSheet, revealVerdicts } from "./lib/sheet.ts"
import type { SheetLine } from "./lib/sheet.ts"

const argv = process.argv.slice(2)

const ROOT = "/home/ssalb/eepalytics"

/*
 * The game is a flag rather than a constant because this file is now the ONLY blinded sheet
 * builder for post-game reviews: the two that existed before it differed in nothing but the arm
 * list and the store-key prefix, which is how the same question got measured twice.
 */
const flagOf = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (argv[i + 1] ?? fallback)
}

const GAME = Number(flagOf("game", "5639406342"))
const SESSION = flagOf("session", "js-mtvxb5f4-f81a")
const HIM = flagOf("him", "2")
const MAP_W = 14870
const MAP_H = 14980

/** The five arms, named by their file. The order here is the LOAD order and is not the sheet order. */
/*
 * The five arms of the blinded model comparison, by default — the run whose verdicts are on disk.
 *
 * Overridable with `--arms a,b`, because a re-run against a CORRECTED pack is a different
 * experiment and must not be pooled with the original by editing this list. Each name is the
 * `postgame-<arm>.json` the arm script wrote.
 */
const armsArg = argv.indexOf("--arms")
const ARMS =
	armsArg >= 0 && argv[armsArg + 1] !== undefined ?
		argv[armsArg + 1]!.split(",").map(a => a.trim()).filter(a => a !== "")
	:	["anthropic-opus", "anthropic-sonnet", "openai-gpt5", "gemini-flash", "gemini-pro"]

/* ------------------------------------------------------------------- reveal */

if (argv[0] === "--reveal") {
	const [keyPath, verdictPath] = [argv[1], argv[2]]
	if (!keyPath || !verdictPath)
		throw new Error("--reveal takes two paths: the key this run wrote, and your exported verdicts")
	console.log(revealVerdicts(readFileSync(keyPath, "utf8"), readFileSync(verdictPath, "utf8")))
	process.exit(0)
}

/* -------------------------------------------------------------------- input */

const read = (p: string): any => JSON.parse(readFileSync(p, "utf8"))

const pack = read(`${ROOT}/data/eval/pack-${GAME}.json`)
const timeline = JSON.parse(gunzipSync(readFileSync(`${ROOT}/data/blobs/${GAME}/timeline.json.gz`)).toString())

const clockOf = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

interface Item {
	arm: string
	title: string
	fix: string
	body: string | null
	evidence: string | null
	tSec: number | null
	latencyMs: number
}

const items: Item[] = ARMS.flatMap(arm => {
	const file = read(`${ROOT}/data/eval/postgame-${arm}.json`)
	const parsed = file.parsed
	if (!parsed || !Array.isArray(parsed.items)) throw new Error(`${arm}: no parsed.items`)
	return parsed.items.map((it: any) => ({
		arm,
		title: String(it.title ?? "").trim(),
		fix: String(it.fix ?? "").trim(),
		body: it.body ? String(it.body).trim() : null,
		evidence: it.evidence ? String(it.evidence).trim() : null,
		tSec: typeof it.tSec === "number" ? it.tSec : null,
		latencyMs: file.latencyMs ?? 0
	}))
})

/* --------------------------------------------------------- the clock it means */

/**
 * A whole-game item still gets a picture.
 *
 * One of the thirty-seven has `tSec: null` — a pattern across four deaths — and a card with no
 * frame reads as a card with less evidence behind it, which is a difference between arms that
 * nobody intended. Its own text names four clocks, so the picture is the FIRST one it names and
 * the block says so in its first line. Guessing a clock it did not name would be worse than no
 * picture; using one it did name is just reading it.
 */
const firstClockIn = (text: string): number | null => {
	const m = /\b(\d{1,2}):([0-5]\d)\b/.exec(text)
	return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const pictureSec = (it: Item): number | null =>
	it.tSec ?? firstClockIn(`${it.title} ${it.fix} ${it.body ?? ""}`)

/* --------------------------------------------------------------- the channels */

const nearestBy = <T,>(rows: readonly T[], t: number, of: (r: T) => number): T =>
	rows.reduce((best, r) => (Math.abs(of(r) - t) < Math.abs(of(best) - t) ? r : best))

const within = <T,>(rows: readonly T[], t: number, span: number, of: (r: T) => number): T[] =>
	rows.filter(r => Math.abs(of(r) - t) <= span)

/** Exact once-per-minute positions from the ingested timeline. NO review was shown these. */
const truePositions: { tSec: number; x: number; y: number }[] = timeline.frames.map((f: any) => ({
	tSec: Math.round(f.timestamp / 1000),
	x: f.participantFrames[HIM].position.x,
	y: f.participantFrames[HIM].position.y
}))

/** Exact event positions for anything he was credited on — the only unambiguous anchors there are. */
const trueEvents: { tSec: number; x: number; y: number; what: string }[] = []
for (const f of timeline.frames)
	for (const e of f.events)
		if (e.position && (e.killerId === 2 || e.victimId === 2 || (e.assistingParticipantIds ?? []).includes(2)))
			trueEvents.push({
				tSec: Math.round(e.timestamp / 1000),
				x: e.position.x,
				y: e.position.y,
				what:
					e.victimId === 2 ? "HE DIED here"
					: e.killerId === 2 ? "HIS kill/take here"
					: "his assist here"
			})

const asPct = (x: number, y: number): string =>
	`${((x / MAP_W) * 100).toFixed(1)}% from the left, ${((1 - y / MAP_H) * 100).toFixed(1)}% from the top`

const BASELINE_KEYS = [
	"cs@10",
	"cs@14",
	"cs@20",
	"csPerMin",
	"kills",
	"deaths",
	"assists",
	"killParticipation",
	"visionPerMin",
	"eliteControlPct",
	"elitesSecuredByUser",
	"goldLostToDeaths",
	"enemyJungleShare",
	"enemyHalfPct",
	"goldDelta@10",
	"xpDelta@10"
]

const endOfGame = (): string => {
	const h = pack.game.hisLine
	return (
		`  Lillia ${h.kda}, ${h.cs} CS (${h.csDetail}), ${h.gold}g, vision ${h.visionScore}, ` +
		`level ${h.champLevel}, ${h.damageToChampions} damage to champions. ` +
		`${pack.game.durationClock}, ${pack.game.result}.`
	)
}

const blockFor = (it: Item): string => {
	const out: string[] = []
	const t = it.tSec
	const pic = pictureSec(it)

	if (t === null)
		out.push(
			"WHOLE-GAME ITEM — it names no single clock, so there is no one instant to check it at. " +
				`The picture above is the first clock its own text names (${pic === null ? "none" : clockOf(pic)}); ` +
				"everything below is the state at that clock."
		)

	const at = t ?? pic

	if (at !== null) {
		const s = nearestBy(pack.spine, at, (x: any) => x.tSec)
		out.push("")
		out.push(
			`THE LIVE FEED'S OWN SAMPLE nearest ${clockOf(at)} — it is at ${s.clock}. His CS is floored to tens; ` +
				"every Kayn figure is AS LAST SEEN and carries its age, never a present-tense fact:"
		)
		out.push(
			`  him: lvl ${s.me.level}, ${s.me.cs} CS (${s.me.csPerMin}/min), ${s.me.kills}/${s.me.deaths}/${s.me.assists}, ` +
				`HP ${s.me.hp} (${s.me.hpPct}%), mana ${s.me.mana} (${s.me.manaPct}%), ${s.me.goldInHand}g in hand, ` +
				`ward score ${s.me.wardScore}${s.me.dead ? `, DEAD (back in ${s.me.respawnSec}s)` : ""}`
		)
		out.push(`  his items: ${s.me.items.map((i: any) => i.name).join(", ") || "(none)"}`)
		out.push(
			`  Kayn as last seen: lvl ${s.counterpart.level}, ${s.counterpart.cs} CS, ` +
				`${s.counterpart.kills}/${s.counterpart.deaths}/${s.counterpart.assists}, ` +
				`items ${s.counterpart.items.map((i: any) => i.name).join(", ") || "(none)"}`
		)
		out.push(
			`  the age of that reading: level unchanged ${Math.round(s.counterpart.levelUnchangedSec)}s, ` +
				`CS unchanged ${Math.round(s.counterpart.csUnchangedSec)}s, ` +
				`items unchanged ${Math.round(s.counterpart.itemsUnchangedSec)}s`
		)
		out.push(
			`  his team: ${s.teams.his.players.map((p: any) => `${p.champion} ${p.level} ${p.cs}cs ${p.kda}`).join(" · ")}`
		)
		out.push(
			`  enemy as seen: ${s.teams.enemy.players.map((p: any) => `${p.champion} ${p.level} ${p.cs}cs ${p.kda}`).join(" · ")}`
		)

		const reads = within(pack.positionTrack.reads, at, 60, (r: any) => r.tSec)
		out.push("")
		out.push(
			`MINIMAP READS within 60s — model-read from the frames, ${pack.positionTrack.meta.ok} of ` +
				`${pack.positionTrack.meta.reads} passed the fence. It returns HIS icon and UNLABELLED red rings, ` +
				"so it cannot tell you which ring is Kayn:"
		)
		if (reads.length === 0) out.push("  (none — the track is blind at this clock)")
		for (const r of reads)
			out.push(
				`  ${r.clock} ${r.label} (${r.pct.left}% left, ${r.pct.top}% top) ${r.activity}, ` +
					`${r.enemyRings} red ring(s)` +
					`${r.handChecked ? ` — hand-checked, ${r.handErrorPct}% of the map off the human label` : ""}`
			)

		const anchor = nearestBy(truePositions, at, p => p.tSec)
		out.push("")
		out.push("EXACT POSITION, from the ingested post-game timeline — NO review was given this channel:")
		out.push(
			`  at ${clockOf(anchor.tSec)} (${anchor.tSec - at >= 0 ? "+" : ""}${(anchor.tSec - at).toFixed(0)}s from this clock) ` +
				`he was at (${anchor.x}, ${anchor.y}) — ${asPct(anchor.x, anchor.y)}. Blue base is bottom-left.`
		)
		for (const e of within(trueEvents, at, 45, x => x.tSec))
			out.push(`  ${clockOf(e.tSec)} ${e.what}: (${e.x}, ${e.y}) — ${asPct(e.x, e.y)}`)

		const evs = within(pack.events, at, 45, (e: any) => e.tSec).filter((e: any) => e.name !== "MinionsSpawning")
		out.push("")
		out.push("EVENTS within 45s:")
		if (evs.length === 0) out.push("  (none)")
		for (const e of evs)
			out.push(
				`  ${e.clock} ${e.name} ${e.killer ?? ""}${e.victim ? ` -> ${e.victim}` : ""}` +
					`${e.dragonName ? ` ${e.dragonName}` : ""}${e.turret ? " (a turret)" : ""}` +
					`${e.assisters.length ? ` [assists: ${e.assisters.join(", ")}]` : ""}${e.involvesHim ? "   <- HIM" : ""}`
			)

		const said = within(pack.liveCoach.lines, at, 60, (l: any) => l.tSec)
		out.push("")
		out.push("WHAT THE LIVE COACH SAID within 60s — the 0/10 pass, here only so a post-game item that")
		out.push("merely repeats it is visible as such:")
		if (said.length === 0) out.push("  (it said nothing in this window)")
		for (const l of said) out.push(`  ${l.clock} "${l.text}"`)
	}

	out.push("")
	out.push("HIS OWN 20-GAME AVERAGES — every one is a MEAN over recent games, this game excluded:")
	for (const k of BASELINE_KEYS) {
		const b = pack.baselines.stats[k]
		if (b) out.push(`  ${k}: ${Number(b.mean.toFixed(2))} (n=${b.n})`)
	}

	out.push("")
	out.push("END OF GAME, from the INGESTED MATCH (exact — the spine above is the live feed and will not agree):")
	out.push(endOfGame())

	out.push("")
	out.push(
		"WHAT NO CHANNEL HERE KNOWS: who was in vision of whom, whether smite was up, what his team was " +
			"calling, where Kayn was at any instant (the reader returns unlabelled red rings), his cooldowns " +
			"except where a frame shows the bar, or why he did any of it."
	)
	return out.join("\n")
}

/* ------------------------------------------------------------------- the frame */

const frameFor = (sec: number | null): { b64: string | null; skewMs: number | null; clock: string | null } => {
	if (sec === null) return { b64: null, skewMs: null, clock: null }
	const f = nearestBy(pack.frames, sec, (x: any) => x.tSec)
	try {
		return {
			b64: readFileSync(f.path).toString("base64"),
			skewMs: Math.round((f.tSec - sec) * 1000),
			clock: f.clock
		}
	} catch {
		return { b64: null, skewMs: null, clock: null }
	}
}

/* -------------------------------------------------------------------- the sheet */

/**
 * The ids are assigned AFTER the shuffle.
 *
 * `renderSheet` shuffles again for display, but the id is printed on the card and travels into the
 * exported verdicts — numbering in load order would make L01-L08 one model and L09-L15 the next,
 * recoverable by anyone who sorted the export. A blind that only holds while nobody sorts is not a
 * blind. The seed is the game id, so re-rendering the same game numbers the cards the same way and
 * a half-finished grading session still lines up.
 */
const lines: SheetLine[] = shuffled(items, GAME).map((it, n) => {
	const pic = pictureSec(it)
	const { b64, skewMs, clock } = frameFor(pic)
	return {
		id: `L${String(n + 1).padStart(2, "0")}`,
		armKey: it.arm,
		clock: it.tSec === null ? `whole game · picture at ${clock ?? "n/a"}` : clockOf(it.tSec),
		atSec: it.tSec ?? pic ?? 0,
		text: `${it.title}\n\nFIX — ${it.fix}` + (it.body ? `\n\n${it.body}` : ""),
		latencyMs: it.latencyMs,
		block: blockFor(it),
		offered:
			it.evidence ?
				[it.evidence]
			:   ["this item named no evidence — the review was asked for one and this one left it empty"],
		frameB64: b64,
		windowId: SESSION,
		skewMs
	}
})

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const storeKey = `postgame-models-${GAME}-${stamp}`
const sheetPath = `${ROOT}/data/eval/${storeKey}-sheet.html`
const keyPath = `${ROOT}/data/eval/${storeKey}-key.json`

writeFileSync(
	sheetPath,
	renderSheet(lines, {
		storeKey,
		title: `post-game reviews · ${GAME} · ${lines.length} items`,
		note:
			`Every card is ONE feedback item from a whole-game review of ${GAME} — Lillia jungle vs Kayn, 28:14, ` +
			`loss, the game the live coach scored 0/10 on. Five reviews wrote these; each was given the same pack ` +
			`and the same sixteen frames, and which one wrote which card is not on this page, nor is how long any ` +
			`of them took. The picture is the journal frame nearest the item's own clock — click it for full size. ` +
			`Press b for the disclosure: what the item said it was citing, the live feed's sample at that clock, ` +
			`the minimap reads, the events, what the live coach was saying, his own averages, and the exact ` +
			`position from the post-game timeline, which no review was given. Grade what the item is worth to you ` +
			`between games.`,
		labels: {
			summary: "what it cited, and the pack's own state at that clock",
			offered: "what this item said it was citing (its own words)",
			block: "the pack at that clock — what actually happened",
			offeredEmpty: "(this item named no evidence)"
		}
	})
)
/**
 * The key gets one field the renderer does not write: which model each arm actually was, and what
 * it cost.
 *
 * `revealVerdicts` prints the arm name, and "anthropic-opus" is not the same statement as
 * "claude-opus-5 at 5m30s for eight items". Those two facts are the point of the exercise and they
 * are on disk in five separate run files; putting them in the key means the reveal is one command
 * and not a scavenger hunt. Extra top-level fields are ignored by the reveal's parser, which reads
 * `rows` and nothing else.
 */
const key = JSON.parse(renderKey(lines, storeKey))
key.arms = Object.fromEntries(
	ARMS.map(arm => {
		const file = read(`${ROOT}/data/eval/postgame-${arm}.json`)
		return [
			arm,
			{
				provider: file.provider,
				model: file.model ?? file.modelUsed ?? file.modelRequested,
				framesSent: file.framesSent,
				latencyMs: file.latencyMs,
				items: items.filter(i => i.arm === arm).length,
				cards: lines.filter(l => l.armKey === arm).map(l => l.id)
			}
		]
	})
)
writeFileSync(keyPath, `${JSON.stringify(key, null, 1)}\n`)

const withFrame = lines.filter(l => l.frameB64 !== null).length
console.log(`wrote ${sheetPath}`)
console.log(`  ${lines.length} cards, ${withFrame} carry a journal frame`)
console.log(`wrote ${keyPath}   (the key — do not open it before grading)`)
for (const arm of ARMS) console.log(`  ${arm}: ${items.filter(i => i.arm === arm).length} items`)
console.log(
	`\nreveal:  node --experimental-strip-types scripts/postgame-sheet.ts --reveal ${keyPath} <your-verdicts.json>`
)
