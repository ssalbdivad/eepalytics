/**
 * The FROZEN clause blocks of the two legacy live-coach modes. Pure data, no filesystem.
 *
 * ## Why a data module and not the markdown it came from
 *
 * `fenced` and `cite-or-quiet` are measured arms. AGENTS.md states the rule they live under: their
 * stored runs are only meaningful while the text that produced them exists byte for byte, which is
 * why `live-prompt.ts` may not be reworded and why `live-coach-mode.test.ts` fails if it moves.
 * Champion clauses were the one input to those arms that lived on disk in `knowledge/champions/
 * *.md` — the same files that were deleted on 2026-09-18 because every sentence in them was
 * written by a model out of its own head and nothing could tell a true one from an invented one.
 *
 * Deleting the files without freezing the clauses would have silently changed what those two arms
 * are, and a comparison whose inputs moved is not a comparison. So the five `## Live coaching`
 * sections that existed — four champions and the role default; the other twenty files never had
 * one — are reproduced here BYTE FOR BYTE as they stood at commit 96a6c493304482e603f93c5f4598e8011b0cd6ac, section text and
 * all, and `parseChampionClauses` runs on them exactly as it ran on the files. Freezing the INPUT
 * rather than the parse output is deliberate: it is the parser's behaviour that was measured too.
 *
 * ## The two texts, and why they differ by exactly two lines
 *
 * `legacyClauseSection` is the corpus AS MEASURED. Nothing may edit it; it exists to reproduce
 * runs, and a run reproduced against repaired text proves nothing about the run.
 *
 * `shippedClauseSection` is what a player hears today, and it is the as-measured corpus minus
 * `RETRACTIONS`. Two Lillia clauses are withdrawn. Both descend from a sentence in `lillia.md`
 * that no source supports — "E rolls OVER TERRAIN, and grants VISION of what it rolls past" —
 * against the wiki's own rendered text for Swirlseed, which says the seed "detonates upon hitting
 * an enemy or terrain while on the ground" and reveals only the enemies caught in the cone, for
 * two seconds. That false parent licensed 38% of the champion-specific lines the live coach has
 * ever spoken and 11.2% of the stored post-game advice.
 *
 * The honest note on the two retracted clauses, because a retraction that overstates itself is the
 * same failure in the other direction: read literally, "it reveals whoever it rolls into" is TRUE
 * — a seed that reaches an enemy does reveal him. What is false is the habit both clauses exist to
 * teach, which is throwing the seed down a corridor to LEARN something. Against terrain it
 * detonates and tells him nothing, and he was told otherwise four times in one file. They are
 * withdrawn because the advice rests on the false parent, and withdrawing them costs nothing that
 * was ever measured: withholding the champion file entirely moved the live path by
 * +1.1 points [-2.1, +4.2], p = 0.547.
 *
 * ## Nothing may be ADDED here
 *
 * This file is a tombstone, not a knowledge base. Champion knowledge that ships today is fetched,
 * per-line sourced and rendered by `champion-brief.ts`; a new clause written into this module
 * would be exactly the unsourced model prose the deletion was for, wearing a frozen-data label.
 * `legacy-clauses.test.ts` pins the section digests, so an edit has to say out loud what it did.
 */

/** The commit whose `knowledge/champions/*.md` these sections were taken from, verbatim. */
export const FROZEN_AT_COMMIT = "96a6c493304482e603f93c5f4598e8011b0cd6ac"

/** The date the files were deleted and this module became their only copy. */
export const FROZEN_ON = "2026-09-18"

/**
 * `## Live coaching` section text, keyed by `championKey()` — plus `_default`, the role fallback.
 *
 * Five entries because five files had the section. Twenty champion files carried prose only, which
 * the legacy arms never read: their whole contribution to those modes was the empty string.
 */
