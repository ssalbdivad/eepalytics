/**
 * THE shared measurement primitives for `scripts/`. One implementation each, one place.
 *
 * Two things live here, and they are here for the same reason: both were written more than once,
 * and a second copy of either lets the repo quote two different numbers for one question.
 *
 * Wilson lives in `src/analysis/coach-score.ts` because the scorer ships it; this file is the
 * other half — the test that says whether a DIFFERENCE between two arms survives.
 *
 * ## Why it is here rather than in a harness
 *
 * It was written twice. `frame-value.ts` had `mcnemar(pairs)` and `adjudicate.ts` had
 * `mcnemarExact(a, b)`: the same two-sided exact binomial at p = 0.5 over the discordant pairs,
 * reached by two different summations, each with its own unit test. `compare-arms.ts` then
 * imported one of them FROM a harness, which is the import direction `scripts/README.md` rule 2
 * exists to forbid — a driver that imports a driver drags the whole run with it.
 *
 * Two implementations of one p-value is not a redundancy, it is a place where the repo can quote
 * two different numbers for the same comparison and nobody would know which was run.
 *
 * Both call shapes are kept because both are the natural one at their call site: an ablation has
 * the pairs, an adjudication has already counted the disagreements.
 */

/* ==================================================================== blinding */

/**
 * mulberry32, the one seeded generator in `scripts/`.
 *
 * Extracted out of `shuffled` unchanged — same arithmetic, same call order — because the
 * unpaired tests below resample and must do it reproducibly too. `scripts/lib/stats.test.ts`
 * pins the orderings `shuffled` produced before the extraction, so a drift here fails there.
 */
export const mulberry32 = (seed: number): (() => number) => {
	let a = seed >>> 0
	return (): number => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * A seeded shuffle, so "shuffled" means the same thing on a re-run.
 *
 * Every blinded harness here writes its seed into its key file so a second judging pass over the
 * same run sees the lines in the same order and the two passes can be compared line for line. That
 * only holds while there is ONE shuffle: this was written twice, byte-identical in behaviour but
 * not in source, as `blind-judge.ts`'s `shuffled` and `frame-value.ts`'s `shuffledBy`. Checked
 * before they were merged — 549 cases, lengths 0-60 against nine seeds spanning the u32 range,
 * zero disagreements — so every stored run's ordering is re-derivable from this function.
 *
 * mulberry32 over a Fisher-Yates walking down. Do not "improve" either half: the generator and the
 * direction of the loop are both part of the stored orderings, and changing one silently makes
 * every key file in `data/eval/` describe an order this code can no longer reproduce.
 *
 * `bench-stream.ts` deliberately keeps its own: it seeds from a STRING and uses a plain LCG, so its
 * sheets are re-derivable against a different sequence. Merging the two would rewrite that history.
 */
export const shuffled = <T,>(items: readonly T[], seed: number): T[] => {
	const rand = mulberry32(seed)
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		;[out[i], out[j]] = [out[j]!, out[i]!]
	}
	return out
}

/* ==================================================================== paired comparison */

/** The 2x2 of a paired comparison, plus the exact p-value on its discordant cells. */
export interface McNemar {
	/** a preferred, b preferred, and how many turns were decided the same way by both. */
	aOnly: number
	bOnly: number
	both: number
	neither: number
	p: number
}

/** log(n choose k), summed rather than via factorials so n in the hundreds does not overflow. */
const logChoose = (n: number, k: number): number => {
	let r = 0
	for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i)
	return r
}

/**
 * Two-sided exact binomial at p = 0.5 on `a` and `b` discordant pairs — McNemar's exact test.
 *
 * Exact rather than the chi-square approximation because the discordant counts here are routinely
 * under ten, which is exactly where the approximation's p-value is optimistic.
 */
export const mcnemarExact = (a: number, b: number): number => {
	const n = a + b
	if (n === 0) return 1
	const lo = Math.min(a, b)
	let tail = 0
	for (let k = 0; k <= lo; k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2)
	return Math.min(1, 2 * tail)
}

