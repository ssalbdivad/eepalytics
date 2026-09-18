/**
 * The tombstone's own tripwire.
 *
 * `legacy-clauses.ts` is the only surviving copy of the `## Live coaching` sections that
 * `knowledge/champions/*.md` carried before those files were deleted on 2026-09-18. Two measured
 * arms — `fenced` and `cite-or-quiet` — were run against exactly those bytes, and AGENTS.md's
 * numbers for them are quotable only while the bytes hold. Nothing else in the repo can notice if
 * they move: the markdown they came from is gone, so there is nothing left to diff against.
 *
 * So the digests are pinned here. An edit to a section fails this file and has to argue for itself
 * in a diff, which is the whole mechanism. The digests are of the AS-MEASURED text; the shipped text
 * is checked separately, as the as-measured text minus exactly the recorded retractions.
 */

import { createHash } from "node:crypto"
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { ADVICE_KINDS, parseChampionClauses } from "../shared/champion-advice.ts"
import {
	LEGACY_CLAUSE_SECTIONS,
	RETRACTIONS,
	ROLE_DEFAULT_KEY,
	legacyClauseKeys,
	legacyClauseSection,
	retractionsFor,
	shippedClauseSection
} from "./legacy-clauses.ts"

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16)

/**
 * Taken on 2026-09-18 from `knowledge/champions/*.md` at commit 96a6c49, the last commit in which
 * those files existed. `git show 96a6c49:knowledge/champions/lillia.md` still reproduces them.
 */
const PINNED: Record<string, { sha: string; chars: number }> = {
	_default: { sha: "70de81ba86cfc482", chars: 2936 },
	belveth: { sha: "543cfbeca47b11bc", chars: 2966 },
	leesin: { sha: "083ae4ea63af9ef4", chars: 2965 },
	lillia: { sha: "8115474b47e2928e", chars: 3042 },
	trundle: { sha: "01e67c05ba6eb97c", chars: 3051 }
}

describe("the frozen clause corpus", () => {
	it("holds exactly the five sections that existed, and nothing new", () => {
		deepStrictEqual(legacyClauseKeys(), Object.keys(PINNED).sort())
	})

	it("is byte-identical to the markdown the arms were measured on", () => {
		for (const [key, pin] of Object.entries(PINNED)) {
			const section = legacyClauseSection(key)
			strictEqual(
				section.length,
				pin.chars,
				`${key}'s section changed length. It is the only copy of what \`fenced\` and \`cite-or-quiet\` ` +
					`were measured on — if this is deliberate, those runs no longer describe what ships and the ` +
					`numbers in AGENTS.md have to come down with it.`
			)
			strictEqual(sha(section), pin.sha, `${key}'s section was edited`)
		}
	})

	it("parses, so the freeze did not quietly cost a clause", () => {
		for (const key of legacyClauseKeys()) {
			const clauses = parseChampionClauses(legacyClauseSection(key))
			const n = ADVICE_KINDS.reduce((sum, k) => sum + (clauses[k]?.length ?? 0), 0)
			ok(n > 0, `${key} parses to no clauses at all`)
		}
	})

	it("keeps every kind answerable from the role default, which is what the merge falls back on", () => {
		const role = parseChampionClauses(shippedClauseSection(ROLE_DEFAULT_KEY))
		for (const kind of ADVICE_KINDS) ok((role[kind]?.length ?? 0) > 0, `the role default has nothing for "${kind}"`)
	})
})

describe("the retractions", () => {
	it("each names a fetched source and what it is refuting", () => {
		ok(RETRACTIONS.length > 0, "nothing is retracted, so the shipped and measured corpora are the same text")
		for (const r of RETRACTIONS) {
			ok(r.source.trim().length > 40, `${r.clause}: no source quoted`)
			ok(r.why.trim().length > 40, `${r.clause}: no reason recorded`)
			ok(
				legacyClauseSection(r.key).includes(r.clause),
				`${r.clause} is retracted from a section that never contained it`
			)
		}
	})

	it("removes whole clause lines and leaves everything else byte-identical", () => {
		for (const key of legacyClauseKeys()) {
			const measured = legacyClauseSection(key).split("\n")
			const dropped = retractionsFor(key).map(r => r.clause)
			deepStrictEqual(
				shippedClauseSection(key).split("\n"),
				measured.filter(l => !dropped.some(c => l.trim().endsWith(c))),
				`${key}: the shipped section differs from the measured one by more than whole retracted lines`
			)
		}
	})

	it("leaves the shipped corpus with no clause a source contradicts", () => {
		for (const r of RETRACTIONS)
			strictEqual(shippedClauseSection(r.key).includes(r.clause), false, `still shipping: ${r.clause}`)
	})
})
