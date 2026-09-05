/**
 * Rescuing the journal's stored ground-truth blocks — the 1,280 frames with no raw sample.
 *
 * ## The two defects, and why only one of them is a defect
 *
 * `journal_frame.truthJson` holds the block the coach was actually handed at that instant. Those
 * blocks were rendered by `championOf` BEFORE it consulted `riotIdGameName`, so every name in the
 * `Just happened:` line arrived as a bare summoner name in a block whose every other line is
 * champions: measured here, **12,226 of 12,786 name slots across 1,809 stored blocks were raw riot
 * game names**, and the coach spoke them as champions ("You got Baron with Electrician"). That is
 * the defect this module repairs, and it is repairable because the post-game match blob knows
 * exactly which champion each riot ID played.
 *
 * The second thing that shows up in these blocks is NOT a defect and is deliberately left alone —
 * see `rosterDrift` below.
 *
 * ## Pure on purpose
 *
 * Blocks and a roster go in, a repaired block comes out. `scripts/expand-corpus.ts` owns the
 * SQLite reads and the file writes; everything decidable lives here so it can be tested against
 * the one game where the raw feed survives to check the answer.
 */

/** One participant, as the post-game match gives them: a riot ID and the champion they played. */
export interface RepairRosterEntry {
	participantId: number
	teamId: number
	championName: string
	/** `"Name#TAG"` as stored on `participant.riotId`. */
	riotId: string
	isUser: boolean
}

/**
 * The bare game name the EVENT feed sends — everything before the first `#`.
 *
 * Split on the FIRST `#`, not the last: a riot ID's tag line cannot contain `#`, but nothing stops
 * a game name from being odd, and taking the first split is the only reading that cannot silently
 * relocate the boundary.
 */
export const gameNameOf = (riotId: string): string => {
	const i = riotId.indexOf("#")
	return (i === -1 ? riotId : riotId.slice(0, i)).trim()
}

export interface EventRepair {
	/** The `Just happened:` payload with every resolvable name replaced by its champion. */
	text: string
	/** Names resolved by matching `participant.riotId`'s game name — the intended path. */
	byRiotId: number
	/**
	 * Names that were ALREADY a champion in this game.
	 *
	 * Not a fallback and not a guess: the Live Client Data API reports some accounts with an empty
	 * `riotIdGameName` and the champion name in `summonerName` (measured on three of eight games
	 * here — Viego, Kayn and Smolder), so the event feed named them by champion and the old
	 * renderer passed that straight through. It was already correct; it is counted separately so
	 * nobody reads this module's 100% resolution rate as 100% *mapped*.
	 */
	byChampionName: number
	/** Raw tokens that matched neither. They become `someone`, exactly as the shipped code does. */
	unresolved: string[]
	/** Segments dropped because neither side of a kill resolved — the shipped rule. */
	dropped: number
}

