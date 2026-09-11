/**
 * Timeline frame access + interpolation primitives.
 *
 * ## The one-frame-per-minute problem
 * The LCU timeline emits ONE frame per minute (644 of 665 inter-frame gaps measured at
 * exactly 60 000 ms; the exceptions are each game's final partial frame). The median distance
 * a player travels between two samples is **4082 units — 28% of the map**
 * (`.research/analytics.md` §4.3).
 *
 * Linear interpolation halves the reconstruction error (median 2871 -> 1452 units against the
 * exact `CHAMPION_KILL.position` ground truth) and is therefore MANDATORY — but a 1452-unit
 * median error is still larger than a champion's vision radius. Everything downstream of
 * `interpPosition` is a guess and must be labelled `confidence: "low"`.
 *
 * Marks past the last frame return `null`, never the last value: otherwise a 10-minute remake
 * would proudly report a CS@20.
 */

import type {
	LcuEvent,
	LcuFrame,
	LcuParticipantFrame,
	LcuTimeline
} from "../shared/schema/lcu.ts"
import { lerpPos, type Pos } from "../shared/map.ts"

/** Numeric fields that exist on every participant frame. */
export type NumericFrameField =
	| "currentGold"
	| "totalGold"
	| "xp"
	| "level"
	| "minionsKilled"
	| "jungleMinionsKilled"

/** Frames, defensively sorted. An absent timeline yields `[]` — every caller must cope. */
export const framesOf = (timeline: LcuTimeline | null | undefined): LcuFrame[] =>
	timeline?.frames ?
		[...timeline.frames].sort((a, b) => a.timestamp - b.timestamp)
	:	[]

/** `participantFrames` is keyed by STRING ("1".."10"), which trips everybody up once. */
export const pfOf = (
	frame: LcuFrame,
	participantId: number
): LcuParticipantFrame | null =>
	frame.participantFrames[String(participantId)] ?? null

export const firstFrameMs = (frames: LcuFrame[]): number =>
	frames.length > 0 ? frames[0]!.timestamp : 0

export const lastFrameMs = (frames: LcuFrame[]): number =>
	frames.length > 0 ? frames[frames.length - 1]!.timestamp : 0

/** Participant ids present in the timeline, ascending. */
export const participantIdsOf = (frames: LcuFrame[]): number[] => {
	const seen = new Set<number>()
	for (const f of frames)
		for (const k of Object.keys(f.participantFrames)) {
			const n = Number(k)
			if (Number.isFinite(n)) seen.add(n)
		}
	return [...seen].sort((a, b) => a - b)
}

export interface Bracket {
	a: LcuFrame
	b: LcuFrame
	/** 0 at `a`, 1 at `b`. */
	t: number
}

/**
 * The two frames straddling `ms`, or `null` when `ms` falls outside the recorded window.
 * Binary search; frames are already sorted by `framesOf`.
 */
export const bracket = (frames: LcuFrame[], ms: number): Bracket | null => {
	if (frames.length === 0) return null
	const first = frames[0]!
	const last = frames[frames.length - 1]!
	if (ms < first.timestamp || ms > last.timestamp) return null
	if (ms === last.timestamp) return { a: last, b: last, t: 0 }

	let lo = 0
	let hi = frames.length - 1
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1
		if (frames[mid]!.timestamp <= ms) lo = mid
		else hi = mid
	}
	const a = frames[lo]!
	const b = frames[hi]!
	const span = b.timestamp - a.timestamp
	return { a, b, t: span === 0 ? 0 : (ms - a.timestamp) / span }
}

/**
 * Linear interpolation of a monotone-ish scalar. Use for `totalGold`, `xp`, `currentGold`,
 * `minionsKilled`, `jungleMinionsKilled`. NOT for `level` — see `stepScalar`.
 */
export const interpScalar = (
	frames: LcuFrame[],
	participantId: number,
	ms: number,
	field: NumericFrameField
): number | null => {
	const br = bracket(frames, ms)
	if (!br) return null
	const pa = pfOf(br.a, participantId)
	const pb = pfOf(br.b, participantId)
	if (!pa) return null
	if (!pb) return pa[field]
	return pa[field] + (pb[field] - pa[field]) * br.t
}

/** Last-known value. `level` is a step function; interpolating it invents level 7.4. */
export const stepScalar = (
	frames: LcuFrame[],
	participantId: number,
	ms: number,
	field: NumericFrameField
): number | null => {
	const br = bracket(frames, ms)
	if (!br) return null
	const pa = pfOf(br.a, participantId)
	return pa ? pa[field] : null
}

/**
 * Interpolated position. **This is a guess.** Median error against ground truth is 1452 units.
 * Anything computed from it is `confidence: "low"` and must be phrased "likely", never "was".
 */
export const interpPosition = (
	frames: LcuFrame[],
	participantId: number,
	ms: number
): Pos | null => {
	const br = bracket(frames, ms)
	if (!br) return null
	const pa = pfOf(br.a, participantId)
	const pb = pfOf(br.b, participantId)
	if (!pa) return null
	if (!pb) return { x: pa.position.x, y: pa.position.y }
	return lerpPos(pa.position, pb.position, br.t)
}

/** Every event in the timeline, flattened and sorted. */
export const allEvents = (timeline: LcuTimeline | null | undefined): LcuEvent[] => {
	const out: LcuEvent[] = []
	for (const f of framesOf(timeline)) if (f.events) out.push(...f.events)
	return out.sort((a, b) => a.timestamp - b.timestamp)
}

/** Sum of `totalGold` across a team at `ms`, interpolated. `null` outside the window. */
export const teamGoldAt = (
	frames: LcuFrame[],
	participantIds: number[],
	ms: number
): number | null => {
	let sum = 0
	let any = false
	for (const pid of participantIds) {
		const g = interpScalar(frames, pid, ms, "totalGold")
		if (g !== null) {
			sum += g
			any = true
		}
	}
	return any ? sum : null
}

/** Frames strictly inside a game-clock window, in ms. */
export const framesBetween = (
	frames: LcuFrame[],
	fromMs: number,
	toMs: number
): LcuFrame[] => frames.filter(f => f.timestamp >= fromMs && f.timestamp <= toMs)

/* ------------------------------------------------------------------ stats */

export const median = (xs: number[]): number => {
	if (xs.length === 0) return NaN
	const s = [...xs].sort((a, b) => a - b)
	const mid = s.length >> 1
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Linear-interpolated percentile (numpy's default method), `q` in [0,1]. */
export const percentile = (xs: number[], q: number): number => {
	if (xs.length === 0) return NaN
	const s = [...xs].sort((a, b) => a - b)
	if (s.length === 1) return s[0]!
	const pos = clamp(q, 0, 1) * (s.length - 1)
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

export const mean = (xs: number[]): number =>
	xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length

/** Sample standard deviation (n-1). `0` for n < 2. */
export const stdev = (xs: number[]): number => {
	if (xs.length < 2) return 0
	const m = mean(xs)
	return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

export const clamp = (n: number, lo: number, hi: number): number =>
	n < lo ? lo : n > hi ? hi : n

export const round = (n: number, dp = 0): number => {
	const f = 10 ** dp
	return Math.round(n * f) / f
}
