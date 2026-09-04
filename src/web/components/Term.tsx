/**
 * Highlights League vocabulary in coach prose and defines it on hover.
 *
 * ## Why not just write simpler prose
 *
 * The coach says "cs", "gank", "prio". Replacing those with plain English would make the advice
 * useless the moment the reader hears the real word anywhere else — and it would patronise the
 * reader who already knows it. The vocabulary IS the thing being learned. So the words stay and
 * become askable.
 *
 * ## Why highlight each term only once per block
 *
 * Marking every occurrence turns a paragraph into a field of dotted underlines, which is worse
 * than not marking anything: the reader stops seeing them and the prose becomes hard to read.
 * First mention per block is where someone actually stops to ask.
 *
 * Matching is word-boundary anchored, so "prio" does not fire inside "priority" and "cs" does
 * not fire inside "css".
 */

import { Fragment, useMemo } from "react"
import { GLOSSARY, GLOSSARY_TERMS } from "../lib/glossary.ts"
import "./components.css"

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One regex over every term and alias, longest first so "full clear" beats "clear". */
const PATTERN = new RegExp(
	`\\b(${GLOSSARY_TERMS.map(t => escape(t.term)).join("|")})\\b`,
	"gi"
)

const keyFor = (matched: string): string | null =>
	GLOSSARY_TERMS.find(t => t.term.toLowerCase() === matched.toLowerCase())?.key ?? null

export interface GlossedProps {
	children: string
	/** Set false in dense places where the underlines would be noise. */
	enabled?: boolean
}

/**
 * Render text with the first mention of each known term marked and defined.
 *
 * Plain text in, React out — never `dangerouslySetInnerHTML`. The text is model output, and
 * building HTML from it would turn a prompt injection into script execution.
 */
export const Glossed = ({ children, enabled = true }: GlossedProps) => {
	const parts = useMemo(() => {
		if (!enabled || children === "") return [children]
		const seen = new Set<string>()
		const out: (string | { term: string; key: string })[] = []
		let last = 0
		for (const m of children.matchAll(PATTERN)) {
			const key = keyFor(m[0])
			if (key === null || seen.has(key)) continue
			seen.add(key)
			const at = m.index ?? 0
			if (at > last) out.push(children.slice(last, at))
			out.push({ term: m[0], key })
			last = at + m[0].length
		}
		if (last < children.length) out.push(children.slice(last))
		return out
	}, [children, enabled])

	return (
		<>
			{parts.map((part, i) =>
				typeof part === "string" ?
					<Fragment key={i}>{part}</Fragment>
				:	<abbr key={i} className="csk-term" title={GLOSSARY[part.key]?.definition}>
						{part.term}
					</abbr>
			)}
		</>
	)
}
