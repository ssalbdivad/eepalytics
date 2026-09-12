/**
 * The mechanical clock check, pinned in both directions.
 *
 * The whole point of this file is that the checker must NOT convict a correct sentence. Every
 * inversion it catches is worth nothing if it also flags "back in twelve seconds" as wrong, so the
 * supported cases below outnumber the contradicted ones deliberately.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { clockClaims, deathClockBlock, framingOf, mechanicalVerdict, readPayload } from "./payload-claims.ts"

/** A block in the shape `live-brief.ts` rendered BEFORE the both-clocks fix: remaining only. */
const OLD = `NOW
8:42. YOU ARE ALIVE, HP 80% (900 of 1130), mana 50% (300 of 608). Counterpart Kayn: DEAD, back in 12s, lvl 6 — level with you, 1/1/0 (row 4s old).

GAME CLOCK 8:42. CLASSIC on Summoner's Rift.

YOU — Lillia, JUNGLE, level 6, side ORDER

ENEMY JUNGLER — Kayn, level 6, 1/1/0

YOUR TEAM (besides you)
- Urgot (TOP, lvl 6) 0/0/0, 10 CS, ward score 0.0. Items: no items
- Yone (MIDDLE, lvl 7) 0/0/0, 40 CS, ward score 0.0. Items: no items
- Xayah (BOTTOM, lvl 6) 0/0/0, 50 CS, ward score 0.0. Items: no items
- Morgana (UTILITY, lvl 5) 0/0/0, 0 CS, ward score 1.0. Items: no items

ENEMY TEAM (besides their jungler)
- Ornn (TOP, lvl 6) 0/0/0, 20 CS, ward score 0.0. Items: no items
- Singed (MIDDLE, lvl 6) 0/0/0, 30 CS, ward score 0.0. Items: no items
- Draven (BOTTOM, lvl 7) 2/0/0, 60 CS, ward score 0.0. Items: no items
- Lulu (UTILITY, lvl 5) 0/1/0, 0 CS, ward score 1.5 DEAD, respawns in 20s. Items: no items`

/**
 * The same instant with both clocks, in the wording of the 2026-09-12 corpora — `down Ns, back in
 * Ns`. KEPT, because every stored run under `data/eval/` is written in it and a reader must be able
 * to re-derive those figures with today's checker.
 */
const NEW = OLD.replace("Kayn: DEAD, back in 12s", "Kayn: DEAD, down 21s, back in 12s").replace(
	"ward score 1.5 DEAD, respawns in 20s",
	"ward score 1.5 DEAD, down at least 9s, respawns in 20s"
)

/** The same instant in the wording the brief renders TODAY: each clock naming its own direction. */
const SHIPPED = OLD.replace("Kayn: DEAD, back in 12s", "Kayn: DEAD, died 21s ago, respawns in 12s").replace(
	"ward score 1.5 DEAD, respawns in 20s",
	"ward score 1.5 DEAD, died at least 9s ago, respawns in 20s"
)

/*
 * TWO WORDINGS, ONE CHECKER, and the reason is that the stored corpora cannot be re-rendered. The
 * clock phrasing changed on 2026-09-12 after the old pair was measured and found unreadable in
 * 95% [87-98] of the lines that state an elapsed death time; every run on disk is in the old
 * wording and every run after it is in the new one. A checker that understood only one of them
 * would silently report `not-stated` for half the evidence in this repo.
 */
test("the same instant parses identically in the stored wording and the shipped one", () => {
	const a = readPayload(NEW)
	const b = readPayload(SHIPPED)
	for (const champ of ["Kayn", "Lulu"]) {
		const x = a.dead.find(d => d.champion === champ)!
		const y = b.dead.find(d => d.champion === champ)!
		assert.deepEqual(
			{ e: y.elapsedSec, k: y.elapsedKind, r: y.remainingSec },
			{ e: x.elapsedSec, k: x.elapsedKind, r: x.remainingSec },
			champ
		)
	}
})