/** The same test from the raw pairs, carrying the 2x2 the reader has to see beside the p. */
export const mcnemar = (pairs: readonly { a: boolean; b: boolean }[]): McNemar => {
	const aOnly = pairs.filter(x => x.a && !x.b).length
	const bOnly = pairs.filter(x => !x.a && x.b).length
	const both = pairs.filter(x => x.a && x.b).length
	const neither = pairs.filter(x => !x.a && !x.b).length
	return { aOnly, bOnly, both, neither, p: mcnemarExact(aOnly, bOnly) }
}

/* ================================================================== unpaired comparison */

/**
 * Everything below answers ONE question: does a quantity measured on his won games differ from
 * the same quantity on his lost ones, and by how much, with an interval a reader can argue with.
 *
 * It is unpaired — there is no turn-for-turn correspondence between a win and a loss — so
 * McNemar above does not apply and nothing here is a substitute for it.
 *
 * Three deliberate choices:
 *
 *   RANKS, NOT MEANS, decide significance. Almost every jungle quantity on record here is
 *   skewed or bounded (deaths, camp share, gold in hand) and a handful of 40-minute games
 *   drag a mean around. Mann-Whitney asks only "is a randomly chosen won game higher than a
 *   randomly chosen lost one", which is also the only claim a coach can act on.
 *
 *   THE EFFECT SIZE IS AN AUC, because it is the same number as the test statistic
 *   (`U / n1n2`) and it reads in plain words: 0.50 is a coin flip, 0.70 means seven times in
 *   ten the won game is the higher one. Cohen's d is reported beside it for readers who want
 *   a mean difference, never instead of it.
 *
 *   THE INTERVALS ARE BOOTSTRAPPED, stratified within each group and seeded, so a re-run of a
 *   stored table reproduces it digit for digit. A normal-theory interval on a bounded count
 *   would reach past 0 and past 1.
 */

