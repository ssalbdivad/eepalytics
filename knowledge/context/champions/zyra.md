## ZYRA — FETCHED FACTS (copied from the sources named on each line)

Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap.

### Identity
- title: Rise of the Thorns [wikiModule raw@2026-09-18, fetched 2026-09-18]
- resource: Mana [wikiModule raw@2026-09-18, fetched 2026-09-18]
- melee or ranged: Ranged [wikiModule raw@2026-09-18, fetched 2026-09-18]
- positions Riot's client lists: Support [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released in patch: V1.0.0.143 [wikiModule raw@2026-09-18, fetched 2026-09-18]
- last changed in patch: V26.08 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Base stats
- base stat: hp_base 574, hp_lvl 93, mp_base 418, mp_lvl 25, arm_base 29, arm_lvl 4.2, mr_base 30, mr_lvl 1.3, hp5_base 5.5, hp5_lvl 0.5, mp5_base 7, mp5_lvl 0.8, dam_base 53, dam_lvl 3.2, as_base 0.681, as_lvl 2.11, range 575, ms 340 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Passive
- name: Garden of Thorns [wiki-p rev-3986877, fetched 2026-09-18]
- static cooldown, not affected by ability haste: 13.6 – 8.51 (based on level) [wiki-p rev-3986877, fetched 2026-09-18]
- what it does: Innate: Periodically, Zyra spawns one or two Seeds nearby that last for 30 seconds, granting sight over the surrounding area for 1 second. After 1 second, enemy champions can destroy Seeds by moving on top of them. Zyra can only have a total of 8 Seeds planted at a time, preserving Seeds spawned by Rampant Growth over Seeds spawned by Garden of Thorns. [wiki-p rev-3986877, fetched 2026-09-18]
- effect radius: 900 [wiki-p rev-3986877, fetched 2026-09-18]
- targeting: Passive [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: PENDING FOR TEST: The pattern/probability of Garden of Thorns spawning one seed or two. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra tries to plant Seeds in brush and not on top of walls. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra tries not to plant Seeds too close together and at different angles. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra does not plant any Seeds if she is concealed within a brush (unless there is an enemy ward in it, in which case it takes her a little longer to plant the Seed) or when there is no room for additional ones. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra does not plant any Seeds if she is within 1400 units of the coordinate points (400, 400) or (14000, 14000), which are roughly at the center of the fountains on Summoner's Rift. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: These same coordinates may not hold as fountain positions on other maps (e.g. on the Arena map, the Magma Chamber area overlaps with the second exclusion radius) and may prompt the implementation of this behaviour to be changed in the future.(bug) [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra tries to plant Seeds close to an enemy near her. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Zyra tries to plant Seeds under enemy structures only if she is in basic attack range of them. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Zyra tries to plant Seeds on the other side of the wall she is facing and/or standing right next to. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Zyra tries to plant Seeds in the direction she is facing and/or moving. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra tries to plant Seeds near jungle path entrances. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Zyra tries to plant Seeds behind herself when she is walking through the river and there are no jungle path entrances near her. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra tries to plant Seeds between herself and the enemy champion she has vision of (or is heading towards her) in a 45º angle to the left or to the right depending on where on lane she is standing. [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra tries to plant Seeds against the inner walls of epic monster pits ( Dragon, Rift Herald, Baron Nashor) [wiki-p rev-3986877, fetched 2026-09-18]
- edge case: Zyra has a hidden passive that grants her 10% increased size for 33 seconds after having Leona's Sunlight applied to her. [wiki-p rev-3986877, fetched 2026-09-18]

### Q
- name: Deadly Spines [wiki-q rev-4013461, fetched 2026-09-18]
- cooldown: 7 / 6.5 / 6 / 5.5 / 5 [wiki-q rev-4013461, fetched 2026-09-18]
- cost: 55 [wiki-q rev-4013461, fetched 2026-09-18]
- what it does: Active: Zyra sprouts thorny spines at the target location that appear after a 0.625-seconds delay, dealing magic damage to enemies hit. If Deadly Spine hits a Seed, it sprouts into a Thorn Spitter that lasts for 8 seconds. [wiki-q rev-4013461, fetched 2026-09-18]
- damage by rank: Magic Damage: 60 / 100 / 140 / 180 / 220 (+ 65% AP) [wiki-q rev-4013461, fetched 2026-09-18]
- target range: 800 [wiki-q rev-4013461, fetched 2026-09-18]
- cast time: 0.25 [wiki-q rev-4013461, fetched 2026-09-18]
- targeting: Location [wiki-q rev-4013461, fetched 2026-09-18]
- damage type: Magic [wiki-q rev-4013461, fetched 2026-09-18]
- spell shield: True [wiki-q rev-4013461, fetched 2026-09-18]
- edge case: Each Thorn Spitter will generate 2 stacks of Conqueror and 1 stack of Electrocute. [wiki-q rev-4013461, fetched 2026-09-18]

### W
- what it does: Active: Zyra plants a Seed at the target location that remains for 60 seconds and grants sight over the surrounding area, though decreasing in radius after 1 second. After 1.5 seconds, enemy champions can destroy the Seed by stepping on it, which reveals them for 2 seconds. Zyra periodically stocks a Seed charge, up to a maximum of 2. Killing an enemy generates 35% charge toward a Seed, increased to 100% for large enemies and whenever scoring an enemy champion takedown. [wiki-w rev-4044057, fetched 2026-09-18]
- targeting: Location [wiki-w rev-4044057, fetched 2026-09-18]
- spell shield: false [wiki-w rev-4044057, fetched 2026-09-18]
- edge case: This ability always employs Quick cast. [wiki-w rev-4044057, fetched 2026-09-18]
- edge case: Upon first rank up, Rampant Growth gains 2 charges. [wiki-w rev-4044057, fetched 2026-09-18]
- edge case: Seeds are untargetable. [wiki-w rev-4044057, fetched 2026-09-18]
- edge case: Rampant Growth cannot be learnt at level 1. [wiki-w rev-4044057, fetched 2026-09-18]
- WITHHELD (name, cooldown, cost): Data Dragon and the wiki disagree about it on this patch, so no value is shown. This app does not know what it is — say nothing about it.

### E
- name: Grasping Roots [wiki-e rev-4013460, fetched 2026-09-18]
- cooldown: 11 [wiki-e rev-4013460, fetched 2026-09-18]
- cost: 70 / 75 / 80 / 85 / 90 [wiki-e rev-4013460, fetched 2026-09-18]
- what it does: Active: Zyra shoots a surge of vines in the target direction that deals magic damage to enemies hit and roots them for a duration. If Grasping Roots hits a Seed, it sprouts into a Vine Lasher that lasts for 8 seconds. [wiki-e rev-4013460, fetched 2026-09-18]
- damage by rank: Magic Damage: 60 / 95 / 130 / 165 / 200 (+ 60% AP) Root Duration: 1 / 1.25 / 1.5 / 1.75 / 2 seconds [wiki-e rev-4013460, fetched 2026-09-18]
- target range: 1100 • 1200 [wiki-e rev-4013460, fetched 2026-09-18]
- cast time: 0.25 [wiki-e rev-4013460, fetched 2026-09-18]
- width: 140 • 560 [wiki-e rev-4013460, fetched 2026-09-18]
- missile or dash speed: 1150 [wiki-e rev-4013460, fetched 2026-09-18]
- targeting: Direction [wiki-e rev-4013460, fetched 2026-09-18]
- damage type: Magic [wiki-e rev-4013460, fetched 2026-09-18]
- spell shield: True [wiki-e rev-4013460, fetched 2026-09-18]
- edge case: This ability will cast from wherever the caster is at the end of the cast time. [wiki-e rev-4013460, fetched 2026-09-18]
- edge case: Zyra will be locked out of actions for 0.15 seconds after casting Grasping Roots. [wiki-e rev-4013460, fetched 2026-09-18]
- edge case: Each Vine Lasher will generate 2 stacks of Conqueror and 1 stack of Electrocute. [wiki-e rev-4013460, fetched 2026-09-18]

### R
- name: Stranglethorns [wiki-r rev-3945317, fetched 2026-09-18]
- cooldown: 110 / 100 / 90 [wiki-r rev-3945317, fetched 2026-09-18]
- cost: 100 [wiki-r rev-3945317, fetched 2026-09-18]
- what it does: Active: Zyra summons a monstrous thicket at the target location that deals magic damage to enemies hit as it expands. After 2 seconds, the thicket snaps upward to knock up enemies within for 1 second. Plants hit by the thicket become enraged, restoring 50% of their current health, increasing their maximum health by 50%, gaining 25% increased size and refreshing their duration while the thicket expands. Additionally they attack in a flurry, launching two shots per attack, dealing 「 150% damage per flurry. 」「 75% damage per shot. 」 [wiki-r rev-3945317, fetched 2026-09-18]
- damage by rank: Magic Damage: 200 / 300 / 400 (+ 70% AP) [wiki-r rev-3945317, fetched 2026-09-18]
- target range: 700 [wiki-r rev-3945317, fetched 2026-09-18]
- cast time: 0.25 [wiki-r rev-3945317, fetched 2026-09-18]
- effect radius: 560 [wiki-r rev-3945317, fetched 2026-09-18]
- targeting: Location [wiki-r rev-3945317, fetched 2026-09-18]
- damage type: Magic [wiki-r rev-3945317, fetched 2026-09-18]
- spell shield: True [wiki-r rev-3945317, fetched 2026-09-18]
- edge case: Plants grown during the 2 seconds prior to the displacement will also be enraged. [wiki-r rev-3945317, fetched 2026-09-18]
- edge case: Plants already grown before Stranglethorns is cast will have their duration refreshed if they are inside the area of effect. [wiki-r rev-3945317, fetched 2026-09-18]
- edge case: Stranglethorns' buff on Plants lasts 10 seconds, however the Plants normally die naturally after 8 seconds. [wiki-r rev-3945317, fetched 2026-09-18]

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-p: League of Legends Wiki, ability data template, revision rev-3986877, fetched 2026-09-18 — 20 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Zyra%2FGarden%20of%20Thorns&prop=text
- wiki-q: League of Legends Wiki, ability data template, revision rev-4013461, fetched 2026-09-18 — 11 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Zyra%2FDeadly%20Spines&prop=text
- wiki-w: League of Legends Wiki, ability data template, revision rev-4044057, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Zyra%2FRampant%20Growth&prop=text
- wiki-e: League of Legends Wiki, ability data template, revision rev-4013460, fetched 2026-09-18 — 15 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Zyra%2FGrasping%20Roots&prop=text
- wiki-r: League of Legends Wiki, ability data template, revision rev-3945317, fetched 2026-09-18 — 14 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Zyra%2FStranglethorns&prop=text
