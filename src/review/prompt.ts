/**
 * Building the coach's prompts.
 *
 * The system prompt is **not** in this file. It is the Coach Lillia section of `AGENTS.md`,
 * read off disk at runtime and cached against the file's mtime. Editing `AGENTS.md` changes
 * the coach with no code change and no restart — which is the point: the persona is user-facing
 * copy, and copy should not require a deploy. The section is delimited by
 * `<!-- COACH:BEGIN -->` / `<!-- COACH:END -->`; if those markers go missing we fall back to
 * the `## Part 2` heading, and if that is gone too we fall back to a minimal built-in persona
 * and say so loudly rather than sending an empty system prompt.
 *
 * The user prompt is the digest, rendered. Two rules govern what goes in it:
 *
 *  - **Everything the coach may cite is in the prompt, verbatim and by id.** Moment ids and
 *    metric keys are printed so they can be copied. `parse.ts` then rejects any citation that
 *    is not on that list, which turns "never fabricate a stat" from an instruction into a
 *    property of the pipeline.
 *  - **What is missing is stated as loudly as what is present.** `dataGaps` is rendered near
 *    the top, because the most common way an LLM invents a League stat is by being asked
 *    about item builds and not being told it cannot see them.
 */

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { FRAME_INTERVAL_MS, REVIEW_VERSION } from "../shared/constants.ts"
import { zoneOf } from "../shared/map.ts"
import { ROLE_LABELS } from "../shared/schema/domain.ts"
import { fmtClock, fmtDuration } from "../shared/time.ts"
import type { Digest, GameDigest, TrendDigest } from "./digest-contract.ts"
import type { JsonSchema } from "./claude.ts"
import { COACH_CATEGORIES } from "./parse.ts"

/**
 * Bumped when the *rendering* below changes in a way that should re-review existing games.
 * The persona text is hashed separately, so editing `AGENTS.md` already invalidates on its
 * own — this is for changes to the code in this file.
 */
export const PROMPT_TEMPLATE_VERSION = 4

const HERE = dirname(fileURLToPath(import.meta.url))
/** `src/review/prompt.ts` -> repo root. Overridable for tests and for a packaged install. */
export const PERSONA_PATH = (process.env.EEPALYTICS_AGENTS_MD ?? process.env.CSK_AGENTS_MD) ?? resolve(HERE, "../../AGENTS.md")

const BEGIN_MARKER = "<!-- COACH:BEGIN -->"
const END_MARKER = "<!-- COACH:END -->"
const BEGIN_RE = /^[ \t]*<!--\s*COACH:BEGIN\s*-->[ \t]*$/m
const END_RE = /^[ \t]*<!--\s*COACH:END\s*-->[ \t]*$/m

/* ============================================================ persona */

export interface Persona {
	/** The persona text sent as the system prompt. Never empty. */
	text: string
	/** Where it came from, for the health endpoint. */
	source: "markers" | "heading" | "fallback"
	path: string
	/** Non-fatal complaints — a missing marker, a suspiciously short section. */
	warnings: string[]
}

/**
 * Last-resort persona. Deliberately terse and deliberately worse than `AGENTS.md`: if this
 * ever ships to a user, the `warnings` array is how they find out, and a bland-but-honest
 * coach beats a crash or an empty system prompt.
 */
const FALLBACK_PERSONA = `You are Coach Lillia, a League of Legends coach for one jungle player.
You are encouraging and funny, you reference T1 players (Faker, Oner, Keria, Gumayusi, Doran), and you roast the play, never the player.
Hard rules: never invent a statistic; cite only numbers, timestamps and ids that appear in the digest you were given; every point ends with something concrete to do next game; hedge anything the data cannot prove, because positions are sampled only once per minute.
Return JSON only, matching the schema in the request.`

let cache: { mtimeMs: number; size: number; persona: Persona } | null = null

/** Read the persona out of `AGENTS.md`, cached against the file's mtime+size. */
export const loadPersona = (path: string = PERSONA_PATH): Persona => {
	let stat: { mtimeMs: number; size: number }
	try {
		const s = statSync(path)
		stat = { mtimeMs: s.mtimeMs, size: s.size }
	} catch {
		return {
			text: FALLBACK_PERSONA,
			source: "fallback",
			path,
			warnings: [`could not stat ${path}; using the built-in fallback persona`]
		}
	}

	if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.persona.path === path)
		return cache.persona

	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch (e) {
		return {
			text: FALLBACK_PERSONA,
			source: "fallback",
			path,
			warnings: [`could not read ${path} (${e instanceof Error ? e.message : String(e)}); using the built-in fallback persona`]
		}
	}

	const persona = extractPersona(raw, path)
	cache = { ...stat, persona }
	return persona
}