export const LEGACY_CLAUSE_SECTIONS: Readonly<Record<string, string>> = {
	"_default": "## Live coaching\n\nRole advice — the fallback for every champion, and the fill for any kind a champion file\nleaves bare. Every clause here has to be true of *the jungle*, never of a champion.\nHalf-sentences, said out loud after a number the client has already proved. **No digits** —\na figure here would be a claim about the game, and every figure he hears must come from the\nclient. Anything with a number in it is refused at load time, deliberately.\n\nSeveral clauses per key is intentional: a fixed clause per kind means the identical half-sentence\nevery time that kind fires, and sameness is what made him stop listening. Each one has to end on\nsomething he can DO in the next thirty seconds.\n\nrace-behind: take the camps that are up before you take the fight, you win that race more reliably\nrace-behind: answer farm with farm, and gank only the lane that can turn it into a plate\nrace-behind: cross for his camps when yours are dead, not instead of yours\nrace-behind: ward the entrance before you cross, rather than assuming he is elsewhere\n\nrace-ahead: spend the lead on an objective rather than a duel, the objective is the part you keep\nrace-ahead: you are ahead on tempo, so be at the next timer before he can be\nrace-ahead: keep the route full and take his camps while yours come back\n\nrestraint: decline it, a coin flip you walk away from costs a camp and one you lose costs the pit\nrestraint: take your own camps instead and be full health when that timer comes up\nrestraint: the level comes back off a clear, so buy the level before you buy the fight\n\nfight-lost: reset and come back even rather than forcing the rematch on their timer\nfight-lost: the second fight after a lost one is where a game stops being survivable, so farm\nfight-lost: clear your own half while their cooldowns run, then look at the map again\n\nfight-absent: that one was already decided, the objective across the map is not\nfight-absent: start walking to the next one now rather than after the ping\nfight-absent: if you cannot be in it, make it cost them, take the camps they walked away from\n\ndeath: check the entry with a ward before you cross next time, not once you are already inside.\ndeath: when you respawn, clear your own side first and let their timers run down.\ndeath: walk back toward the next objective timer instead of the fight you just lost.\ndeath: the fight went ahead without you either way, so buy for the next one, not the last one.\n\nbuild: assume the duel just got worse and take the fight you already had the numbers for\nbuild: that is a real spike on him, so avoid the even fight until you have reset too\nbuild: he paid for that, so make him spend it somewhere that is not the pit you want\n\nfarm-behind: run the next route to the end, a gank that is not ready is not one\nfarm-behind: take the camps on the way to where you were going, not a lap back\nfarm-behind: soak the wave crashing into your own turret while camps come back\n",
	"belveth": "## Live coaching\n\nHalf-sentences, said out loud after a number the client has already proved. **No digits** —\na figure here would be a claim about the game, and every figure he hears must come from the\nclient. Anything with a number in it is refused at load time, deliberately.\n\nSeveral clauses per key is intentional: a fixed clause per kind means the identical half-sentence\nevery time that kind fires, and sameness is what made him stop listening. Each one has to end on\nsomething he can DO in the next thirty seconds.\n\nEvery clause below is pinned in `src/knowledge/champion-claims.test.ts`: each one names the\nmechanic it is betting on and where that mechanic was checked. Add a clause and the test fails\nuntil you write down what it depends on.\n\nrace-behind: you get paid for the long game, so take the camps and stop trading tempo for a coin flip\nrace-behind: your clear speeds up as the stacks build, so finish the early routes\nrace-behind: you have no true form yet, so farm the side he is not on until the pit comes up\n\nrace-ahead: baron and herald leave the coral that matters, so line one up while you are ahead\nrace-ahead: your stacks are the part that stays, so keep the takedowns coming and skip the duel\nrace-ahead: every large monster is another permanent stack, so keep the route full and take his camps\n\nrestraint: without a coral you have no true form, so go and take camps until you can get one\nrestraint: every camp adds a stack you keep, so farm the level back and come again\nrestraint: a level down your dashes are your exit and not your entry, so walk away and clear\n\nfight-lost: your dashes need room, so pull it into open ground rather than a corridor\nfight-lost: the tail refunds that dash only when it lands on a champion, so aim it at one\nfight-lost: hold the spin while their damage is on you, not while you are chasing someone\n\nfight-absent: that one was decided before you could reach it, so go and set up the epic monster\nfight-absent: an epic monster leaves a coral and stacks, so go take one instead of chasing this\nfight-absent: be at the pit before it starts, arriving late is the thing your dashes cannot fix\n\ndeath: your stacks are permanent, so being behind is never a reason to force it back.\ndeath: each dash direction has its own cooldown, so keep one pointed at the way out.\ndeath: true form ends and the stacks do not, so play for the next coral rather than this fight.\n\nbuild: he spikes and you compound, so take the objective now and the fight later\nbuild: if that makes the duel worse, go and stack somewhere he is not standing\nbuild: his item is a clock on the phase you are weak in, so farm through it rather than test it\n\nfarm-behind: every camp you finish is a permanent stack, so run the route out rather than cut it\nfarm-behind: each dash direction has its own timer, so clear with one still pointed at the way out\nfarm-behind: stacks are the only thing you keep through a death, so bank them before contesting\n",
	"leesin": "## Live coaching\n\nHalf-sentences, said out loud after a number the client has already proved. **No digits** —\na figure here would be a claim about the game, and every figure he hears must come from the\nclient. Anything with a number in it is refused at load time, deliberately.\n\nSeveral clauses per key is intentional: a fixed clause per kind means the identical half-sentence\nevery time that kind fires, and sameness is what made him stop listening. Each one has to end on\nsomething he can DO in the next thirty seconds.\n\nEvery clause below is pinned in `src/knowledge/champion-claims.test.ts`: each one names the\nmechanic it is betting on and where that mechanic was checked. Add a clause and the test fails\nuntil you write down what it depends on.\n\nrace-behind: your clear is unremarkable, so make the next deviation buy a kill or a plate\nrace-behind: you catch up on a landed Q with an ally nearby, not on a faster route\nrace-behind: take his camps while your Q is up, and leave the moment it is not\n\nrace-ahead: you are an early champion, so turn this into a tower rather than sitting on it\nrace-ahead: your lead is a kill threat rather than a stat check, so find a lane to follow up\nrace-ahead: the ward hop is the reach nobody else has, so pick the lane with a wall to cross\n\nrestraint: levels down you can arrive but not finish, so take your camps and come back with R\nrestraint: a Q you land into a fight you still lose is the worst version of this, so walk away\nrestraint: put a ward in first, then come back for the fight with something to hop out to\n\nfight-lost: you are committed the moment you dash, so leave a ward behind you to get back out\nfight-lost: the recast hurts most on someone already low, so pick the damaged target\nfight-lost: R is for removing someone or kicking them into your team, not for closing a gap\n\nfight-absent: your kit is choosing the fight, so choose the next one and be early\nfight-absent: you need an angle and a target already low, so set the next one up from the side\nfight-absent: drop a ward on the next objective now, it is vision and it is your way in\n\ndeath: everything you own starts with a landed Q, so do not cross while it is down.\ndeath: put the ward down before you enter, so leaving is a button rather than a walk.\ndeath: with R down you have no way to break a fight open, so take the camp instead.\ndeath: melee means the way out has to exist first, so check there is an ally to jump to.\n\nbuild: you win the phase before his items land, so force something before he finishes the next\nbuild: that makes the melee trade worse, so pick a target that is already damaged instead\nbuild: once he beats your carry, kick him away from the fight rather than into it\n\nfarm-behind: your strong window is burning while you walk, so take the camps on the way to it\nfarm-behind: make the next detour buy a kill or a plate, or do not take it\nfarm-behind: the level that makes your gank a kill comes off camps, so clear first\n",
	"lillia": "## Live coaching\n\nHalf-sentences, said out loud after a number the client has already proved. **No digits** —\na figure here would be a claim about the game, and every figure he hears must come from the\nclient. Anything with a number in it is refused at load time, deliberately.\n\nSeveral clauses per key is intentional: a fixed clause per kind means the identical half-sentence\nevery time that kind fires, and sameness is what made him stop listening. Each one has to end on\nsomething he can DO in the next thirty seconds.\n\nEvery clause below is pinned in `src/knowledge/champion-claims.test.ts`: each one names the\nmechanic it is betting on and where that mechanic was checked. Add a clause and the test fails\nuntil you write down what it depends on.\n\nrace-behind: your clear only gets faster while it keeps running, so finish the whole route\nrace-behind: you do not win the straight early duel, so win the race on route speed instead\nrace-behind: the Prance stacks decay once you stop hitting things, so keep the route moving\nrace-behind: roll a Swirlseed down his entrance, it reveals whoever it rolls into\n\nrace-ahead: you are ahead because the route never stopped, so do not stop it to go find him\nrace-ahead: keep the clear running toward his camps while the speed is stacked\nrace-ahead: no burst means you cannot cash a lead in a duel, so cash it on a drake\n\nrestraint: you have no burst to end it early, so take your own camps and come back with the ult\nrestraint: get the level back off a full clear, then contest it with the ult up\nrestraint: your speed is for leaving, not for winning that, so path away and take camps\n\nfight-lost: your damage arrives over time, so take the long fights with room to kite\nfight-lost: the ult only sleeps someone already covered in dust, so hit them before you cast it\nfight-lost: a corridor takes away the speed that is your real exit, pull them into open ground\n\nfight-absent: your value is being where they are not, so take the far camps while that settles\nfight-absent: arriving late on foot only feeds it, take the far objective instead\nfight-absent: start walking to the next timer, your speed only pays in transit\n\ndeath: the W hop is a step and not an escape, so the leaving has to start before you commit.\ndeath: roll a Swirlseed in ahead of you next time, it reveals whoever it rolls into.\ndeath: speed only saves you when it is already stacked, so start moving before you need it.\ndeath: a pit or a corridor is where your escape stops existing, so fight at the entrance to it.\n\nbuild: if that shortens the fight, stop taking the fight and go take something instead\nbuild: you win the long one, so ask whether he can still be outlasted before you contest\nbuild: you do not out-trade an item, you out-run it, so take camps and skip the duel\n\nfarm-behind: that is an interrupted route, not a slow one, so finish the next\nfarm-behind: a camp skipped mid-route costs the speed for all the ones after, so take it now\nfarm-behind: stop hovering the lane, the camp that is already up is the tempo\n",
	"trundle": "## Live coaching\n\nHalf-sentences, said out loud after a number the client has already proved. **No digits** —\na figure here would be a claim about the game, and every figure he hears must come from the\nclient. Anything with a number in it is refused at load time, deliberately.\n\nSeveral clauses per key is intentional: a fixed clause per kind means the identical half-sentence\nevery time that kind fires, and sameness is what made him stop listening. Each one has to end on\nsomething he can DO in the next thirty seconds.\n\nEvery clause below is pinned in `src/knowledge/champion-claims.test.ts`: each one names the\nmechanic it is betting on and where that mechanic was checked. Add a clause and the test fails\nuntil you write down what it depends on.\n\nrace-behind: your power is now rather than later, so take the camps that put you next to him\nrace-behind: your best version is the early duel, so cross for his camps while it still is\nrace-behind: he is buying time and you have none, so shorten the route and force contact\n\nrace-ahead: you fall off relative to the field, so turn this into a tower before it stops being one\nrace-ahead: the lead is a clock, spend it while the phase you are strongest in is still running\nrace-ahead: walk at him with it, a camp is worth less to you than a fight you already win\n\nrestraint: even is your fight and a level down is not, so take the level back off your own camps\nrestraint: Chomp wants a duel and not a collapse, so back out and clear instead\nrestraint: get the level first, you win the fight on that pit once you are even\n\nfight-lost: the field boosts your healing and speed only while you stand on it, so fight on top of it\nfight-lost: the pillar goes down to cut them apart before you commit, not once you are surrounded\nfight-lost: the ult wants the biggest body in the fight, so drain the tank and not the carry\n\nfight-absent: your window is early, so start walking to the next one before it starts\nfight-absent: without the pillar down first you are just another body, so set the next one up\nfight-absent: you want the fight you chose, so go take a camp of his and make him come\n\ndeath: you have no dash, only a wall, so the pillar goes down before you commit rather than after.\ndeath: your field is where you win, so take the fight at your camp instead of walking into theirs.\ndeath: a pit or a tri-brush is your best ground and your worst exit, pick which before you enter.\n\nbuild: you steal stats rather than out-scale them, so take the fight before that item matters\nbuild: the longer this runs the less of it is yours, treat the item as a clock and force now\nbuild: if that made him tankier there is more for the ult to take, so look for him on the pit\n\nfarm-behind: a broken clear costs you the exact phase you are strongest in, so finish the route\nfarm-behind: you cannot duel a level down, take the camps that fix the level\nfarm-behind: clear toward him, your farm and your fight are the same walk\nfarm-behind: enemies dying near you heal you, so clear through the camp rather than backing\n"
}

