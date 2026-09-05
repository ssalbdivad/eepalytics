/**
 * What is in the picture that he is NOT already tracking, and is any of it worth a sentence?
 *
 * ## Why this exists
 *
 * `scripts/probe-vision.ts` established two things on the real socket, and they only make sense
 * together: the model READS the frame perfectly (the game clock, 6/6 exact, 1100 image tokens a
 * turn, against 0/6 and a plausible invention 6/6 with no image), and it IGNORES the frame
 * completely when coaching (14 turns with the JPEG against 14 without, identical blocks and the
 * shipped prompt: the speak-or-PASS decision matched on 13 of 14 and every spoken line in both
 * arms was derivable from the ground-truth block alone).
 *
 * The cause is architectural. `buildFacts` computes and RANKS every candidate line in TypeScript
 * and the prompt lets the model speak only from that list, so with no ranked fact computed from
 * pixels the picture cannot matter by construction. The fix is to rank frame facts beside the
 * client's. This probe is the question that comes BEFORE that fix: **which frame facts are worth
 * their tokens at all?**
 *
 * It is the "not visible, not generic" test from AGENTS.md applied to pixels, and it is deliberately
 * hostile to the obvious answers. His own health bar is the thing he is most certainly already
 * looking at; a coach that reads it back is the exact failure that made this product useless to
 * him. So every candidate has to clear a measured bar, not a plausible story.
 *
 * ## The three arms, and what each one can actually settle
 *
 *   census    offline    What the CLIENT already covers, how often it has anything to say, and
 *                        whether a frame-readable state predicts anything. No API calls.
 *   minimap   API        Can the model count champions on the minimap AT THE SHIPPED RESOLUTION?
 *                        Scored against a number it was never shown.
 *   extract   API        Every candidate frame fact over sampled frames, audited against the block
 *                        the coach was actually holding and against what happened next.
 *
 * ## The instrument that makes the minimap arm honest
 *
 * There is no ground truth for "where is the enemy jungler" in any channel this app has — that is
 * the whole reason the minimap is interesting. But there IS exact ground truth for a neighbouring
 * question, and it costs nothing: **living allies are ALWAYS drawn on the minimap.** So the number
 * of blue-ringed portraits must equal the client's own "Alive right now: N of yours", a figure the
 * model is not shown and that no human typed in. If it cannot count the icons it is allowed to see,
 * nothing it says about the icons it is guessing at is worth ranking.
 *
 * The enemy count gets the other half: a dead champion is not drawn, so `enemyIcons` may never
 * exceed the client's alive-enemy count. Exceeding it is not an error rate, it is a fabrication
 * rate, and it is measured the same way `probe-vision.ts` measures a confabulated clock.
 *
 * ## Where the frames and the states come from
 *
 * `journal_frame` — 1,323 JPEGs from six real games, written by the same `grabFrame()` the coach
 * sends (1536 wide, JPEG q0.72), each stamped with the live game clock and 1,319 of them carrying
 * the exact ground-truth block the coach was holding at that instant. The block is parsed back into
 * a state here rather than re-derived, so the census is a record of what the coach KNEW.
 *
 * One caveat that has to be stated because it would otherwise silently mislead: those stored blocks
 * were rendered by an OLDER `buildFacts` — they say "camps" where today's says "CS", and they carry
 * per-champion respawn lines the shipped ranker has since deleted. So the census reports the RATE at
 * which the coach had something to say, and `--replay` re-measures that rate through TODAY's code
 * over `data/live-samples/split-*.ndjson` as the control. Both are reported; they agree to within
 * two points.
 *
 * Run it:
 *
 *   EEPALYTICS_DATA_DIR=/path/to/data node --experimental-strip-types scripts/probe-attention.ts
 *   EEPALYTICS_DATA_DIR=... node --experimental-strip-types scripts/probe-attention.ts --replay
 *   EEPALYTICS_DATA_DIR=... node --experimental-strip-types scripts/probe-attention.ts --minimap 16
 *   EEPALYTICS_DATA_DIR=... node --experimental-strip-types scripts/probe-attention.ts --extract 40 --out data/eval/attention.json
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "../src/shared/constants.ts"
import { geminiKey } from "../src/review/gemini-live.ts"

/* ------------------------------------------------------------ flags */

const argv = process.argv.slice(2)
const flag = (name: string, fallback = ""): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/**
 * The model that does the LOOKING, which is deliberately not the model that does the COACHING.
 *
 * A vision pre-pass is a separate call whose output is a ranked fact, so it is free to be a cheap
 * text-out model rather than the native-audio socket. Measured here: one extraction costs 1100
 * image tokens plus 1,900-4,400 THINKING tokens, and the thinking is most of the bill.
 */
