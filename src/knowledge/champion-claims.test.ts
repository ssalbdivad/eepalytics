/**
 * What every shipped clause is BETTING ON, written down, one line each.
 *
 * ## Why this file exists
 *
 * `parseChampionAdvice` refuses any clause containing a digit, and that fence is real: it kills
 * every benchmark, price, cooldown and win rate at load time. What it cannot do is tell whether a
 * digit-free sentence is TRUE. It validates FORM and never SUBJECT.
 *
 * It has already been walked through. `belveth.md` shipped `death: your stacks die with you`.
 * Death in Lavender stacks are permanent and survive death — the same file said so two paragraphs
 * earlier — so the coach was set up to say the single most confidently wrong thing it could say
 * to someone who mains the champion. Nothing in the repo noticed, because nothing in the repo
 * knew what the clause depended on.
 *
 * ## What this test can and cannot catch
 *
 * It CANNOT verify truth. No test can: a mechanic is a fact about a patched game, and a test file
 * is a string in a repo. Nothing here re-reads ddragon, and nothing here would fail the day Riot
 * reworks Bel'Veth.
 *
 * What it CAN do is make the bet explicit and unavoidable:
 *
 *   - every clause on disk must be pinned to at least one entry in `FACTS`, so a clause cannot be
 *     added, reworded or moved without someone writing down the mechanic it leans on;
 *   - every fact must name where it was checked, from the sanctioned list in `knowledge/
 *     SOURCES.md`, or be labelled a judgment — and a judgment must SAY it is one, in its id;
 *   - every fact must be cited by a clause, so the table cannot rot into decoration;
 *   - and the handful of mistakes already made here are pinned as forbidden phrasings per file,
 *     so the specific wrong sentence cannot come back.
 *
 * So: when a patch changes a champion, this is the file that tells you which clauses fall. It is
 * a bet register, not an oracle. Read `FACTS` when you re-source a champion; if a `says` line is
 * no longer true, every clause citing it is now false and has to go.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { ADVICE_KINDS, parseChampionClauses } from "../shared/champion-advice.ts"

/*
 * Resolved from THIS file rather than through `EEPALYTICS_KNOWLEDGE_DIR`, deliberately: the point
 * is to guard what ships, and a seam that a test could point elsewhere guards nothing.
 */
const CHAMPIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../knowledge/champions")

interface Fact {
	/** The mechanic, in one sentence. If this stops being true, every clause citing it is false. */
	says: string
	/**
	 * Where it was checked, and when. Must begin with a source sanctioned by `knowledge/
	 * SOURCES.md` — or with "community consensus", which is NOT sanctioned and is therefore only
	 * allowed on an id that admits, in the id itself, that it is a judgment.
	 */
	checked: string
}

const CHECKED_ON = "2026-09-05"

/**
 * The role facts. True of the jungle, not of any champion — this is what `_default.md` may lean
 * on, and it is why `_default.md` is allowed to say nothing about a kit.
 */
const ROLE_FACTS = {
	"role.camps-are-gold-and-xp": {
		says: "Jungle camps pay gold and experience, so a clear is how a jungler buys back a level.",
		checked: "role fundamentals — true of every jungler in every game, no champion mechanic involved"
	},
	"role.camps-respawn": {
		says: "Camps respawn on a timer, so a camp left standing is one the other jungler can take.",
		checked: "role fundamentals — true of every jungler in every game, no champion mechanic involved"
	},
	"role.objective-timers": {
		says: "Drakes, heralds/grubs and Baron are shared objectives on a spawn timer both junglers can read.",
		checked: "role fundamentals — true of every jungler in every game, no champion mechanic involved"
	},
	"role.objectives-persist": {
		says: "An objective taken stays taken; a duel won converts into nothing by itself.",
		checked: "role fundamentals — true of every jungler in every game, no champion mechanic involved"
	},
	"role.vision": {
		says: "A ward is the only way to know a jungle entrance is empty before walking into it.",
		checked: "role fundamentals — true of every jungler in every game, no champion mechanic involved"
	},
	"role.plates": {
		says: "Turret plates exist in the early game, so a gank can convert into gold that is not a kill.",
		checked: "role fundamentals — true of every jungler in every game, no champion mechanic involved"
	},
	"role.items-change-a-duel": {
		says: "A completed item changes what a duel is worth, and the live client reports the counterpart's completed items — which is the only reason the `build` kind fires at all.",
		checked: "role fundamentals — the fact kind is built on `allPlayers` items in `src/analysis/live-facts.ts`"
	},
	"role.jungler-soaks-waves": {
		says: "A jungler may soak a lane wave, and this app's CS figures count those minions (AGENTS.md).",
		checked: "role fundamentals — stated in AGENTS.md Part 2, 'Say CS, never camps'"
	},
	"role.judgment": {
		says: "A coaching judgment about jungle play. Not a claim about any champion's kit and not measured — here to be argued with, not verified.",
		checked: "community consensus — explicitly not a mechanic and not sourced"
	}
} satisfies Record<string, Fact>