export interface Retraction {
	/** `championKey()` of the champion whose section carried it. */
	key: string
	/** The clause text, exactly as the parser would have returned it. */
	clause: string
	/** What the fetched source actually says. */
	source: string
	why: string
}

/**
 * Clauses withdrawn from the shipped path and kept in the measured one.
 *
 * A clause qualifies only when a FETCHED source contradicts the mechanic it rests on. Not when it
 * reads oddly, not when a better one exists, and never because an agent disagreed with it: this
 * list is the one place a clause can be removed, and its bar is a URL.
 */
export const RETRACTIONS: readonly Retraction[] = [
	{
		key: "lillia",
		clause: "roll a Swirlseed down his entrance, it reveals whoever it rolls into",
		source:
			"League of Legends Wiki, Lillia — Swirlseed: \"The seed detonates upon hitting an enemy " +
			"or terrain while on the ground, dealing magic damage to enemies in a cone, slowing them " +
			"by 40% for 3 seconds and revealing them for 2 seconds.\" Riot Data Dragon 16.18.1 agrees: " +
			"\"the seed rolls until it hits an enemy or collides with terrain.\"",
		why:
			"Teaches the seed as a scouting tool down a corridor. It detonates on the first terrain it " +
			"meets and reveals nobody, so the information it promises does not exist. Descends from the " +
			"file's \"rolls over terrain, and grants vision of what it rolls past\", which no source says."
	},
	{
		key: "lillia",
		clause: "roll a Swirlseed in ahead of you next time, it reveals whoever it rolls into.",
		source:
			"League of Legends Wiki, Lillia — Swirlseed: \"The seed detonates upon hitting an enemy " +
			"or terrain while on the ground ... revealing them for 2 seconds.\"",
		why:
			"The same habit on the death kind, and the worse of the two: it is spoken to a player who " +
			"just died to something he could not see, which is exactly when a promise of free " +
			"information gets believed."
	}
]