/** Exported for tests: pull the persona section out of a markdown string. */
export const extractPersona = (raw: string, path = PERSONA_PATH): Persona => {
	const warnings: string[] = []

	// The markers must be ALONE ON THEIR LINE. AGENTS.md's own preamble mentions them inline
	// ("the markers `<!-- COACH:BEGIN -->` / `<!-- COACH:END -->` are load-bearing"), and an
	// indexOf() would happily extract the five characters between those two mentions.
	const begin = BEGIN_RE.exec(raw)
	const end = END_RE.exec(raw)
	if (begin?.index !== undefined && end?.index !== undefined && end.index > begin.index) {
		const text = raw.slice(begin.index + begin[0].length, end.index).trim()
		if (text.length >= 200) return { text, source: "markers", path, warnings }
		warnings.push(`the COACH markers in ${path} enclose only ${text.length} characters`)
	} else warnings.push(`no standalone ${BEGIN_MARKER} / ${END_MARKER} pair in ${path}; falling back to heading detection`)

	// Fallback: "## Part 2 …" (or any "## …Coach…" heading) up to the next level-2 heading.
	const heading = /^##\s+(?:part\s*2\b.*|.*coach.*)$/im.exec(raw)
	if (heading?.index !== undefined) {
		const after = raw.slice(heading.index + heading[0].length)
		const next = /^##\s+/m.exec(after)
		const text = (next ? after.slice(0, next.index) : after).trim()
		if (text.length >= 200) return { text, source: "heading", path, warnings }
	}

	warnings.push(`no persona section found in ${path}; using the built-in fallback persona`)
	return { text: FALLBACK_PERSONA, source: "fallback", path, warnings }
}

/** Drop the mtime cache. Tests, and the settings screen's "reload persona" button. */
export const clearPersonaCache = (): void => {
	cache = null
}

/* ====================================================== output schema */

/**
 * What the model must return. `id`, `gameId` and `mediaIds` are deliberately absent: the app
 * assigns those, so there is nothing for the model to invent.
 */
export const COACH_JSON_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["headline", "encouragement", "items", "goals"],
	properties: {
		headline: { type: "string", description: "One line. Meme-y but true, and carrying a real number when one exists." },
		encouragement: { type: "string", description: "Sincere hype, kept separate from the critique. Never sarcastic." },
		items: {
			type: "array",
			minItems: 1,
			maxItems: 10,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["title", "fix", "severity", "category", "impact", "actionability", "confidence", "tSec", "momentIds", "metricKeys"],
				properties: {
					title: {
						type: "string",
						maxLength: 70,
						description:
							"The claim WITH its number, under 70 chars. What he scans, so it carries the wit. 'Down 41 CS at 16:00', not 'Farming issues'."
					},
					fix: {
						type: "string",
						maxLength: 140,
						description:
							"ONE imperative sentence, under 140 chars: the single thing to do differently. No 'next game:' prefix, no second sentence."
					},
					body: {
						type: "string",
						maxLength: 500,
						description:
							"OPTIONAL elaboration, under 500 chars — the joke, the T1 reference, the reasoning. Collapsed behind a click, so never put the number or the fix here. Omit it entirely when the title and fix say enough."
					},
					severity: { type: "string", enum: ["info", "minor", "major"] },
					impact: {
						type: "string",
						enum: ["high", "medium", "low"],
						description:
							"What this plausibly cost, anchored to a real figure from the digest. Never a win-rate percentage — this data cannot support one."
					},
					actionability: {
						type: "string",
						enum: ["high", "medium", "low"],
						description: "Could he follow this fix mid-game? 'high' is a rule with a trigger."
					},
					confidence: {
						type: "string",
						enum: ["high", "medium", "low"],
						description:
							"Is this solid enough to change behaviour over? 'low' is automatically demoted to info and stops being phrased as a correction."
					},
					category: {
						type: "string",
						// The one list. `parse.ts` lower-cases anything outside it rather than
						// rejecting the item, so a drifted second copy here would not fail — it
						// would just quietly stop the UI badging what the model was told to send.
						enum: [...COACH_CATEGORIES]
					},
					tSec: {
						type: ["number", "null"],
						description: "Game clock in SECONDS this point anchors to, or null for a whole-game point."
					},
					momentIds: {
						type: "array",
						items: { type: "string" },
						description: "Ids copied verbatim from the MOMENTS list. Any other value is rejected."
					},
					metricKeys: {
						type: "array",
						items: { type: "string" },
						description: "Keys copied verbatim from the METRICS list. Any other value is rejected."
					}
				}
			}
		},
		goals: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			items: { type: "string" },
			description: "Concrete, checkable things to try in the next games."
		}
	}
}

/* ============================================================ prompts */

