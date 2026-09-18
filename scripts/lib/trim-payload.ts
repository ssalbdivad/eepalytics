/**
 * REMOVE A SECTION FROM A BUILT PAYLOAD, so a bench can ask what it was worth.
 *
 * ## Why this is a post-process and not an option on `buildBrief`
 *
 * `live-brief.ts` is the shipped payload and every stored measurement in this repo was taken on the
 * bytes it produces. A `drop` parameter there would be a fifth way for a future edit to change what
 * the coach is holding without meaning to. This cuts the rendered text instead, by section header,
 * so the arm under test is provably the shipped payload MINUS a named section and nothing else —
 * and when a cut wins, the change to `live-brief.ts` is written afterwards, deliberately.
 *
 * ## The presets, and the evidence each one rests on
 *
 * From `data/eval/section-yield-20260918.json`, 3,474 blind-judged lines across five corpora:
 *
 *  - `log` — the EVENT LOG is 22% of the payload and 79% of its lines are older than three
 *    minutes. Attribution credited the old half with 4 useful lines in 2,807 once the age digits
 *    were gated out. This keeps the last `EVENT_RECENT_SEC` seconds and drops the rest.
 *  - `dead` — `HIS OWN BASELINES` (never spoken: zero lines in 3,649 contain "average", "usual",
 *    "baseline" or "normally"), the kill-participation half of `JOINS` (zero lines contain
 *    "participation"), and `THE GAME SO FAR` (0.3 integers a turn that no other section carries).
 *  - `both` — the two together, about a third of the payload.
 *
 * Each preset states what it removes in `TRIMS` so a run file names its own cut.
 */

/** Where the event log stops being the present and starts being history. */
export const EVENT_RECENT_SEC = 180

export interface Trim {
	id: string
	what: string
	/** Whole sections removed, matched on the first line of the section. */
	sections: readonly string[]
	/** Keep only event-log lines at most this old, or null to keep the log whole. */
	eventMaxAgeSec: number | null
	/** Drop JOINS lines matching this, or null to keep JOINS whole. */
	dropJoinLines: RegExp | null
}

export const TRIMS: Record<string, Trim> = {
	log: {
		id: "log",
		what: "EVENT LOG truncated to the last 180 seconds",
		sections: [],
		eventMaxAgeSec: EVENT_RECENT_SEC,
		dropJoinLines: null
	},
	dead: {
		id: "dead",
		what: "HIS OWN BASELINES, THE GAME SO FAR and the kill-participation line of JOINS removed",
		sections: ["HIS OWN BASELINES", "THE GAME SO FAR"],
		eventMaxAgeSec: null,
		dropJoinLines: /kill participation/i
	},
	both: {
		id: "both",
		what: "the `dead` sections removed AND the EVENT LOG truncated to 180s",
		sections: ["HIS OWN BASELINES", "THE GAME SO FAR"],
		eventMaxAgeSec: EVENT_RECENT_SEC,
		dropJoinLines: /kill participation/i
	}
}

/** `- 21:40 (5m30s ago) Zed killed Lillia` -> 330. Null when the line is not an event. */
export const eventAgeSec = (line: string): number | null => {
	const m = line.match(/^- \d+:\d\d \((?:(\d+)m)?(\d+)s ago\)/)
	if (m === null) return null
	return (m[1] === undefined ? 0 : Number(m[1]) * 60) + Number(m[2])
}

/**
 * The payload with `trim` applied. `null` returns the text untouched, so the control arm and the
 * shipped path go through the same call and cannot drift apart.
 */
export const trimPayload = (text: string, trim: Trim | null): string => {
	if (trim === null || text === "") return text
	const kept: string[] = []
	for (const section of text.split("\n\n")) {
		const head = section.split("\n")[0] ?? ""
		if (trim.sections.some(s => head.startsWith(s))) continue
		if (trim.eventMaxAgeSec !== null && head.startsWith("EVENT LOG")) {
			const lines = section.split("\n")
			const body = lines.slice(1).filter(l => {
				const age = eventAgeSec(l)
				return age === null || age <= trim.eventMaxAgeSec!
			})
			/*
			 * An empty log still gets its header and a line saying so. A section that silently
			 * vanishes when nothing is recent would make the cut arm ALSO a structure change, and
			 * the one thing an ablation may not do is vary two things.
			 */
			kept.push([lines[0]!, ...(body.length > 0 ? body : ["- nothing in the last 3 minutes"])].join("\n"))
			continue
		}
		if (trim.dropJoinLines !== null && head.startsWith("JOINS")) {
			const lines = section.split("\n")
			const body = lines.slice(1).filter(l => !trim.dropJoinLines!.test(l))
			if (body.length === 0) continue
			kept.push([lines[0]!, ...body].join("\n"))
			continue
		}
		kept.push(section)
	}
	return kept.join("\n\n")
}

/** The trim named by an arm modifier such as `cut-log`, or null when the arm carries none. */
export const trimFromMods = (mods: readonly string[]): Trim | null => {
	for (const mod of mods) {
		if (!mod.startsWith("cut-")) continue
		const trim = TRIMS[mod.slice(4)]
		if (trim === undefined) throw new Error(`unknown trim ${mod} — one of ${Object.keys(TRIMS).map(k => "cut-" + k).join(", ")}`)
		return trim
	}
	return null
}