const LILLIA_FACTS = {
	"lillia.q-stacks-move-speed": {
		says: "Blooming Blows passively stacks Prance movement speed whenever a spell hits an enemy; the stacks expire after a few seconds and then fall off one at a time, so the speed only exists while the route keeps hitting things.",
		checked: `ddragon 16.17.1 Lillia.json (LilliaQ) + wiki.leagueoflegends.com/en-us/Lillia, ${CHECKED_ON}`
	},
	"lillia.w-is-her-only-hop": {
		says: "Watch Out! Eep! dashes a short distance toward the target location and cannot pass through terrain, and it is the ONLY dash, blink or leap in the kit — which is why 'she has no dash' is wrong and 'the hop will not carry her over a wall' is right.",
		checked: `wiki.leagueoflegends.com/en-us/Lillia (W, 500 target range and a 350 dash, not through terrain) + ddragon 16.17.1 Lillia.json for the rest of the kit, ${CHECKED_ON}`
	},
	"lillia.e-reveals-what-it-hits": {
		says: "Swirlseed rolls until it meets a wall or a target; what it lands on is damaged, slowed and revealed briefly. It reveals what it HITS — it does not light up the ground it rolled over.",
		checked: `ddragon 16.17.1 Lillia.json (LilliaE) + wiki.leagueoflegends.com/en-us/Lillia, ${CHECKED_ON}`
	},
	"lillia.r-needs-dream-dust": {
		says: "Lilting Lullaby only makes drowsy, and then sleeps, enemies already carrying Dream Dust from her passive.",
		checked: `ddragon 16.17.1 Lillia.json (LilliaR) + wiki.leagueoflegends.com/en-us/Lillia, ${CHECKED_ON}`
	},
	"lillia.damage-arrives-over-time": {
		says: "Dream-Laden Bough is a max-health damage-over-time applied by her spells, so her damage lands across a fight rather than in a burst.",
		checked: `ddragon 16.17.1 Lillia.json (passive) + wiki.leagueoflegends.com/en-us/Lillia, ${CHECKED_ON}`
	},
	"lillia.judgment.weak-early-duel": {
		says: "She loses the straight early duel to most junglers and is played as a scaling one.",
		checked: "community consensus — no sanctioned per-patch source is cited for it, so it is a judgment and is labelled as one"
	}
} satisfies Record<string, Fact>

const BELVETH_FACTS = {
	"belveth.stacks-are-permanent": {
		says: "Death in Lavender grants PERMANENT attack-speed stacks for takedowns on large minions, monsters and champions, and they are not lost on death — which is why finishing a route pays her twice and why being behind is never a reason to force a fight.",
		checked: `ddragon 16.17.1 Belveth.json (passive: "permanent attack speed stacks") + wiki.leagueoflegends.com/en-us/Bel%27Veth, ${CHECKED_ON}. THIS IS THE ONE THE FILE ONCE GOT BACKWARDS ("your stacks die with you").`
	},
	"belveth.q-per-direction-cooldown": {
		says: "Void Surge dashes in one of four directions and each direction carries its own cooldown, so an exit can be up while an entry is down.",
		checked: `wiki.leagueoflegends.com/en-us/Bel%27Veth (Q, per-direction cooldown) + ddragon 16.17.1 Belveth.json, ${CHECKED_ON}`
	},
	"belveth.w-refunds-a-dash": {
		says: "Above and Below knocks up and slows, and hitting a champion with it resets Void Surge's cooldown in that direction.",
		checked: `wiki.leagueoflegends.com/en-us/Bel%27Veth (W) + ddragon 16.17.1 Belveth.json, ${CHECKED_ON}`
	},
	"belveth.e-pays-while-damaged": {
		says: "Royal Maelstrom roots her while it channels, slashes the lowest-health enemy nearby, and grants lifesteal and damage reduction — so it pays while damage is on her, and not while she is chasing.",
		checked: `ddragon 16.17.1 Belveth.json (BelvethE) + wiki.leagueoflegends.com/en-us/Bel%27Veth, ${CHECKED_ON}`
	},
	"belveth.coral-from-takedowns": {
		says: "Void Corals are left behind by champion and epic-monster takedowns; Baron, the pit Rift Herald and Voidgrubs leave an enhanced one.",
		checked: `wiki.leagueoflegends.com/en-us/Bel%27Veth (R) + ddragon 16.17.1 Belveth.json, ${CHECKED_ON}`
	},
	"belveth.true-form-needs-a-coral": {
		says: "Endless Banquet cannot be cast without a Void Coral to consume, so True Form is a coral, not simply a level.",
		checked: `wiki.leagueoflegends.com/en-us/Bel%27Veth (R) + ddragon 16.17.1 Belveth.json, ${CHECKED_ON}`
	},
	"belveth.true-form-is-temporary": {
		says: "True Form runs on a duration and only stops expiring once she is deep into her Lavender stacks — the FORM is rented and the STACKS are owned, which is the opposite way round from how it reads.",
		checked: `wiki.leagueoflegends.com/en-us/Bel%27Veth (R duration by Lavender stacks), ${CHECKED_ON}`
	},
	"belveth.judgment.weak-early": {
		says: "Her first few minutes are her weakest phase, before stacks and before anything has died to leave a coral.",
		checked: "community consensus — no sanctioned per-patch source is cited for it, so it is a judgment and is labelled as one"
	}
} satisfies Record<string, Fact>