export interface PromptOptions {
	/** 0 = dry and clinical, 1 = full meme goblin. Scales jokes only, never the numbers. */
	intensity?: number
	/** Folded into the prompt hash so switching models re-reviews rather than reusing. */
	model?: string
	/** Inject a persona (tests). Otherwise read from `AGENTS.md`. */
	persona?: Persona
	/**
	 * The post-game pack, rendered — `renderPack()` from `./pack.ts`.
	 *
	 * It goes in as a SECTION of the user prompt rather than replacing the digest, because the
	 * digest is what the citation allowlist is built from: moment ids, metric keys and every
	 * baseline figure are policed against it by `parse.ts`, and swapping the body out would
	 * quietly disable that. The pack adds what the digest cannot carry — the counterpart's exact
	 * CS, gold and level off the timeline, and where he was when each objective fell.
	 */
	pack?: string
	/**
	 * The frames attached to this call, as a stable fingerprint (their ids, in order).
	 *
	 * Only the fingerprint is hashed, never the bytes. Two reviews of one game that attached
	 * different pictures are different reviews and must not reuse each other's answer; two that
	 * attached the same pictures are the same call and must not re-bill.
	 */
	frameKey?: string
}

export interface BuiltPrompt {
	system: string
	user: string
	schema: JsonSchema
	/** sha256 over persona + template + REVIEW_VERSION + model + digest. */
	promptHash: string
	persona: Persona
	/** Rough size signal for logs and for spotting a digest that got out of hand. */
	approxChars: number
}

const clamp01 = (n: number | undefined): number =>
	typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.8

const intensityDirective = (intensity: number): string =>
	intensity <= 0.3 ?
		`INTENSITY ${intensity.toFixed(2)} — dry and clinical. Numbers, zones and fixes. At most one aside in the whole review. The rules about citing real numbers and ending on a fix are unchanged.`
	: intensity <= 0.7 ?
		`INTENSITY ${intensity.toFixed(2)} — one bit per item. T1 references land but do not dominate. The rules about citing real numbers and ending on a fix are unchanged.`
	:	`INTENSITY ${intensity.toFixed(2)} — full meme goblin. Open every item on the joke. You still cite the real number, and you still end on the fix.`

const systemFor = (persona: Persona, intensity: number): string =>
	`${persona.text}\n\n---\n\n${intensityDirective(intensity)}\n\nReturn a single JSON object and nothing else.`

/** Per-game review. */
export const gamePrompt = (digest: GameDigest, opts: PromptOptions = {}): BuiltPrompt => {
	const persona = opts.persona ?? loadPersona()
	const intensity = clamp01(opts.intensity)
	const user = renderGame(digest, opts.pack)
	return {
		system: systemFor(persona, intensity),
		user,
		schema: COACH_JSON_SCHEMA,
		promptHash: promptHash({
			persona: persona.text,
			kind: "game",
			model: opts.model,
			digest,
			intensity,
			pack: opts.pack,
			frameKey: opts.frameKey
		}),
		persona,
		approxChars: user.length
	}
}

/** Cross-game trends. */
export const trendPrompt = (digest: TrendDigest, opts: PromptOptions = {}): BuiltPrompt => {
	const persona = opts.persona ?? loadPersona()
	const intensity = clamp01(opts.intensity)
	const user = renderTrend(digest)
	return {
		system: systemFor(persona, intensity),
		user,
		schema: COACH_JSON_SCHEMA,
		promptHash: promptHash({ persona: persona.text, kind: "trend", model: opts.model, digest, intensity }),
		persona,
		approxChars: user.length
	}
}

/**
 * The cache key for a review. Covers the persona text, this file's template version,
 * `REVIEW_VERSION`, the model and the digest — so re-opening a game never re-bills, editing
 * `AGENTS.md` re-reviews everything, and switching model re-reviews too.
 *
 * `promptHash()` with no digest gives the template-only hash, which is what a health check or
 * a "the persona changed, invalidate everything" sweep wants.
 */
/**
 * Fields that record WHEN a digest was built rather than what is in it.
 *
 * `buildGameDigest`/`buildTrendDigest` stamp `generatedMs: Date.now()`, and hashing the
 * digest whole therefore produced a different `promptHash` on every single call. That
 * silently disabled the entire re-billing guard: `reviewExistsForPrompt` could never match,
 * the deterministic review id `rv-g<id>-<hash12>` never deduped, and re-opening a game paid
 * Claude again for a byte-identical prompt. Measured: four reviews of game 5633915410, four
 * distinct hashes, four charges.
 *
 * None of these fields is rendered into the prompt, so dropping them from the hash keeps it a
 * faithful fingerprint of exactly what the model is shown.
 */
const VOLATILE_DIGEST_FIELDS = ["generatedMs"] as const

const stableDigest = (digest: unknown): unknown => {
	if (digest === null || typeof digest !== "object" || Array.isArray(digest)) return digest
	const rest = { ...(digest as Record<string, unknown>) }
	for (const field of VOLATILE_DIGEST_FIELDS) delete rest[field]
	return rest
}

