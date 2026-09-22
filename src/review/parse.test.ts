/**
 * `invented-trigger-clock` — the prose fence, and the corpus it was measured on.
 *
 * Every FIXTURE in this file is a RECORDED item: the `fix` strings are the exact bytes a real
 * coach wrote about a real game of his, and the moment ids beside them are that game's actual
 * digest ids, copied out of `data/eval/persona-ab-20260919-{flash,sonnet}.json`. A hand-written
 * fixture here would be worth very little, because the whole question this check had to answer is
 * what a real coach writes into a real `fix` — and the answer turned out to be "a whole-minute
 * window it was told about, or a spawn timer it made up", which nobody would have guessed.
 *
 * `data/eval` is gitignored, so the six flagged cases and their negatives are inlined above and
 * the whole-corpus replay at the bottom SKIPS when the files are not on this machine. The inline
 * cases are the regression test; the replay is the precision measurement, re-derivable.
 */

import { existsSync, readFileSync } from "node:fs"
import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildReview } from "./parse.ts"
import { baselineToken } from "./digest-contract.ts"
import type { CitationAllowlist } from "./digest-contract.ts"

const allowlist = (momentIds: string[], metricKeys: string[] = ["eliteControlPct"]): CitationAllowlist => ({
	momentIds: new Set(momentIds),
	metricKeys: new Set(metricKeys),
	baselineByMetric: new Map(),
	baselineFigures: new Set()
})

const review = (fix: string, allowed: CitationAllowlist, momentIds: string[] = [...allowed.momentIds].slice(0, 1)) =>
	buildReview({
		raw: {
			headline: "h",
			encouragement: "e",
			items: [
				{
					title: "0% objective control, losing all 3 grubs before 10:00",
					fix,
					body: "",
					severity: "major",
					category: "objectives",
					tSec: 500,
					momentIds,
					metricKeys: []
				}
			],
			goals: ["g"]
		},
		kind: "game",
		gameId: 1,
		model: "m",
		promptHash: "p",
		allowed
	})

const clockWarnings = (r: ReturnType<typeof review>) =>
	r.warnings.filter(w => w.code === "invented-trigger-clock").map(w => w.message)

/* Real digests, real ids. See the header. */
const G5644549844 = allowlist([
	"g5644549844-death-224",
	"g5644549844-death-425",
	"g5644549844-death-912",
	"g5644549844-death-1137",
	"g5644549844-objective_missed-531",
	"g5644549844-objective_missed-748",
	"g5644549844-objective_missed-1067",
	"g5644549844-objective_missed-1394",
	"g5644549844-positioning-720",
	"g5644549844-teamfight-1229"
])
const G5643993063 = allowlist([
	"g5643993063-kill-267",
	"g5643993063-kill-390",
	"g5643993063-objective-550",
	"g5643993063-death-764",
	"g5643993063-death-859",
	"g5643993063-kill-931",
	"g5643993063-objective-1078",
	"g5643993063-death-1128"
])
const G5644057279 = allowlist([
	"g5644057279-objective-415",
	"g5644057279-death-481",
	"g5644057279-positioning-720",
	"g5644057279-teamfight-751",
	"g5644057279-objective-931",
	"g5644057279-death-1255",
	"g5644057279-objective-1415",
	"g5644057279-death-1469",
	"g5644057279-teamfight-1591",
	"g5644057279-objective-1800",
	"g5644057279-death-1899",
	"g5644057279-death-2065"
])