const MODEL = flag("model", "gemini-3.6-flash")
const HTTP = "https://generativelanguage.googleapis.com/v1beta/models"

/** The shipped turn. Every per-game figure in this file is quoted against this cadence. */
const TURN_SEC = 20
/** How far ahead "would this have changed the next decision" looks. */
const HORIZON_SEC = 30

/* ------------------------------------------------------------ the state, parsed back out of the block */

/**
 * What the coach knew at one instant, read back out of the block it was holding.
 *
 * Parsed rather than recomputed on purpose. `buildLiveStateForBench` would give a state for the
 * `live-samples` games only — and of the six games with frames on disk, exactly one has raw samples
 * as well, covering its first 6:43. Parsing the stored block instead gives all six games end to end,
 * and it has the stronger property of being what the coach ACTUALLY held rather than a
 * reconstruction of it.
 */
export interface Snap {
	id: string
	path: string
	tSec: number
	k: number
	d: number
	a: number
	cs: number | null
	hp: number | null
	maxHp: number | null
	gold: number | null
	dead: boolean
	/** Includes him when he is alive — this is the client's own "Alive right now" line. */
	mine: number | null
	theirs: number | null
	/** The ranked list as rendered. Empty means the coach was told to PASS. */
	facts: string[]
	block: string
}

/** `You: Lillia lv7 0/1/3, 70 CS, 1533/1541 HP, 1208g` — every field after the score is optional. */
const YOU =
	/^You: (\S+)(?: lv(\d+))? (\d+)\/(\d+)\/(\d+)(?:, (\d+) CS)?(?:, ([\d.]+)\/([\d.]+) HP)?(?:, (\d+) gold)?(, DEAD)?/m

export const parseBlock = (id: string, path: string, tSec: number, block: string): Snap | null => {
	const you = YOU.exec(block)
	if (!you) return null
	const alive = /^Alive right now: (\d+) of yours against (\d+) of theirs/m.exec(block)
	const list = /### What he is NOT looking at[\s\S]*?\n\n([\s\S]*?)\n\n\*\*The ten/.exec(block)
	return {
		id,
		path,
		tSec,
		k: Number(you[3]),
		d: Number(you[4]),
		a: Number(you[5]),
		cs: you[6] ? Number(you[6]) : null,
		hp: you[7] ? Number(you[7]) : null,
		maxHp: you[8] ? Number(you[8]) : null,
		gold: you[9] ? Number(you[9]) : null,
		dead: you[10] !== undefined,
		mine: alive ? Number(alive[1]) : null,
		theirs: alive ? Number(alive[2]) : null,
		facts:
			list ?
				list[1]!
					.split("\n")
					.filter(l => l.startsWith("- "))
					.map(l => l.slice(2))
			:	[],
		block
	}
}

/**
 * Split one long journal session into the games inside it.
 *
 * The screen share persists across games by design, so a session's frames run 0..2035s and then
 * start again at 0. Same signal and same tolerance `daemon/live-sampler.ts` and `buildFacts` use for
 * the same reason: two reads a second apart can disagree by a little, a new game disagrees by
 * minutes.
 */
export const segment = (snaps: readonly Snap[]): Snap[][] => {
	const out: Snap[][] = []
	let cur: Snap[] | null = null
	let last = -1
	for (const s of snaps) {
		if (!cur || s.tSec < last - 30) {
			cur = []
			out.push(cur)
		}
		cur.push(s)
		last = s.tSec
	}
	return out
}

/** Wilson, because every rate below is a proportion on a few dozen trials and reads as stronger than it is. */
export const wilson = (k: number, n: number): string => {
	if (n === 0) return "n/a"
	const p = k / n
	const z = 1.96
	const d = 1 + (z * z) / n
	const centre = (p + (z * z) / (2 * n)) / d
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
	return `${(100 * p).toFixed(1)}% [${(100 * Math.max(0, centre - half)).toFixed(0)}, ${(100 * Math.min(1, centre + half)).toFixed(0)}]`
}

/**
 * Every frame that carries a block, WHETHER OR NOT the JPEG is still on disk.
 *
 * This distinction cost a wrong headline and is worth the comment. 503 of the 1,826 rows point at a
 * path from the checkout's previous name and their pictures are gone; the BLOCKS are intact. An
 * earlier version filtered the timeline by `existsSync` and so measured the hindsight window across
 * a state series with 503 holes in it — which reported that he never dies at low health (0 of 75
 * snapshots) while a backwards count over the whole series found two deaths preceded by exactly
 * that. A gap in a timeline does not look like an error, it looks like a finding.
 *
 * So: the census and every hindsight number run over the complete series, and only the arms that
 * actually send a picture filter by what is on disk.
 */
