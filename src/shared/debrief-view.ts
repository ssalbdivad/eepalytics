/**
 * The debrief's four computed sentences — the parts of that screen no model writes.
 *
 * ## Why any of this is code
 *
 * The screen's top band claims one thing about the game in 21px type ("Nine neutral objectives
 * in this game. All nine went to Kayn."), and three tiles claim three numbers under it. A model
 * could write that line, and for most of this app's life something like it did — which is how a
 * coach ends up saying he was ninety CS ahead of a jungler he was level with. **A sentence
 * assembled from counted facts cannot be wrong about the count.** So the shape line is selected
 * and phrased here, the tiles are picked here, and the baseline printed next to each tile is
 * COPIED out of the digest rather than recalled or recomputed.
 *
 * ## The baseline rule, mechanically
 *
 * `AGENTS.md` rule 4: a baseline is copied, never derived by subtracting the delta from the
 * value and never rounded into a rounder-sounding number. Three real reviews broke it by
 * arithmetic (2874 became 3150, -407 became -438, 9.4 became 8.2) and all three read as
 * measurements. `baselineOf` therefore only ever *extracts digits that already exist* — from
 * `baselineText` when the digest carried one, otherwise from the metric's own `explain`
 * sentence — and returns null rather than computing when neither is there. A tile with no
 * baseline prints no baseline.
 *
 * Pure and browser-safe: the page renders these and a test asserts them, with no server between.
 */

import type { Metric } from "./schema/domain.ts"
import { fmtDelta, fmtQty, unitSuffix } from "./num.ts"

/* =========================================================== baselines */

/** `Your 20-game average is 101.4 (sd 9)` / `your own average: 2874`, as written. */
const BASELINE_PATTERNS: readonly RegExp[] = [
	/your own average:\s*(-?[\d.,]+)/i,
	/your\s+\d+-game\s+average\s+is\s+(-?[\d.,]+)/i,
	/your\s+own\s+average\s+of\s+(-?[\d.,]+)/i
]

/**
 * The baseline for a metric, as DIGITS THAT ALREADY EXIST somewhere in the digest.
 *
 * Never `value - vsBaseline`. That arithmetic is exactly the fabrication rule 4 names: it looks
 * like a measurement, it is off by the rounding in both operands, and it has shipped wrong
 * three times.
 */
export const baselineOf = (m: Metric): string | null => {
	const text = m.baselineText ?? ""
	for (const re of BASELINE_PATTERNS) {
		const hit = re.exec(text) ?? re.exec(m.explain)
		if (hit?.[1]) return hit[1].replace(/[.,]$/, "")
	}
	return null
}

/**
 * The baseline as the tile prints it: COPIED digits, plus the unit they were measured in.
 *
 * A tile read `30%` with `your average 13.2` under it — a percentage compared against a bare
 * number, which is not a comparison a reader can make without first guessing that the second
 * figure is also a percentage. The digits are still the digest's own and are never touched;
 * only the `%` is added, because a percent sign is part of the unit, not part of the value.
 */
export const baselineLabel = (m: Metric): string => {
	const base = baselineOf(m)
	return base === null ? "no baseline yet" : `your average ${base}${unitSuffix(m.unit)}`
}

/* =============================================================== tiles */

/**
 * The three numbers worth the top of the screen: the largest NORMALISED moves against his own
 * baseline.
 *
 * Normalised, because the raw deltas are not comparable — a 900g swing and a 4-CS swing are the
 * same size in different units, and sorting on the absolute delta would make gold win every
 * game. `confidence: "low"` is excluded outright: an interpolated figure must never be one of
 * the three things he reads.
 */
export const TILE_COUNT = 3

/**
 * Which family a metric belongs to, so the three tiles cannot all say the same thing.
 *
 * Measured, not hypothetical: on game 5639406342 the top three by move were "share of elite
 * objectives taken: 0%", "elite objectives you smited: 0" and "time in the enemy half: 3.4%" —
 * the first two are the same fact stated twice, because taking no objectives and smiting none
 * are perfectly correlated. A tile that repeats its neighbour spends the most valuable space on
 * the screen saying nothing new.
 */
