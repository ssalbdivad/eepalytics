/**
 * Fight detection, pinned against the two defects a verifier actually found in the last attempt.
 *
 * Those two have their own describe block and they are not hypotheticals: a real run said
 * *"they took Baron -8 seconds later"* out loud, and a separate one silenced the biggest event in
 * the game because an ally Herald happened to land in the window first.
 *
 * The last block walks a REAL game — the reference fixture's own `CHAMPION_KILL` and
 * `ELITE_MONSTER_KILL` timings, tick by tick — because the windows in this module are only
 * defensible if real kills actually cluster the way they claim.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import {
	BOUGHT_WINDOW_SEC,
	FIGHT_ACTIVE_SEC,
	FIGHT_CHAIN_SEC,
	FIGHT_COOLDOWN_SEC,
	FIGHT_MAX_SPAN_SEC,
	FIGHT_WORTH_SAYING_SEC,
	newFightMemory,
	readFight,
	resetFightMemory
} from "./fights.ts"
import type { FightInput, FightKill } from "./fights.ts"
import { loadFixture, REFERENCE_GAME_ID } from "./__fixtures__/index.ts"

const ALLIES = ["Ally1", "Ally2", "Ally3", "Ally4"]
const ENEMIES = ["Foe1", "Foe2", "Foe3", "Foe4", "Foe5"]

const input = (over: Partial<FightInput> = {}): FightInput => ({
	nowSec: 600,
	me: "Lillia",
	allies: ALLIES,
	enemies: ENEMIES,
	kills: [],
	objectives: [],
	meDeadForSec: null,
	hp: 1800,
	maxHp: 2000,
	alliesAlive: 5,
	enemiesAlive: 5,
	...over
})

/** A kill, tersely. Assisters default to nobody. */
const kill = (
	killer: string,
	victim: string,
	atSec: number,
	assisters: string[] = []
): FightKill => ({ killer, victim, atSec, assisters })

/** Three of his team dead in eight seconds, ending at 500. He is not in it. */
const wipe: FightKill[] = [
	kill("Foe1", "Ally1", 492),
	kill("Foe2", "Ally2", 496),
	kill("Foe1", "Ally3", 500)
]

