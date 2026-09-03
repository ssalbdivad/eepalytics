/**
 * "The three things to work on", derived from reviews you already paid for.
 *
 * ## Why this is computed rather than asked for
 *
 * Another model call to summarise N reviews would cost money, take a minute, and produce a
 * different answer each run. The reviews already contain the judgment — every item carries an
 * impact, an actionability, a confidence and a category. Aggregating those is arithmetic, so it
 * is instant, free, reproducible, and it can point at the exact items it came from.
 *
 * ## What makes something a focus area
 *
 * RECURRENCE, weighted by priority. One bad game is a bad game; the same category costing you
 * across four of the last ten is a habit, and habits are what coaching is for. A single
 * high-priority item does NOT become a focus area on its own — that is what the game's own
 * review is for, and promoting it here would just repeat the loudest recent thing.
 *
 * PURE. Callers supply the items.
 */

import type { FeedbackItem } from "../shared/schema/domain.ts"

/** Below this many distinct games, a category is an incident and not a pattern. */
export const MIN_GAMES_FOR_PATTERN = 2

export interface FocusArea {
	category: string
	/** How many distinct games this showed up in. The honesty number — always shown. */
	games: number
	/** Total items across those games. */
	occurrences: number
	/** Mean priority of the contributing items, 0-1. */
	weight: number
	/** The single highest-priority example, so the UI can link to a real moment. */
	exemplar: { gameId: number | null; title: string; fix: string }
	/** Every distinct fix suggested, most recent first — the actual advice, deduplicated. */
	fixes: string[]
}

/**
 * `items` should be the ranked feedback from the recent window, newest game first.
 *
 * Praise is excluded: "keep doing this" is not something to work on, and letting it compete
 * would push a genuine weakness off a three-slot list.
 */
export const focusAreas = (
	items: readonly (FeedbackItem & { gameId: number | null })[],
	limit = 3
): FocusArea[] => {
	const byCategory = new Map<string, (FeedbackItem & { gameId: number | null })[]>()
	for (const item of items) {
		const category = item.category ?? "other"
		if (category === "praise" || item.severity === "info") continue
		// An item the coach was not confident about should not become a training focus.
		if (item.confidence === "low") continue
		const list = byCategory.get(category)
		if (list) list.push(item)
		else byCategory.set(category, [item])
	}

	const areas: FocusArea[] = []
	for (const [category, list] of byCategory) {
		const games = new Set(list.map(i => i.gameId)).size
		if (games < MIN_GAMES_FOR_PATTERN) continue
		const sorted = [...list].sort((a, b) => b.priority - a.priority)
		const top = sorted[0]!
		areas.push({
			category,
			games,
			occurrences: list.length,
			weight: Math.round((list.reduce((s, i) => s + i.priority, 0) / list.length) * 100) / 100,
			exemplar: { gameId: top.gameId, title: top.title, fix: top.fix },
			fixes: [...new Set(sorted.map(i => i.fix).filter(f => f !== ""))].slice(0, 4)
		})
	}

	return areas
		// Recurrence first, then how much it cost. A cheap habit you repeat every game outranks
		// an expensive thing that happened twice.
		.sort((a, b) => b.games - a.games || b.weight - a.weight)
		.slice(0, limit)
}