describe("invented-trigger-clock", () => {
	it("flags the fix AGENTS.md names by example", () => {
		// Recorded: flash run, new arm, game 5644549844 item 0. All three judges called it
		// unsupported and two of them quoted the 5:30 back.
		const w = clockWarnings(
			review("Start moving to the grub pit at 5:30 so you can contest or trade early map objectives.", G5644549844)
		)
		strictEqual(w.length, 1)
		const msg = w[0] ?? ""
		ok(msg.includes("5:30"), msg)
		ok(msg.includes("no spawn table"), msg)
	})

	it("flags a spawn timer stated as a fact about the game", () => {
		// Recorded: sonnet run, new arm, game 5644057279 item 2 — "the 8:30 grub spawn".
		const w = clockWarnings(
			review(
				"Treat the 8:30 grub spawn like a second drake timer — contest at least one voidgrub instead of letting the trio go.",
				G5644057279
			)
		)
		strictEqual(w.length, 1)
		ok((w[0] ?? "").includes("8:30"), w[0] ?? "no warning")
	})

	it("flags both ends of an invented window, once each", () => {
		// Recorded: sonnet run, game 5644219249 item 0.
		const w = clockWarnings(
			review(
				"Show up for at least one grub in that 9:30-9:50 wave instead of ceding all three to Volibear's side.",
				allowlist([
					"g5644219249-death-221",
					"g5644219249-death-460",
					"g5644219249-death-625",
					"g5644219249-death-769",
					"g5644219249-positioning-840",
					"g5644219249-teamfight-894",
					"g5644219249-death-987",
					"g5644219249-teamfight-1092"
				])
			)
		)
		strictEqual(w.length, 2)
	})

	it("does NOT flag the persona's own window — the exemption the corpus forced", () => {
		// 45 of the 293 recorded fixes carry a whole-minute clock and this is what they look like.
		// Without the exemption this check fires on all 45 at 47% precision (21 true, 24 false).
		for (const fix of [
			"From 10:00 to 15:00, farm your safe jungle camps and cross the river only with a teammate on screen.",
			"Cross the river after 10:00 only with vision or a teammate on your screen.",
			"Stop face-checking mid lane past 20:00 without Prance stacks or team backup."
		])
			strictEqual(clockWarnings(review(fix, G5644549844)).length, 0, fix)
	})

	it("does NOT flag a real moment quoted one second off", () => {
		// Recorded: flash run, game 5643993063 item 0, judged SUPPORTED by all three. The moment
		// id is `…-1078` (17:58) and the coach wrote 17:57. At tolerance 0 this is a false
		// positive; it is the reason the tolerance is 5s.
		strictEqual(
			clockWarnings(review("Keep locking down neutral spawns on timer like you did at Herald at 17:57.", G5643993063)).length,
			0
		)
		// …and 18:56 against `g5644549844-death-1137` (18:57), the other one.
		strictEqual(
			clockWarnings(
				review("After getting collapsed on by 4 (like at 18:56), disengage instead of joining the next 5v5.", G5644549844)
			).length,
			0
		)
	})

	it("stays quiet when the digest has no moments at all", () => {
		// A trend review has an empty `momentIds`. A fence that cannot tell "no evidence" from
		// "contradicted" would flag every item in the review.
		const r = buildReview({
			raw: {
				headline: "h",
				encouragement: "e",
				items: [
					{
						title: "t",
						fix: "Be at the grub pit by 5:30 next game.",
						body: "",
						severity: "minor",
						tSec: null,
						momentIds: [],
						metricKeys: ["csPerMin"]
					}
				],
				goals: ["g"]
			},
			kind: "trend",
			gameId: null,
			model: "m",
			promptHash: "p",
			allowed: allowlist([], ["csPerMin"])
		})
		strictEqual(r.warnings.filter(w => w.code === "invented-trigger-clock").length, 0)
	})

	it("reads the clock out of a suffixed moment id", () => {
		// `makeMomentId` allows `g<id>-<kind>-<tSec>-<suffix>`. Nothing in the stored corpus uses
		// one, so this is the case a format change would break silently.
		strictEqual(clockWarnings(review("Be at the pit by 8:20.", allowlist(["g1-objective-500-2"]))).length, 0)
	})

	it("warns rather than dropping, and the message reaches the item", () => {
		const r = review("Start moving to the grub pit at 5:30 so you can contest early objectives.", G5644549844)
		ok(r.ok)
		strictEqual(r.value.items.length, 1, "a flagged item still ships")
		ok(r.value.items[0]?.warnings?.some(m => m.includes("5:30")), "the reader sees which figure could not be checked")
	})
})

