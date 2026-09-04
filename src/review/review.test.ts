/**
 * Offline tests for the review unit. No network, no database, no `claude` subprocess —
 * everything here runs in milliseconds so it can stay in `pnpm test` forever.
 *
 * The fixtures below are SHAPE fixtures, not League data: gameId 1, two moments, two metrics.
 * They are deliberately not plausible match statistics, so nothing in this file can ever be
 * mistaken for a real game (see AGENTS.md, "Never fabricate a stat").
 *
 * Run: node --experimental-strip-types --test "src/**\/*.test.ts"
 */

import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { extractJson, runCoach } from "./claude.ts"
import { allowlistOf, GameDigest } from "./digest-contract.ts"
import type { GameDigest as GameDigestT, TrendDigest as TrendDigestT } from "./digest-contract.ts"
import { clearPersonaCache, extractPersona, gamePrompt, loadPersona, PERSONA_PATH, promptHash, trendPrompt } from "./prompt.ts"
import { buildReview, failedReview, makeReviewId, parseCoachOutput } from "./parse.ts"

/* ============================================================ fixture */

const digest: GameDigestT = {
	kind: "game",
	schemaVersion: 1,
	game: {
		gameId: 1,
		teamId: 100,
		queue: "test-queue",
		patch: "0.0",
		durationSec: 600,
		win: true,
		championName: "test-champion",
		role: "JGL",
		roleConfidence: "high",
		kills: 0,
		deaths: 0,
		assists: 0,
		cs: 0,
		jungleCs: 0,
		gold: 0,
		visionScore: 0,
		champLevel: 1,
		damageToChampions: 0
	},
	players: [
		{
			participantId: 1,
			team: "ally",
			role: "JGL",
			championName: "test-champion",
			isUser: true,
			kills: 0,
			deaths: 0,
			assists: 0,
			cs: 0,
			gold: 0,
			visionScore: 0,
			champLevel: 1,
			damageToChampions: 0
		},
		{
			participantId: 6,
			team: "enemy",
			role: "JGL",
			championName: "test-enemy",
			isUser: false,
			kills: 0,
			deaths: 0,
			assists: 0,
			cs: 0,
			gold: 0,
			visionScore: 0,
			champLevel: 1,
			damageToChampions: 0
		}
	],
	metrics: [
		{
			key: "metric_a",
			label: "Metric A",
			value: 1,
			unit: "",
			band: "unknown",
			vsBaseline: null,
			confidence: "high",
			explain: "fixture"
		},
		{
			key: "metric_b",
			label: "Metric B",
			value: 2,
			unit: "",
			band: "unknown",
			vsBaseline: null,
			confidence: "low",
			explain: "fixture"
		}
	],
	moments: [
		{
			id: "g1-death-100",
			gameId: 1,
			tSec: 100,
			kind: "death",
			title: "Fixture death",
			severity: 0.5,
			mapX: 7000,
			mapY: 7000,
			cameraTarget: null,
			participantsInvolved: [1],
			costGold: null,
			confidence: "high",
			evidence: "fixture"
		},
		{
			id: "g1-objective-200",
			gameId: 1,
			tSec: 200,
			kind: "objective",
			title: "Fixture objective",
			severity: 0.3,
			mapX: 9800,
			mapY: 4400,
			cameraTarget: null,
			participantsInvolved: [1],
			costGold: null,
			confidence: "medium",
			evidence: "fixture"
		}
	],
	dataGaps: ["no item purchases", "no ward placements"]
}

const allowed = allowlistOf(digest)

const item = (over: Record<string, unknown> = {}) => ({
	title: "T",
	body: "Body with the number 7 in it.",
	severity: "minor",
	category: "pathing",
	tSec: 100,
	momentIds: ["g1-death-100"],
	metricKeys: ["metric_a"],
	...over
})

const output = (over: Record<string, unknown> = {}) => ({
	headline: "H",
	encouragement: "E",
	items: [item()],
	goals: ["do the thing"],
	...over
})

const build = (raw: unknown) =>
	buildReview({
		raw,
		kind: "game",
		gameId: 1,
		model: "test-model",
		promptHash: "0".repeat(64),
		allowed,
		durationSec: digest.game.durationSec
	})

/* ============================================================ digest */

test("the fixture digest validates against the contract", () => {
	const parsed = GameDigest(digest)
	assert.ok(!(parsed instanceof Error), "fixture should be a valid GameDigest")
})