const RETRACTED_BY_KEY = new Map<string, string[]>()
for (const r of RETRACTIONS) {
	const list = RETRACTED_BY_KEY.get(r.key) ?? []
	list.push(r.clause)
	RETRACTED_BY_KEY.set(r.key, list)
}

/**
 * The key the ROLE fallback is stored under — it came from `_default.md`, so it keeps that name.
 *
 * `championKey()` would render it `default`, and it is deliberately not that: it is not a champion,
 * and a lookup that can collide with one is a lookup that can hand the role's clauses to a champion
 * whose name happens to normalise the same way. Callers name it explicitly.
 */
export const ROLE_DEFAULT_KEY = "_default"

/**
 * The section AS MEASURED, or `""`.
 *
 * `""` is the normal answer and not a failure: twenty of the twenty-four champion files never had
 * a clause section, so the legacy arms have always handed those champions nothing.
 */
export const legacyClauseSection = (key: string): string => LEGACY_CLAUSE_SECTIONS[key] ?? ""

/** The retracted clauses for one champion, for a caller that wants to say what it dropped. */
export const retractionsFor = (key: string): readonly Retraction[] =>
	RETRACTIONS.filter(r => r.key === key)

/**
 * The section as it SHIPS: as measured, minus every retracted clause line.
 *
 * Removing whole lines rather than rewriting them keeps the remaining clauses byte-identical, so
 * the only difference between the two corpora is absence — which is the only difference a reader
 * of a diff can check at a glance.
 */
export const shippedClauseSection = (key: string): string => {
	const section = legacyClauseSection(key)
	const drop = RETRACTED_BY_KEY.get(key)
	if (section === "" || !drop) return section
	return section
		.split("\n")
		.filter(line => {
			const text = line.trim()
			return !drop.some(clause => text.endsWith(clause) && text.includes(":"))
		})
		.join("\n")
}

/** Which champions the legacy arms have any clause for at all. */
export const legacyClauseKeys = (): string[] => Object.keys(LEGACY_CLAUSE_SECTIONS).sort()
