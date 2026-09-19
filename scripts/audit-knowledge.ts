/**
 * What is the champion knowledge in the prompts standing on? — `pnpm audit:knowledge [champion]`
 *
 * ## Why this is a script and not a paragraph in a report
 *
 * The claim this repo now makes about champion knowledge is that every sentence of it was copied
 * off a URL. That claim is worth exactly as much as the command that re-checks it, because the
 * previous claim — a four-line provenance header at the top of a markdown file — was also true
 * at the top and false by the third paragraph. `lillia.md` cited "op.gg jungle-paths (16.17)",
 * which is not an endpoint, and said the Swirlseed rolls over terrain and grants vision along its
 * path, which it does not. Nothing in the repo could tell, because a file-level citation does not
 * describe sentences.
 *
 * So this assembles the two prompts a player actually gets — the live system instruction and the
 * post-game CHAMPION CONTEXT — and audits the delivered bytes against the claim ledger that
 * produced them, line for line. An untraced line is one that reached the model without a source,
 * and it is the alarm this whole pipeline exists to raise.
 *
 * ## What it prints, in order
 *
 * 1. Every retracted or refuted sentence, probed against both prompts and the legacy clause path.
 *    These are the eighteen wrong claims the 2026-09-18 audit found, phrased as patterns.
 * 2. The line-level audit of the post-game block: claim lines, structural lines, untraced lines.
 * 3. The live block split into its champion half (must be fully cited) and its role half (prose,
 *    unsourced, labelled as such in the prompt — counted here so the number is never a surprise).
 * 4. The table's own diagnostics: what was REFUSED by `checkClaim` and what was WITHHELD because
 *    Data Dragon and the wiki disagreed.
 *
 * Exits 1 when the champion half of either prompt carries a line no claim produced, or when a
 * refuted sentence is back. Nothing here is a judgment call, so a red exit is a real regression.
 *
 * NODE ONLY. Reads no network: it audits what is on disk, which is the point.
 */

import { championBriefSync, championTableSync } from "../src/knowledge/champion-brief.ts"
import { championContext } from "../src/knowledge/champion-context.ts"
import { liveChampionKnowledge } from "../src/review/live-coach-knowledge.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { auditAssembled } from "../src/knowledge/provenance.ts"
import { RETRACTIONS } from "../src/knowledge/legacy-clauses.ts"
import { championKey } from "../src/knowledge/index.ts"

/**
 * The sentences the 2026-09-18 audit adjudicated WRONG against a fetched source, as patterns.
 *
 * Each one is quoted from the corpus it shipped in, with what the source says beside it. They are
 * patterns rather than exact strings because the failure worth catching is the CLAIM coming back in
 * new words, which is how "the seed reveals what it rolls past" survived four rewrites of one file.
 */
/*
 * `subject` is the champion the claim is ABOUT, and it is load-bearing rather than documentation.
 * These patterns were written against Lillia's file and probed only Lillia; run over the whole
 * roster they catch other champions saying true things in the same words — Riven's passive really
 * does deal "bonus damage to monsters" and the wiki really does say so, so probing her file with
 * Lillia's W pattern reports a fabrication that is a fetched fact. A probe is only meaningful about
 * the champion whose sentence it was written from.
 */
const REFUTED: { subject: string; pattern: RegExp; was: string; source: string }[] = [
	{
		subject: "Lillia",
		pattern: /rolls? over terrain|vision of what it rolls past|scouting ward|throw (?:it )?over a wall/i,
		was: "Lillia E rolls over terrain and grants vision of what it rolls past",
		source: "wiki Swirlseed: \"detonates upon hitting an enemy or terrain while on the ground\"; ddragon: \"rolls until it hits an enemy or collides with terrain\""
	},
	{
		subject: "Lillia",
		pattern: /reveals whoever it rolls into/i,
		was: "the two live clauses that taught the seed as a corridor scout",
		source: "retracted 2026-09-18; against terrain it detonates and reveals nobody"
	},
	{
		subject: "Lillia",
		pattern: /bonus damage to monsters/i,
		was: "Lillia W deals bonus damage to monsters",
		source: "wiki: W deals 50% damage to MINIONS; no monster modifier exists on W at all"
	},
	{
		subject: "Lillia",
		pattern: /every enemy hit grants a stack|each enemy hit grants a stack/i,
		was: "Lillia Q grants a Prance stack per enemy hit",
		source: "wiki: one stack per ability that hits AT LEAST ONE enemy, capped at 4"
	},
	{
		subject: "Lillia",
		pattern: /two-minute cooldown|two minute cooldown/i,
		was: "Lillia R has a two-minute cooldown",
		source: "wiki + ddragon: 150 / 130 / 110 seconds"
	},
	{
		subject: "Belveth",
		pattern: /stacks? (?:die|are lost|reset) with you/i,
		was: "Bel'Veth's stacks die with her",
		source: "wiki: Lavender stacks are permanent"
	},
	{
		subject: "Viego",
		pattern: /every enemy who dies near him leaves a wraith|including his own dead teammate/i,
		was: "every death near Viego leaves a possessable wraith",
		source: "wiki: only enemy champions Viego's team kills"
	}
]