const loadSnaps = (): Snap[][] => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const rows = db
		.prepare("SELECT id, path, tSec, truthJson FROM journal_frame WHERE truthJson IS NOT NULL ORDER BY atMs")
		.all() as unknown as { id: string; path: string; tSec: number; truthJson: string }[]
	db.close()
	const snaps = rows
		.map(r => parseBlock(r.id, r.path, r.tSec, r.truthJson))
		.filter((s): s is Snap => s !== null)
	return segment(snaps)
}

/** The subset whose JPEG survives, for the arms that send one. */
const onDisk = (games: Snap[][]): Snap[][] => games.map(g => g.filter(s => existsSync(s.path))).filter(g => g.length > 0)

/** Every snapshot that is at least `TURN_SEC` of game clock after the last one kept. */
const atTurnCadence = (game: readonly Snap[]): Snap[] => {
	const out: Snap[] = []
	let last = -1e9
	for (const s of game) {
		if (s.tSec - last < TURN_SEC) continue
		last = s.tSec
		out.push(s)
	}
	return out
}

/** Did he die inside the horizon? The one hindsight test that needs no interpretation. */
const diedWithin = (game: readonly Snap[], s: Snap): boolean =>
	game.some(x => x.tSec > s.tSec && x.tSec <= s.tSec + HORIZON_SEC && x.d > s.d)

/** Did he spend? A gold DROP is a purchase, which means the shop was open and he was at base or dead. */
const spentWithin = (game: readonly Snap[], s: Snap): boolean =>
	s.gold !== null &&
	game.some(x => x.tSec > s.tSec && x.tSec <= s.tSec + HORIZON_SEC && x.gold !== null && x.gold < s.gold! - 200)

/* ------------------------------------------------------------ arm 1: the census */

/**
 * What the client already covers, how often, and whether a frame-readable state predicts anything.
 *
 * The health band is the point of this arm and it is the reason it runs first. "He is low, back
 * off" is the single most obvious thing a picture can support, and it is measured here against the
 * only outcome that matters.
 */
const census = (games: Snap[][]): void => {
	const turns = games.flatMap(g => atTurnCadence(g).map(s => ({ g, s })))
	const withFact = turns.filter(t => t.s.facts.length > 0)
	console.log(`\n## census — ${games.length} games, ${games.flatMap(g => g).length} frames, ${turns.length} turns at ${TURN_SEC}s`)
	console.log(`turns carrying a ranked client fact: ${withFact.length}/${turns.length} = ${wilson(withFact.length, turns.length)}`)
	console.log(`he is DEAD on ${wilson(turns.filter(t => t.s.dead).length, turns.length)} of turns`)
	console.log(`he buys something within ${HORIZON_SEC}s on ${wilson(turns.filter(t => spentWithin(t.g, t.s)).length, turns.length)} of turns`)

	/*
	 * Deaths, by everything the frame can see and the block cannot say as well.
	 *
	 * Run over EVERY snapshot rather than the 20s turns, because the bands are thin and a rate on
	 * twenty trials is not evidence of anything. The base rate moves by less than a point between
	 * the two, so nothing is bought by the choice except n.
	 */
	const all = games.flatMap(g => g.filter(s => !s.dead).map(s => ({ g, s })))
	const rate = (label: string, sub: { g: Snap[]; s: Snap }[]) =>
		console.log(`  ${label.padEnd(32)} n=${String(sub.length).padStart(4)}  P(dies within ${HORIZON_SEC}s) = ${wilson(sub.filter(x => diedWithin(x.g, x.s)).length, sub.length)}`)
	/*
	 * EPISODES, not snapshots — and this correction is load-bearing.
	 *
	 * Snapshots are five seconds apart, so one stretch at low health is fifteen rows that all say the
	 * same thing. Counting them as independent trials makes 0/75 look like p ≈ 0.003 when the real
	 * evidence is 0 of 13 separate times he went below a quarter health. A contiguous run in one band
	 * is one trial, and it counts as a death if any snapshot inside it was followed by one.
	 */
	const episodes = (lo: number, hi: number): { n: number; died: number } => {
		let n = 0
		let died = 0
		for (const game of games) {
			let inRun = false
			let runDied = false
			for (const s of game) {
				const frac = s.maxHp ? s.hp! / s.maxHp : null
				const inBand = !s.dead && frac !== null && frac >= lo && frac < hi
				if (inBand && !inRun) {
					inRun = true
					runDied = false
					n++
				}
				if (inBand && diedWithin(game, s)) runDied = true
				if (!inBand && inRun) {
					inRun = false
					if (runDied) died++
				}
			}
			if (inRun && runDied) died++
		}
		return { n, died }
	}
	console.log(`\ndoes a frame-readable state predict the next death?`)
	rate("base rate, alive", all)
	const band = (lo: number, hi: number) =>
		all.filter(x => x.s.maxHp !== null && x.s.hp! / x.s.maxHp! >= lo && x.s.hp! / x.s.maxHp! < hi)
	rate("HP under 25%", band(0, 0.25))
	rate("HP 25-40%", band(0.25, 0.4))
	rate("HP 40-60%", band(0.4, 0.6))
	rate("HP 60-85%", band(0.6, 0.85))
	rate("HP over 85%", band(0.85, 1.01))
	rate("outnumbered (block knows this)", all.filter(x => (x.s.theirs ?? 0) > (x.s.mine ?? 0)))
	rate("even or ahead", all.filter(x => (x.s.theirs ?? 0) <= (x.s.mine ?? 0)))
	console.log(`\nthe same thing counted as EPISODES, which is the honest n:`)
	for (const [lo, hi, label] of [
		[0, 0.25, "HP under 25%"],
		[0.25, 0.4, "HP 25-40%"],
		[0.4, 0.6, "HP 40-60%"],
		[0.6, 1.01, "HP over 60%"]
	] as [number, number, string][]) {
		const e = episodes(lo, hi)
		console.log(`  ${label.padEnd(32)} ${e.died}/${e.n} episodes led to a death within ${HORIZON_SEC}s  ${wilson(e.died, e.n)}`)
	}
}