test("reads the roster, both clocks and the game clock off a rendered block", () => {
	const f = readPayload(NEW)
	assert.equal(f.clockSec, 522)
	assert.equal(f.me, "Lillia")
	assert.equal(f.counterpart, "Kayn")
	assert.ok(f.roster.includes("Draven") && f.roster.includes("Ornn") && f.roster.includes("Kayn"))
	const kayn = f.dead.find(d => d.champion === "Kayn")!
	assert.deepEqual({ e: kayn.elapsedSec, k: kayn.elapsedKind, r: kayn.remainingSec }, { e: 21, k: "exact", r: 12 })
	const lulu = f.dead.find(d => d.champion === "Lulu")!
	assert.deepEqual({ e: lulu.elapsedSec, k: lulu.elapsedKind, r: lulu.remainingSec }, { e: 9, k: "at-least", r: 20 })
})

test("an old block states only the remaining clock, and says so rather than guessing", () => {
	const kayn = readPayload(OLD).dead.find(d => d.champion === "Kayn")!
	assert.deepEqual({ e: kayn.elapsedSec, k: kayn.elapsedKind, r: kayn.remainingSec }, { e: null, k: "not-stated", r: 12 })
})

test("THE INVERSION: an elapsed claim that is really the remaining figure", () => {
	// 132 of 135 elapsed lines on the stored runs did exactly this.
	const claims = clockClaims("Kayn has been dead for twelve seconds, so start the grubs now.", readPayload(OLD))
	assert.equal(claims.length, 1)
	assert.equal(claims[0]!.verdict, "UNSUPPORTED")
	assert.equal(claims[0]!.matchesOtherClock, true)
	assert.equal(mechanicalVerdict(claims), "inversion-shaped")
})

test("the same sentence against a block that states the elapsed half is decidably wrong", () => {
	const claims = clockClaims("Kayn has been dead for twelve seconds, so start the grubs now.", readPayload(NEW))
	assert.equal(claims[0]!.verdict, "CONTRADICTED")
	assert.equal(mechanicalVerdict(claims), "contradicted")
})

test("and the correct elapsed sentence against the same block is SUPPORTED", () => {
	const claims = clockClaims("Kayn is down for twenty seconds, so start the grubs now.", readPayload(NEW))
	assert.equal(claims[0]!.verdict, "SUPPORTED")
	assert.equal(mechanicalVerdict(claims), "supported")
})

test("a REMAINING claim is checked against the remaining figure, not convicted for it", () => {
	const claims = clockClaims("Kayn is back in twelve seconds, so take the grubs before he lands.", readPayload(OLD))
	assert.equal(claims.length, 1)
	assert.equal(claims[0]!.verdict, "SUPPORTED")
	assert.equal(claims[0]!.matchesOtherClock, false)
})

test("'dead for ANOTHER twenty seconds' is a remaining claim, not an inversion", () => {
	// The word `another` is the whole difference, and reading it backwards would manufacture an
	// inversion out of a correct sentence.
	const claims = clockClaims("Lulu is dead for another twenty seconds.", readPayload(OLD))
	assert.equal(claims.length, 1)
	assert.equal(claims[0]!.kind, "dead.remaining")
	assert.equal(claims[0]!.verdict, "SUPPORTED")
})

test("a death clock about somebody the payload has ALIVE is contradicted outright", () => {
	const claims = clockClaims("Draven is dead for thirty seconds, so push the lane.", readPayload(NEW))
	assert.equal(claims[0]!.verdict, "CONTRADICTED")
})

test("a figure with no champion to attach it to produces no claim at all", () => {
	assert.deepEqual(clockClaims("You have been dead for twelve seconds.", readPayload(NEW)), [])
	assert.equal(mechanicalVerdict([]), "no-claim")
})

test("a sentence naming two dead players attaches each figure to its own clause", () => {
	const p = readPayload(NEW)
	const claims = clockClaims("Kayn is down for twenty seconds and Lulu is back in twenty seconds.", p)
	assert.deepEqual(
		claims.map(c => [c.subject, c.kind, c.verdict]),
		[
			["Lulu", "dead.remaining", "SUPPORTED"],
			["Kayn", "dead.elapsed", "SUPPORTED"]
		]
	)
})