const TRUNDLE_FACTS = {
	"trundle.passive-heals-off-deaths": {
		says: "King's Tribute heals him for a share of the maximum health of any enemy unit that dies near him, so a full clear is also a heal.",
		checked: `ddragon 16.17.1 Trundle.json (passive) + wiki.leagueoflegends.com/en-us/Trundle, ${CHECKED_ON}`
	},
	"trundle.q-saps-ad": {
		says: "Chomp deals damage, briefly slows, and moves attack damage off the target and onto him. It does NOT heal — the sustain is the passive and the ultimate. The ability is called Chomp; nothing in this kit is called Bite.",
		checked: `ddragon 16.17.1 Trundle.json (TrundleTrollSmash) + wiki.leagueoflegends.com/en-us/Trundle, ${CHECKED_ON}`
	},
	"trundle.w-boosts-healing-and-speed": {
		says: "Frozen Domain grants attack speed, movement speed and increased healing from all sources, and ONLY while he is standing on it — it amplifies healing rather than supplying it.",
		checked: `ddragon 16.17.1 Trundle.json (trundledesecrate) + wiki.leagueoflegends.com/en-us/Trundle, ${CHECKED_ON}`
	},
	"trundle.e-is-terrain": {
		says: "Pillar of Ice becomes impassable terrain for its duration, knocking units aside as it rises and slowing enemies near it.",
		checked: `ddragon 16.17.1 Trundle.json (TrundleCircle) + wiki.leagueoflegends.com/en-us/Trundle, ${CHECKED_ON}`
	},
	"trundle.r-steals-from-the-biggest": {
		says: "Subjugate takes a share of the target's health, armour and magic resist and gives him the same, so it pays most on the biggest body in the fight.",
		checked: `ddragon 16.17.1 Trundle.json (TrundlePain) + wiki.leagueoflegends.com/en-us/Trundle, ${CHECKED_ON}`
	},
	"trundle.no-dash": {
		says: "Nothing in the kit dashes, blinks or leaps; the only repositioning tool is the pillar, and it moves other people.",
		checked: `ddragon 16.17.1 Trundle.json (all four spells) + wiki.leagueoflegends.com/en-us/Trundle, ${CHECKED_ON}`
	},
	"trundle.judgment.early-power": {
		says: "He is at his strongest early in a straight duel and falls off relative to the field.",
		checked: "community consensus — no sanctioned per-patch source is cited for it, so it is a judgment and is labelled as one"
	}
} satisfies Record<string, Fact>

const LEESIN_FACTS = {
	"leesin.q-must-land-first": {
		says: "Sonic Wave must hit before Resonating Strike exists at all; the recast dashes to whatever it hit and its damage grows with that target's missing health. Every entry and every escape is downstream of a landed Q, and it costs energy.",
		checked: `ddragon 16.17.1 LeeSin.json (LeeSinQOne, range 1100, 50 energy) + wiki.leagueoflegends.com/en-us/Lee_Sin, ${CHECKED_ON}`
	},
	"leesin.w-targets-any-ally-or-ward": {
		says: "Safeguard dashes to any allied unit in range — a champion, a minion or a WARD — shielding him, and a champion ally too. A ward placed beforehand is a way back out.",
		checked: `ddragon 16.17.1 LeeSin.json (LeeSinWOne, range 700) + wiki.leagueoflegends.com/en-us/Lee_Sin, ${CHECKED_ON}`
	},
	"leesin.r-is-his-only-displacement": {
		says: "Dragon's Rage knocks the target back and knocks up whatever the flying body collides with. It is his only hard displacement and the only way he removes one enemy from a fight, and its cooldown is long enough early that spending it badly costs minutes.",
		checked: `ddragon 16.17.1 LeeSin.json (LeeSinR, range 375, cooldown 110/85/60) + wiki.leagueoflegends.com/en-us/Lee_Sin, ${CHECKED_ON}`
	},
	"leesin.melee-commitment": {
		says: "Every payoff in the kit needs melee range, and each entry is a commitment with no free exit unless one was set up first.",
		checked: `ddragon 16.17.1 LeeSin.json (Q recast dashes to the target; W needs an allied unit; E is a 450 radius), ${CHECKED_ON}`
	},
	"leesin.route-full-clear-first": {
		says: "His most-played and best-winning routes are a six-camp full clear, with the scuttle-or-gank decision coming AFTER the sixth camp rather than instead of it.",
		checked: "jungler.gg Lee Sin pathing (page labels itself 26.16, one patch stale — cited in leesin.md's own source line); re-read the routes when the patch moves"
	},
	"leesin.judgment.early-champion": {
		says: "An early-tempo champion whose games are decided by decisions rather than by the champion — he is picked constantly and wins about as often as a coin flip.",
		checked: "community consensus, standing next to a near-even win rate at 16.17 Emerald+ (lolalytics re-read 2026-09-05: 50.93% over 262,100 games); the READING of that number is a judgment"
	}
} satisfies Record<string, Fact>