test("allowlistOf collects every moment id and metric key", () => {
	assert.deepEqual([...allowed.momentIds].sort(), ["g1-death-100", "g1-objective-200"])
	assert.deepEqual([...allowed.metricKeys].sort(), ["metric_a", "metric_b"])
})

/* =========================================================== persona */

test("the real AGENTS.md yields a persona from its markers, with no warnings", () => {
	clearPersonaCache()
	const p = loadPersona()
	assert.equal(p.source, "markers", `expected marker extraction from ${PERSONA_PATH}`)
	assert.deepEqual(p.warnings, [])
	assert.ok(p.text.length > 2000, "the persona should be substantial")
	assert.match(p.text, /coachskaffur/)
	assert.match(p.text, /Faker/)
	assert.ok(!p.text.includes("## Part 1"), "Part 1 must not leak into the system prompt")
})

test("markers mentioned inline in prose do not truncate the persona", () => {
	// This is the exact bug the line-anchored matcher exists to prevent: AGENTS.md's own
	// preamble names both markers inside one sentence.
	const md = [
		"# Doc",
		"The markers `<!-- COACH:BEGIN -->` / `<!-- COACH:END -->` are load-bearing.",
		"",
		"<!-- COACH:BEGIN -->",
		"REAL PERSONA. ".repeat(40),
		"<!-- COACH:END -->"
	].join("\n")
	const p = extractPersona(md, "test.md")
	assert.equal(p.source, "markers")
	assert.ok(p.text.startsWith("REAL PERSONA."))
})

test("a missing marker pair falls back to the heading, then to the built-in persona", () => {
	const heading = `# Doc\n\n## Part 2 — The Coach\n\n${"Heading persona body. ".repeat(20)}\n\n## Part 3\n\nnot this`
	const h = extractPersona(heading, "test.md")
	assert.equal(h.source, "heading")
	assert.ok(!h.text.includes("not this"))
	assert.equal(h.warnings.length, 1)

	const none = extractPersona("# Doc\n\nnothing here", "test.md")
	assert.equal(none.source, "fallback")
	assert.match(none.text, /coachskaffur/)
	assert.ok(none.warnings.length > 0)
})

test("a missing AGENTS.md degrades to the fallback persona instead of throwing", () => {
	clearPersonaCache()
	const p = loadPersona(join(mkdtempSync(join(tmpdir(), "csk-")), "does-not-exist.md"))
	assert.equal(p.source, "fallback")
	assert.ok(p.warnings.length > 0)
	clearPersonaCache()
})

/* ============================================================ prompt */

test("the game prompt prints every citable id, plus the data gaps", () => {
	const built = gamePrompt(digest, { model: "test-model" })
	for (const m of digest.moments) assert.ok(built.user.includes(m.id), `moment id ${m.id} missing from prompt`)
	for (const m of digest.metrics) assert.ok(built.user.includes(m.key), `metric key ${m.key} missing from prompt`)
	for (const gap of digest.dataGaps) assert.ok(built.user.includes(gap), `data gap "${gap}" missing from prompt`)
	assert.match(built.user, /once per 60 seconds/)
	assert.ok(built.system.includes("coachskaffur"))
})

test("the prompt names map zones rather than raw coordinates", () => {
	const built = gamePrompt(digest, { model: "test-model" })
	assert.match(built.user, /dragon pit/)
	assert.ok(!built.user.includes("9800"), "raw x/y should not be rendered")
})

test("intensity changes the system prompt but never the digest", () => {
	const dry = gamePrompt(digest, { intensity: 0 })
	const loud = gamePrompt(digest, { intensity: 1 })
	assert.notEqual(dry.system, loud.system)
	assert.equal(dry.user, loud.user)
	assert.match(dry.system, /dry and clinical/)
	assert.match(loud.system, /meme goblin/)
})

test("promptHash is stable, and moves when the persona, model, digest or intensity moves", () => {
	const persona = { text: "P", source: "markers" as const, path: "x", warnings: [] }
	const base = { persona: persona.text, kind: "game", model: "m", digest, intensity: 0.8 }
	assert.equal(promptHash(base), promptHash(base), "same inputs must hash the same")
	assert.notEqual(promptHash(base), promptHash({ ...base, persona: "P2" }))
	assert.notEqual(promptHash(base), promptHash({ ...base, model: "m2" }))
	assert.notEqual(promptHash(base), promptHash({ ...base, intensity: 0.1 }))
	assert.notEqual(
		promptHash(base),
		promptHash({ ...base, digest: { ...digest, game: { ...digest.game, deaths: 1 } } })
	)
})