/* ------------------------------------------------------------ arm 2: can it read the minimap */

/**
 * The counting question, with NO block attached.
 *
 * No block on purpose: the answer to "how many of yours are alive" is written in the block in
 * words, so a model that is handed both is being scored on its reading rather than its looking —
 * the same trap `probe-vision.ts` avoids by falsifying the block's clock.
 */
const COUNT_Q = `This is a League of Legends minimap (or a screenshot whose bottom-right corner holds one).
Each LIVING champion is drawn as a small circular portrait: the player's own team is ringed in blue or white, the enemy team in red. Turrets are shield-shaped icons and are NOT champions. Wards, plants and jungle camps are small squares or diamonds and are NOT champions. A dead champion is not drawn at all. Portraits overlap when champions stand together — count each one.
Answer ONLY with JSON: {"allyIcons": <how many blue-ringed portraits, counting the player's own>, "enemyIcons": <how many red-ringed portraits>}`

interface Ask {
	json: Record<string, unknown> | null
	imageTokens: number
	thoughtTokens: number
	ms: number
	error?: string
}

const ask = async (b64: string, question: string): Promise<Ask> => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")
	const started = Date.now()
	try {
		const r = await fetch(`${HTTP}/${MODEL}:generateContent`, {
			method: "POST",
			headers: { "x-goog-api-key": key, "content-type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }, { text: question }]
					}
				],
				/*
				 * Roomy on purpose. Measured in `live-providers.ts` and again here: a tight
				 * `maxOutputTokens` does not shorten a reasoning model, it TRUNCATES it, and a
				 * truncated extraction is scored as a refusal by a probe that cannot tell the two
				 * apart.
				 */
				generationConfig: { maxOutputTokens: 8000, responseMimeType: "application/json" }
			})
		})
		const body = (await r.json()) as {
			candidates?: { content?: { parts?: { text?: string }[] } }[]
			usageMetadata?: {
				thoughtsTokenCount?: number
				promptTokensDetails?: { modality?: string; tokenCount?: number }[]
			}
		}
		const text = (body.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("")
		const imageTokens =
			body.usageMetadata?.promptTokensDetails?.find(d => d.modality === "IMAGE")?.tokenCount ?? 0
		const out: Ask = {
			json: null,
			imageTokens,
			thoughtTokens: body.usageMetadata?.thoughtsTokenCount ?? 0,
			ms: Date.now() - started
		}
		try {
			out.json = JSON.parse(text) as Record<string, unknown>
		} catch {
			out.error = `unparseable: ${text.slice(0, 80)}`
		}
		return out
	} catch (e) {
		return { json: null, imageTokens: 0, thoughtTokens: 0, ms: Date.now() - started, error: String(e) }
	}
}