export const promptHash = (
	parts: {
		persona?: string
		kind?: string
		model?: string
		digest?: unknown
		intensity?: number
		/** The rendered pack, when one was sent. Its text IS what the model saw. */
		pack?: string
		/** The ids of the frames attached, in order. See `PromptOptions.frameKey`. */
		frameKey?: string
	} = {}
): string =>
	createHash("sha256")
		.update(
			JSON.stringify({
				reviewVersion: REVIEW_VERSION,
				templateVersion: PROMPT_TEMPLATE_VERSION,
				persona: parts.persona ?? loadPersona().text,
				kind: parts.kind ?? null,
				model: parts.model ?? null,
				intensity: parts.intensity ?? null,
				pack: parts.pack ?? null,
				frameKey: parts.frameKey ?? null,
				digest: stableDigest(parts.digest ?? null)
			}),
			"utf8"
		)
		.digest("hex")

/* ========================================================= rendering */

const n = (v: number | null | undefined, digits = 0): string =>
	typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "n/a"

const signed = (v: number | null | undefined, digits = 0): string =>
	typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(digits)}` : "n/a"

const bullets = (lines: string[]): string => lines.map(l => `- ${l}`).join("\n")

const OUTPUT_RULES = `## HOW TO ANSWER

Return ONE JSON object, no markdown fences, no prose outside it:

{ "headline": string, "encouragement": string, "items": [ { "title", "fix", "body", "severity", "category", "impact", "actionability", "confidence", "tSec", "momentIds", "metricKeys" } ], "goals": [string] }

### LENGTH IS A HARD CONSTRAINT, NOT A STYLE NOTE

He reads this between games. A wall of text does not get read, and coaching that is not read
changes nothing — a shorter item that lands beats a better item that does not. Every field has a
budget and the budgets are enforced:

- **title** — under 70 characters. The claim WITH its number. This is the part he scans, so it
  carries the wit. "Down 11 CS to Brand at 10:00", not "Pathing issues in the early game".
- **fix** — ONE sentence, under 140 characters, imperative. The single thing to do differently.
  No preamble, no "next game:" prefix, no second sentence. If you cannot say it in one sentence,
  you have not worked out what the fix is.
- **body** — under 500 characters, and OPTIONAL. Leave it out unless it adds something the title
  and fix genuinely do not. It is collapsed behind a click, so this is where the joke, the T1
  reference and the reasoning live — never the number he needs, and never the fix.
- **headline** — one line, under 100 characters.
- **encouragement** — one or two sentences. Not a paragraph.
- **goals** — one line each, under 120 characters.

Write FEWER, BETTER items. Three that matter beats six that pad. An item you are adding for
completeness is one he will skim past on the way to the ones that count.

### RATE EVERY ITEM ON THREE AXES — the app sorts by them, you do not

Give each item \`impact\`, \`actionability\` and \`confidence\`, each "high" | "medium" | "low".
The app combines them into a ranking, so be honest rather than emphatic: inflating them all to
"high" destroys the ordering and buries the item that actually mattered.

**THESE ARE YOUR JUDGMENT, AND THAT IS FINE.** Most coaching calls cannot be computed from this
data — whether a gank was worth the tempo, whether a fight was winnable, how much a bad recall
cost. Rate them anyway, using judgment, the way a coach watching over his shoulder would. The UI
shows them explicitly as your call rather than as measurements, so a subjective rating is honest.
Refusing to rate because you cannot prove it is not caution, it is just less useful.

There is exactly one thing you may not do: **dress a judgment up as a computed number.** Rating
\`impact: "high"\` is a judgment and is fine. Writing "this cost you about 3% win rate" is a
fabricated statistic under rule 2, because nothing here supports computing one. Ordinals are
judgments; percentages read as measurements. Ground the rating in a real figure WHEN one exists,
and simply judge it when one does not.

**impact — what did this plausibly cost him?**
  - high    plausibly decided a phase of the game. A 4,000g swing, two uncontested drakes, dying
            three times in the enemy jungle before 15:00.
  - medium  a real cost he can feel but recover from.
  - low     tidy-up. Correct, but it was never the reason this game went the way it did.

**actionability — could he follow this fix mid-game?**
  - high    a rule with a trigger. "If you cannot say where the enemy jungler is, take your own
            raptors instead."
  - medium  real, but needs judgment in the moment.
  - low     true and hard to act on. Usually a sign the fix is not worked out yet.

**confidence — is this solid enough that he should change behaviour over it?**
  - high    read straight off an event or an end-of-game stat, and the conclusion follows from it.
  - medium  computed at frame boundaries, or one clear instance.
  - low     depends on interpolation between one-minute frames, on a single ambiguous sequence,
            or on guessing intent.

**An item you rate \`confidence: "low"\` is automatically demoted to \`info\` and stops being
phrased as a correction.** That is the intended path, not a failure — use it. Being confidently
wrong costs more than staying quiet, because it teaches him to discount the whole review.

### TRADE-OFFS ARE NOT MISTAKES

Some plays are a decision with a cost, not an error, and calling them errors is how a coach loses
credibility. A gank that produced a kill and two plates while a drake went uncontested is a
TRADE, and the honest read is what it bought against what it cost — not "you missed drake".

When the data cannot tell you whether the trade was good, say that: \`severity: "info"\`,
\`confidence: "low"\`, and a \`fix\` phrased as the question to ask himself next time rather than
an instruction. You cannot see his lane states, his cooldowns, or what he could hear. Reserve
\`major\` for plays where the cost is clear and there was no compensating gain.

### NON-NEGOTIABLE, AND MECHANICALLY CHECKED

- Every entry in "momentIds" must be copied character-for-character from the MOMENTS list. Every
  entry in "metricKeys" must be copied character-for-character from the METRICS list. Anything
  else is dropped, and an item whose citations are ALL invented is deleted whole.
- Every number, timestamp and map zone you cite must appear somewhere in this prompt.
- The number goes in the **title** or the **fix**, where he will see it — not buried in body.
- "tSec" is SECONDS of game clock, and must fall inside the game's duration.
- Every item has a real "fix". An item you cannot give a fix for is a joke, and it gets cut.
- At least one item is positive (severity "info", category "praise") whenever the data supports
  one. Its "fix" is what to keep doing.
- Hedge anything drawn from a low-confidence moment. You may say "you looked alone"; you may not
  say "you were alone".`