test("promptHash ignores when the digest was built, so re-reviewing does not re-bill", () => {
	// buildGameDigest stamps generatedMs: Date.now(). It is never rendered into the prompt, so
	// two digests that differ only there are the SAME prompt and must hash the same — otherwise
	// reviewExistsForPrompt never matches and every re-open pays Claude again for identical
	// bytes. This is exactly what happened in practice: four reviews of one game, four hashes.
	const base = { persona: "P", kind: "game", model: "m", intensity: 0.8 }
	const at = (generatedMs: number) => promptHash({ ...base, digest: { ...digest, generatedMs } })
	assert.equal(at(1), at(2), "generatedMs must not change the hash")

	// ...but anything the model actually reads still must.
	assert.notEqual(
		at(1),
		promptHash({
			...base,
			digest: { ...digest, generatedMs: 1, game: { ...digest.game, deaths: 99 } }
		})
	)
})

test("editing AGENTS.md invalidates the prompt hash", () => {
	const dir = mkdtempSync(join(tmpdir(), "csk-persona-"))
	const path = join(dir, "AGENTS.md")
	const write = (body: string) =>
		writeFileSync(path, `# Doc\n\n<!-- COACH:BEGIN -->\n${body.repeat(30)}\n<!-- COACH:END -->\n`)

	write("version one. ")
	clearPersonaCache()
	const a = gamePrompt(digest, { persona: loadPersona(path) }).promptHash
	write("version two. ")
	clearPersonaCache()
	const b = gamePrompt(digest, { persona: loadPersona(path) }).promptHash
	assert.notEqual(a, b)
	clearPersonaCache()
})

/* ======================================================== extraction */

test("extractJson recovers an object from fences, prose and trailing chatter", () => {
	assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
	assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
	assert.deepEqual(extractJson('Here you go!\n```\n{"a":1}\n```\nHope that helps.'), { a: 1 })
	assert.deepEqual(extractJson('Sure: {"a":1} — done.'), { a: 1 })
	assert.deepEqual(extractJson('{"a":"a } brace in a string"}'), { a: "a } brace in a string" })
	assert.deepEqual(extractJson('{"a":"escaped \\" quote }"}'), { a: 'escaped " quote }' })
	assert.equal(extractJson("no json at all"), undefined)
	assert.equal(extractJson("   "), undefined)
})

/* ============================================================= parse */

test("a well-formed response parses", () => {
	const r = parseCoachOutput(output())
	assert.ok(r.ok)
	assert.equal(r.value.items.length, 1)
})

test("a fenced string response parses", () => {
	const r = parseCoachOutput("```json\n" + JSON.stringify(output()) + "\n```")
	assert.ok(r.ok)
})

test("empty, non-JSON, array and headline-less responses fail with distinct codes", () => {
	const empty = parseCoachOutput("")
	assert.ok(!empty.ok && empty.code === "empty")
	const notJson = parseCoachOutput("I would rather not.")
	assert.ok(!notJson.ok && notJson.code === "not-json")
	const arr = parseCoachOutput([1, 2, 3])
	assert.ok(!arr.ok && arr.code === "not-object")
	const noHeadline = parseCoachOutput(output({ headline: "" }))
	assert.ok(!noHeadline.ok && noHeadline.code === "schema")
})

test('a "8:12" clock string is coerced to seconds', () => {
	const r = parseCoachOutput(output({ items: [item({ tSec: "8:12" })] }))
	assert.ok(r.ok)
	assert.equal(r.value.items[0]?.tSec, 492)
})

/* ==================================================== no-fabrication */

test("an unknown moment id is dropped and warned about", () => {
	const r = build(output({ items: [item({ momentIds: ["g1-death-100", "g1-death-999"] })] }))
	assert.ok(r.ok)
	assert.deepEqual(r.value.items[0]?.momentIds, ["g1-death-100"])
	assert.ok(r.warnings.some(w => w.code === "unknown-moment-id" && w.message.includes("g1-death-999")))
})