const FACTS: Record<string, Fact> = {
	...ROLE_FACTS,
	...LILLIA_FACTS,
	...BELVETH_FACTS,
	...TRUNDLE_FACTS,
	...LEESIN_FACTS
}

/**
 * Every clause that ships, and what it is betting on.
 *
 * The clause text is VERBATIM. Reword a clause in the markdown and this table stops matching,
 * which is the point: a reworded clause is a new bet and somebody has to say what it rests on.
 */
const PINS: Record<string, [clause: string, facts: string[]][]> = {
	"_default.md": [
		["take the camps that are up before you take the fight, you win that race more reliably", ["role.camps-are-gold-and-xp", "role.judgment"]],
		["answer farm with farm, and gank only the lane that can turn it into a plate", ["role.plates", "role.judgment"]],
		["cross for his camps when yours are dead, not instead of yours", ["role.camps-respawn"]],
		["ward the entrance before you cross, rather than assuming he is elsewhere", ["role.vision"]],
		["spend the lead on an objective rather than a duel, the objective is the part you keep", ["role.objectives-persist"]],
		["you are ahead on tempo, so be at the next timer before he can be", ["role.objective-timers"]],
		["keep the route full and take his camps while yours come back", ["role.camps-respawn"]],
		["decline it, a coin flip you walk away from costs a camp and one you lose costs the pit", ["role.objective-timers", "role.judgment"]],
		["take your own camps instead and be full health when that timer comes up", ["role.camps-are-gold-and-xp", "role.objective-timers"]],
		["the level comes back off a clear, so buy the level before you buy the fight", ["role.camps-are-gold-and-xp"]],
		["reset and come back even rather than forcing the rematch on their timer", ["role.judgment"]],
		["the second fight after a lost one is where a game stops being survivable, so farm", ["role.judgment"]],
		["clear your own half while their cooldowns run, then look at the map again", ["role.camps-are-gold-and-xp", "role.judgment"]],
		["that one was already decided, the objective across the map is not", ["role.objective-timers"]],
		["start walking to the next one now rather than after the ping", ["role.objective-timers", "role.judgment"]],
		["if you cannot be in it, make it cost them, take the camps they walked away from", ["role.camps-are-gold-and-xp"]],
		["check the entry with a ward before you cross next time, not once you are already inside.", ["role.vision"]],
		["when you respawn, clear your own side first and let their timers run down.", ["role.camps-respawn"]],
		["walk back toward the next objective timer instead of the fight you just lost.", ["role.objective-timers"]],
		["the fight went ahead without you either way, so buy for the next one, not the last one.", ["role.judgment"]],
		["assume the duel just got worse and take the fight you already had the numbers for", ["role.items-change-a-duel"]],
		["that is a real spike on him, so avoid the even fight until you have reset too", ["role.items-change-a-duel"]],
		["he paid for that, so make him spend it somewhere that is not the pit you want", ["role.items-change-a-duel", "role.objective-timers"]],
		["run the next route to the end, a gank that is not ready is not one", ["role.camps-are-gold-and-xp"]],
		["take the camps on the way to where you were going, not a lap back", ["role.camps-are-gold-and-xp"]],
		["soak the wave crashing into your own turret while camps come back", ["role.jungler-soaks-waves", "role.camps-respawn"]]
	],
	"lillia.md": [
		["your clear only gets faster while it keeps running, so finish the whole route", ["lillia.q-stacks-move-speed"]],
		["you do not win the straight early duel, so win the race on route speed instead", ["lillia.judgment.weak-early-duel", "lillia.q-stacks-move-speed"]],
		["the Prance stacks decay once you stop hitting things, so keep the route moving", ["lillia.q-stacks-move-speed"]],
		["roll a Swirlseed down his entrance, it reveals whoever it rolls into", ["lillia.e-reveals-what-it-hits"]],
		["you are ahead because the route never stopped, so do not stop it to go find him", ["lillia.q-stacks-move-speed"]],
		["keep the clear running toward his camps while the speed is stacked", ["lillia.q-stacks-move-speed", "role.camps-respawn"]],
		["no burst means you cannot cash a lead in a duel, so cash it on a drake", ["lillia.damage-arrives-over-time", "role.objectives-persist"]],
		["you have no burst to end it early, so take your own camps and come back with the ult", ["lillia.damage-arrives-over-time", "lillia.r-needs-dream-dust"]],
		["get the level back off a full clear, then contest it with the ult up", ["role.camps-are-gold-and-xp", "lillia.r-needs-dream-dust"]],
		["your speed is for leaving, not for winning that, so path away and take camps", ["lillia.q-stacks-move-speed", "lillia.w-is-her-only-hop"]],
		["your damage arrives over time, so take the long fights with room to kite", ["lillia.damage-arrives-over-time"]],
		["the ult only sleeps someone already covered in dust, so hit them before you cast it", ["lillia.r-needs-dream-dust"]],
		["a corridor takes away the speed that is your real exit, pull them into open ground", ["lillia.w-is-her-only-hop", "lillia.q-stacks-move-speed"]],
		["your value is being where they are not, so take the far camps while that settles", ["lillia.q-stacks-move-speed", "role.judgment"]],
		["arriving late on foot only feeds it, take the far objective instead", ["lillia.w-is-her-only-hop", "role.objective-timers"]],
		["start walking to the next timer, your speed only pays in transit", ["lillia.q-stacks-move-speed", "role.objective-timers"]],
		["the W hop is a step and not an escape, so the leaving has to start before you commit.", ["lillia.w-is-her-only-hop"]],
		["roll a Swirlseed in ahead of you next time, it reveals whoever it rolls into.", ["lillia.e-reveals-what-it-hits"]],
		["speed only saves you when it is already stacked, so start moving before you need it.", ["lillia.q-stacks-move-speed"]],
		["a pit or a corridor is where your escape stops existing, so fight at the entrance to it.", ["lillia.w-is-her-only-hop"]],
		["if that shortens the fight, stop taking the fight and go take something instead", ["lillia.damage-arrives-over-time", "role.items-change-a-duel"]],
		["you win the long one, so ask whether he can still be outlasted before you contest", ["lillia.damage-arrives-over-time", "role.items-change-a-duel"]],
		["you do not out-trade an item, you out-run it, so take camps and skip the duel", ["lillia.q-stacks-move-speed", "role.items-change-a-duel"]],
		["that is an interrupted route, not a slow one, so finish the next", ["lillia.q-stacks-move-speed"]],
		["a camp skipped mid-route costs the speed for all the ones after, so take it now", ["lillia.q-stacks-move-speed"]],
		["stop hovering the lane, the camp that is already up is the tempo", ["role.camps-respawn", "role.camps-are-gold-and-xp"]]
	],
	"belveth.md": [
		["you get paid for the long game, so take the camps and stop trading tempo for a coin flip", ["belveth.stacks-are-permanent", "role.judgment"]],
		["your clear speeds up as the stacks build, so finish the early routes", ["belveth.stacks-are-permanent"]],
		["you have no true form yet, so farm the side he is not on until the pit comes up", ["belveth.true-form-needs-a-coral", "belveth.judgment.weak-early"]],
		["baron and herald leave the coral that matters, so line one up while you are ahead", ["belveth.coral-from-takedowns"]],
		["your stacks are the part that stays, so keep the takedowns coming and skip the duel", ["belveth.stacks-are-permanent"]],
		["every large monster is another permanent stack, so keep the route full and take his camps", ["belveth.stacks-are-permanent", "role.camps-respawn"]],
		["without a coral you have no true form, so go and take camps until you can get one", ["belveth.true-form-needs-a-coral", "belveth.coral-from-takedowns"]],
		["every camp adds a stack you keep, so farm the level back and come again", ["belveth.stacks-are-permanent", "role.camps-are-gold-and-xp"]],
		["a level down your dashes are your exit and not your entry, so walk away and clear", ["belveth.q-per-direction-cooldown", "belveth.judgment.weak-early"]],
		["your dashes need room, so pull it into open ground rather than a corridor", ["belveth.q-per-direction-cooldown"]],
		["the tail refunds that dash only when it lands on a champion, so aim it at one", ["belveth.w-refunds-a-dash"]],
		["hold the spin while their damage is on you, not while you are chasing someone", ["belveth.e-pays-while-damaged"]],
		["that one was decided before you could reach it, so go and set up the epic monster", ["role.objective-timers"]],
		["an epic monster leaves a coral and stacks, so go take one instead of chasing this", ["belveth.coral-from-takedowns", "belveth.stacks-are-permanent"]],
		["be at the pit before it starts, arriving late is the thing your dashes cannot fix", ["belveth.q-per-direction-cooldown", "role.objective-timers"]],
		["your stacks are permanent, so being behind is never a reason to force it back.", ["belveth.stacks-are-permanent"]],
		["each dash direction has its own cooldown, so keep one pointed at the way out.", ["belveth.q-per-direction-cooldown"]],
		["true form ends and the stacks do not, so play for the next coral rather than this fight.", ["belveth.true-form-is-temporary", "belveth.stacks-are-permanent"]],
		["he spikes and you compound, so take the objective now and the fight later", ["belveth.stacks-are-permanent", "role.items-change-a-duel"]],
		["if that makes the duel worse, go and stack somewhere he is not standing", ["role.items-change-a-duel", "belveth.stacks-are-permanent"]],
		["his item is a clock on the phase you are weak in, so farm through it rather than test it", ["role.items-change-a-duel", "belveth.judgment.weak-early"]],
		["every camp you finish is a permanent stack, so run the route out rather than cut it", ["belveth.stacks-are-permanent"]],
		["each dash direction has its own timer, so clear with one still pointed at the way out", ["belveth.q-per-direction-cooldown", "role.camps-are-gold-and-xp"]],
		["stacks are the only thing you keep through a death, so bank them before contesting", ["belveth.stacks-are-permanent"]]
	],
	"trundle.md": [
		["without the pillar down first you are just another body, so set the next one up", ["trundle.e-is-terrain"]],
		["your power is now rather than later, so take the camps that put you next to him", ["trundle.judgment.early-power", "role.camps-are-gold-and-xp"]],
		["your best version is the early duel, so cross for his camps while it still is", ["trundle.judgment.early-power", "trundle.q-saps-ad"]],
		["he is buying time and you have none, so shorten the route and force contact", ["trundle.judgment.early-power"]],
		["you fall off relative to the field, so turn this into a tower before it stops being one", ["trundle.judgment.early-power"]],
		["the lead is a clock, spend it while the phase you are strongest in is still running", ["trundle.judgment.early-power"]],
		["walk at him with it, a camp is worth less to you than a fight you already win", ["trundle.judgment.early-power", "trundle.q-saps-ad"]],
		["even is your fight and a level down is not, so take the level back off your own camps", ["trundle.judgment.early-power", "role.camps-are-gold-and-xp"]],
		["Chomp wants a duel and not a collapse, so back out and clear instead", ["trundle.q-saps-ad"]],
		["get the level first, you win the fight on that pit once you are even", ["role.camps-are-gold-and-xp", "trundle.r-steals-from-the-biggest"]],
		["the field boosts your healing and speed only while you stand on it, so fight on top of it", ["trundle.w-boosts-healing-and-speed"]],
		["the pillar goes down to cut them apart before you commit, not once you are surrounded", ["trundle.e-is-terrain"]],
		["the ult wants the biggest body in the fight, so drain the tank and not the carry", ["trundle.r-steals-from-the-biggest"]],
		["your window is early, so start walking to the next one before it starts", ["trundle.judgment.early-power", "role.objective-timers"]],
		["you want the fight you chose, so go take a camp of his and make him come", ["trundle.judgment.early-power", "role.camps-respawn"]],
		["you have no dash, only a wall, so the pillar goes down before you commit rather than after.", ["trundle.no-dash", "trundle.e-is-terrain"]],
		["your field is where you win, so take the fight at your camp instead of walking into theirs.", ["trundle.w-boosts-healing-and-speed"]],
		["a pit or a tri-brush is your best ground and your worst exit, pick which before you enter.", ["trundle.no-dash", "trundle.e-is-terrain"]],
		["you steal stats rather than out-scale them, so take the fight before that item matters", ["trundle.q-saps-ad", "trundle.r-steals-from-the-biggest", "role.items-change-a-duel"]],
		["the longer this runs the less of it is yours, treat the item as a clock and force now", ["trundle.judgment.early-power", "role.items-change-a-duel"]],
		["if that made him tankier there is more for the ult to take, so look for him on the pit", ["trundle.r-steals-from-the-biggest", "role.items-change-a-duel"]],
		["a broken clear costs you the exact phase you are strongest in, so finish the route", ["trundle.judgment.early-power"]],
		["you cannot duel a level down, take the camps that fix the level", ["role.camps-are-gold-and-xp", "trundle.judgment.early-power"]],
		["clear toward him, your farm and your fight are the same walk", ["trundle.judgment.early-power", "role.camps-are-gold-and-xp"]],
		["enemies dying near you heal you, so clear through the camp rather than backing", ["trundle.passive-heals-off-deaths"]]
	],
	"leesin.md": [
		["your strong window is burning while you walk, so take the camps on the way to it", ["leesin.judgment.early-champion", "leesin.route-full-clear-first", "role.camps-are-gold-and-xp"]],
		["the ward hop is the reach nobody else has, so pick the lane with a wall to cross", ["leesin.w-targets-any-ally-or-ward"]],
		["your clear is unremarkable, so make the next deviation buy a kill or a plate", ["leesin.judgment.early-champion", "role.plates"]],
		["you catch up on a landed Q with an ally nearby, not on a faster route", ["leesin.q-must-land-first", "leesin.w-targets-any-ally-or-ward"]],
		["take his camps while your Q is up, and leave the moment it is not", ["leesin.q-must-land-first"]],
		["you are an early champion, so turn this into a tower rather than sitting on it", ["leesin.judgment.early-champion"]],
		["your lead is a kill threat rather than a stat check, so find a lane to follow up", ["leesin.judgment.early-champion", "leesin.q-must-land-first"]],
		["levels down you can arrive but not finish, so take your camps and come back with R", ["leesin.r-is-his-only-displacement", "role.camps-are-gold-and-xp"]],
		["a Q you land into a fight you still lose is the worst version of this, so walk away", ["leesin.q-must-land-first", "leesin.melee-commitment"]],
		["put a ward in first, then come back for the fight with something to hop out to", ["leesin.w-targets-any-ally-or-ward"]],
		["you are committed the moment you dash, so leave a ward behind you to get back out", ["leesin.melee-commitment", "leesin.w-targets-any-ally-or-ward"]],
		["the recast hurts most on someone already low, so pick the damaged target", ["leesin.q-must-land-first"]],
		["R is for removing someone or kicking them into your team, not for closing a gap", ["leesin.r-is-his-only-displacement"]],
		["your kit is choosing the fight, so choose the next one and be early", ["leesin.melee-commitment", "role.judgment"]],
		["you need an angle and a target already low, so set the next one up from the side", ["leesin.q-must-land-first", "leesin.melee-commitment"]],
		["drop a ward on the next objective now, it is vision and it is your way in", ["leesin.w-targets-any-ally-or-ward", "role.vision"]],
		["everything you own starts with a landed Q, so do not cross while it is down.", ["leesin.q-must-land-first"]],
		["put the ward down before you enter, so leaving is a button rather than a walk.", ["leesin.w-targets-any-ally-or-ward"]],
		["with R down you have no way to break a fight open, so take the camp instead.", ["leesin.r-is-his-only-displacement"]],
		["melee means the way out has to exist first, so check there is an ally to jump to.", ["leesin.melee-commitment", "leesin.w-targets-any-ally-or-ward"]],
		["you win the phase before his items land, so force something before he finishes the next", ["leesin.judgment.early-champion", "role.items-change-a-duel"]],
		["that makes the melee trade worse, so pick a target that is already damaged instead", ["role.items-change-a-duel", "leesin.q-must-land-first"]],
		["once he beats your carry, kick him away from the fight rather than into it", ["leesin.r-is-his-only-displacement", "role.items-change-a-duel"]],
		["make the next detour buy a kill or a plate, or do not take it", ["role.plates", "leesin.judgment.early-champion"]],
		["the level that makes your gank a kill comes off camps, so clear first", ["role.camps-are-gold-and-xp", "leesin.judgment.early-champion"]]
	]
}