/**
 * The minimap, cropped out of a shipped frame.
 *
 * Measured off the journal's own 1536x864 frames: the minimap occupies x 1244..1536, y 570..862 —
 * a 292x292 square, in which a champion portrait is about fourteen pixels across. The crop is
 * exact rather than generous because including the HUD around it would let the model answer the
 * count off the portraits in the top bar instead.
 */
export const MINIMAP_CROP = { w: 292, h: 292, x: 1244, y: 570 } as const

const cropMinimap = (src: string, dst: string, scale: number): string => {
	execFileSync("ffmpeg", [
		"-y",
		"-loglevel",
		"error",
		"-i",
		src,
		"-vf",
		`crop=${MINIMAP_CROP.w}:${MINIMAP_CROP.h}:${MINIMAP_CROP.x}:${MINIMAP_CROP.y},scale=${MINIMAP_CROP.w * scale}:${MINIMAP_CROP.h * scale}:flags=lanczos`,
		"-q:v",
		"2",
		dst
	])
	return readFileSync(dst).toString("base64")
}

/**
 * Stratified by how many allies are alive, because 52% of all frames are 5v5.
 *
 * An unstratified draw would score mostly on states whose answer is always five, and a model that
 * simply said "five" every time would look competent. Every bucket that exists gets a share.
 */
const stratify = (games: Snap[][], n: number): Snap[] => {
	const all = games.flatMap(g => g).filter(s => s.mine !== null)
	const buckets = [5, 4, 3, 2].map(m => all.filter(s => (m === 2 ? s.mine! <= 2 : s.mine === m)))
	const want = [Math.ceil(n * 0.4), Math.ceil(n * 0.25), Math.ceil(n * 0.25), Math.ceil(n * 0.1)]
	const out: Snap[] = []
	buckets.forEach((b, i) => {
		const step = Math.max(1, Math.floor(b.length / want[i]!))
		for (let j = 0; j < want[i]! && j * step < b.length; j++) out.push(b[j * step]!)
	})
	return out
}

const minimapArm = async (games: Snap[][], n: number, out: string): Promise<void> => {
	const dir = mkdtempSync(`${tmpdir()}/attention-`)
	const set = stratify(games, n)
	const rows: Record<string, unknown>[] = []
	console.log(`\n## minimap — ${set.length} frames, ${MODEL}, three renderings of the same picture`)
	console.log("frame                       t   truth   full-frame   crop 1x     crop 3x")
	for (const s of set) {
		const full = readFileSync(s.path).toString("base64")
		const [a, b, c] = await Promise.all([
			ask(full, COUNT_Q),
			ask(cropMinimap(s.path, `${dir}/${s.id}-1.jpg`, 1), COUNT_Q),
			ask(cropMinimap(s.path, `${dir}/${s.id}-3.jpg`, 3), COUNT_Q)
		])
		const show = (r: Ask) =>
			`${String(r.json?.allyIcons ?? "-")}/${String(r.json?.enemyIcons ?? "-")}`.padEnd(11)
		console.log(
			`${s.id.padEnd(26)} ${String(Math.round(s.tSec)).padStart(4)}  ${s.mine}v${s.theirs}   ${show(a!)} ${show(b!)} ${show(c!)}`
		)
		rows.push({ id: s.id, tSec: s.tSec, mine: s.mine, theirs: s.theirs, full: a, crop1: b, crop3: c })
	}
	const score = (key: "full" | "crop1" | "crop3") => {
		const live = rows.filter(r => (r[key] as Ask).json !== null)
		const ally = live.map(r => Number(((r[key] as Ask).json as { allyIcons: number }).allyIcons) - Number(r.mine))
		const exact = ally.filter(x => x === 0).length
		const within1 = ally.filter(x => Math.abs(x) <= 1).length
		const impossible = live.filter(
			r => Number(((r[key] as Ask).json as { enemyIcons: number }).enemyIcons) > Number(r.theirs)
		).length
		const tok = live.reduce((t, r) => t + (r[key] as Ask).imageTokens, 0) / Math.max(1, live.length)
		const think = live.reduce((t, r) => t + (r[key] as Ask).thoughtTokens, 0) / Math.max(1, live.length)
		console.log(
			`${key.padEnd(6)} allies exact ${exact}/${live.length} (${wilson(exact, live.length)}), within one ${within1}/${live.length}, ` +
				`mean signed error ${(ally.reduce((x, y) => x + y, 0) / Math.max(1, ally.length)).toFixed(2)}, ` +
				`enemies claimed above the number alive ${impossible}/${live.length}, ` +
				`${Math.round(tok)} image + ${Math.round(think)} thinking tokens`
		)
	}
	console.log()
	score("full")
	score("crop1")
	score("crop3")
	if (out !== "") writeFileSync(out, JSON.stringify(rows, null, 2))
}

