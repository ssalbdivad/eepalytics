/**
 * How much of a game we actually watched, and therefore what we are allowed to say about it.
 *
 * ## The rule this exists to enforce
 *
 * A game with frames may be graded and coached. A game without frames gets numbers and nothing
 * else — no grade, no feedback items, no goals, no judgement of any kind.
 *
 * That is not a UI preference, it is the structural version of a lesson this app learned the
 * expensive way. For most of its life it produced confident coaching from a per-minute timeline
 * that could not support it: "clear faster, you need to use more abilities" said to someone using
 * abilities on cooldown, from data containing no abilities. Making judgement *impossible* without
 * evidence is the only fix that survives a prompt rewrite.
 *
 * ## Why coverage is not span, and why that distinction is the whole module
 *
 * The obvious metric is wrong in a way that quietly defeats the rule. Both
 *
 *     frameSpanSec / gameDurationSec          (span)
 *     framesWritten / framesExpectedInSpan    (density inside the span)
 *
 * are satisfied by a handful of frames clustered at the start plus one near the end: five frames
 * between 2:00 and 4:00 and one at 34:00 gives a span ratio of 0.91 for a game nobody watched.
 * That would unlock grading on almost anything, which is exactly the failure mode the tier is
 * built to prevent.
 *
 * So coverage is measured the only way that means what it says: cut the game into fixed buckets
 * and count how many of them contain at least one frame. Clustering cannot inflate it, because a
 * hundred frames in one bucket still fill one bucket.
 */

/** Buckets are 30s. Fine enough that a gap is visible, coarse enough to tolerate a dropped frame. */
export const BUCKET_SEC = 30

/**
 * Coverage needed to grade. 0.6 is deliberately not 0.9: the player alt-tabs, the share drops, a
 * loading screen eats the first minute. Two thirds of a game watched is enough to coach it, and
 * demanding near-perfection would mean the graded tier almost never fires — which is the same as
 * not building it.
 */
export const WATCHED_MIN_COVERAGE = 0.6

/**
 * And a floor on the absolute count, because coverage alone is unstable for short games: a 4
 * minute remake is 8 buckets, where 5 frames would "cover" 0.63 of it.
 */
export const WATCHED_MIN_FRAMES = 40

export type EvidenceTier = "numbers" | "watched"

export interface Evidence {
	tier: EvidenceTier
	/** Fraction of 30s buckets in the game that contain at least one frame. 0..1. */
	coverage: number
	frames: number
	buckets: number
	bucketsCovered: number
	/** Why it is not `watched`, for the UI to say plainly. Null when it is. */
	shortfall: string | null
}

export interface EvidenceInput {
	/** Game clock seconds at which frames were captured. Unordered, duplicates fine. */
	frameTimesSec: readonly number[]
	/** The game's length. Frames beyond it are ignored rather than trusted. */
	gameDurationSec: number
}

/**
 * Pure, and deliberately so: this is the one definition of "did we watch this", it decides whether
 * the app is allowed to judge, and it must be assertable without a database or a League client.
 */
export const evidenceOf = (input: EvidenceInput): Evidence => {
	const duration = Math.max(0, Math.floor(input.gameDurationSec))
	const buckets = Math.max(1, Math.ceil(duration / BUCKET_SEC))

	const covered = new Set<number>()
	let frames = 0
	for (const t of input.frameTimesSec) {
		// A frame outside the game is not evidence about the game. Loading screens produce these.
		if (!Number.isFinite(t) || t < 0 || t > duration) continue
		frames += 1
		covered.add(Math.min(buckets - 1, Math.floor(t / BUCKET_SEC)))
	}

	const coverage = covered.size / buckets
	const enough = coverage >= WATCHED_MIN_COVERAGE && frames >= WATCHED_MIN_FRAMES

	return {
		tier: enough ? "watched" : "numbers",
		coverage,
		frames,
		buckets,
		bucketsCovered: covered.size,
		shortfall:
			enough ? null
			: frames === 0 ? "no frames — the screen wasn't shared for this game"
			: frames < WATCHED_MIN_FRAMES ?
				`only ${frames} frames (needs ${WATCHED_MIN_FRAMES})`
			:	`only ${Math.round(coverage * 100)}% of the game was on screen (needs ${Math.round(
					WATCHED_MIN_COVERAGE * 100
				)}%)`
	}
}

/**
 * What the UI says about a tier. Kept here so the phrasing cannot drift between the games list,
 * the debrief and the review — and phrased so the ungraded tier reads as a consequence of how the
 * game was played, never as the app being broken or the player being at fault.
 */
export const TIER_LABEL: Record<EvidenceTier, string> = {
	numbers: "Numbers only",
	watched: "Watched"
}

export const TIER_EXPLAIN: Record<EvidenceTier, string> = {
	numbers:
		"Nobody watched this one, so it gets facts and no opinions — the timeline records positions once a minute and knows nothing about how you actually played. Share your screen next game and it can be graded.",
	watched:
		"Your screen was shared for this game, so the coach could watch it. That is the only reason it is allowed to grade you or talk about how a fight went."
}