export const familyOf = (key: string): string => {
	const k = key.toLowerCase().replace(/@\d+$/, "")
	if (k.includes("elite") || k.includes("objective") || k.includes("dragon")) return "objectives"
	if (k.includes("vision") || k.includes("ward")) return "vision"
	if (k.includes("death")) return "deaths"
	if (k.includes("damage")) return "damage"
	// Every `*Delta@*` is the SAME comparison in a different unit — CS, XP and gold against the
	// counterpart at 10:00 move together, and three tiles of it is one fact printed three times.
	if (k.includes("delta")) return "race"
	if (k.includes("cs") || k.includes("farm")) return "cs"
	if (k.includes("gold")) return "gold"
	if (k.includes("xp")) return "xp"
	if (k.includes("half") || k.includes("centroid") || k.includes("extension")) return "position"
	if (k.includes("kill") || k.includes("assist") || k.includes("kda")) return "fights"
	return k
}

/**
 * The move, NORMALISED AGAINST THE BASELINE rather than against this game's own value.
 *
 * Dividing by the value is unstable exactly where it matters: a metric that came out at zero
 * divides by one and wins every comparison, so a game with no objectives taken ranks "0 elites"
 * above a 21-CS deficit. Dividing by his own average asks the question the tile is actually
 * making — how far from normal was this, in units of normal — and is defined at zero.
 */
const moveOf = (m: Metric): number => {
	const base = Number(baselineOf(m) ?? NaN)
	const denom = Number.isFinite(base) && Math.abs(base) > 0.001 ? Math.abs(base) : Math.abs(m.value) || 1
	return Math.abs(m.vsBaseline ?? 0) / denom
}

export const pickTiles = (metrics: readonly Metric[], n: number = TILE_COUNT): Metric[] => {
	const ranked = metrics
		.filter(
			m =>
				m.vsBaseline !== null &&
				Number.isFinite(m.vsBaseline) &&
				m.confidence !== "low" &&
				Number.isFinite(m.value)
		)
		.map(m => ({ m, move: moveOf(m) }))
		.sort((a, b) => b.move - a.move)

	const seen = new Set<string>()
	const out: Metric[] = []
	for (const { m } of ranked) {
		const family = familyOf(m.key)
		if (seen.has(family)) continue
		seen.add(family)
		out.push(m)
		if (out.length === n) break
	}
	return out
}

/**
 * Which way a metric moved, for colour. `band` already says good/ok/bad against his own
 * baseline, so this only turns that into the page's two-colour vocabulary — and `unknown`
 * stays grey rather than guessing a direction.
 */
export const directionOf = (m: Metric): "for" | "against" | "neutral" =>
	m.band === "good" ? "for"
	: m.band === "bad" ? "against"
	: "neutral"

/* ========================================================== shape line */

export interface ShapeInput {
	objectives: readonly { side: "his" | "enemy"; takenBy: string }[]
	counterpartName: string | null
	metrics: readonly Metric[]
}

export interface ShapeLine {
	/** The neutral half, rendered in ordinary type. */
	lead: string
	/** The half that carries the result, coloured. Empty when there is nothing to colour. */
	turn: string
	direction: "for" | "against" | "neutral"
	/** What it was counted from, shown on hover. Never absent. */
	source: string
}

const WORDS = [
	"No",
	"One",
	"Two",
	"Three",
	"Four",
	"Five",
	"Six",
	"Seven",
	"Eight",
	"Nine",
	"Ten"
] as const

const countWord = (n: number): string => WORDS[n] ?? String(n)

/**
 * One sentence about the SHAPE of the game, counted rather than judged.
 *
 * Objectives first, because a neutral-objective count is exact (`ELITE_MONSTER_KILL.killerId`
 * is the reliable half of the event) and because a jungler's game is decided there. When the
 * timeline is missing there are no objectives to count, so it falls back to the biggest
 * checkpoint move — still a copied figure, still not a judgement.
 */
