/**
 * What he does that the other jungler doesn't.
 *
 * ## Why this exists, and why it is not the pattern miner
 *
 * `clusterDeaths` ranks by LIFT, which finds combinations that are *surprising* within his own
 * deaths. That is the wrong question for coaching, and the failure is structural rather than a
 * tuning problem: a trait present in 56% of his deaths is his single largest behavioural
 * signature, and lift penalises it precisely for being common. Measured, the miner ranked "as the
 * first of your team to fall" — the rare polarity — above the trait that describes more than half
 * of how he dies.
 *
 * So this asks the complementary question: not "what is unusual for him", but "what does he do a
 * lot of, that a comparable player in the same games does less of".
 *
 * ## The control, and why it is not a ladder average
 *
 * The app says on screen that it compares against his own recent games and never against a ladder
 * average, and it means it — a ladder average pools different ranks, roles and patches into a
 * number that describes nobody.
 *
 * The **enemy jungler in his own games** is the opposite of that. Same patch, same matchmaking
 * bracket, same role, same fights, same map state, chosen by Riot rather than by us. It is the
 * only available answer to the question that actually separates a habit from a job description:
 * *is this me, or is this what junglers do?*
 *
 * That question is not academic. Of the three traits he named himself, the control killed one:
 * being collapsed on by three or more happens in 54% of his deaths and 50% of the enemy
 * jungler's, so it is the role and not the player. Without the comparison the app would have
 * coached the one thing that was not his problem.
 *
 * ## What it is careful about
 *
 * One player per game is a noisy control, and the enemy jungler is not a model of correct play —
 * he is simply someone doing the same job. So a difference must clear a real bar before it is
 * said out loud, and what comes out is phrased as a difference in habit, never as a verdict on
 * which player is better.
 */

/** The boolean facts compared. Each is read off the timeline; none is a judgement. */
export interface DeathTraitVector {
	/** A teammate had already gone down in the 20s before this death. */
	afterAllyDown: boolean
	/** Three or more enemies were credited with the kill. */
	collapsed: boolean
	/** At least a component's worth of gold was still in the pocket. */
	carryingGold: boolean
	/** No teammate was provably in the fight. */
	alone: boolean
}

export type DeathTraitKey = keyof DeathTraitVector

export interface TraitComparison {
	key: DeathTraitKey
	/** Said the way the coach would say it, in the second person. */
	label: string
	subjectRate: number
	controlRate: number
	subjectDeaths: number
	controlDeaths: number
	/** Two-proportion z. Positive means he does it MORE than the other jungler. */
	z: number
	/** Only true when it clears the bar below — the rest are kept for inspection, not for saying. */
	worthSaying: boolean
}

/**
 * The bar, and it is deliberately high.
 *
 * Four traits are tested, so a nominal 0.05 is really 0.05/4 ≈ 0.0125 once the family is
 * accounted for, which is |z| ≈ 2.5. Below that a difference is a coin landing the same way
 * twice, and a coach who says those things confidently is one you learn to discount.
 */
export const MIN_Z = 2.5

/** Below this there is not enough of either player to compare, whatever the rates look like. */
export const MIN_DEATHS = 30

const LABELS: Record<DeathTraitKey, (his: number, theirs: number) => string> = {
	afterAllyDown: (h, t) =>
		`${h}% of your deaths come within 20s of a teammate going down — the other jungler in those same games is at ${t}%`,
	collapsed: (h, t) =>
		`${h}% of your deaths are to three or more enemies, against ${t}% for the other jungler`,
	carryingGold: (h, t) =>
		`${h}% of the time you die you still have 800g or more in your pocket — the other jungler ${t}%`,
	alone: (h, t) =>
		`${h}% of your deaths have no teammate provably in the fight, against ${t}%`
}

const pct = (x: number): number => Math.round(x * 100)

/**
 * Compare two populations of deaths, trait by trait.
 *
 * Pure: takes the vectors, returns the comparison, and knows nothing about timelines or games —
 * which is what lets the bar be asserted in a test rather than eyeballed on real data.
 */
export const compareDeathTraits = (
	subject: readonly DeathTraitVector[],
	control: readonly DeathTraitVector[]
): TraitComparison[] => {
	const keys: DeathTraitKey[] = ["afterAllyDown", "collapsed", "carryingGold", "alone"]
	const out: TraitComparison[] = []

	for (const key of keys) {
		const a = subject.filter(d => d[key]).length
		const b = control.filter(d => d[key]).length
		const na = subject.length
		const nb = control.length
		if (na === 0 || nb === 0) continue

		const pa = a / na
		const pb = b / nb
		// Pooled two-proportion z. Zero variance (both 0% or both 100%) means no difference to test.
		const pooled = (a + b) / (na + nb)
		const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb))
		const z = se > 0 ? (pa - pb) / se : 0

		out.push({
			key,
			label: LABELS[key](pct(pa), pct(pb)),
			subjectRate: pa,
			controlRate: pb,
			subjectDeaths: na,
			controlDeaths: nb,
			z,
			// Only ever surfaced when he does it MORE: "you die alone less often than they do" is
			// true, and is not a thing to work on.
			worthSaying: z >= MIN_Z && na >= MIN_DEATHS && nb >= MIN_DEATHS
		})
	}

	return out.sort((x, y) => y.z - x.z)
}

/**
 * The caveat that travels with these numbers, wherever they are shown.
 *
 * Not decoration. The control is one player per game and is not a model of correct play — he is
 * someone doing the same job, badly or well. The comparison is evidence that a habit is HIS
 * rather than the role's; it is not evidence that the other player was right.
 */
export const TRAIT_CAVEAT =
	"Compared against the enemy jungler in those same games — same patch, same rank, same fights. " +
	"That answers whether a habit is yours or just what junglers do. It does not mean the other " +
	"jungler played it correctly."
