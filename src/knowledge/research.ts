/**
 * Champion research — fetch current champion context on demand, once per champion per patch.
 *
 * WHY NOT A STATIC LIBRARY. Hand-written notes for 170 champions go stale every two weeks and
 * nobody maintains them. Notes for the champion actually being reviewed, keyed to the patch the
 * game was played on, cannot go stale: a different patch is a different cache key.
 *
 * WHY NOT ON EVERY REVIEW. `promptHash` covers the digest, and the digest carries the champion
 * context. If that context changed on every fetch, no two reviews of the same game would ever
 * hash alike and `reviewExistsForPrompt` would re-bill for every reopened game — a real cost the
 * queue deliberately avoids. It would also put a network dependency in the coaching path. So the
 * unit of work is the PATCH, not the review: research runs when `knowledge/champions/<key>.md`
 * is missing or written for a different patch, and every review in between reads the file.
 *
 * WHY A SEPARATE CALL PATH FROM `runCoach`. The coach is invoked with `--tools ""` on purpose —
 * it gets no filesystem, no bash, no web, because a coaching call must be a deterministic
 * function of the digest. Research is the opposite: it exists to go and look things up. Keeping
 * them in different functions is what stops the coach ever gaining a tool it should not have.
 *
 * THE TRUST BOUNDARY. Everything written here ends up in the coaching prompt unverified — it is
 * the one part that was not measured from the user's game, and `src/review/parse.ts` cannot
 * check it the way it checks a cited number. So the domain allowlist below is enforced twice:
 * in the prompt, and as `--allowed-domains` on the CLI. `knowledge/SOURCES.md` explains what may
 * be written down at all.
 *
 * NODE ONLY.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { KNOWLEDGE_DIR, championKey, championNote, clearKnowledgeCache } from "./index.ts"
import { makeLogger, errText } from "../daemon/log.ts"

const log = makeLogger("knowledge")

/**
 * The only domains research may read. Tier 1 is official and definitionally correct about what
 * changed; tier 2 are counting real games, which is why they can be trusted about what is
 * standard. See `knowledge/SOURCES.md` for the reasoning and for what may be written down.
 */
export const TRUSTED_DOMAINS = [
	"ddragon.leagueoflegends.com",
	"leagueoflegends.com",
	"www.leagueoflegends.com",
	"op.gg",
	"www.op.gg",
	"u.gg",
	"www.u.gg",
	"lolalytics.com",
	"jungler.gg"
] as const

const VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json"

/** `16.17.1` -> `16.17`. Hotfix builds do not change balance. */
export const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".")

/** The live patch, or null if Data Dragon could not be reached. Never throws. */
export const livePatch = async (signal?: AbortSignal): Promise<string | null> => {
	try {
		const res = await fetch(VERSIONS_URL, { signal: signal ?? AbortSignal.timeout(15_000) })
		if (!res.ok) return null
		const versions = (await res.json()) as unknown
		return Array.isArray(versions) && typeof versions[0] === "string" ? minorOf(versions[0]) : null
	} catch {
		return null
	}
}

/**
 * Does this champion need researching for this patch?
 *
 * `patch: durable` notes never do — that marker means champion identity rather than tuning, and
 * identity survives a balance change. A note written by a human is respected the same way a
 * generated one is; the file is the source of truth either way.
 */
export const needsResearch = (championName: string, patch: string): boolean => {
	const note = championNote(championName)
	if (note === null || note.isDefault) return true
	return note.patch !== "durable" && note.patch !== patch
}