/* ================================================== the precision measurement, replayed */

/**
 * The whole stored corpus, if it is on this machine: 293 items from the persona A/B, joined to
 * the three judged files. This is the same join `data/eval/parse-prose-fence-20260922.json`
 * records; keeping it runnable is what makes that file a measurement rather than a claim.
 */
const CORPUS = [
	["data/eval/persona-ab-20260919-flash.json", "flash"],
	["data/eval/persona-ab-20260919-sonnet.json", "sonnet"]
] as const
const JUDGED: Record<string, string[]> = {
	flash: [
		"data/eval/persona-ab-20260919-flash-judged-claude-opus-5.json",
		"data/eval/persona-ab-20260919-flash-judged-claude-sonnet-5-uncapped.json",
		"data/eval/persona-ab-20260919-flash-judged-gemini-3.6-flash.json"
	],
	sonnet: [
		"data/eval/persona-ab-20260919-sonnet-judged-claude-opus-5.json",
		"data/eval/persona-ab-20260919-sonnet-judged-claude-sonnet-5.json",
		"data/eval/persona-ab-20260919-sonnet-judged-gemini-3.6-flash.json"
	]
}

const haveCorpus = [...CORPUS.map(c => c[0]), ...Object.values(JUDGED).flat()].every(existsSync)