test("an item whose citations are ALL invented is deleted whole", () => {
	const r = build(
		output({
			items: [item(), item({ title: "Fabricated", momentIds: ["nope"], metricKeys: ["also-nope"] })]
		})
	)
	assert.ok(r.ok)
	assert.equal(r.value.items.length, 1)
	assert.equal(r.value.items[0]?.title, "T")
	assert.ok(r.warnings.some(w => w.code === "fabricated-citations"))
})

test("a review in which every item was fabricated fails rather than shipping", () => {
	const r = build(output({ items: [item({ momentIds: ["nope"], metricKeys: ["nope"] })] }))
	assert.ok(!r.ok)
	assert.equal(r.code, "no-items")
})

test("a tSec outside the game is nulled, not shown", () => {
	const r = build(output({ items: [item({ tSec: 99_999 })] }))
	assert.ok(r.ok)
	assert.equal(r.value.items[0]?.tSec, null)
	assert.ok(r.warnings.some(w => w.code === "tsec-out-of-range"))
})

test("an item with no digit in its body is kept but flagged", () => {
	const r = build(output({ items: [item({ body: "Just vibes, no numbers here." })] }))
	assert.ok(r.ok)
	assert.ok(r.warnings.some(w => w.code === "no-number-cited"))
})

test("a review with no positive item is flagged", () => {
	const r = build(output({ items: [item({ severity: "major", category: "deaths" })] }))
	assert.ok(r.ok)
	assert.ok(r.warnings.some(w => w.code === "no-praise"))
})

/* ========================================================== assembly */

test("ids are deterministic so a re-run upserts rather than duplicates", () => {
	const a = build(output())
	const b = build(output())
	assert.ok(a.ok && b.ok)
	assert.equal(a.value.id, b.value.id)
	assert.equal(a.value.id, makeReviewId("game", 1, "0".repeat(64)))
	assert.equal(a.value.items[0]?.id, `${a.value.id}-i0`)
})

test("goals are trimmed, deduped and capped at three", () => {
	const r = build(output({ goals: [" a ", "a", "b", "c", "d"] }))
	assert.ok(r.ok)
	assert.deepEqual(r.value.goals, ["a", "b", "c"])
	assert.ok(r.warnings.some(w => w.code === "goals-truncated"))
})

test("the assembled review is shaped for insertReview", () => {
	const r = build(output())
	assert.ok(r.ok)
	const rv = r.value
	assert.equal(rv.kind, "game")
	assert.equal(rv.gameId, 1)
	assert.equal(rv.status, "ok")
	assert.equal(rv.error, null)
	assert.equal(typeof rv.createdMs, "number")
	assert.deepEqual(rv.items[0]?.mediaIds, [], "media is attached later by the capture pipeline")
})

test("failedReview produces a persistable row that carries the error", () => {
	const rv = failedReview({
		kind: "game",
		gameId: 1,
		model: "test-model",
		promptHash: "0".repeat(64),
		error: "the model was rate limited"
	})
	assert.equal(rv.status, "failed")
	assert.equal(rv.error, "the model was rate limited")
	assert.deepEqual(rv.items, [])
	assert.equal(rv.id, makeReviewId("game", 1, "0".repeat(64)))
})

/* ============================================================= trend */

const trendDigest: TrendDigestT = {
	kind: "trend",
	schemaVersion: 1,
	gameCount: 2,
	games: [
		{
			gameId: 1,
			gameCreationMs: 0,
			championName: "test-champion",
			role: "JGL",
			win: true,
			durationSec: 600,
			kills: 0,
			deaths: 0,
			assists: 0,
			cs: 0,
			gold: 0,
			visionScore: 0
		},
		{
			gameId: 2,
			gameCreationMs: 1,
			championName: "test-champion",
			role: "JGL",
			win: false,
			durationSec: 600,
			kills: 0,
			deaths: 0,
			assists: 0,
			cs: 0,
			gold: 0,
			visionScore: 0
		}
	],
	series: [
		{
			key: "series_a",
			label: "Series A",
			points: [
				{ gameId: 1, tMs: 0, value: 1 },
				{ gameId: 2, tMs: 1, value: 2 }
			],
			mean: 1.5,
			ci95: null,
			trendable: false,
			note: "n=2, too few games for a direction"
		}
	],
	dataGaps: ["no per-minute data in this window"],
	priorFeedback: [{ gameId: 1, title: "An earlier note", severity: "major", category: "deaths" }]
}