export const shapeLine = (input: ShapeInput): ShapeLine | null => {
	const objs = input.objectives
	if (objs.length > 0) {
		const enemy = objs.filter(o => o.side === "enemy").length
		const his = objs.length - enemy
		const lead = `${countWord(objs.length)} neutral objective${objs.length === 1 ? "" : "s"} in this game.`
		const source = `counted from ${objs.length} ELITE_MONSTER_KILL events in the timeline`
		// One name only when one player took every one of them — otherwise it is the team's.
		const soloTaker =
			enemy === objs.length && input.counterpartName !== null &&
			objs.every(o => o.takenBy === input.counterpartName)

		if (enemy === objs.length)
			return {
				lead,
				turn:
					soloTaker ?
						`All ${objs.length === 1 ? "of it" : countWord(objs.length).toLowerCase()} went to ${input.counterpartName}.`
					:	`All of them went to the enemy team.`,
				direction: "against",
				source
			}
		if (his === objs.length)
			return { lead, turn: "You took every one of them.", direction: "for", source }
		return {
			lead,
			turn: `${countWord(enemy)} went to the enemy team.`,
			direction: enemy > his ? "against" : "for",
			source
		}
	}

	const top = pickTiles(input.metrics, 1)[0]
	if (!top) return null
	const base = baselineOf(top)
	const delta = top.vsBaseline ?? 0
	return {
		lead: `${top.label}: ${fmtQty(top.value, top.unit)}.`,
		turn:
			base === null ?
				`${fmtDelta(delta, top.unit, top.value)} against your own average.`
			:	`Your own average is ${base}${unitSuffix(top.unit)}.`,
		direction: directionOf(top),
		source: top.explain
	}
}

/* ============================================================ kept line */

export interface KeptInput {
	metrics: readonly Metric[]
	/** His takedowns on the counterpart, from the timeline. Exact — these are kill events. */
	counterpartTakedowns: readonly { clock: string; kind: "kill" | "assist" }[]
	counterpartName: string | null
	/**
	 * Metric keys already shown as tiles. The Kept line is the band's second sentence and must
	 * not restate its first — a screen that says the same number twice in four lines reads as
	 * padding, which is precisely what the caps exist to prevent.
	 */
	excludeKeys?: readonly string[]
}

/**
 * The one thing that went right, counted rather than complimented.
 *
 * Mandatory when the data supports one, and it lives in the verdict band rather than as a
 * fourth card — which is the only reason three cards is enough. `AGENTS.md` rule 6 asks for a
 * positive item in every review; this is the version that does not need a model, so it is there
 * even on a game with no review at all.
 *
 * Returns null rather than reaching for something flattering. A game where nothing measurable
 * went well gets no `Kept:` line, and that is more respectful than a manufactured one.
 */
export const keptLine = (input: KeptInput): string | null => {
	const clauses: string[] = []

	const exclude = new Set(input.excludeKeys ?? [])
	const good = input.metrics.filter(
		m =>
			m.band === "good" &&
			m.vsBaseline !== null &&
			m.confidence !== "low" &&
			!exclude.has(m.key)
	)
	const best = pickTiles(good, 1)[0]
	if (best) {
		const base = baselineOf(best)
		clauses.push(
			`${best.label}: ${fmtQty(best.value, best.unit)}` +
				(base === null ? "" : ` against your own average of ${base}${unitSuffix(best.unit)}`)
		)
	}

	const kills = input.counterpartTakedowns.filter(t => t.kind === "kill")
	if (kills.length > 0 && input.counterpartName !== null)
		clauses.push(
			`you killed ${input.counterpartName} ${kills.length === 1 ? "once" : kills.length === 2 ? "twice" : `${kills.length} times`} — ${listOf(kills.map(k => k.clock))}`
		)

	if (clauses.length === 0) return null
	const text = clauses.join(", and ")
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "3:42, 23:41 and 30:22" — a list a person would say out loud. */
const listOf = (parts: readonly string[]): string =>
	parts.length <= 1 ? (parts[0] ?? "")
	: parts.length === 2 ? `${parts[0]} and ${parts[1]}`
	: `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`

/**
 * The app's one number policy, under the name this screen already calls it by.
 *
 * It used to round everything to a single decimal on its own, which meant `1545` xp printed as
 * `1545` here and `1545.0` two components away, and neither grouped its thousands. It now
 * delegates to `shared/num.ts` so the debrief's prose, its tiles and the post-game panel are
 * incapable of disagreeing about the same figure.
 */
export const fmtNumber = (n: number): string => fmtQty(n)