/* ------------------------------------------------------------ arm 3: every candidate, audited */

/**
 * The candidate frame facts, in the wording the extraction is asked for.
 *
 * Each one is here because somebody could plausibly argue for it, INCLUDING the ones this probe
 * expects to kill. `hpFraction` and `playerDead` are the controls: both are already stated in the
 * block, in digits, so a pre-pass that spends a call to rediscover them is spending money to be
 * less accurate than the client.
 */
const EXTRACT_Q = `This is a screenshot of the player's whole monitor at 1536x864. It is USUALLY a League of Legends game — the minimap is then the square in the bottom-right corner and the player's own champion is in the middle of the main view — but he shares the monitor rather than the game window, so it is sometimes another application entirely.
Report only what you can actually see. Where you cannot tell, use null.
Answer ONLY with JSON:
{"isGame": <true only if this picture shows a League of Legends game in progress>,
 "allyIcons": <blue-ringed champion portraits on the minimap, counting the player's own, or null>,
 "enemyIcons": <red-ringed champion portraits on the minimap, or null>,
 "myHalf": <"top-left" | "top-right" | "bottom-left" | "bottom-right" | "centre" — where the player's own portrait sits on the minimap>,
 "enemyHalves": [<the same vocabulary, one entry per red-ringed portrait>],
 "enemyNearMe": <true if a red-ringed portrait is within about a fifth of the minimap's width of the player's own>,
 "recalling": <true if the player is channelling a recall — a filling ring or bar under the champion>,
 "shopOpen": <true if the item shop panel is open over the game>,
 "playerDead": <true if the player is dead: greyed view, respawn countdown>,
 "fightOnScreen": <true if two or more champions are trading damage in the main view>,
 "campTimersShown": <true if the minimap is drawing numeric respawn timers next to jungle camps>}`

const extractArm = async (games: Snap[][], n: number, out: string): Promise<void> => {
	const all = games.flatMap(g => g.map(s => ({ g, s })))
	const step = Math.max(1, Math.floor(all.length / n))
	const set = Array.from({ length: Math.min(n, all.length) }, (_, i) => all[i * step]!)
	const rows: Record<string, unknown>[] = []
	console.log(`\n## extract — ${set.length} frames, ${MODEL}`)
	for (const { g, s } of set) {
		const r = await ask(readFileSync(s.path).toString("base64"), EXTRACT_Q)
		const j = (r.json ?? {}) as Record<string, unknown>
		rows.push({
			id: s.id,
			tSec: s.tSec,
			seen: j,
			/* Everything below is what the CLIENT already knew at that instant, for the audit. */
			truth: {
				mine: s.mine,
				theirs: s.theirs,
				dead: s.dead,
				hpFrac: s.maxHp ? Number((s.hp! / s.maxHp).toFixed(3)) : null,
				facts: s.facts
			},
			next: { died: diedWithin(g, s), bought: spentWithin(g, s) },
			cost: { imageTokens: r.imageTokens, thoughtTokens: r.thoughtTokens, ms: r.ms },
			...(r.error ? { error: r.error } : {})
		})
		process.stdout.write(".")
	}
	console.log()
	const live = rows.filter(r => Object.keys(r.seen as object).length > 0)
	const frac = (label: string, pred: (r: Record<string, unknown>) => boolean) => {
		const k = live.filter(pred).length
		console.log(`  ${label.padEnd(38)} ${String(k).padStart(3)}/${live.length}  ${wilson(k, live.length)}`)
	}
	const seen = (r: Record<string, unknown>) => r.seen as Record<string, unknown>
	const truth = (r: Record<string, unknown>) => r.truth as { dead: boolean; mine: number; theirs: number; facts: string[] }
	console.log("\nhow often is each candidate TRUE at all (a fact that is never true cannot be worth a call):")
	frac("not a picture of the game at all", r => seen(r).isGame === false)
	frac("recalling", r => seen(r).recalling === true)
	frac("shop open", r => seen(r).shopOpen === true)
	frac("fight on screen", r => seen(r).fightOnScreen === true)
	frac("an enemy is next to him", r => seen(r).enemyNearMe === true)
	frac("camp timers drawn on the minimap", r => seen(r).campTimersShown === true)
	frac("three or more enemies dark", r => Number(seen(r).enemyIcons ?? 9) <= truth(r).theirs - 3)
	console.log("\nagreement with the client on the two things the block ALREADY states:")
	frac("playerDead matches the block", r => seen(r).playerDead === truth(r).dead)
	frac("ally count exact", r => Number(seen(r).allyIcons) === truth(r).mine)
	frac("enemy count above the number alive", r => Number(seen(r).enemyIcons ?? 0) > truth(r).theirs)
	console.log("\nhindsight, over the whole sample:")
	frac("client had a ranked fact", r => truth(r).facts.length > 0)
	frac("he died within 30s", r => (r.next as { died: boolean }).died)
	const cost = live.reduce((t, r) => t + (r.cost as { imageTokens: number }).imageTokens, 0) / Math.max(1, live.length)
	const think = live.reduce((t, r) => t + (r.cost as { thoughtTokens: number }).thoughtTokens, 0) / Math.max(1, live.length)
	const ms = live.reduce((t, r) => t + (r.cost as { ms: number }).ms, 0) / Math.max(1, live.length)
	console.log(`\ncost per extraction: ${Math.round(cost)} image + ${Math.round(think)} thinking tokens, ${Math.round(ms)}ms`)
	if (out !== "") writeFileSync(out, JSON.stringify(rows, null, 2))
}