describe("readFight — clustering", () => {
	it("groups kills inside the chain window into one fight", () => {
		const out = readFight(
			input({ nowSec: 520, kills: [kill("Lillia", "Foe1", 490), kill("Lillia", "Foe2", 500)] }),
			newFightMemory()
		)
		strictEqual(out.fight?.won, 2)
		strictEqual(out.fight?.firstSec, 490)
		strictEqual(out.fight?.lastSec, 500)
	})

	it("starts a new fight once the chain window lapses", () => {
		// 490 then 510 is a 20 second gap: two separate things, and only the later one is current.
		const out = readFight(
			input({
				nowSec: 560,
				kills: [
					kill("Lillia", "Foe1", 470),
					kill("Lillia", "Foe2", 490),
					kill("Foe3", "Ally1", 530),
					kill("Foe3", "Ally2", 540)
				]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.firstSec, 530, "only the most recent cluster is the current fight")
		strictEqual(out.fight?.won, 0)
		strictEqual(out.fight?.lost, 2)
	})

	it("caps a chain of deaths so a losing stretch is not called one fight", () => {
		/*
		 * A death every fourteen seconds chains forever under the gap rule alone. Six of them
		 * spans seventy seconds, and "that fight was 0 for 6" would be a claim about a minute and
		 * a half of the game.
		 */
		const kills = [0, 14, 28, 42, 56, 70].map((d, i) =>
			kill("Foe1", ALLIES[i % ALLIES.length]!, 400 + d)
		)
		const out = readFight(input({ nowSec: 490, kills }), newFightMemory())
		ok(out.fight !== null)
		ok(
			out.fight.lastSec - out.fight.firstSec <= FIGHT_MAX_SPAN_SEC,
			"a fight may never span more than the cap"
		)
	})

	it("ignores a single kill — the respawn window already covers that", () => {
		const out = readFight(
			input({ nowSec: 520, kills: [kill("Lillia", "Foe1", 500)] }),
			newFightMemory()
		)
		strictEqual(out.fight, null)
		strictEqual(out.line, null)
	})

	it("does not count a death it cannot put on a side", () => {
		// Neither name is on either roster, so there is no trade to report.
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Krug", "Gromp", 495), kill("Krug", "Razorbeak", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight, null)
	})

	it("drops a mirror-matchup champion rather than guessing its side", () => {
		/*
		 * Blind pick allows the same champion on both teams, and then a name does not identify a
		 * side at all. Only the unambiguous death is counted, which drops this below the minimum.
		 */
		const out = readFight(
			input({
				enemies: [...ENEMIES, "Ally1"],
				nowSec: 520,
				kills: [kill("Foe2", "Ally1", 496), kill("Foe2", "Ally2", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight, null, "one attributable death is not a fight")
	})
})

describe("readFight — timing", () => {
	it("says nothing while kills are still landing, and asks for silence", () => {
		const out = readFight(input({ nowSec: 505, kills: wipe }), newFightMemory())
		strictEqual(out.line, null)
		strictEqual(out.quiet, true, "a fight in progress silences the whole turn, not just this")
		strictEqual(out.fight?.settled, false)
	})

	it("stops asking for silence before it is ready to speak", () => {
		/*
		 * The gap between the two windows is deliberate. `FIGHT_ACTIVE_SEC` asks whether he is
		 * clicking; `FIGHT_CHAIN_SEC` asks whether the count can still change. Between them the
		 * coach is free to say anything else it has.
		 */
		const out = readFight(
			input({ nowSec: 500 + FIGHT_ACTIVE_SEC + 1, kills: wipe }),
			newFightMemory()
		)
		strictEqual(out.quiet, false, "the fight is resolving; other facts may be spoken")
		strictEqual(out.line, null, "but its own count is not final yet")
	})

	it("speaks once the fight can no longer gain a kill", () => {
		const out = readFight(
			input({ nowSec: 500 + FIGHT_CHAIN_SEC, kills: wipe }),
			newFightMemory()
		)
		strictEqual(out.quiet, false)
		ok(out.line !== null, "settled fights are speakable")
		strictEqual(out.fight?.settled, true)
	})

	it("stops mentioning a fight once its corpses are getting back up", () => {
		const out = readFight(
			input({ nowSec: 500 + FIGHT_WORTH_SAYING_SEC + 1, kills: wipe }),
			newFightMemory()
		)
		strictEqual(out.line, null)
		ok(out.fight !== null, "still detected, just not worth a sentence")
	})

	it("announces a fight exactly once", () => {
		const mem = newFightMemory()
		const first = readFight(input({ nowSec: 520, kills: wipe }), mem)
		ok(first.line !== null)
		// Five seconds later the feed still carries the same three kills.
		const second = readFight(input({ nowSec: 525, kills: wipe }), mem)
		strictEqual(second.line, null, "the same fight must not be re-announced on every poll")
	})

	it("holds a second fight back rather than losing it", () => {
		const mem = newFightMemory()
		ok(readFight(input({ nowSec: 520, kills: wipe }), mem).line !== null)
		const next = [kill("Foe1", "Ally1", 540), kill("Foe2", "Ally2", 545)]
		strictEqual(
			readFight(input({ nowSec: 560, kills: [...wipe, ...next] }), mem).line,
			null,
			"inside the cooldown"
		)
		// Still inside its own forty-second window once the cooldown lapses, so it is not lost.
		const later = readFight(
			input({ nowSec: 520 + FIGHT_COOLDOWN_SEC, kills: [...wipe, ...next] }),
			mem
		)
		ok(later.line !== null, "a delayed fight is still spoken")
	})

	it("forgets everything between games", () => {
		const mem = newFightMemory()
		ok(readFight(input({ nowSec: 520, kills: wipe }), mem).line !== null)
		resetFightMemory(mem)
		ok(
			readFight(input({ nowSec: 520, kills: wipe }), mem).line !== null,
			"a new game starts clean"
		)
	})
})

describe("readFight — fights that do not earn the turn", () => {
	it("says nothing about an even trade he was standing in", () => {
		/*
		 * "that fight was 1 for 1, so take your camps and reset" was produced three times in the
		 * reference game. He was there; he knows it went even; and the sentence would read
		 * identically pasted onto any game he has ever played.
		 */
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Foe2", "Ally1", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.won, 1)
		strictEqual(out.fight?.lost, 1)
		strictEqual(out.line, null)
	})

	it("still reports an even trade he was NOT in", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Ally1", "Foe1", 496), kill("Foe2", "Ally2", 500)]
			}),
			newFightMemory()
		)
		ok(out.line?.includes("1 for 1 without you"), out.line ?? "no line")
	})

	it("does not narrate a win he was in with nothing exact to do next", () => {
		// The game already gave him a banner and a sound for each of those kills.
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)],
				alliesAlive: 5,
				enemiesAlive: 5
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.won, 2)
		strictEqual(out.line, null)
	})

	it("speaks that same win once something exact is attached to it", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)],
				alliesAlive: 5,
				enemiesAlive: 3
			}),
			newFightMemory()
		)
		ok(out.line !== null, "a window he can use is not a readback")
	})

	it("speaks an even trade he was in when it bought them an objective", () => {
		const out = readFight(
			input({
				nowSec: 530,
				kills: [kill("Lillia", "Foe1", 496), kill("Foe2", "Ally1", 500)],
				objectives: [{ name: "BaronKill", atSec: 512, byEnemy: true }]
			}),
			newFightMemory()
		)
		ok(out.line?.includes("they took Baron 12 seconds later"), out.line ?? "no line")
	})
})