/**
 * Sentences that are WRONG about this champion and have already been written down once.
 *
 * A forbidden phrase is cheap and it is exact: it cannot catch the next mistake, only the one
 * that was already made. Every entry here names a real sentence that shipped, or a real sentence
 * a re-write nearly reintroduced, and the fact that refutes it.
 */
const FORBIDDEN: Record<string, { pattern: RegExp; why: string }[]> = {
	"belveth.md": [
		{
			pattern: /stacks?\s+(die|are lost|reset|disappear|go away|come off)/i,
			why: "Death in Lavender stacks are PERMANENT and survive death (belveth.stacks-are-permanent). `death: your stacks die with you` shipped once — this is that sentence."
		},
		{
			pattern: /true form is permanent|permanently in true form/i,
			why: "True Form runs on a duration until she is deep into her Lavender stacks (belveth.true-form-is-temporary). The stacks are the permanent half, not the form."
		}
	],
	"lillia.md": [
		{
			pattern: /no dash|without a dash|has no dash|there is no dash/i,
			why: "Watch Out! Eep! IS a dash — short, toward the target location, and blocked by terrain (lillia.w-is-her-only-hop). Say that the hop will not carry her over a wall; do not say she has none."
		}
	],
	"trundle.md": [
		{
			pattern: /\bbite\b/i,
			why: "Trundle's Q is called Chomp, and it does not heal (trundle.q-saps-ad). `Bite is sustain and a stat steal in one button` shipped once and was wrong twice over."
		}
	],
	"leesin.md": [
		{
			pattern: /\bno dash\b/i,
			why: "Resonating Strike and Safeguard are both dashes (leesin.q-must-land-first, leesin.w-targets-any-ally-or-ward)."
		}
	]
}