const SAMPLING_NOTE = `Positions come from timeline frames sampled once per ${Math.round(
	FRAME_INTERVAL_MS / 1000
)} seconds; the median distance travelled between two samples is about 28% of the map. Anything about who was near whom, or where someone walked between samples, is an interpolation. Moments marked confidence "low" depend on that interpolation — hedge them.`

/**
 * `pack` is the post-game pack from `./pack.ts`, rendered, or undefined.
 *
 * It is pushed in BEFORE `OUTPUT_RULES` rather than appended at the end, so the last thing the
 * model reads is still how to answer. Where the two sources overlap the pack wins and says so:
 * the digest's enemy-jungler figures are end-of-game totals from the match, and the pack's are
 * per-minute rows off the timeline — same source, finer grain, and neither of them is the live
 * feed's visibility counter.
 */
const renderGame = (d: GameDigest, pack?: string): string => {
	const g = d.game
	const teamId = g.teamId
	const user = d.players.find(p => p.isUser)
	const enemyJungler = d.players.find(p => p.team === "enemy" && p.role === "JGL")
	const allyOf = (team: "ally" | "enemy") =>
		d.players
			.filter(p => p.team === team)
			.map(
				p =>
					`${ROLE_LABELS[p.role]} ${p.championName}${p.isUser ? " (YOU)" : ""} — ${p.kills}/${p.deaths}/${p.assists}, ${p.cs} cs, ${p.gold}g, ${p.visionScore} vision, lvl ${p.champLevel}`
			)

	const sections: string[] = []

	sections.push(`# GAME ${g.gameId} — ${g.queue}, patch ${g.patch}

You are reviewing ONE game. The player is **${ROLE_LABELS[g.role]}** on **${g.championName}**${
		g.roleConfidence === "high" ? "" : ` (role inferred, confidence ${g.roleConfidence} — do not make the role itself the joke)`
	}.

- Result: **${g.win ? "WIN" : "LOSS"}** in ${fmtDuration(g.durationSec)}
- KDA: ${g.kills}/${g.deaths}/${g.assists}
- CS: ${g.cs + g.jungleCs}
- Gold: ${g.gold} · Damage to champions: ${g.damageToChampions} · Vision score: ${g.visionScore} · Level ${g.champLevel}${
		typeof g.teamKills === "number" && typeof g.enemyKills === "number" ?
			`\n- Team kills ${g.teamKills} vs ${g.enemyKills}`
		:	""
	}`)

	sections.push(`## WHAT THIS DATA CANNOT TELL YOU

${bullets(d.dataGaps.length > 0 ? d.dataGaps : ["(analysis reported no gaps, which is unusual — be careful about anything you cannot point at below)"])}

${SAMPLING_NOTE}`)

	sections.push(`## TEAMS

Your team:
${bullets(allyOf("ally"))}

Enemy team:
${bullets(allyOf("enemy"))}
${
	enemyJungler ?
		`\nThe player you are racing is the enemy jungler, **${enemyJungler.championName}** (${enemyJungler.kills}/${enemyJungler.deaths}/${enemyJungler.assists}, ${enemyJungler.cs} cs, ${enemyJungler.gold}g).`
	:	"\nNo enemy jungler could be identified; do not invent one."
}

Players are given as champions on purpose. You do not know your teammates' names and you must not roast a teammate as a person — cite their champion and their line only as context for what you could have done.`)

	/*
	 * The bolded figure is this game. The figure after it is a DELTA, not a baseline — and
	 * that distinction is where reviews have actually gone wrong. Measured on a real review of
	 * game 5633952046: the coach reported "your usual 3150g" (digest: 2874), "your normal
	 * -438g" (digest: -407) and "your usual 8.2%" (digest: 9.4), each apparently by inverting
	 * the delta in its head rather than reading the average sitting one line below. Wrong
	 * baselines are indistinguishable from right ones in the finished prose, so the header
	 * says out loud where the baseline lives and that subtracting is not how you get it.
	 */
	sections.push(`## METRICS — cite these by "key"

Each line is: **this game's value** · the DELTA against your own recent average · **your average
itself** · band · confidence.

To say "your usual X", COPY the number after \`your N-game average\`, from THIS metric's own line.
Do not subtract the delta from this game's value to reconstruct it, do not round it off, do not
call it a median (it is a mean), and do not take an average off a different metric's line — every
metric has its own, and they are not interchangeable.

**If you quote a metric's value or its average, put that metric's key in the item's
\`metricKeys\`.** The app attaches the chart and the evidence to an item through its citations, so
a number whose metric is not cited renders on screen with nothing behind it.

${
	d.metrics.length === 0 ?
		"(none — analysis produced no metrics for this game)"
	:	d.metrics
			.map(
				m =>
					`- key: \`${m.key}\` — ${m.label}: **${n(m.value, Number.isInteger(m.value) ? 0 : 1)}${m.unit}**` +
					` · vs your own average: ${m.vsBaseline === null ? "no baseline yet" : signed(m.vsBaseline, Number.isInteger(m.vsBaseline) ? 0 : 1)}` +
					`${m.baselineText ? ` · ${m.baselineText}` : ""}` +
					` · band ${m.band} · confidence ${m.confidence}\n  ${m.explain}`
			)
			.join("\n")
}`)

	sections.push(`## MOMENTS — cite these by "id"

