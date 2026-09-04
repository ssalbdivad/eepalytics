/**
 * The pre-game fence.
 *
 * Two things are worth testing here and they are both about drift. First, the five allowed
 * example lines must survive the guard that ships next to them — a demonstration the app would
 * itself reject teaches the model the wrong lesson. Second, the prompt must keep saying the
 * things it exists to say: no runes, no items, no spell timers, and champion notes are for the
 * plan.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, test } from "node:test"
import {
	ALLOWED_MATCHUP_LINES,
	BANNED_MATCHUP_LINES,
	matchupPromptSection,
	unsupportedMatchupClaims
} from "./matchup-prompt.ts"
import type { MatchupBrief } from "./schema/api.ts"

const BRIEF: MatchupBrief = {
	phase: "GameStart",
	queue: "Ranked Solo/Duo",
	you: { champion: "Lillia", championId: 876, role: "JGL", spells: ["Flash", "Smite"], isYou: true },
	opponent: {
		champion: "Trundle",
		championId: 48,
		role: "JGL",
		spells: ["Smite", "Flash"],
		isYou: false
	},
	opponentBasis: "declared",
	allies: [],
	enemies: [],
	championNotes: {
		champion: "Lillia",
		text: "Her clear accelerates as it chains.",
		patch: "16.17",
		source: "test"
	},
	opponentNotes: { champion: "Trundle", text: "He wants the even early fight." },
	unknowns: []
}

describe("unsupportedMatchupClaims", () => {
	test("passes every line the prompt holds up as allowed", () => {
		for (const line of ALLOWED_MATCHUP_LINES)
			deepStrictEqual(unsupportedMatchupClaims(line, BRIEF), [], `should be allowed: ${line}`)
	})

	test("catches every line the prompt holds up as banned", () => {
		for (const { line } of BANNED_MATCHUP_LINES) {
			// The teammate-blame line is a persona failure, not a data one — it names nothing and
			// cites nothing, so no mechanical net can see it. Everything the net IS for must trip.
			if (line.startsWith("Your bot lane")) continue
			ok(unsupportedMatchupClaims(line, BRIEF).length > 0, `should be caught: ${line}`)
		}
	})

	/*
	 * The check that catches a rune or an item NAMED rather than described, which is the likeliest
	 * fabrication here and which no vocabulary list can see.
	 */
	test("catches a proper noun that is not in this game", () => {
		ok(unsupportedMatchupClaims("He's running Conqueror.", BRIEF).length > 0)
		ok(unsupportedMatchupClaims("Rush Liandry's into him.", BRIEF).length > 0)
		ok(unsupportedMatchupClaims("He'll play it like a Rek'Sai.", BRIEF).length > 0)
	})

	test("permits the champions and spells that ARE in this game", () => {
		deepStrictEqual(
			unsupportedMatchupClaims("Your Lillia clear beats his Trundle clear to six.", BRIEF),
			[]
		)
		deepStrictEqual(unsupportedMatchupClaims("He took Smite and Flash.", BRIEF), [])
	})

	test("permits neutral map vocabulary and the T1 rotation", () => {
		deepStrictEqual(
			unsupportedMatchupClaims("Path to Scuttle, then look at Baron side — Oner's route.", BRIEF),
			[]
		)
	})

	test("catches a rune by the word alone", () => {
		ok(unsupportedMatchupClaims("His keystone is going to punish that.").length > 0)
		ok(unsupportedMatchupClaims("Rune page looks standard.").length > 0)
	})

	test("catches a build recommendation", () => {
		ok(unsupportedMatchupClaims("Get boots first.").length > 0)
		ok(unsupportedMatchupClaims("Your item spike is at two.").length > 0)
	})

	test("catches a spell timer but not the fact that a spell was taken", () => {
		ok(unsupportedMatchupClaims("His Flash is down for another minute.").length > 0)
		ok(unsupportedMatchupClaims("Smite is on cooldown, contest it.").length > 0)
		deepStrictEqual(unsupportedMatchupClaims("He took Smite and Flash."), [])
	})

	test("catches a percentage, which always reads as a measurement", () => {
		ok(unsupportedMatchupClaims("You win this about 46% of the time.").length > 0)
	})

	test("says nothing about an ordinary plan", () => {
		deepStrictEqual(
			unsupportedMatchupClaims("Full clear, take scuttle, be level six before you look at mid."),
			[]
		)
	})
})

describe("matchupPromptSection", () => {
	const text = matchupPromptSection(BRIEF)

	test("states the three bans in the model's own words", () => {
		ok(text.includes("never assert a rune, an item, or a summoner spell timer"))
		ok(text.includes("Enemy runes are not published by any pre-game endpoint"))
		ok(text.includes("Nobody has bought anything"))
		ok(text.includes('"His Flash is down" is a fabrication'))
	})

	test("fences the champion notes the same way a review does", () => {
		ok(text.includes("the client wins"))
		ok(text.includes('never say "the guide says"') || text.includes('the guide says'))
		ok(text.includes("no notes for a champion, coach the **role**"))
	})

	test("names both champions, both positions and both spell pairs", () => {
		ok(text.includes("Lillia (jungle, Flash + Smite)"))
		ok(text.includes("Trundle (jungle, Smite + Flash)"))
	})

	test("carries the allowed and banned examples", () => {
		for (const line of ALLOWED_MATCHUP_LINES) ok(text.includes(line))
		for (const { line } of BANNED_MATCHUP_LINES) ok(text.includes(line))
	})

	test("prints the notes it was given and labels them unmeasured", () => {
		ok(text.includes("Her clear accelerates as it chains."))
		ok(text.includes("He wants the even early fight."))
		ok(text.includes("NOT measured"))
	})

	test("tells the coach to stop when there is no counterpart", () => {
		const text = matchupPromptSection({
			...BRIEF,
			opponent: null,
			opponentBasis: "none",
			opponentNotes: null
		})
		ok(text.includes("No enemy counterpart was identified"))
		ok(text.includes("there is no matchup to talk about"))
	})

	test("hedges a Smite-only identification", () => {
		const text = matchupPromptSection({ ...BRIEF, opponentBasis: "smite" })
		ok(text.includes("Smite alone"))
		ok(text.includes('say "looks like"'))
	})

	test("renders the unknowns rather than dropping them", () => {
		const text = matchupPromptSection({
			...BRIEF,
			unknowns: ["There are no champion notes on file for Trundle."]
		})
		ok(text.includes("What this brief could NOT establish"))
		ok(text.includes("no champion notes on file for Trundle"))
	})

	test("stays short enough to be read on a loading screen", () => {
		// The section is the SYSTEM half; what the coach says back is capped separately. This is a
		// regression guard against the prompt quietly growing into a wall.
		ok(text.length < 8000, `prompt section was ${text.length} chars`)
		strictEqual(text.includes("undefined"), false)
	})
})