test("the trend prompt cites series keys, prior feedback and the honesty rule", () => {
	const built = trendPrompt(trendDigest, { model: "test-model" })
	assert.ok(built.user.includes("series_a"))
	assert.ok(built.user.includes("NOT trendable"))
	assert.ok(built.user.includes("An earlier note"))
	assert.ok(built.user.includes("no per-minute data in this window"))
	assert.match(built.user, /at least 2 games/)
	assert.match(built.user, /`momentIds` must be an empty array/)
})

test("a trend review has no moments to cite, so any moment id is a fabrication", () => {
	const trendAllowed = allowlistOf(trendDigest)
	assert.equal(trendAllowed.momentIds.size, 0)
	assert.deepEqual([...trendAllowed.metricKeys], ["series_a"])

	const r = buildReview({
		raw: output({
			items: [
				item({ momentIds: [], metricKeys: ["series_a"] }),
				item({ title: "Invented", momentIds: ["g1-death-100"], metricKeys: [] })
			]
		}),
		kind: "trend",
		gameId: null,
		model: "test-model",
		promptHash: "0".repeat(64),
		allowed: trendAllowed
	})
	assert.ok(r.ok)
	assert.equal(r.value.items.length, 1, "the item citing a per-game moment must be dropped")
	assert.equal(r.value.gameId, null)
	assert.ok(r.warnings.some(w => w.code === "fabricated-citations"))
})

/* ========================================================== runCoach */

/**
 * `runCoach` is exercised against a stub that impersonates `claude -p --output-format json`.
 * The real CLI is verified separately (and costs money per call); the retry, timeout, stdin
 * and error-shaping logic does not need a real model to be worth testing.
 */
const stubCli = (bodyJs: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "csk-stub-"))
	const path = join(dir, "stub-claude.mjs")
	writeFileSync(
		path,
		`#!/usr/bin/env node
const args = process.argv.slice(2)
let stdin = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", d => (stdin += d))
process.stdin.on("end", () => {
${bodyJs}
})
`
	)
	chmodSync(path, 0o755)
	return path
}

const withStub = async <T>(bin: string, fn: () => Promise<T>): Promise<T> => {
	const prev = process.env.CSK_CLAUDE_BIN
	process.env.CSK_CLAUDE_BIN = bin
	try {
		return await fn()
	} finally {
		if (prev === undefined) delete process.env.CSK_CLAUDE_BIN
		else process.env.CSK_CLAUDE_BIN = prev
	}
}

const call = (over: Record<string, unknown> = {}) =>
	runCoach({ system: "sys", user: "usr", model: "test-model", schema: { type: "object" }, label: "test", ...over })

// Never write data/logs/coach.jsonl from the test suite.
process.env.CSK_COACH_LOG = "0"

test("runCoach parses a good CLI response and records usage", async () => {
	const good = stubCli(
		`process.stdout.write(JSON.stringify({type:"result",is_error:false,num_turns:1,session_id:"stub-session",total_cost_usd:0.001,usage:{input_tokens:10,output_tokens:20},result:JSON.stringify({headline:"H"})}))`
	)
	const r = await withStub(good, () => call())
	assert.ok(r.ok, r.ok ? "" : r.error)
	assert.deepEqual(r.data, { headline: "H" })
	assert.equal(r.meta.transport, "cli")
	assert.equal(r.meta.attempts, 1)
	assert.equal(r.meta.turns, 1)
	assert.equal(r.meta.usage.inputTokens, 10)
	assert.equal(r.meta.usage.outputTokens, 20)
	assert.equal(r.meta.usage.costUsd, 0.001)
})

test("the prompt travels on stdin, never on argv", async () => {
	const echo = stubCli(
		`process.stdout.write(JSON.stringify({is_error:false,result:JSON.stringify({stdinChars:stdin.length,argvHasPrompt:args.some(a=>a.includes("SECRET-PROMPT"))})}))`
	)
	const r = await withStub(echo, () => call({ user: "SECRET-PROMPT ".repeat(100) }))
	assert.ok(r.ok)
	assert.deepEqual(r.data, { stdinChars: 1400, argvHasPrompt: false })
})

test("structured_output is preferred over the text result when present", async () => {
	const stub = stubCli(
		`process.stdout.write(JSON.stringify({is_error:false,structured_output:{from:"schema"},result:"{\\"from\\":\\"text\\"}"}))`
	)
	const r = await withStub(stub, () => call({ schemaMode: "always" }))
	assert.ok(r.ok)
	assert.deepEqual(r.data, { from: "schema" })
})