const RULES = (champion: string, patch: string, role: string): string =>
	`Write the champion-context file for **${champion}** (${role}) at patch **${patch}** of
League of Legends.

## Where you may look

ONLY these domains. A claim you cannot source from one of them does not go in the file:

${TRUSTED_DOMAINS.map(d => `  - ${d}`).join("\n")}

  - leagueoflegends.com patch notes are definitionally correct about what Riot CHANGED.
  - op.gg / u.gg / lolalytics / jungler.gg are counting real games, so they are reliable about
    what is STANDARD. Prefer whichever states its patch and sample size, and say the sample size
    when you claim something is standard: "the most-played route at this patch across 34k games"
    is checkable, "the best route" is not.
  - If a page does not say which patch it describes, do not use it. A guide that cannot be dated
    cannot be checked for staleness.

## What goes in

Prose that shapes **what the player should do differently next game**:

  - clear routes, how often each is played, and clear times;
  - power spikes by level, and what the champion wants from a fight;
  - where the champion is vulnerable, and why a death in a given place costs them more;
  - matchup shape against other junglers, when the data supports it.

## What must NOT go in — these are hard

  - **No item builds, rune pages, or skill order as a grading criterion.** The data this coach
    reads has no item purchases, no wards and no skill levels, so it could never check what the
    player actually did. Advice about them would float free of any evidence, which is the exact
    failure this app exists to prevent. Ability ROLES are fine ("her E reveals what it hits");
    "she should max W second" is not.
  - **No number that could read as a measurement of the player's own game.** A champion's base
    clear time is context. It is never a stat about him.
  - **Nothing you could not verify.** Leave it out. An incomplete note is fine and expected; an
    invented one poisons every review of this champion until someone notices.

## Output

Write the file to \`knowledge/champions/${championKey(champion)}.md\`, exactly this shape:

\`\`\`
patch: ${patch}
sourcedAt: <today, YYYY-MM-DD>
source: <the pages you actually used, each with the patch it described>
---
<the prose>
\`\`\`

The three header lines come FIRST, before the \`---\`, and they are not optional. **A file with
no \`source:\` line is discarded unread**, however good the prose is — provenance is the only
thing standing between this file and an unverifiable claim reaching the coach. List the actual
domains you fetched.

Use \`patch: durable\` INSTEAD of the patch number only if everything you wrote would survive a
balance change. Mixed content keeps the patch number.

Write the file and nothing else. No commentary, no other files.`

/**
 * Every domain named in a note's `source:` header must be on the allowlist.
 *
 * The prompt says where to look, but a prompt is a request. This is the enforcement: a note that
 * cites something unsanctioned is rejected and the previous file put back, because the whole
 * risk of this feature is unverified prose reaching the coaching prompt. A header naming no
 * source at all also fails — provenance is not optional.
 */
/**
 * Tokens that look like hostnames but are filenames. A well-sourced note citing Data Dragon's
 * `LeeSin.json` was rejected because `leesin.json` matches any reasonable domain pattern — 8 KB
 * of correctly-sourced research thrown away over a file extension. A validator that fails this
 * way teaches you to switch it off.
 */
const FILE_SUFFIXES = new Set([
	"json", "md", "html", "htm", "txt", "csv", "png", "jpg", "jpeg", "svg", "gif", "webp",
	"pdf", "ts", "js", "tsx", "jsx", "xml", "yml", "yaml", "gz", "zip"
])

export const sourcesAreTrusted = (sourceHeader: string): boolean => {
	const text = sourceHeader.toLowerCase()
	if (text.trim() === "" || text.trim() === "unknown") return false

	const allowed = new Set<string>(TRUSTED_DOMAINS.map(d => d.replace(/^www\./, "")))
	const tokens = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/g) ?? []
	const domains = tokens
		.map(t => t.replace(/^www\./, ""))
		.filter(t => !FILE_SUFFIXES.has(t.split(".").pop() ?? ""))

	// Provenance is not optional: a header naming no domain at all is unverifiable.
	if (domains.length === 0) return false
	// And every domain it does name has to be sanctioned — one untrusted citation alongside
	// three good ones still means part of the note cannot be checked.
	return domains.every(d => allowed.has(d))
}

export interface ResearchResult {
	ok: boolean
	champion: string
	patch: string
	error?: string
	durationMs: number
}

const CLI_TIMEOUT_MS = Number((process.env.FAWNSEI_RESEARCH_TIMEOUT_MS ?? process.env.CSK_RESEARCH_TIMEOUT_MS) ?? 300_000)

/**
 * Run one research pass. Never throws — champion context is an enhancement, and a review must
 * still be produced when the network, the CLI or the model is unavailable.
 */