const TURRET = /^turret down \(/

/**
 * Resolve one name slot the way `championOf` in `src/server/routes/live.ts` does today.
 *
 * The sentinel matters more than the mapping: an unresolved name kept in the block is
 * indistinguishable from a hallucination once it has been spoken, so it never survives.
 */
const resolveOne = (
	who: string,
	byName: Map<string, string>,
	champions: Set<string>,
	tally: EventRepair
): string => {
	const mapped = byName.get(who)
	if (mapped !== undefined) {
		tally.byRiotId++
		return mapped
	}
	if (champions.has(who)) {
		tally.byChampionName++
		return who
	}
	tally.unresolved.push(who)
	return "someone"
}

/**
 * Repair the `Just happened:` payload — the semicolon-joined list of already-phrased events.
 *
 * Names are read out of the KNOWN SHAPES rather than substring-replaced across the line. The
 * shapes come from the renderer that wrote them (`X killed Y`, `<objective> taken by X`,
 * `turret down (...)`), and a substring pass would have been happy to rewrite the word "taken" for
 * a player called `ken`. Splitting on the shape and mapping whole tokens cannot do that.
 */
export const repairEventLine = (payload: string, roster: readonly RepairRosterEntry[]): EventRepair => {
	const byName = new Map<string, string>()
	for (const p of roster) {
		const g = gameNameOf(p.riotId)
		if (g !== "") byName.set(g, p.championName)
	}
	const champions = new Set(roster.map(p => p.championName))
	const out: EventRepair = { text: "", byRiotId: 0, byChampionName: 0, unresolved: [], dropped: 0 }
	if (payload.trim() === "") return out

	const known = (s: string): boolean => byName.has(s) || champions.has(s)
	const kept: string[] = []
	for (const seg of payload.split("; ")) {
		if (TURRET.test(seg)) {
			kept.push(seg)
			continue
		}
		const takenAt = seg.lastIndexOf(" taken by ")
		if (takenAt !== -1) {
			const who = seg.slice(takenAt + " taken by ".length)
			kept.push(`${seg.slice(0, takenAt)} taken by ${resolveOne(who, byName, champions, out)}`)
			continue
		}
		/*
		 * A kill. Find the " killed " that splits it into two names we recognise, rather than the
		 * first one — a riot game name may contain the word, and the roster is the only thing that
		 * can say where the boundary really is. Fall back to the sole occurrence so a line with an
		 * unknown name still reports its unknown name instead of being silently skipped.
		 */
		const marks: number[] = []
		for (let i = seg.indexOf(" killed "); i !== -1; i = seg.indexOf(" killed ", i + 1)) marks.push(i)
		if (marks.length === 0) {
			kept.push(seg)
			continue
		}
		const split =
			marks.find(i => known(seg.slice(0, i)) && known(seg.slice(i + " killed ".length))) ?? marks[0]!
		const k = resolveOne(seg.slice(0, split), byName, champions, out)
		const v = resolveOne(seg.slice(split + " killed ".length), byName, champions, out)
		/*
		 * Drop a kill nobody can be named in, exactly as the shipped renderer does. "someone killed
		 * someone" is not a fact, it is filler that pushes a real event out of the six-event window.
		 */
		if (k === "someone" && v === "someone") {
			out.dropped++
			continue
		}
		kept.push(`${k} killed ${v}`)
	}
	out.text = kept.join("; ")
	return out
}

/** The champion named in one roster cell — `"Jarvan IV lv8 2/3/1"` is `Jarvan IV`. */
const cellChampion = (cell: string): string =>
	cell
		.replace(/ lv\d+ \d+\/\d+\/\d+.*$/, "")
		.replace(/ \d+\/\d+\/\d+.*$/, "")
		.trim()

const rosterLine = (block: string, label: string): string[] | null => {
	const m = block.match(new RegExp(`^${label} (.*)$`, "m"))
	if (m === null) return null
	return m[1]!.split(" · ").map(cellChampion)
}

export interface RosterDrift {
	side: "allies" | "enemies"
	slot: number
	shown: string
	expected: string
}

/**
 * Where the stored roster disagrees with the post-game participant list, slot by slot.
 *
 * **This is a report, never a rewrite.** Measured across 1,809 stored blocks the two agree in
 * 1,787; every one of the 22 exceptions is in a single game and every one of them is Viego wearing
 * the champion he had just possessed — the block showed `Lillia` on the ENEMY team ten seconds
 * after the feed said `Viego killed Gooskaffur`, with Viego's own running KDA beside it. The
 * client was telling the truth about what was on screen, so "correcting" the name would replace a
 * faithful record with a tidier fiction and would also erase the one case a corpus most needs to
 * contain. The frames are kept, flagged, and the caller decides.
 *
 * Both lines are emitted in participantId order — verified on every stored block here — so a slot
 * comparison is a real comparison and not an alignment guess.
 */
export const rosterDrift = (block: string, roster: readonly RepairRosterEntry[]): RosterDrift[] => {
	const me = roster.find(p => p.isUser)
	if (!me) return []
	const expect = {
		allies: roster.filter(p => p.teamId === me.teamId && !p.isUser).map(p => p.championName),
		enemies: roster.filter(p => p.teamId !== me.teamId).map(p => p.championName)
	}
	const shown = { allies: rosterLine(block, "Your team:"), enemies: rosterLine(block, "Enemy team:") }
	const out: RosterDrift[] = []
	for (const side of ["allies", "enemies"] as const) {
		const got = shown[side]
		if (got === null) continue
		for (let i = 0; i < Math.max(got.length, expect[side].length); i++)
			if (got[i] !== expect[side][i])
				out.push({ side, slot: i, shown: got[i] ?? "(absent)", expected: expect[side][i] ?? "(absent)" })
	}
	return out
}

export interface BlockRepair {
	block: string
	events: EventRepair
	drift: RosterDrift[]
	/** False when the block carried no `Just happened:` line at all, so nothing was rewritten. */
	changed: boolean
}

/**
 * Repair one stored block: the event line, and nothing else.
 *
 * Everything else in a stored block is a figure the client reported at that instant and cannot be
 * recomputed without the raw sample this frame does not have. Rewriting only the line whose defect
 * is provable keeps the artefact honest about what it is — see the header of
 * `scripts/expand-corpus.ts` for the list of sections today's `renderState` emits that these
 * blocks predate.
 */
export const repairBlock = (block: string, roster: readonly RepairRosterEntry[]): BlockRepair => {
	const drift = rosterDrift(block, roster)
	const m = block.match(/^Just happened: (.*)$/m)
	if (m === null)
		return { block, events: { text: "", byRiotId: 0, byChampionName: 0, unresolved: [], dropped: 0 }, drift, changed: false }
	const events = repairEventLine(m[1]!, roster)
	/*
	 * An event line that repairs to nothing takes its heading with it. The renderer only emits
	 * `Just happened:` when it has something to say, and leaving a bare label behind would be a new
	 * gap in a block whose whole design is to have none.
	 */
	const replaced = events.text === "" ? "" : `Just happened: ${events.text}`
	const before = block.slice(0, m.index!)
	const after = block.slice(m.index! + m[0].length)
	return {
		block: (events.text === "" ? before.replace(/\n\n$/, "\n") + after.replace(/^\n/, "") : before + replaced + after),
		events,
		drift,
		changed: true
	}
}