/* ------------------------------------------------------------ where a client fact already lives */

/**
 * For each line the ranker offers: where could he have got it WITHOUT the coach?
 *
 * This is the AGENTS.md "not visible" test turned on the client's own facts, and it is here because
 * a vision pass has to be justified against what the coach already says rather than against nothing.
 *
 *   banner     the game announced it itself — a dragon or Baron take is a full-screen banner and a
 *              sound cue, so the line adds warmth and no information.
 *   hud        a number on his HUD: the objective timer he can read, the gold in the corner.
 *   scoreboard visible, but only if he holds TAB or watches the kill feed go by.
 *   unseen     genuinely not obtainable from his screen at all — his own rolling average, a share
 *              of his team's kills, what an item means for this matchup.
 *
 * Ranked by how much the LINE is worth, not how true it is. Everything above `unseen` is a readout
 * with one redeeming feature: it says what to do about the thing rather than merely naming it.
 */
export type FactHome = "banner" | "hud" | "scoreboard" | "unseen"

export const homeOf = (line: string): FactHome =>
	/they took|they have Baron|they have Herald|you (just got|secured|stole)/.test(line) ? "banner"
	: /back in \d+ seconds|is up NOW|gold (sitting )?unspent|gold unspent for/.test(line) ? "hud"
	: /is down \d+ seconds|are dead — you/.test(line) ? "scoreboard"
	: "unseen"

/* ------------------------------------------------------------ the control: today's ranker */

/**
 * The same "how often does the client have anything to say" rate, through TODAY's `buildFacts`.
 *
 * The census reads stored blocks, and those were rendered months of measurement ago. If the two
 * disagreed the census would be reporting the rate of a coach nobody runs any more. They do not:
 * 25% of stored turns against 23% replayed. Kept as a flag rather than the default because it needs
 * `data/live-samples` and a corpus for the farm baseline, and the census needs neither.
 */