describe("readFight — participation", () => {
	it("names the fight he was not in, which is the whole point", () => {
		const out = readFight(input({ nowSec: 520, kills: wipe }), newFightMemory())
		strictEqual(out.fight?.participation, "absent")
		ok(out.line?.includes("without you"), out.line ?? "no line")
	})

	it("does not say 'without you' when he took part", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Foe1", "Ally1", 496), kill("Foe1", "Lillia", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.participation, "victim")
		strictEqual(out.line?.includes("without you"), false)
	})

	it("counts an assist as presence", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Ally1", "Foe1", 496, ["Lillia"]), kill("Foe2", "Ally2", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.participation, "assist")
	})

	it("prefers the takedown when he traded his own life for one", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Foe2", "Lillia", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.participation, "killer")
	})
})

describe("readFight — the trade", () => {
	it("reads kills first, deaths second", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [
					kill("Lillia", "Foe1", 494),
					kill("Lillia", "Foe2", 497),
					kill("Foe3", "Ally1", 500)
				],
				// Two of theirs are still down, so the win has something exact attached to it.
				enemiesAlive: 3
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.won, 2)
		strictEqual(out.fight?.lost, 1)
		ok(out.line?.includes("2 for 1"), out.line ?? "no line")
	})

	it("counts a death to a turret against his side even with no killer to credit", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Turret_T1_C_05_A", "Ally1", 496), kill("Foe1", "Ally2", 500)]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.lost, 2)
		strictEqual(out.fight?.won, 0)
	})
})