/**
 * `--all`: the same three checks over EVERY champion in the table, as a roster summary.
 *
 * The single-champion report below is the one to read when something is wrong. This is the one that
 * says nothing is: the claim "no unsourced sentence reaches any prompt" is about 173 champions and
 * was only ever exercised on two, so it was a claim about Lillia wearing a claim about the corpus.
 * Counterparts are paired round-robin rather than fixed, so the live instruction under test is a
 * different pair every time and no champion is only ever checked as the subject.
 */
const auditRoster = (): never => {
	const load = championTableSync()
	const names = [...load.facts.values()].map(f => f.displayName).sort()
	let bad = 0
	let cited = 0
	let untraced = 0
	let missing = 0
	const failures: string[] = []
	for (const [i, name] of names.entries()) {
		const other = names[(i + 1) % names.length]!
		const ledger = championBriefSync(name)
		const text = championContext(name)
		if (!ledger || text === null) {
			missing += 1
			failures.push(`${name}: table row and committed file disagree about whether he exists`)
			continue
		}
		const report = auditAssembled(text, ledger)
		untraced += report.untraced.length
		cited += report.claimLines
		if (report.untraced.length > 0 || report.unsourcedClaims > 0) {
			bad += 1
			failures.push(`${name}: ${report.untraced.length} untraced, ${report.unsourcedClaims} unsourced — ${report.untraced[0] ?? ""}`)
		}
		const instruction = fullKnowledge({ champion: name, counterpart: other })
		const half = instruction.indexOf("\n# THE ROLE")
		const championHalf = half === -1 ? instruction : instruction.slice(0, half)
		const loose = championHalf
			.split("\n")
			.filter(l => l.trim().startsWith("- "))
			.filter(l => !/\[[^\]]+, fetched \d{4}-\d{2}-\d{2}\]$/.test(l.trim()))
			.filter(l => !/^- \w[\w-]*: .*https?:\/\//.test(l.trim()))
			// The WITHHELD notices cite nothing because they assert nothing — see `provenance.ts`.
			.filter(l => !l.trim().startsWith("- WITHHELD ("))
		if (loose.length > 0) {
			bad += 1
			failures.push(`${name}: ${loose.length} uncited lines in the live instruction — ${loose[0]!.slice(0, 80)}`)
		}
		for (const r of REFUTED.filter(r => championKey(r.subject) === championKey(name) || championKey(r.subject) === championKey(other)))
			if (r.pattern.test(text) || r.pattern.test(instruction)) {
				bad += 1
				failures.push(`${name}: a refuted claim is back — ${r.was}`)
			}
	}
	console.log(`# Champion knowledge audit — the whole roster\n`)
	console.log(`${names.length} champions · ${cited} cited lines in the committed files · ${untraced} untraced · ${missing} missing`)
	console.log(
		`${REFUTED.length} refuted sentences probed wherever their SUBJECT appears — as the champion of a ` +
			`file, or as the counterpart in a live instruction — which is ${new Set(REFUTED.map(r => r.subject)).size} champions ` +
			`across ${names.length * 2} blocks`
	)
	if (failures.length === 0) console.log(`\nOK — every line of every champion's prompt traces to a claim with a URL on it.`)
	else for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f}`)
	process.exit(failures.length === 0 ? 0 : 1)
}

if (process.argv.includes("--all")) auditRoster()

const champion = process.argv[2] ?? "Lillia"
const counterpart = process.argv[3] ?? "Kayn"

/*
 * TWO objects, and the gap between them is the check.
 *
 * `brief` is the LEDGER — what the renderer says every line of this champion's section is and where
 * it came from. `delivered` is the committed file in `knowledge/context/`, which is the only thing
 * the running app ever reads. Auditing the delivered bytes against the ledger is strictly stronger
 * than auditing the renderer's own output against itself: it catches a hand edit to a generated
 * file, which is exactly how the sentence this pipeline replaced got in.
 */
const brief = championBriefSync(champion)
const delivered = championContext(champion)
if (!brief) {
	console.error(
		`No fetched row for ${champion}. That is a legitimate state — it means the coach says nothing ` +
			`champion-specific — but there is nothing to audit. Run \`pnpm fetch:champions\` if you expected one.`
	)
	process.exit(1)
}

const live = fullKnowledge({ champion, counterpart })
const clauses = liveChampionKnowledge(champion)

let failures = 0

console.log(`# Champion knowledge audit — ${champion} vs ${counterpart}\n`)