const replayArm = async (): Promise<void> => {
	const { DATA_DIR } = await import("../src/shared/constants.ts")
	const { baselineFromRows, perGameMetrics } = await import("../src/analysis/index.ts")
	const { paceReading } = await import("../src/analysis/live-coach.ts")
	const { loadCorpus } = await import("../src/daemon/corpus.ts")
	const { readdirSync } = await import("node:fs")
	const { MIN_GAP_SEC, ROUTINE_GAP_SEC } = await import("../src/analysis/live-facts.ts")
	const baseline = baselineFromRows(perGameMetrics(loadCorpus(40)))
	const dir = `${DATA_DIR}/live-samples`
	const games = readdirSync(dir).filter(f => /^split-\d+\.ndjson$/.test(f)).sort()
	console.log(`\n## replay — today's buildFacts over ${games.length} recorded games at ${TURN_SEC}s`)
	let allTurns = 0
	let allFacts = 0
	let allStanding = 0
	let allExpiring = 0
	let allBoth = 0
	const homes: Record<FactHome, number> = { banner: 0, hud: 0, scoreboard: 0, unseen: 0 }
	for (const file of games) {
		const game = file.replace(".ndjson", "")
		/*
		 * One module instance per game. `routes/live.ts` keeps its fact memory at module scope —
		 * right for a daemon with one user and one game — so replaying four games through one
		 * import would carry game one's rate limits into game two. Same trick, same reason, as
		 * `scripts/probe-generic.ts`.
		 */
		const mod = (await import(`../src/server/routes/live.ts?attention=${game}`)) as typeof import("../src/server/routes/live.ts")
		const lines = readFileSync(`${dir}/${file}`, "utf8").split("\n").filter(l => l.trim() !== "")
		let last = -1e9
		let turns = 0
		let facts = 0
		/*
		 * The other half of the gating question, and the half that decides it.
		 *
		 * `buildFacts` will not OFFER a `standing` fact within `ROUTINE_GAP_SEC` of the last thing
		 * the coach said, or an `expiring` one within `MIN_GAP_SEC`. A vision fact would be subject
		 * to exactly those floors, so a vision call made inside one of those windows buys a fact
		 * that is forbidden before it is computed. Counting them is what turns "run it every turn?"
		 * into arithmetic instead of taste.
		 */
		let lastOfferedAtSec = 0
		let standingAllowed = 0
		let expiringAllowed = 0
		let bothQuiet = 0
		for (const line of lines) {
			const o = JSON.parse(line) as { gameTime: number; data: unknown }
			if (o.gameTime - last < TURN_SEC) continue
			last = o.gameTime
			const state = mod.buildLiveStateForBench(o.data, o.gameTime)
			if (!state) continue
			state.pace = paceReading({
				live: {
					gameTimeSec: o.gameTime,
					championName: state.me.champion,
					cs: state.me.cs ?? 0,
					deaths: state.me.d ?? 0,
					kills: state.me.k ?? 0,
					assists: state.me.a ?? 0,
					level: state.me.level ?? 0,
					observed: { dragonSec: null, baronSec: null, heraldSec: null }
				},
				baseline,
				focus: []
			})
			turns++
			const sinceLast = lastOfferedAtSec === 0 ? Number.POSITIVE_INFINITY : o.gameTime - lastOfferedAtSec
			if (sinceLast >= ROUTINE_GAP_SEC) standingAllowed++
			if (sinceLast >= MIN_GAP_SEC) expiringAllowed++
			// The gate a shipped pre-pass would actually use: sayable AND the client has nothing.
			if (sinceLast >= ROUTINE_GAP_SEC && state.unseen.length === 0) bothQuiet++
			if (state.unseen.length > 0) {
				facts++
				lastOfferedAtSec = o.gameTime
				for (const l of state.unseen) homes[homeOf(l)] += 1
			}
		}
		allTurns += turns
		allFacts += facts
		allStanding += standingAllowed
		allExpiring += expiringAllowed
		allBoth += bothQuiet
		console.log(
			`  ${game}  ${facts}/${turns} turns carried a fact = ${wilson(facts, turns)}` +
				`; a vision fact could have been SAID on ${expiringAllowed}/${turns} turns as expiring, ${standingAllowed}/${turns} as standing`
		)
	}
	console.log(`  all       client fact ${allFacts}/${allTurns} = ${wilson(allFacts, allTurns)}`)
	console.log(`  all       vision fact sayable: expiring ${allExpiring}/${allTurns} = ${wilson(allExpiring, allTurns)}, standing ${allStanding}/${allTurns} = ${wilson(allStanding, allTurns)}`)
	const lines = homes.banner + homes.hud + homes.scoreboard + homes.unseen
	console.log(
		`  all       of ${lines} offered lines, ${homes.banner} were a banner he watched, ${homes.hud} a number on his HUD, ` +
			`${homes.scoreboard} the scoreboard — only ${homes.unseen} (${wilson(homes.unseen, lines)}) are unobtainable from his screen`
	)
	console.log(`  all       BOTH (standing-sayable and client quiet) ${allBoth}/${allTurns} = ${wilson(allBoth, allTurns)}`)
	console.log(`  all       client QUIET ${allTurns - allFacts}/${allTurns} = ${wilson(allTurns - allFacts, allTurns)} — the "only when quiet" gate saves only what the other ${wilson(allFacts, allTurns)} costs`)
}

/* ------------------------------------------------------------ main */

const main = async (): Promise<void> => {
	const games = loadSnaps()
	if (games.length === 0) throw new Error(`no journal frames on disk under ${DB_PATH}`)
	const out = flag("out")
	census(games)
	if (has("replay")) await replayArm()
	if (has("minimap")) await minimapArm(onDisk(games), Number(flag("minimap", "16")), out)
	if (has("extract")) await extractArm(onDisk(games), Number(flag("extract", "40")), out)
}

await main()
