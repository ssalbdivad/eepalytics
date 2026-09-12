/**
 * The app's ONE number-formatting policy.
 *
 * ## Why this file exists
 *
 * A verification pass found the same quantity printed two ways within one card: `1.9k gold`
 * sitting directly above `+1954 vs your avg`, `1545.0 xp` with a trailing zero on a figure that
 * cannot have a fractional part, and a debrief tile reading `30%` against `your average 13.2`
 * with the sign left off the baseline. None of those were wrong numbers. They were the same
 * number rendered by three components that each decided precision for themselves — `fmtCompact`
 * in one, `toFixed(1)` in another, `toLocaleString()` in a third — and the effect is that the
 * reader cannot compare two figures on the same screen without doing arithmetic first.
 *
 * **A number's format must never depend on which component rendered it.** So the decision is
 * made here, from the quantity and its unit, and every surface calls in.
 *
 * ## The policy, in full
 *
 * 1. **Grain comes from the quantity, never from the slot.** `fmtQty` and `fmtDelta` are the
 *    only two ways a measured figure reaches the screen.
 * 2. **Counting units are whole numbers.** `gold`, `xp`, `cs`, `units`, `lvl`, `damage` — you
 *    cannot have 1545.0 of any of them, and the `.0` reads as precision that was never
 *    measured.
 * 3. **Everything else carries two significant decimals, scaled by magnitude:** `>= 100` gets
 *    none, `>= 10` gets one, below that gets two. So `1,110`, `21`, `8.1`, `2.06` — each figure
 *    is about three digits wide, which is what makes a column of them scannable.
 * 4. **Trailing zeros after the point are always trimmed.** `8.10` is `8.1`; `21.0` is `21`.
 *    This is the rule that kills `1545.0 xp` and it applies to percentages too.
 * 5. **Percent keeps one decimal and never leaves its sign behind.** `30%`, `21.8%` — and the
 *    `%` goes on every figure of that metric, the value, the delta AND the baseline. A tile
 *    reading `30%` over `your average 13.2` is comparing a percentage to a bare number.
 * 6. **Thousands are grouped from 1,000 up.** `16,085`, `1,954`.
 * 7. **Compaction (`33k`, `1.2M`) is allowed only for a number STANDING ALONE in a dense list
 *    column.** Never where a second figure of the same quantity — a delta, a baseline, an
 *    opponent's value — is printed beside it. That pairing is precisely the `1.9k gold` bug,
 *    and it is the only rule here that is about context rather than the number.
 * 8. **A delta is formatted like its value and never coarser.** Always signed (`+`, `−`, `±`),
 *    same unit, same grouping, and at least as fine as the value it moved, capped at two
 *    decimals — so a count with a fractional mean-difference (`8 assists`, `+0.15`) still says
 *    what it moved by instead of rounding it to `+0`.
 * 9. **An interval is printed at the grain of the number it brackets.** `150 ± 9`, never
 *    `150.10 ± 8.94` beside a chart whose own header says `150`.
 * 10. **A baseline is COPIED digits plus the value's unit.** `AGENTS.md` rule 4 — never
 *    re-rounded, never recomputed. This file may append a `%`; it may never touch a digit.
 * 11. **Absent is `--`, never `0`.** A zero that means "we don't know" is a fabricated stat.
 *
 * Clocks, durations and relative wall-clock are the same policy in a different dimension and
 * already live in one place: `shared/time.ts`. Nothing prints its own.
 *
 * Pure and browser-safe. No I/O, no Node imports.
 */

/** What the UI prints where there is no number. Never `0`, never an empty cell. */
export const MISSING = "--"

/**
 * Units you can only have a whole number of.
 *
 * `lvl` is here because levels are integers; `units` is the map-distance unit, which is
 * measured in thousands and whose tenths are noise at the scale it is read at.
 */
const COUNT_UNITS: ReadonlySet<string> = new Set([
	"gold",
	"xp",
	"cs",
	"units",
	"lvl",
	"damage",
	"count"
])

/** Comma every three digits, on the integer part only. */
const group = (text: string): string => {
	const neg = text.startsWith("-")
	const body = neg ? text.slice(1) : text
	const [whole = "", frac] = body.split(".")
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	return `${neg ? "-" : ""}${grouped}${frac === undefined ? "" : `.${frac}`}`
}

/** Drop `.0`, `.10` -> `.1`, and the point itself when nothing survives it. */
const trimZeros = (text: string): string =>
	text.includes(".") ? text.replace(/\.?0+$/, "") : text