${
	d.moments.length === 0 ?
		"(none — analysis found nothing worth anchoring to in this game)"
	:	d.moments
			.map(m => {
				const zone = zoneOf({ x: m.mapX, y: m.mapY }, teamId)
				return (
					`- id: \`${m.id}\` — **${fmtClock(m.tSec)}** ${m.kind} · ${m.title}\n` +
					`  where: ${zone} · severity ${m.severity.toFixed(2)} · confidence ${m.confidence}` +
					`${m.costGold === null ? "" : ` · gold swing ${signed(m.costGold)}`}\n` +
					`  evidence: ${m.evidence}`
				)
			})
			.join("\n")
}`)

	/*
	 * NO ROW HERE NAMES A PLAYER, and saying so is the difference between a gap and a fabrication.
	 *
	 * Measured: `scripts/persona-ab.ts` over 30 of his own games found the re-aimed prompt's
	 * on-target items 53% [40-65] unsupported against 19% [12-29] for its own off-target ones, and
	 * the judge's reasons name this list. On game 5644514466 a review said "Zero early objectives by
	 * 10:00 while Cho'Gath took drake and 3 grubs" where the row says `8:17 — HORDE taken by the
	 * enemy` and names nobody at all. Part 2 already says objective credit is KILLER-ONLY and to
	 * phrase it as his TEAM; what it never said is that the enemy row carries no name, so the model
	 * filled the gap with the counterpart it did know about — which is a claim about who was
	 * standing there, invented.
	 *
	 * This is a statement about the FEED'S OWN PROPERTIES, which is the only editorial content any
	 * payload in this app is allowed to carry. It does not tell the model what to say about an
	 * objective.
	 *
	 * The better fix is to CARRY the killer where the timeline knows it — `killerId` is the reliable
	 * half of `ELITE_MONSTER_KILL` (its `assistingParticipantIds` name the other team 23% of the
	 * time) and `review/pack.ts` already prints `takenByChampion` on the frame path. That is a
	 * change to the digest's own shape and its schema, and it is NOT DONE.
	 */
	if (d.objectives && d.objectives.length > 0)
		sections.push(`## OBJECTIVES
No row below names a player. The timeline says WHICH TEAM took each one and this digest carries no
killer, so "the enemy took it" is the whole of what is known — naming a champion is inventing one.

${d.objectives
	.map(
		o =>
			`- ${fmtClock(o.tSec)} — ${o.kind}${o.subType ? ` (${o.subType})` : ""} taken by ${
				o.takenBy === "ally" ? "your team" : "the enemy"
			}${o.userZone ? `; you were around ${o.userZone}` : ""}${o.confidence ? ` [confidence ${o.confidence}]` : ""}`
	)
	.join("\n")}`)

	if (d.timeline && d.timeline.length > 0)
		sections.push(`## PER-MINUTE (differences are against the enemy in the same role; blank means not computable)