describe("readFight — what the fight bought them", () => {
	it("reports an enemy objective taken after it, with a positive interval", () => {
		const out = readFight(
			input({
				nowSec: 530,
				kills: wipe,
				objectives: [{ name: "BaronKill", atSec: 514, byEnemy: true }]
			}),
			newFightMemory()
		)
		ok(out.line?.includes("they took Baron 14 seconds later"), out.line ?? "no line")
	})

	it("never emits a negative interval", () => {
		/*
		 * The measured defect, verbatim: *"they took Baron -8 seconds later"*. It happened because
		 * an objective taken DURING the kill cluster was allowed to count as bought by it.
		 */
		const out = readFight(
			input({
				nowSec: 520,
				kills: wipe,
				objectives: [{ name: "BaronKill", atSec: 492, byEnemy: true }]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.bought, null, "an objective inside the fight was not bought by it")
		strictEqual(out.line?.includes("Baron"), false)
	})

	it("takes the ENEMY objective, not merely the first one in the window", () => {
		/*
		 * The second measured defect: an ally Herald at 870 and an enemy Baron at 880 suppressed
		 * the line entirely, because the filter took the earliest objective and only then checked
		 * whose it was.
		 */
		const out = readFight(
			input({
				nowSec: 900,
				kills: [kill("Foe1", "Ally1", 860), kill("Foe1", "Ally2", 865)],
				objectives: [
					{ name: "HeraldKill", atSec: 870, byEnemy: false },
					{ name: "BaronKill", atSec: 880, byEnemy: true }
				]
			}),
			newFightMemory()
		)
		ok(out.line?.includes("they took Baron 15 seconds later"), out.line ?? "no line")
	})

	it("ignores an objective too far after the fight to have been bought by it", () => {
		const out = readFight(
			input({
				nowSec: 560,
				kills: wipe,
				objectives: [{ name: "BaronKill", atSec: 500 + BOUGHT_WINDOW_SEC + 1, byEnemy: true }]
			}),
			newFightMemory()
		)
		strictEqual(out.fight?.bought, null)
	})

	it("says the drake by the name people use for it", () => {
		const out = readFight(
			input({
				nowSec: 530,
				kills: wipe,
				objectives: [{ name: "DragonKill", atSec: 515, byEnemy: true, dragonType: "Fire" }]
			}),
			newFightMemory()
		)
		ok(out.line?.includes("Infernal drake"), out.line ?? "no line")
	})

	it("drops the interval rather than rounding it to something nobody says", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: wipe,
				objectives: [{ name: "BaronKill", atSec: 500.4, byEnemy: true }]
			}),
			newFightMemory()
		)
		ok(out.line?.includes("straight after"), out.line ?? "no line")
		strictEqual(out.line?.includes("0 seconds"), false)
	})
})

describe("readFight — what the next thirty seconds are for", () => {
	const settled = { nowSec: 520, kills: wipe }

	it("tells him to catch up after a fight his team lost", () => {
		const out = readFight(input(settled), newFightMemory())
		ok(out.line?.endsWith("so back off and catch up"), out.line ?? "no line")
	})

	it("refuses the forward call while he is down bodies, however the trade read", () => {
		// A fight won 2 for 0 fifteen seconds ago whose corpses are already back up.
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)],
				alliesAlive: 2,
				enemiesAlive: 5
			}),
			newFightMemory()
		)
		ok(out.line?.endsWith("back off and catch up"), out.line ?? "no line")
	})

	it("sends him to the free camps only when he is actually up bodies", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)],
				alliesAlive: 5,
				enemiesAlive: 3
			}),
			newFightMemory()
		)
		ok(out.line?.endsWith("take the free camps while you are up bodies"), out.line ?? "no line")
	})

	it("sends him to reset instead when he is nearly dead", () => {
		const out = readFight(
			input({
				nowSec: 520,
				kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)],
				alliesAlive: 5,
				enemiesAlive: 3,
				hp: 300,
				maxHp: 2000
			}),
			newFightMemory()
		)
		ok(out.line?.endsWith("reset before you take anything else"), out.line ?? "no line")
	})

	it("gives an instruction he can follow from the respawn screen", () => {
		const out = readFight(
			input({ ...settled, meDeadForSec: 22, alliesAlive: 4 }),
			newFightMemory()
		)
		ok(out.line?.endsWith("come back and take camps, not fights"), out.line ?? "no line")
	})
})

