/**
 * Building the coach's prompts.
 *
 * The system prompt is **not** in this file. It is the Coach Skaffur section of `AGENTS.md`,
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

/**
 * Bumped when the *rendering* below changes in a way that should re-review existing games.
 * The persona text is hashed separately, so editing `AGENTS.md` already invalidates on its
 * own — this is for changes to the code in this file.
 */
export const PROMPT_TEMPLATE_VERSION = 1

const HERE = dirname(fileURLToPath(import.meta.url))
/** `src/review/prompt.ts` -> repo root. Overridable for tests and for a packaged install. */
export const PERSONA_PATH = process.env.CSK_AGENTS_MD ?? resolve(HERE, "../../AGENTS.md")

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
const FALLBACK_PERSONA = `You are Coach Skaffur, a League of Legends coach for one jungle player.
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
				required: ["title", "body", "severity", "category", "tSec", "momentIds", "metricKeys"],
				properties: {
					title: { type: "string", description: "Short and punchy; names the thing, e.g. 'Down 41 CS at 16:00'." },
					body: {
						type: "string",
						description:
							"The roast, the real number, then the fix — in that order. The fix goes in its own final sentence."
					},
					severity: { type: "string", enum: ["info", "minor", "major"] },
					category: {
						type: "string",
						enum: ["pathing", "tempo", "objectives", "vision", "farming", "teamfight", "deaths", "praise", "other"]
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
	const user = renderGame(digest)
	return {
		system: systemFor(persona, intensity),
		user,
		schema: COACH_JSON_SCHEMA,
		promptHash: promptHash({ persona: persona.text, kind: "game", model: opts.model, digest, intensity }),
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

Return ONE JSON object, no markdown fences, no prose outside it, matching the schema you were given:

{ "headline": string, "encouragement": string, "items": [ { "title", "body", "severity", "category", "tSec", "momentIds", "metricKeys" } ], "goals": [string] }

Non-negotiable, and mechanically checked before the user ever sees this:
- Every entry in "momentIds" must be copied character-for-character from the MOMENTS list below. Every entry in "metricKeys" must be copied character-for-character from the METRICS list below. Anything else is dropped, and an item whose citations are ALL invented is deleted whole.
- Every number, timestamp and map zone you cite must appear somewhere in this prompt.
- "tSec" is SECONDS of game clock, and must fall inside the game's duration.
- Every item ends on a concrete thing to do next game.
- At least one item is positive (severity "info", category "praise") whenever the data supports one.
- Hedge anything drawn from a low-confidence moment. You may say "you looked alone"; you may not say "you were alone".`

const SAMPLING_NOTE = `Positions come from timeline frames sampled once per ${Math.round(
	FRAME_INTERVAL_MS / 1000
)} seconds; the median distance travelled between two samples is about 28% of the map. Anything about who was near whom, or where someone walked between samples, is an interpolation. Moments marked confidence "low" depend on that interpolation — hedge them.`

const renderGame = (d: GameDigest): string => {
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
- ${g.role === "JGL" ? "Camps" : "CS"}: ${g.role === "JGL" ? g.jungleCs : g.cs + g.jungleCs}${g.role === "JGL" ? ` (plus ${g.cs} lane minions)` : ""}
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

	sections.push(`## METRICS — cite these by "key"

${
	d.metrics.length === 0 ?
		"(none — analysis produced no metrics for this game)"
	:	d.metrics
			.map(
				m =>
					`- key: \`${m.key}\` — ${m.label}: **${n(m.value, Number.isInteger(m.value) ? 0 : 1)}${m.unit}**` +
					` · vs your own baseline: ${m.vsBaseline === null ? "no baseline yet" : signed(m.vsBaseline, Number.isInteger(m.vsBaseline) ? 0 : 1)}` +
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

	if (d.objectives && d.objectives.length > 0)
		sections.push(`## OBJECTIVES

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

${bullets(d.baseline)}`)

	if (d.notes && d.notes.length > 0) sections.push(`## ANALYSIS CAVEATS\n\n${bullets(d.notes)}`)

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

**Honesty rule for this pass:** a pattern needs at least 2 games behind it. With fewer, say "one game" and do not call it a trend. Where a series is marked \`trendable: false\`, the spread swamps the slope — describe the level, never the direction.`)

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
					` · n=${s.points.length} · ${s.trendable ? "a direction is defensible here" : "NOT trendable"}\n` +
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
export const buildPrompt = (digest: Digest, opts: PromptOptions = {}): BuiltPrompt =>
	digest.kind === "game" ? gamePrompt(digest, opts) : trendPrompt(digest, opts)