test("the block handed to the judge states both clocks and never derives one from the other", () => {
	const block = deathClockBlock(readPayload(NEW))
	assert.match(block, /Kayn: already dead 21s; 12s LEFT/)
	assert.match(block, /Lulu: already dead AT LEAST 9s; 20s LEFT/)
	assert.match(deathClockBlock(readPayload(OLD)), /Kayn: how long he has ALREADY been dead is NOT STATED/)
})

test("nobody down renders as nobody down, not as an empty list", () => {
	const alive = OLD.replace("Kayn: DEAD, back in 12s", "Kayn: alive").replace(
		" DEAD, respawns in 20s",
		""
	)
	assert.match(deathClockBlock(readPayload(alive)), /nobody in this payload is down/)
})

/**
 * THE COUPLING, PINNED AGAINST THE REAL RENDERER.
 *
 * Everything above is checked against blocks written by hand in this file, which proves the regexes
 * read what this file thinks a block looks like and nothing more. The renderer is in another module
 * and is edited for other reasons; a reworded death clause would leave every test above passing and
 * silently take this checker to zero claims — a mechanical check that finds nothing looks exactly
 * like a coach that stopped making the error.
 *
 * So this builds a block with `buildBrief` from the shared fixture and reads it back. The fixture's
 * own `deathsSeen` entry is the one `live-brief.test.ts` uses: Lissandra's `ChampionKill` at 346s.
 */
test("readPayload recovers both clocks from a block the real renderer wrote", async () => {
	const { readFileSync } = await import("node:fs")
	const { buildBrief } = await import("../../src/shared/live-brief.ts")
	const raw = readFileSync(new URL("../../src/shared/__fixtures__/live-brief-sample.ndjson", import.meta.url), "utf8")
	const cur = JSON.parse(raw.trim().split("\n").at(-1)!) as { gameTime: number; data: unknown }
	const brief = buildBrief({
		raw: cur.data,
		gameTimeSec: cur.gameTime,
		counterpartSeenSec: cur.gameTime - 118,
		deathsSeen: { Lissandra: { atSec: 346, exact: true } }
	})
	assert.ok(brief, "the fixture must still build a brief")
	const facts = readPayload(brief.text)
	assert.equal(facts.me, "Lillia")
	assert.equal(facts.counterpart, "Briar")
	assert.equal(facts.roster.length, 10, `roster was ${facts.roster.join(", ")}`)
	const liss = facts.dead.find(d => d.champion === "Lissandra")
	assert.ok(liss, `no death clock read for Lissandra; dead read as ${facts.dead.map(d => d.champion).join(", ") || "nobody"}`)
	assert.equal(liss.elapsedKind, "exact")
	assert.equal(liss.elapsedSec, Math.round(cur.gameTime - 346))
	assert.ok(liss.remainingSec !== null && liss.remainingSec >= 0)
})

/*
 * The three cases the dead-clock headline turns on. Across 410 elapsed-phrasing lines in three
 * stored corpora, `past` is 0 and every single line the kill-log check convicted is `bare` — so a
 * test that let `bare` drift into `past` would silently restate a 45% wrong-number rate about
 * sentences that never made a claim about the past.
 */
test("framingOf calls an unambiguous time-since-death a past claim", () => {
	assert.equal(framingOf("Viego has been dead for fourteen seconds, so take dragon."), "past")
	assert.equal(framingOf("Viego died fourteen seconds ago, so take dragon."), "past")
})

test("framingOf calls an unambiguous remaining figure a window", () => {
	assert.equal(framingOf("Viego is down for another fourteen seconds, so take dragon."), "window")
	assert.equal(framingOf("Viego has fourteen seconds left, so take dragon."), "window")
})

test("framingOf calls the form the coach almost always speaks bare", () => {
	assert.equal(framingOf("Viego is dead for fourteen seconds, so pull dragon right now."), "bare")
})