${d.timeline
	.map(
		r =>
			`- ${String(r.minute).padStart(2, " ")}:00 — gold ${signed(r.goldDiff)} · cs ${signed(r.csDiff)} · xp ${signed(r.xpDiff)}${
				r.zone ? ` · you: ${r.zone}` : ""
			}`
	)
	.join("\n")}`)

	if (d.baseline && d.baseline.length > 0)
		sections.push(`## YOUR OWN BASELINE (this is what "behind" means — never a rank average, never an invented number)

These restate the SAME averages printed on the metric lines above, and add the median. Each line
names its own metric — an average belongs to the metric on its line and to no other.

${bullets(d.baseline)}`)

	/**
	 * Champion context sits AFTER every measured section on purpose. By the time the model reads
	 * it, the numbers it is allowed to cite are already established, and this arrives explicitly
	 * labelled as the one part of the prompt that was not measured.
	 */
	if (d.championContext && !d.championContext.isDefault) {
		const cc = d.championContext
		sections.push(`## CHAMPION CONTEXT — ${cc.champion} (FETCHED, and NOT measured from this game)

This section is how ${cc.champion} works, copied line by line out of Riot's own champion data and
the League of Legends Wiki. **Every line names the source it came from, its revision and the date
it was fetched, in the line.** None of it was measured from THIS game, so it can tell you what the
champion does and it can never tell you what happened.

Rules for this section, and they are absolute:

- It may shape **what you tell him to do next game**. A fix that fits the champion beats a
  generic one.
- It may **never** become a number, a stat, a timestamp, or a claim about what happened. Every
  figure you cite still has to come from the metrics and moments above.
- If anything here disagrees with the data above, **the data wins** and you drop the note.
- Do not quote it, do not attribute it, and do not tell him "the guide says". Absorb it.
- **If something about this champion is not on a line below, no source published it and you do
  not know it.** Routes, clear order, gank conditions, power spikes and what an item purchase
  implies are not here because nothing publishes them — say less rather than filling the gap.
${cc.staleness ? `- ${cc.staleness}\n` : ""}
${cc.text}${
			cc.opponent ?
				`\n\n### The enemy jungler — ${cc.opponent.champion}\n\nSame rules. This is for understanding what he was racing, not for asserting what that player did.\n\n${cc.opponent.text}`
			:	""
		}`)
	}

	if (d.notes && d.notes.length > 0) sections.push(`## ANALYSIS CAVEATS\n\n${bullets(d.notes)}`)

	/*
	 * WITHOUT FRAMES, THE BAR IS MUCH HIGHER.
	 *
	 * A data-only review knows end-of-game totals and positions once a minute. That supports
	 * arithmetic about the whole game and supports almost nothing about individual moments —
	 * whether contesting an objective was possible depends on who was alive, whether smite was
	 * up and whether a trade elsewhere was better, and none of that is recorded.
	 *
	 * A real review said "Enemy took baron nashor while you were elsewhere" about a baron taken
	 * seconds after the player died. That is the failure mode: a confident accusation built on an
	 * interpolated position, about a moment he could not have affected.
	 */
	if (d.hasFrames !== true)
		sections.push(`## NO REPLAY FRAMES FOR THIS GAME — STAY ON THE NUMBERS

Nobody has watched this game. You have end-of-game totals and positions sampled once a MINUTE.
That is enough for arithmetic about the whole game and almost nothing about single moments.

**What you may claim:**
- Whole-game and checkpoint figures against his own baseline: camps, CS at 10/14/20, gold and xp
  deltas, damage share, vision score, KDA, deaths, objective COUNTS for each team.
- That an event happened, with its timestamp: he died at 14:20; the enemy took baron at 20:51.

**What you may NOT claim, at all:**
- That he *should have* been somewhere, or that being somewhere was a mistake. You cannot see
  who else was alive, whether smite was up, what his team was doing, or whether trading elsewhere
  was correct. An uncontested objective is a FACT about the game, not a fault.
- Anything about how an ability was used, how a camp was cleared, or how a fight was entered.
  None of that is in this data.
- Any read that depends on where he was between two frames.

**Write FEWER items than usual — three is plenty, two is fine.** An honest short review beats a
padded one, and there is genuinely less to say without having watched the game.

Set \`confidence\` honestly and expect it to be lower here; the app demotes low-confidence items
out of the corrective voice, which is the correct outcome rather than a failure.

End the review by telling him that watching the replay frames is how he gets feedback on ability
usage, kiting and fight execution — the things this data cannot reach.`)

	if (pack !== undefined && pack.trim() !== "") sections.push(pack)

	sections.push(OUTPUT_RULES)
	sections.push(
		`Write 3-6 items for this game. Order them by how much they cost him. ${
			user ? "" : "(The user could not be located in the player list — stay general and do not invent their line.)"
		}`.trim()
	)

	return sections.join("\n\n")
}