export const researchChampion = async (
	championName: string,
	patch: string,
	role = "jungle",
	signal?: AbortSignal
): Promise<ResearchResult> => {
	const started = Date.now()
	const fail = (error: string): ResearchResult => ({
		ok: false,
		champion: championName,
		patch,
		error,
		durationMs: Date.now() - started
	})

	mkdirSync(join(KNOWLEDGE_DIR, "champions"), { recursive: true })

	// Keep the note we already have. If research writes something unsanctioned, the old file
	// going back is the safe outcome: stale-but-reviewed beats fresh-but-unchecked.
	const target = join(KNOWLEDGE_DIR, "champions", `${championKey(championName)}.md`)
	const previous = existsSync(target) ? readFileSync(target, "utf8") : null
	const restore = (): void => {
		if (previous === null) rmSync(target, { force: true })
		else writeFileSync(target, previous)
		clearKnowledgeCache()
	}

	const bin = (process.env.FAWNSEI_CLAUDE_BIN ?? process.env.CSK_CLAUDE_BIN) ?? "claude"
	const args = [
		"--print",
		"--output-format",
		"json",
		// Research is the ONE call in this app allowed to reach the network. The CLI has no
		// domain-restriction flag, so the allowlist is enforced AFTER the fact by
		// `sourcesAreTrusted` — a check in code beats an instruction in a prompt.
		"--tools",
		"WebSearch,WebFetch,Write",
		"--add-dir",
		KNOWLEDGE_DIR,
		"--disable-slash-commands",
		"--strict-mcp-config",
		"--no-session-persistence",
		"--safe-mode",
		"--effort",
		"medium"
	]

	return await new Promise<ResearchResult>(resolve => {
		let proc
		try {
			proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], signal })
		} catch (err) {
			resolve(fail(`could not start ${bin}: ${errText(err)}`))
			return
		}

		const timer = setTimeout(() => proc.kill("SIGKILL"), CLI_TIMEOUT_MS)
		let stderr = ""
		proc.stderr.on("data", d => (stderr += String(d)))
		proc.stdout.on("data", () => {})
		proc.on("error", err => {
			clearTimeout(timer)
			resolve(fail(errText(err)))
		})
		proc.on("close", code => {
			clearTimeout(timer)
			if (code !== 0) {
				resolve(fail(`${bin} exited ${code}: ${stderr.slice(0, 300)}`))
				return
			}
			// The model wrote the file; re-read it and check it, rather than trusting the exit
			// code. A bad note is worse than no note — it reaches the coach unverified.
			clearKnowledgeCache()
			const note = championNote(championName)
			if (note === null || note.isDefault) {
				restore()
				resolve(fail("the research call finished but wrote no note for this champion"))
				return
			}
			if (!sourcesAreTrusted(note.source)) {
				// Keep the rejected draft next to the file it failed to become. Discarding it
				// silently makes this failure impossible to diagnose, and the reason a note was
				// thrown away matters more than the note did.
				const rejected = `${target}.rejected`
				try {
					writeFileSync(rejected, readFileSync(target, "utf8"))
				} catch {
					/* best effort — the diagnosis is a nicety, the rollback is not */
				}
				restore()
				resolve(
					fail(
						`note cited an unsanctioned source and was discarded (draft kept at ` +
							`${rejected}): source="${note.source}" patch="${note.patch}"`
					)
				)
				return
			}
			resolve({ ok: true, champion: championName, patch: note.patch, durationMs: Date.now() - started })
		})

		proc.stdin.end(RULES(championName, patch, role))
	})
}

/**
 * One research pass per champion at a time.
 *
 * Reviews arrive in bursts — a night's games all get queued together — and they are all the same
 * champion. Without this, twenty reviews would spawn twenty identical research processes, all
 * writing the same file.
 */
const inFlight = new Set<string>()

/** Exposed so the daemon can report what it is doing, and so tests can assert quiescence. */
export const researchInFlight = (): string[] => [...inFlight]

/**
 * Bring a champion's notes up to date if they are behind, and say whether anything changed.
 *
 * Callers treat a `false` as "carry on without champion context" — never as an error worth
 * failing a review over.
 */
export const ensureChampionContext = async (
	championName: string,
	signal?: AbortSignal
): Promise<boolean> => {
	const key = championKey(championName)
	if (inFlight.has(key)) return false
	const patch = await livePatch(signal)
	if (patch === null) {
		log.debug("could not read the live patch; using whatever notes are on disk")
		return false
	}
	if (!needsResearch(championName, patch)) return false

	inFlight.add(key)
	log.info("researching champion context", { champion: championName, patch })
	try {
		const result = await researchChampion(championName, patch, "jungle", signal)
		if (!result.ok) {
			log.warn("champion research failed; reviews continue on the existing notes", {
				champion: championName,
				err: result.error
			})
			return false
		}
		log.info("champion context refreshed", {
			champion: championName,
			patch: result.patch,
			ms: result.durationMs
		})
		return true
	} finally {
		inFlight.delete(key)
	}
}

/**
 * Kick off a refresh WITHOUT blocking the caller.
 *
 * Research means web search plus a model call and was measured at minutes, not seconds. A review
 * must never wait on that: the queue would stall a worker on a network call, and the user is
 * looking at a game now, not after a browse. So the review proceeds on whatever notes are on
 * disk and the refreshed ones land for next time — the notes converge within one review of a
 * patch bump, which is the right trade for never blocking and never failing.
 */
export const refreshChampionContextInBackground = (championName: string): void => {
	void ensureChampionContext(championName).catch(err =>
		log.warn("background champion research threw", {
			champion: championName,
			err: errText(err)
		})
	)
}