/** Ability names that belong to a champion, and therefore must never appear in `_default.md`. */
const ABILITY_NAMES = [
	"Dream-Laden Bough",
	"Blooming Blows",
	"Watch Out! Eep!",
	"Swirlseed",
	"Lilting Lullaby",
	"Death in Lavender",
	"Void Surge",
	"Above and Below",
	"Royal Maelstrom",
	"Endless Banquet",
	"King's Tribute",
	"Chomp",
	"Frozen Domain",
	"Pillar of Ice",
	"Subjugate",
	"Sonic Wave",
	"Resonating Strike",
	"Safeguard",
	"Iron Will",
	"Tempest",
	"Cripple",
	"Dragon's Rage"
]

const SANCTIONED = [
	"ddragon",
	"wiki.leagueoflegends.com",
	"leagueoflegends.com",
	"op.gg",
	"u.gg",
	"lolalytics",
	"jungler.gg",
	"role fundamentals",
	"community consensus"
]

const read = (file: string): string => readFileSync(join(CHAMPIONS_DIR, file), "utf8")

/*
 * The files this register is ABOUT: the ones that ship tagged clauses to the fenced and
 * cite-or-quiet coaches. A champion file written only as prose for the full-knowledge coach
 * (`src/review/live-knowledge-full.ts`, which does no clause parsing at all) has nothing here to
 * pin — every sentence in it is delivered verbatim, so there is no parser step for a claim to go
 * missing in. Scoping by the clause heading rather than by a hardcoded list keeps the emptied-
 * directory guard below honest: delete lillia.md's clause block and it drops out of this list and
 * the register fails, which is exactly what it did the night that mattered.
 */