test("unparseable output is retried once, and the retry attaches the schema", async () => {
	// Emits prose unless --json-schema is present. This is exactly the on-retry contract.
	const stub = stubCli(
		`const strict = args.includes("--json-schema")
  process.stdout.write(JSON.stringify({is_error:false,result: strict ? JSON.stringify({headline:"recovered"}) : "Sure! Here are my thoughts, in prose."}))`
	)
	const r = await withStub(stub, () => call())
	assert.ok(r.ok, r.ok ? "" : r.error)
	assert.deepEqual(r.data, { headline: "recovered" })
	assert.equal(r.meta.attempts, 2)
	assert.ok(r.meta.warnings.some(w => w.includes("schema")))
})

test("output that never parses fails after exactly the allowed attempts", async () => {
	const stub = stubCli(`process.stdout.write(JSON.stringify({is_error:false,result:"nothing but prose"}))`)
	const r = await withStub(stub, () => call())
	assert.ok(!r.ok)
	assert.equal(r.code, "malformed-json")
	assert.equal(r.meta.attempts, 2)
})

test("a CLI error is not retried and carries its detail", async () => {
	const stub = stubCli(
		`process.stdout.write(JSON.stringify({is_error:true,subtype:"error_during_execution",result:"rate limited",usage:{input_tokens:1,output_tokens:0}}))
  process.exitCode = 1`
	)
	const r = await withStub(stub, () => call())
	assert.ok(!r.ok)
	assert.equal(r.code, "cli-error")
	assert.equal(r.meta.attempts, 1, "a transport error must not burn a retry")
	assert.match(r.error, /rate limited/)
})

test("a missing binary is reported, not thrown", async () => {
	const r = await withStub("/definitely/not/a/real/binary", () => call())
	assert.ok(!r.ok)
	assert.equal(r.code, "spawn-failed")
	assert.match(r.error, /could not run/)
})

test("a non-JSON stdout is reported as a CLI error", async () => {
	const stub = stubCli(`process.stdout.write("command not found")`)
	const r = await withStub(stub, () => call())
	assert.ok(!r.ok)
	assert.equal(r.code, "cli-error")
})

test("runCoach times out instead of hanging the daemon", async () => {
	const stub = stubCli(`setTimeout(() => process.stdout.write("{}"), 60000)`)
	const r = await withStub(stub, () => call({ timeoutMs: 200 }))
	assert.ok(!r.ok)
	assert.equal(r.code, "timeout")
	assert.match(r.error, /200 ms/)
})

test("runCoach honours an AbortSignal", async () => {
	const stub = stubCli(`setTimeout(() => process.stdout.write("{}"), 60000)`)
	const ac = new AbortController()
	setTimeout(() => ac.abort(), 100)
	const r = await withStub(stub, () => call({ signal: ac.signal, timeoutMs: 30_000 }))
	assert.ok(!r.ok)
	assert.equal(r.code, "aborted")
})

test("a stub response flows all the way through buildReview", async () => {
	const stub = stubCli(
		`process.stdout.write(JSON.stringify({is_error:false,total_cost_usd:0.002,usage:{input_tokens:5,output_tokens:6},result:JSON.stringify({
    headline:"H", encouragement:"E", goals:["g"],
    items:[{title:"T",fix:"Keep doing that",body:"7 of them",severity:"info",category:"praise",impact:"medium",actionability:"high",confidence:"high",tSec:100,momentIds:["g1-death-100"],metricKeys:["metric_a"]}]
  })}))`
	)
	const built = gamePrompt(digest, { model: "test-model" })
	const r = await withStub(stub, () => call({ system: built.system, user: built.user }))
	assert.ok(r.ok)
	const rv = buildReview({
		raw: r.data,
		kind: "game",
		gameId: 1,
		model: "test-model",
		promptHash: built.promptHash,
		allowed,
		durationSec: digest.game.durationSec,
		meta: r.meta
	})
	assert.ok(rv.ok, rv.ok ? "" : rv.error)
	assert.equal(rv.value.costUsd, 0.002)
	assert.equal(rv.value.inputTokens, 5)
	assert.deepEqual(rv.value.items[0]?.momentIds, ["g1-death-100"])
	assert.deepEqual(rv.warnings, [])
})
