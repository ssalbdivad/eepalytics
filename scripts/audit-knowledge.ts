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

/**
 * The sentences the 2026-09-18 audit adjudicated WRONG against a fetched source, as patterns.
 *
 * Each one is quoted from the corpus it shipped in, with what the source says beside it. They are
 * patterns rather than exact strings because the failure worth catching is the CLAIM coming back in
 * new words, which is how "the seed reveals what it rolls past" survived four rewrites of one file.
 */
const REFUTED: { pattern: RegExp; was: string; source: string }[] = [
	{
		pattern: /rolls? over terrain|vision of what it rolls past|scouting ward|throw (?:it )?over a wall/i,
		was: "Lillia E rolls over terrain and grants vision of what it rolls past",
		source: "wiki Swirlseed: \"detonates upon hitting an enemy or terrain while on the ground\"; ddragon: \"rolls until it hits an enemy or collides with terrain\""
	},
	{
		pattern: /reveals whoever it rolls into/i,
		was: "the two live clauses that taught the seed as a corridor scout",
		source: "retracted 2026-09-18; against terrain it detonates and reveals nobody"
	},
	{
		pattern: /bonus damage to monsters/i,
		was: "Lillia W deals bonus damage to monsters",
		source: "wiki: W deals 50% damage to MINIONS; no monster modifier exists on W at all"
	},
	{
		pattern: /every enemy hit grants a stack|each enemy hit grants a stack/i,
		was: "Lillia Q grants a Prance stack per enemy hit",
		source: "wiki: one stack per ability that hits AT LEAST ONE enemy, capped at 4"
	},
	{
		pattern: /two-minute cooldown|two minute cooldown/i,
		was: "Lillia R has a two-minute cooldown",
		source: "wiki + ddragon: 150 / 130 / 110 seconds"
	},
	{
		pattern: /stacks? (?:die|are lost|reset) with you/i,
		was: "Bel'Veth's stacks die with her",
		source: "wiki: Lavender stacks are permanent"
	},
	{
		pattern: /every enemy who dies near him leaves a wraith|including his own dead teammate/i,
		was: "every death near Viego leaves a possessable wraith",
		source: "wiki: only enemy champions Viego's team kills"
	}
]

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
for (const r of REFUTED) {
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
console.log(`WITHHELD because Data Dragon and the wiki disagreed: ${withheld.length} abilities`)
for (const d of withheld.slice(0, 5)) console.log(`  ${d}`)
if (withheld.length > 5) console.log(`  … and ${withheld.length - 5} more`)

console.log(`\n## Retractions currently in force: ${RETRACTIONS.length}`)
for (const r of RETRACTIONS) console.log(`  ${r.key}: "${r.clause}"`)

console.log(failures === 0 ? "\nOK — nothing refuted, nothing untraced." : `\nFAILED — ${failures} problems above.`)
process.exit(failures === 0 ? 0 : 1)