const shippedFiles = (): string[] =>
	readdirSync(CHAMPIONS_DIR)
		.filter(f => f.endsWith(".md") && /^##+\s*Live coaching\s*$/im.test(read(f)))
		.sort()

/** Every clause on disk, in file order within each kind. */
const clausesOf = (file: string): string[] => {
	const parsed = parseChampionClauses(read(file))
	return ADVICE_KINDS.flatMap(kind => parsed[kind] ?? [])
}

describe("the claims register", () => {
	it("covers every file that ships, and only files that ship", () => {
		// An emptied directory passing green is exactly how a night's work went missing once.
		deepStrictEqual(shippedFiles(), Object.keys(PINS).sort())
		ok(shippedFiles().length > 1, "no champion files on disk")
	})

	it("pins every clause that ships, verbatim", () => {
		for (const file of shippedFiles()) {
			const onDisk = clausesOf(file)
			const pinned = PINS[file]!.map(([clause]) => clause)
			ok(onDisk.length > 0, `${file} loaded no clauses at all`)
			for (const clause of onDisk)
				ok(
					pinned.includes(clause),
					`${file}: this clause is not in the claims register, so nobody has written down what it depends on:\n    ${clause}`
				)
			for (const clause of pinned)
				ok(
					onDisk.includes(clause),
					`${file}: the register pins a clause that no longer loads from the file — reworded, deleted, or refused by the parser:\n    ${clause}`
				)
			strictEqual(new Set(pinned).size, pinned.length, `${file}: a clause is pinned twice`)
		}
	})

	it("gives every clause at least one fact to stand on, and every fact exists", () => {
		for (const [file, pins] of Object.entries(PINS))
			for (const [clause, facts] of pins) {
				ok(facts.length > 0, `${file}: "${clause}" bets on nothing`)
				for (const id of facts) ok(FACTS[id] !== undefined, `${file}: "${clause}" cites unknown fact "${id}"`)
			}
	})

	it("leaves no fact uncited, so the register cannot rot into decoration", () => {
		const cited = new Set(Object.values(PINS).flatMap(pins => pins.flatMap(([, facts]) => facts)))
		for (const id of Object.keys(FACTS)) ok(cited.has(id), `fact "${id}" is cited by no clause — delete it or use it`)
	})

	it("makes every fact say what it is and where it was checked", () => {
		for (const [id, fact] of Object.entries(FACTS)) {
			ok(fact.says.trim().length > 20, `fact "${id}" does not say what it claims`)
			ok(
				SANCTIONED.some(s => fact.checked.startsWith(s)),
				`fact "${id}" is checked against "${fact.checked}", which is not a source sanctioned by knowledge/SOURCES.md`
			)
		}
	})

	it("will not let a judgment pass itself off as a mechanic", () => {
		/*
		 * The whole failure mode is a sentence that reads like a checked fact and is not one. So
		 * the two labels have to agree: "community consensus" is only allowed on an id that says
		 * `judgment` out loud, and an id that says `judgment` may not claim a sanctioned source.
		 */
		for (const [id, fact] of Object.entries(FACTS)) {
			const consensus = fact.checked.startsWith("community consensus")
			const labelled = id.includes("judgment")
			strictEqual(
				consensus,
				labelled,
				`fact "${id}": checked as "${fact.checked.slice(0, 40)}…" but ${labelled ? "labelled" : "not labelled"} a judgment — the id and the provenance must agree`
			)
		}
	})
})

describe("the mistakes already made here", () => {
	it("cannot come back, in any file that once made them", () => {
		for (const [file, rules] of Object.entries(FORBIDDEN)) {
			const text = read(file)
			for (const { pattern, why } of rules) {
				const hit = pattern.exec(text)
				ok(hit === null, `${file} says "${hit?.[0]}" — ${why}`)
			}
		}
	})

	it("is not vacuous: each forbidden pattern still matches the sentence it was written for", () => {
		// A regex that matches nothing is a guard that guards nothing, and it looks identical.
		const specimens: Record<string, string> = {
			"belveth.md": "death: your stacks die with you",
			"lillia.md": "Her escape is movement speed — no dash, no blink.",
			"trundle.md": "Bite is sustain and a stat steal in one button",
			"leesin.md": "he has no dash to get back out"
		}
		for (const [file, rules] of Object.entries(FORBIDDEN)) {
			const specimen = specimens[file]!
			ok(
				rules.some(r => r.pattern.test(specimen)),
				`no rule for ${file} matches the sentence it exists to catch: ${specimen}`
			)
		}
	})
})

describe("_default.md", () => {
	it("names no champion ability, because it is what the coach says when it knows none", () => {
		const text = read("_default.md")
		for (const name of ABILITY_NAMES)
			ok(!text.includes(name), `_default.md mentions "${name}" — the role fallback may not lean on a kit`)
	})

	it("stands on role facts alone", () => {
		for (const [clause, facts] of PINS["_default.md"]!)
			for (const id of facts)
				ok(id.startsWith("role."), `_default.md: "${clause}" cites "${id}", which is a champion fact`)
	})
})