const renderTrend = (d: TrendDigest): string => {
	const sections: string[] = []
	const wins = d.games.filter(g => g.win).length

	sections.push(`# TRENDS — last ${d.gameCount} game${d.gameCount === 1 ? "" : "s"}

You are looking across recent games, not at one game. ${wins}W-${d.games.length - wins}L in the window shown below.

**Honesty rule for this pass:** a pattern needs at least 2 games behind it. With fewer, say "one game" and do not call it a trend. \`trendable: true\` means only that the LEVEL is stable enough to quote — it is NOT permission to say "improving" or "declining". You may claim a direction for exactly one reason: the series line says its slope's own 95% CI excludes zero. Everywhere else, describe the level with its interval and stop.`)

	sections.push(`## WHAT THIS DATA CANNOT TELL YOU

${bullets(d.dataGaps.length > 0 ? d.dataGaps : ["(analysis reported no gaps, which is unusual — be careful about anything you cannot point at below)"])}

${SAMPLING_NOTE}`)

	sections.push(`## GAMES

${d.games
	.map(
		g =>
			`- ${g.gameId} · ${ROLE_LABELS[g.role]} ${g.championName} · ${g.win ? "W" : "L"} in ${fmtDuration(g.durationSec)} · ${g.kills}/${g.deaths}/${g.assists} · ${g.cs} cs · ${g.gold}g · ${g.visionScore} vision`
	)
	.join("\n")}`)

	sections.push(`## SERIES — cite these by "key" in metricKeys

${
	d.series.length === 0 ?
		"(none)"
	:	d.series
			.map(
				s =>
					`- key: \`${s.key}\` — ${s.label}: mean **${n(s.mean, 1)}**` +
					`${s.ci95 === null ? " (sample too small for a confidence interval)" : ` ±${n(s.ci95, 1)} (95% CI)`}` +
					` · n=${s.points.length} · ${
						!s.trendable ? "NOT trendable — quote the level if you must, never a direction"
						: s.slopeSignificant ?
							"the level is quotable AND the slope's own 95% CI excludes zero, so a direction may be claimed"
						:	"the LEVEL is quotable, but NO direction may be claimed — the slope's own 95% CI contains zero"
					}\n` +
					`  ${s.note}\n` +
					`  values: ${s.points.map(p => n(p.value, Number.isInteger(p.value) ? 0 : 1)).join(", ")}`
			)
			.join("\n")
}`)

	if (d.aggregates && d.aggregates.length > 0)
		sections.push(`## WINDOW AGGREGATES — also citable by "key"

${d.aggregates
	.map(
		m =>
			`- key: \`${m.key}\` — ${m.label}: **${n(m.value, Number.isInteger(m.value) ? 0 : 1)}${m.unit}** · band ${m.band} · confidence ${m.confidence}\n  ${m.explain}`
	)
	.join("\n")}`)

	if (d.priorFeedback && d.priorFeedback.length > 0)
		sections.push(`## WHAT YOU ALREADY TOLD HIM (per-game reviews, newest first)

${d.priorFeedback
	.map(f => `- [${f.severity}${f.category ? `/${f.category}` : ""}] ${f.title}${f.gameId === null ? "" : ` (game ${f.gameId})`}`)
	.join("\n")}

If the same note keeps appearing, that IS the trend — say so, and say how many games it spans. Do not simply restate a per-game item as if it were new.`)

	if (d.notes && d.notes.length > 0) sections.push(`## ANALYSIS CAVEATS\n\n${bullets(d.notes)}`)

	sections.push(OUTPUT_RULES)
	sections.push(
		`For this pass: \`momentIds\` must be an empty array (moments belong to single games and are not in scope here). Use \`metricKeys\` for citations, and set \`tSec\` to null unless a series genuinely points at a game-clock moment. Write 3-5 items and exactly 1-3 goals — the goals are the point of this pass.`
	)

	return sections.join("\n\n")
}

/** Convenience for the daemon: dispatch on `digest.kind`. */
/**
 * The digest as the model sees it, with no output instructions attached.
 *
 * `gamePrompt`/`trendPrompt` bolt the review's output contract onto this; the chat needs the
 * same evidence with a different set of instructions, and both must render the digest through
 * ONE function or they will drift apart and the chat will start quoting a stale shape.
 */
export const renderDigest = (digest: Digest): string =>
	digest.kind === "game" ? renderGame(digest) : renderTrend(digest)

export const buildPrompt = (digest: Digest, opts: PromptOptions = {}): BuiltPrompt =>
	digest.kind === "game" ? gamePrompt(digest, opts) : trendPrompt(digest, opts)