describe("readFight — what may never be said", () => {
	/** Every distinct line the module can produce, from a spread of states. */
	const everyLine = (): string[] => {
		const lines: string[] = []
		const push = (over: Partial<FightInput>) => {
			const out = readFight(input({ nowSec: 520, kills: wipe, ...over }), newFightMemory())
			if (out.line !== null) lines.push(out.line)
		}
		push({})
		push({ meDeadForSec: 20 })
		push({ hp: 200, maxHp: 2000 })
		push({ alliesAlive: 5, enemiesAlive: 2 })
		// The bare head, with no tail at all: a fight his team won without him.
		push({ kills: [kill("Ally1", "Foe1", 496), kill("Ally2", "Foe2", 500)] })
		push({ kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)] })
		push({
			kills: [kill("Lillia", "Foe1", 496), kill("Lillia", "Foe2", 500)],
			alliesAlive: 5,
			enemiesAlive: 2
		})
		push({ nowSec: 530, objectives: [{ name: "BaronKill", atSec: 515, byEnemy: true }] })
		push({
			nowSec: 530,
			objectives: [{ name: "DragonKill", atSec: 515, byEnemy: true, dragonType: "Water" }]
		})
		push({ nowSec: 530, objectives: [{ name: "HeraldKill", atSec: 515, byEnemy: true }] })
		return lines
	}

	it("never names a player", () => {
		/*
		 * Names go in — they are the only way to tell the sides apart — and none comes out. That
		 * is the structural answer to the riotId leak that once said "You got Baron with
		 * Electrician" out loud.
		 */
		for (const line of everyLine())
			for (const name of ["Lillia", ...ALLIES, ...ENEMIES])
				strictEqual(line.includes(name), false, `${line} names ${name}`)
	})

	it("never names a place", () => {
		// The live API has no coordinates for anybody, and a prompt-only version of this feature
		// invented a destination in 24% of its lines.
		const banned = /\b(top|bot|mid|lane|river|pit|jungle|side|blue|red|base)\b/i
		for (const line of everyLine()) strictEqual(banned.test(line), false, line)
	})

	it("never abbreviates a unit", () => {
		// "52s" was spoken aloud as "fifty two seds" in a real game.
		for (const line of everyLine()) strictEqual(/\d+\s*[smg]\b/.test(line), false, line)
	})

	it("stays inside one short spoken sentence", () => {
		for (const line of everyLine()) {
			ok(line.length <= 110, `${line.length} chars: ${line}`)
			strictEqual(line.includes("."), false, line)
		}
	})
})

/* ------------------------------------------------------------ a real game */

/**
 * The reference fixture's own kills and objectives, replayed at the poll rate.
 *
 * The champion labels are `P1`..`P10` on purpose: this repo forbids fixtures carrying invented
 * League stats that could be mistaken for real ones, and the fixture files hold champion *ids*
 * with no name table beside them. Nothing under test depends on the labels — the module treats
 * every name as an opaque token — while the timings, the sides, the assist lists and who was in
 * which fight are all exactly what the client recorded.
 */
const HIS_PARTICIPANT_ID = 7
const HIS_TEAM_ID = 200

const realGame = () => {
	const { match, timeline } = loadFixture(REFERENCE_GAME_ID)
	const teamOf = new Map(match.participants.map(p => [p.participantId, p.teamId]))
	const label = (id: number | undefined): string => (id === undefined ? "" : `P${id}`)
	const events = timeline.frames.flatMap(f => f.events ?? [])

	const kills: FightKill[] = events
		.filter(e => e.type === "CHAMPION_KILL")
		.map(e => ({
			killer: label(e.killerId),
			victim: label(e.victimId),
			assisters: (e.assistingParticipantIds ?? []).map(label),
			atSec: e.timestamp / 1000
		}))

	const objectives = events
		.filter(e => e.type === "ELITE_MONSTER_KILL")
		.map(e => {
			const name =
				e.monsterType === "DRAGON" ? "DragonKill"
				: e.monsterType === "BARON_NASHOR" ? "BaronKill"
				: e.monsterType === "RIFTHERALD" ? "HeraldKill"
				: ""
			return {
				name,
				atSec: e.timestamp / 1000,
				// `killerId` is the reliable field on these events; the assist list is not, and
				// nothing here reads it.
				byEnemy: teamOf.get(e.killerId ?? 0) !== HIS_TEAM_ID,
				...(e.monsterSubType ?
					{ dragonType: e.monsterSubType.replace(/_DRAGON$/, "").toLowerCase() }
				:	{})
			}
		})
		.filter(o => o.name !== "")

	return {
		durationSec: match.gameDuration,
		kills,
		objectives,
		me: label(HIS_PARTICIPANT_ID),
		allies: match.participants
			.filter(p => p.teamId === HIS_TEAM_ID && p.participantId !== HIS_PARTICIPANT_ID)
			.map(p => label(p.participantId)),
		enemies: match.participants
			.filter(p => p.teamId !== HIS_TEAM_ID)
			.map(p => label(p.participantId))
	}
}