describe("invented-trigger-clock over the stored A/B corpus", { skip: haveCorpus ? false : "data/eval is gitignored" }, () => {
	it("flags 6 of 293, all majority-unsupported, none in the old arm", () => {
		interface Row {
			arm: string
			gameId: number
			index: number
			fix?: string
			momentIds?: string[]
		}
		let items = 0
		let flagged = 0
		let flaggedBad = 0
		let flaggedOldArm = 0
		let majorityUnsupported = 0

		for (const [path, run] of CORPUS) {
			const runJson = JSON.parse(readFileSync(path, "utf8")) as {
				items: Row[]
				userPrompts: Record<string, string>
			}
			const bad = new Map<string, number>()
			for (const jf of JUDGED[run] ?? []) {
				const j = JSON.parse(readFileSync(jf, "utf8")) as { verdicts: (Row & { supported?: boolean })[] }
				for (const v of j.verdicts) {
					const k = `${v.arm}/${v.gameId}/${v.index}`
					if (!v.supported) bad.set(k, (bad.get(k) ?? 0) + 1)
				}
			}
			// The digest's moment ids, recovered from the rendered prompt the coach actually saw.
			const idsOf = (gameId: number): string[] => [
				...new Set(
					[...(runJson.userPrompts[String(gameId)] ?? "").matchAll(/id: `([^`]+)`/g)].map(m => m[1] ?? "")
				)
			]

			for (const row of runJson.items) {
				items++
				const isBad = (bad.get(`${row.arm}/${row.gameId}/${row.index}`) ?? 0) >= 2
				if (isBad) majorityUnsupported++
				const r = review(row.fix ?? "", allowlist(idsOf(row.gameId)), [])
				if (clockWarnings(r).length === 0) continue
				flagged++
				if (isBad) flaggedBad++
				if (row.arm === "old") flaggedOldArm++
			}
		}

		strictEqual(items, 293)
		strictEqual(majorityUnsupported, 54)
		strictEqual(flagged, 6)
		strictEqual(flaggedBad, 6, "precision 6/6 — a false positive here deletes correct coaching")
		strictEqual(flaggedOldArm, 0, "the rule fires only on the arm the re-aim introduced")
	})

	/**
	 * The OTHER prose fence, measured the same way for the first time.
	 *
	 * `baseline-mismatch` has been in the serious tier for months on the strength of two shipped
	 * examples and has never had a precision number. It has one now, and finding it cost one
	 * line of `quotes()`: the fence fired 5 times over these 293 items, 4 of them on items a
	 * majority of the three judges also called unsupported, and once on a faithful quote whose
	 * decimal had been TRUNCATED rather than rounded (3441.7 written "3,441"). Accepting
	 * truncation takes it to 4 for 4.
	 *
	 * The baselines here are reconstructed from the rendered prompt rather than from the digest
	 * rows, which no longer exist: `prompt.ts` writes `· <baselineText> ·` between the delta and
	 * the band, and `explain` on the next line, which is exactly the pair `allowlistOf` unions.
	 * It is a reconstruction, so treat a one-flag drift here as a rendering change to chase
	 * rather than as a regression.
	 */
	it("baseline-mismatch flags 4 of 293, all majority-unsupported", () => {
		interface Row {
			arm: string
			gameId: number
			index: number
			title?: string
			fix?: string
			body?: string
			severity?: string
			category?: string
			tSec?: number | null
			momentIds?: string[]
			metricKeys?: string[]
		}
		const figures = (t: string): string[] => [...t.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map(m => baselineToken(m[0]))
		let flagged = 0
		let flaggedBad = 0

		for (const [path, run] of CORPUS) {
			const runJson = JSON.parse(readFileSync(path, "utf8")) as { items: Row[]; userPrompts: Record<string, string> }
			const bad = new Map<string, number>()
			for (const jf of JUDGED[run] ?? []) {
				const j = JSON.parse(readFileSync(jf, "utf8")) as { verdicts: (Row & { supported?: boolean })[] }
				for (const v of j.verdicts)
					if (!v.supported) bad.set(`${v.arm}/${v.gameId}/${v.index}`, (bad.get(`${v.arm}/${v.gameId}/${v.index}`) ?? 0) + 1)
			}
			const cache = new Map<string, CitationAllowlist>()
			const allowedFor = (gameId: number): CitationAllowlist => {
				const key = String(gameId)
				const hit = cache.get(key)
				if (hit) return hit
				const lines = (runJson.userPrompts[key] ?? "").split("\n")
				const byMetric = new Map<string, Set<string>>()
				const all = new Set<string>()
				for (const [i, line] of lines.entries()) {
					const m = /^- key: `([^`]+)` — .*? · vs your own average: [^·]*(?:· (.*?))? · band .* · confidence \w+$/.exec(line)
					if (!m?.[1]) continue
					const set = new Set([...figures(m[2] ?? ""), ...figures(lines[i + 1] ?? "")])
					for (const f of set) all.add(f)
					byMetric.set(m[1], set)
				}
				const built: CitationAllowlist = {
					momentIds: new Set([...(runJson.userPrompts[key] ?? "").matchAll(/id: `([^`]+)`/g)].map(x => x[1] ?? "")),
					metricKeys: new Set(byMetric.keys()),
					baselineByMetric: byMetric,
					baselineFigures: all
				}
				cache.set(key, built)
				return built
			}

			for (const row of runJson.items) {
				const r = buildReview({
					raw: {
						headline: "h",
						encouragement: "e",
						items: [{ ...row, momentIds: row.momentIds ?? [], metricKeys: row.metricKeys ?? [] }],
						goals: ["g"]
					},
					kind: "game",
					gameId: row.gameId,
					model: "m",
					promptHash: "p",
					allowed: allowedFor(row.gameId)
				})
				if (r.warnings.filter(w => w.code === "baseline-mismatch").length === 0) continue
				flagged++
				if ((bad.get(`${row.arm}/${row.gameId}/${row.index}`) ?? 0) >= 2) flaggedBad++
			}
		}

		strictEqual(flagged, 4)
		strictEqual(flaggedBad, 4, "zero false positives once a truncated decimal counts as a faithful quote")
	})
})