/** Φ(z), via the Numerical Recipes erfc — relative error under 1.2e-7, plenty for a p-value. */
export const normalCdf = (z: number): number => {
	const x = Math.abs(z) / Math.SQRT2
	const t = 1 / (1 + 0.5 * x)
	const y =
		t *
		Math.exp(
			-x * x -
				1.26551223 +
				t *
					(1.00002368 +
						t *
							(0.37409196 +
								t *
									(0.09678418 +
										t *
											(-0.18628806 +
												t *
													(0.27886807 +
														t *
															(-1.13520398 +
																t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
		)
	const erfc = z >= 0 ? y : 2 - y
	return 1 - erfc / 2
}

/** Midranks, so ties share a rank. Mann-Whitney's tie correction needs the tie group sizes too. */
const midranks = (xs: readonly number[]): { ranks: number[]; tieGroups: number[] } => {
	const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
	const ranks = new Array<number>(xs.length).fill(0)
	const tieGroups: number[] = []
	let i = 0
	while (i < order.length) {
		let j = i
		while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++
		const rank = (i + j) / 2 + 1
		for (let k = i; k <= j; k++) ranks[order[k]!.i] = rank
		if (j > i) tieGroups.push(j - i + 1)
		i = j + 1
	}
	return { ranks, tieGroups }
}

export interface MannWhitney {
	n1: number
	n2: number
	/** P(a random `a` > a random `b`) + half the ties. 0.5 is no separation. */
	auc: number
	/** `2 * auc - 1`. Signed, bounded, and the thing to quote as the effect size. */
	rankBiserial: number
	u: number
	z: number
	p: number
}

/**
 * Two-sided Mann-Whitney U with the tie correction and a continuity correction, normal
 * approximation. At the group sizes this repo has (dozens each) the approximation is
 * indistinguishable from the exact test; at n under about 8 per group it is optimistic, and
 * every caller here reports its n beside the p so a reader can see when that bites.
 */
export const mannWhitney = (a: readonly number[], b: readonly number[]): MannWhitney => {
	const n1 = a.length
	const n2 = b.length
	if (n1 === 0 || n2 === 0)
		return { n1, n2, auc: 0.5, rankBiserial: 0, u: 0, z: 0, p: 1 }
	const { ranks, tieGroups } = midranks([...a, ...b])
	let r1 = 0
	for (let i = 0; i < n1; i++) r1 += ranks[i]!
	const u = r1 - (n1 * (n1 + 1)) / 2
	const auc = u / (n1 * n2)
	const n = n1 + n2
	const tieTerm = tieGroups.reduce((s, t) => s + (t * t * t - t), 0)
	const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)))
	if (variance <= 0) return { n1, n2, auc, rankBiserial: 2 * auc - 1, u, z: 0, p: 1 }
	const z = (Math.abs(u - (n1 * n2) / 2) - 0.5) / Math.sqrt(variance)
	return {
		n1,
		n2,
		auc,
		rankBiserial: 2 * auc - 1,
		u,
		z,
		p: Math.min(1, 2 * (1 - normalCdf(z)))
	}
}

export interface Interval95 {
	point: number
	lo: number
	hi: number
}

const pct = (sorted: readonly number[], q: number): number =>
	sorted.length === 0 ? Number.NaN
	: sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!

/**
 * Percentile bootstrap of any two-sample statistic, resampling WITHIN each group so the group
 * sizes never move. Seeded: the same two arrays and the same seed give the same interval.
 */
export const bootstrap2 = (
	a: readonly number[],
	b: readonly number[],
	stat: (a: readonly number[], b: readonly number[]) => number,
	seed = 20260918,
	iters = 4000
): Interval95 => {
	const point = stat(a, b)
	if (a.length < 2 || b.length < 2) return { point, lo: Number.NaN, hi: Number.NaN }
	const rand = mulberry32(seed)
	const draws: number[] = []
	const ra = new Array<number>(a.length)
	const rb = new Array<number>(b.length)
	for (let it = 0; it < iters; it++) {
		for (let i = 0; i < a.length; i++) ra[i] = a[Math.floor(rand() * a.length)]!
		for (let i = 0; i < b.length; i++) rb[i] = b[Math.floor(rand() * b.length)]!
		const v = stat(ra, rb)
		if (Number.isFinite(v)) draws.push(v)
	}
	draws.sort((x, y) => x - y)
	return { point, lo: pct(draws, 0.025), hi: pct(draws, 0.975) }
}

export const meanOf = (xs: readonly number[]): number =>
	xs.length === 0 ? Number.NaN : xs.reduce((s, x) => s + x, 0) / xs.length

export const sdOf = (xs: readonly number[]): number => {
	if (xs.length < 2) return Number.NaN
	const m = meanOf(xs)
	return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1))
}

/** Pooled-SD standardised mean difference. Reported beside the AUC, never instead of it. */
export const cohensD = (a: readonly number[], b: readonly number[]): number => {
	if (a.length < 2 || b.length < 2) return Number.NaN
	const sa = sdOf(a)
	const sb = sdOf(b)
	const pooled = Math.sqrt(
		((a.length - 1) * sa * sa + (b.length - 1) * sb * sb) / (a.length + b.length - 2)
	)
	return pooled === 0 ? 0 : (meanOf(a) - meanOf(b)) / pooled
}

/**
 * Benjamini-Hochberg q-values, in the INPUT order.
 *
 * Thirty metrics tested at 0.05 produce about one and a half false positives by construction,
 * and the whole point of a table like this is that somebody will read the smallest p in it. BH
 * controls the expected share of false discoveries among the ones called; it does not make any
 * single q a probability that that metric is real.
 */
export const benjaminiHochberg = (ps: readonly number[]): number[] => {
	const m = ps.length
	if (m === 0) return []
	const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p)
	const q = new Array<number>(m).fill(1)
	let running = 1
	for (let k = m - 1; k >= 0; k--) {
		running = Math.min(running, (order[k]!.p * m) / (k + 1))
		q[order[k]!.i] = Math.min(1, running)
	}
	return q
}

/* ================================================================== logistic control */

export interface LogisticTerm {
	name: string
	/** Coefficient in log-odds PER STANDARD DEVIATION of that predictor, so terms compare. */
	beta: number
	se: number
	z: number
	p: number
	/** `exp(beta)` and its 95% Wald interval — the odds multiplier per SD. */
	oddsRatio: number
	orLo: number
	orHi: number
}

export interface LogisticFit {
	n: number
	terms: LogisticTerm[]
	iterations: number
	converged: boolean
}