/** Every tick of the real game, at the five-second poll the daemon actually runs. */
const walk = () => {
	const game = realGame()
	const mem = newFightMemory()
	const spoken: { atSec: number; line: string }[] = []
	const fights: { id: string; won: number; lost: number; span: number; bought: number | null }[] =
		[]
	let quietTicks = 0
	for (let nowSec = 0; nowSec <= game.durationSec; nowSec += 5) {
		const out = readFight(
			{
				nowSec,
				me: game.me,
				allies: game.allies,
				enemies: game.enemies,
				// The live feed only ever carries what has already happened.
				kills: game.kills.filter(k => k.atSec <= nowSec),
				objectives: game.objectives.filter(o => o.atSec <= nowSec),
				meDeadForSec: null,
				hp: 1500,
				maxHp: 2000,
				alliesAlive: 5,
				enemiesAlive: 5
			},
			mem
		)
		if (out.quiet) quietTicks++
		if (out.fight && !fights.some(f => f.id === out.fight!.id))
			fights.push({
				id: out.fight.id,
				won: out.fight.won,
				lost: out.fight.lost,
				span: out.fight.lastSec - out.fight.firstSec,
				bought: out.fight.bought?.gapSec ?? null
			})
		if (out.line !== null) spoken.push({ atSec: nowSec, line: out.line })
	}
	return { game, spoken, fights, quietTicks }
}

describe("readFight — the reference game, tick by tick", () => {
	it("finds fights in a real game and keeps every one inside the span cap", () => {
		const { game, fights } = walk()
		ok(fights.length >= 5, `only ${fights.length} fights in ${game.kills.length} kills`)
		for (const f of fights) {
			ok(f.won + f.lost >= 2, `${f.id} was ${f.won} for ${f.lost}`)
			ok(f.span <= FIGHT_MAX_SPAN_SEC, `${f.id} spanned ${f.span} seconds`)
		}
		// Every death still lands in exactly one fight or in none — never in two.
		const counted = fights.reduce((n, f) => n + f.won + f.lost, 0)
		ok(counted <= game.kills.length, `${counted} attributed of ${game.kills.length} kills`)
	})

	it("goes quiet while a real fight is landing", () => {
		const { quietTicks } = walk()
		ok(quietTicks > 0, "a real game must contain at least one mid-fight tick")
	})

	it("says each fight once, and never two inside the cooldown", () => {
		const { spoken } = walk()
		ok(spoken.length > 0, "a real game should produce lines")
		strictEqual(new Set(spoken.map(s => s.line)).size >= 1, true)
		for (let i = 1; i < spoken.length; i++)
			ok(
				spoken[i]!.atSec - spoken[i - 1]!.atSec >= FIGHT_COOLDOWN_SEC,
				`two lines ${spoken[i]!.atSec - spoken[i - 1]!.atSec} seconds apart`
			)
	})

	it("tells him about a real fight he was not in", () => {
		const { spoken } = walk()
		ok(
			spoken.some(s => s.line.includes("without you")),
			"the flagship case must fire on real data"
		)
	})

	it("never speaks a negative or zero interval on real objective timings", () => {
		const { fights, spoken } = walk()
		for (const f of fights) if (f.bought !== null) ok(f.bought > 0, `${f.id} bought at ${f.bought}`)
		for (const s of spoken) {
			strictEqual(/-\d/.test(s.line), false, s.line)
			strictEqual(s.line.includes("0 seconds later"), false, s.line)
		}
	})

	it("never leaks a participant label into a spoken line", () => {
		const { game, spoken } = walk()
		for (const s of spoken)
			for (const name of [game.me, ...game.allies, ...game.enemies])
				strictEqual(s.line.includes(name), false, `${s.line} names ${name}`)
	})

	it("speaks only about a fight that can no longer change", () => {
		const { game, spoken } = walk()
		for (const s of spoken) {
			const next = game.kills.find(k => k.atSec > s.atSec - FIGHT_CHAIN_SEC && k.atSec <= s.atSec)
			strictEqual(
				next,
				undefined,
				`spoke at ${s.atSec} with a kill still inside the chain window`
			)
		}
	})
})