console.log("## 1. Refuted sentences, probed against every path that reaches the model\n")
for (const r of REFUTED.filter(
	r => championKey(r.subject) === championKey(champion) || championKey(r.subject) === championKey(counterpart)
)) {
	const hits = [
		r.pattern.test(live) ? "LIVE" : null,
		delivered !== null && r.pattern.test(delivered) ? "POST-GAME" : null,
		r.pattern.test(clauses) ? "LEGACY-CLAUSES" : null
	].filter(x => x !== null)
	if (hits.length > 0) failures += 1
	console.log(`${hits.length > 0 ? `PRESENT in ${hits.join(", ")}` : "absent"} — ${r.was}`)
	console.log(`    source says: ${r.source}`)
}

console.log("\n## 2. The post-game CHAMPION CONTEXT block, line for line\n")
if (delivered === null) {
	console.error(
		`No committed context file for ${champion} in knowledge/context/. The table has a row and the ` +
			`tree does not — run \`pnpm generate:context\` and commit the diff.`
	)
	process.exit(1)
}
const audit = auditAssembled(delivered, brief)
console.log(`claim lines ${audit.claimLines} · structural lines ${audit.structureLines} · untraced ${audit.untraced.length} · unsourced claims ${audit.unsourcedClaims}`)
console.log(`oldest fetch anything here rests on: ${audit.oldestFetchedAt ?? "unknown"}`)
for (const u of audit.usage)
	console.log(`  ${u.claims.toString().padStart(3)} lines · ${u.source.publisher}, revision ${u.source.revision}, fetched ${u.source.fetchedAt.slice(0, 10)}\n        ${u.source.url}`)
if (audit.untraced.length > 0) {
	failures += 1
	console.log("\nUNTRACED — these reached the prompt without a claim behind them:")
	for (const l of audit.untraced.slice(0, 20)) console.log(`  ${l}`)
}

console.log("\n## 3. The live system instruction\n")
/*
 * Split at the role heading. Everything above it is the fetched champion material and must be fully
 * cited; the role file below it is prose, and the prompt says so where the model reads it. Counting
 * both halves here is the point — an unsourced line is fine when it is labelled and known, and the
 * way it stops being fine is nobody counting.
 */
const roleAt = live.indexOf("\n# THE ROLE")
const championHalf = roleAt === -1 ? live : live.slice(0, roleAt)
const roleHalf = roleAt === -1 ? "" : live.slice(roleAt)
const CITED = /\[[^\]]+, fetched \d{4}-\d{2}-\d{2}\]$/
const bullets = (text: string): string[] => text.split("\n").filter(l => l.trim().startsWith("- "))
const champBullets = bullets(championHalf)
const uncited = champBullets.filter(l => !CITED.test(l.trim()) && !/^- \w[\w-]*: .*https?:\/\//.test(l.trim()))
console.log(`champion half: ${championHalf.length} chars, ${champBullets.length} lines, ${champBullets.length - uncited.length} carrying an inline citation`)
console.log(`role half (PROSE, unsourced and labelled so in the prompt): ${roleHalf.length} chars, ${bullets(roleHalf).length} bullets`)
if (uncited.length > 0) {
	failures += 1
	console.log("UNCITED champion lines:")
	for (const l of uncited.slice(0, 20)) console.log(`  ${l}`)
}

console.log("\n## 4. The table's own refusals\n")
const load = championTableSync()
const claims = [...load.facts.values()].reduce((n, f) => n + f.claims.length, 0)
console.log(`${load.facts.size} champions · ${claims} checked claims · patch ${load.specifier}`)
const refused = load.diagnostics.filter(d => d.includes("REFUSED"))
const withheld = load.diagnostics.filter(d => d.startsWith("WITHHELD"))
console.log(`REFUSED by checkClaim: ${refused.length}`)
for (const d of refused) console.log(`  ${d}`)
/*
 * Two reasons, counted apart, because they want different fixes. A DISAGREEMENT is the two sources
 * saying different things and is a fact about the patch. A BROKEN EXPANSION is the wiki failing to
 * fill in a field this pipeline asked for on its own, which is a fact about this pipeline — and it
 * is the one that was invisible until `scripts/verify-fetched.ts` went back to the URL.
 */
const disagreed = withheld.filter(d => d.includes("sources disagreed"))
const brokeRendering = withheld.filter(d => d.includes("expansion broke"))
console.log(`WITHHELD because Data Dragon and the wiki disagreed: ${disagreed.length} abilities`)
for (const d of disagreed.slice(0, 5)) console.log(`  ${d}`)
if (disagreed.length > 5) console.log(`  … and ${disagreed.length - 5} more`)
console.log(`WITHHELD because the wiki's own expansion came back broken: ${brokeRendering.length} abilities`)
for (const d of brokeRendering) console.log(`  ${d}`)

console.log(`\n## Retractions currently in force: ${RETRACTIONS.length}`)
for (const r of RETRACTIONS) console.log(`  ${r.key}: "${r.clause}"`)

console.log(failures === 0 ? "\nOK — nothing refuted, nothing untraced." : `\nFAILED — ${failures} problems above.`)
process.exit(failures === 0 ? 0 : 1)