/**
 * Newton-Raphson logistic regression on STANDARDISED predictors, with a tiny ridge on the
 * Hessian so a separated or collinear column returns a huge standard error instead of throwing.
 *
 * It exists for exactly one question in `what-wins.ts`: does a metric measured at ten minutes
 * still separate his wins from his losses once the scoreboard at ten minutes is in the model?
 * A metric that does not is a restatement of "he was already ahead", which is not coachable.
 *
 * With 140 games and two predictors this is comfortably estimable; it is NOT a model to read
 * coefficients off for ten predictors at once, and no caller here does that.
 */
export const logisticFit = (
	columns: readonly { name: string; values: readonly number[] }[],
	y: readonly number[],
	maxIter = 50
): LogisticFit => {
	const n = y.length
	const k = columns.length
	const mus = columns.map(c => meanOf(c.values))
	const sds = columns.map(c => {
		const s = sdOf(c.values)
		return Number.isFinite(s) && s > 0 ? s : 1
	})
	// Column 0 is the intercept; predictors follow, standardised.
	const x = (i: number, j: number): number =>
		j === 0 ? 1 : (columns[j - 1]!.values[i]! - mus[j - 1]!) / sds[j - 1]!
	const p = k + 1
	const beta = new Array<number>(p).fill(0)
	const ridge = 1e-6
	let iterations = 0
	let converged = false
	let cov: number[][] = []
	for (; iterations < maxIter; iterations++) {
		const grad = new Array<number>(p).fill(0)
		const hess = Array.from({ length: p }, () => new Array<number>(p).fill(0))
		for (let i = 0; i < n; i++) {
			let eta = 0
			for (let j = 0; j < p; j++) eta += beta[j]! * x(i, j)
			const mu = 1 / (1 + Math.exp(-eta))
			const w = Math.max(1e-8, mu * (1 - mu))
			for (let j = 0; j < p; j++) {
				grad[j] = grad[j]! + (y[i]! - mu) * x(i, j)
				for (let l = 0; l < p; l++) hess[j]![l] = hess[j]![l]! + w * x(i, j) * x(i, l)
			}
		}
		for (let j = 0; j < p; j++) hess[j]![j] = hess[j]![j]! + ridge
		const inv = invert(hess)
		if (!inv) break
		cov = inv
		let maxStep = 0
		for (let j = 0; j < p; j++) {
			let step = 0
			for (let l = 0; l < p; l++) step += inv[j]![l]! * grad[l]!
			beta[j] = beta[j]! + step
			maxStep = Math.max(maxStep, Math.abs(step))
		}
		if (maxStep < 1e-8) {
			converged = true
			iterations++
			break
		}
	}
	const terms: LogisticTerm[] = columns.map((c, idx) => {
		const j = idx + 1
		const b = beta[j] ?? Number.NaN
		const se = cov[j]?.[j] !== undefined ? Math.sqrt(Math.max(0, cov[j]![j]!)) : Number.NaN
		const z = se > 0 ? b / se : Number.NaN
		return {
			name: c.name,
			beta: b,
			se,
			z,
			p: Number.isFinite(z) ? Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) : Number.NaN,
			oddsRatio: Math.exp(b),
			orLo: Math.exp(b - 1.96 * se),
			orHi: Math.exp(b + 1.96 * se)
		}
	})
	return { n, terms, iterations, converged }
}

/** Gauss-Jordan with partial pivoting. `null` when the matrix is singular to working precision. */
const invert = (m: readonly number[][]): number[][] | null => {
	const n = m.length
	const a = m.map((row, i) => [
		...row,
		...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
	])
	for (let col = 0; col < n; col++) {
		let pivot = col
		for (let r = col + 1; r < n; r++)
			if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r
		if (Math.abs(a[pivot]![col]!) < 1e-12) return null
		;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
		const d = a[col]![col]!
		for (let j = 0; j < 2 * n; j++) a[col]![j] = a[col]![j]! / d
		for (let r = 0; r < n; r++) {
			if (r === col) continue
			const f = a[r]![col]!
			if (f === 0) continue
			for (let j = 0; j < 2 * n; j++) a[r]![j] = a[r]![j]! - f * a[col]![j]!
		}
	}
	return a.map(row => row.slice(n))
}