/**
 * Policy rule 3: two significant decimals, scaled by magnitude.
 *
 * Exported because the interval rule (9) and the delta rule (8) both need to ask the same
 * question about a different number.
 */
export const statDigits = (n: number): number => {
	const a = Math.abs(n)
	if (!Number.isFinite(a)) return 0
	if (a >= 100) return 0
	if (a >= 10) return 1
	return 2
}

const digitsFor = (n: number, unit: string): number =>
	COUNT_UNITS.has(unit) ? 0
	: unit === "%" ? 1
	: statDigits(n)

/** Rules 2-6: the canonical rendering of one measured quantity, without its unit word. */
export const fmtQty = (n: number, unit: string = ""): string => {
	if (!Number.isFinite(n)) return MISSING
	const body = trimZeros(group(n.toFixed(digitsFor(n, unit))))
	return unit === "%" ? `${body}%` : body
}

/**
 * Rule 8: a delta, formatted like the value it moved.
 *
 * `valueForGrain` is the figure this delta is a delta OF. Passing it is what keeps a tile's two
 * lines in step; leaving it out is fine when there is no value on screen beside it.
 */
export const fmtDelta = (
	n: number,
	unit: string = "",
	valueForGrain?: number
): string => {
	if (!Number.isFinite(n)) return MISSING
	const own = digitsFor(n, unit)
	const value = valueForGrain === undefined ? own : digitsFor(valueForGrain, unit)
	const digits = Math.min(2, Math.max(own, value))
	const body = trimZeros(group(Math.abs(n).toFixed(digits)))
	const sign = n > 0 ? "+" : n < 0 ? "−" : "±"
	return `${sign}${body}${unit === "%" ? "%" : ""}`
}

/**
 * Rule 9: a statistic and the interval that brackets it, at ONE grain.
 *
 * The trends table printed `72.45 ± 2.88` directly above a chart header reading `mean 72`, which
 * is the same measurement at two precisions in adjacent elements. The interval follows the mean
 * because the mean is the number being read; a CI quoted finer than the figure it qualifies
 * claims a resolution the figure does not have.
 */
export const fmtInterval = (mean: number, ci: number | null, unit: string = ""): string => {
	if (!Number.isFinite(mean)) return MISSING
	const suffix = unit === "%" ? "%" : ""
	if (ci === null || !Number.isFinite(ci)) return `${fmtQty(mean, unit)}`
	/*
	 * Rule 4 (trim trailing zeros) yields to rule 9 (one grain) inside a pair: trimming each
	 * side on its own gives `7.59 ± 0.4`, two precisions in one expression, which is the exact
	 * defect this function was written to remove. So the decimals are chosen from whichever
	 * side still needs them after trimming, and then BOTH are printed at that width.
	 */
	const cap = digitsFor(mean, unit)
	const needed = (v: number): number => {
		const t = trimZeros(v.toFixed(cap))
		const dot = t.indexOf(".")
		return dot === -1 ? 0 : t.length - dot - 1
	}
	const digits = Math.max(needed(mean), needed(Math.abs(ci)))
	const at = (v: number): string => group(v.toFixed(digits))
	return `${at(mean)}${suffix} ± ${at(Math.abs(ci))}${suffix}`
}

/**
 * Rule 7: the compact form, for a lone number in a column too narrow for the full one.
 *
 * Deliberately NOT reachable from `fmtQty`. The only sanctioned callers are dense list columns
 * where the figure stands by itself — the games list's gold and damage cells. If a delta, a
 * baseline or an opponent's figure is printed beside it, this is the wrong function and the
 * result is the `1.9k gold` / `+1954 vs your avg` pairing this policy exists to prevent.
 */
export const fmtCompact = (n: number): string => {
	if (!Number.isFinite(n)) return MISSING
	const abs = Math.abs(n)
	if (abs >= 1_000_000) return `${trimZeros((n / 1_000_000).toFixed(1))}M`
	if (abs >= 10_000) return `${Math.round(n / 1000)}k`
	if (abs >= 1000) return `${trimZeros((n / 1000).toFixed(1))}k`
	return String(Math.round(n))
}

/**
 * Rule 10: the unit suffix that must travel with a COPIED baseline.
 *
 * The digits are the digest's own and are passed through untouched — this only decides whether
 * a `%` follows them, which is the difference between `your average 13.2` under a tile reading
 * `30%` and a comparison a reader can actually make.
 */
export const unitSuffix = (unit: string): string => (unit === "%" ? "%" : "")
