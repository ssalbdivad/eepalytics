## MASTER YI — FETCHED FACTS (copied from the sources named on each line)

Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap.

### Identity
- title: The Wuju Bladesman [wikiModule raw@2026-09-18, fetched 2026-09-18]
- resource: Mana [wikiModule raw@2026-09-18, fetched 2026-09-18]
- melee or ranged: Melee [wikiModule raw@2026-09-18, fetched 2026-09-18]
- positions Riot's client lists: Jungle [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released in patch: Alpha Week 2 [wikiModule raw@2026-09-18, fetched 2026-09-18]
- last changed in patch: V26.18 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Base stats
- base stat: hp_base 640, hp_lvl 105, mp_base 251, mp_lvl 42, arm_base 33, arm_lvl 5, mr_base 32, mr_lvl 2.05, hp5_base 7.5, hp5_lvl 0.65, mp5_base 7.25, mp5_lvl 0.45, dam_base 65, dam_lvl 2.5, as_base 0.679, as_lvl 2.5, range 175, ms 355 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Passive
- name: Double Strike [wiki-p rev-4057839, fetched 2026-09-18]
- what it does: Innate: Master Yi's basic attacks on-hit generate a stack of Double Strike for 4 seconds, refreshing on subsequent hits and stacking up to 3 times. At 3 stacks, Master Yi's next basic attack on-attack is empowered to consume the stacks on-hit and strike twice, the second strike dealing 50% AD physical damage. The second strike applies on-hit effects, triggers on-attack effects, and is affected by critical strike modifiers. If Master Yi's primary target is killed before the second strike, he will automatically target another nearby enemy. The second strike can critically strike against structures. [wiki-p rev-4057839, fetched 2026-09-18]
- effect radius: 300 [wiki-p rev-4057839, fetched 2026-09-18]
- targeting: Passive [wiki-p rev-4057839, fetched 2026-09-18]
- damage type: Physical [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: The second strike separately rolls a critical strike. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: The second strike does not trigger Sundered Sky's Lightshield Strike. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: If the stacks expire during the empowered attack's first strike animation, the attack cancels and the normal basic attack windup starts. (bug) [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: Double Strike does not cause Master Yi to attack twice. Effects that trigger on completing the attack windup will only trigger once and thus do not interact with Double Strike. (e.g. Hail of Blades). [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: Since Double Strike resets the counter with the first strike, and the second strike applies on-hit effects, the second strike is able to add a stack for the next Double Strike activation. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: If Double Strike's target becomes untargetable shortly after the triggering attack, it will still occur and deal its effects as usual. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: Basic attacks that are dodged, blocked, or missed while Master Yi is blinded will not generate any stacks of Double Strike nor refresh the duration of active stacks. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: Double Strike's interaction with parry effects at 3 stacks (the damage of the strikes is negated in all cases): [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: If the triggering basic attack is dodged, Master Yi will not perform the second strike nor consume the stacks. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: If the triggering basic attack is blocked, Master Yi will perform the second strike but not consume the stacks. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: If the triggering basic attack misses while Master Yi is blinded, he will consume the stacks. [wiki-p rev-4057839, fetched 2026-09-18]
- edge case: The second strike will fail to hit the target at all if the triggering attack misses. On-attack effects do not occur, despite the attack animation playing.(bug) [wiki-p rev-4057839, fetched 2026-09-18]

### Q
- name: Alpha Strike [wiki-q rev-4032850, fetched 2026-09-18]
- cooldown: 20 / 19.5 / 19 / 18.5 / 18 [wiki-q rev-4032850, fetched 2026-09-18]
- cost: 50 / 55 / 60 / 65 / 70 [wiki-q rev-4032850, fetched 2026-09-18]
- what it does: Active: Master Yi vanishes and becomes unable to act. After 0.231 seconds, he marks the target enemy and then proceeds to mark the nearest visible un-marked enemy within 600 units, recurring every 0.231 seconds「 up to 3 times. 」「 for a total of 4 marks. 」If there are no other un-marked targets before then, Master Yi can mark the same enemies again. During Alpha Strike, Master Yi can select a direction from the primary target. Upon finishing marking, Master Yi reappears 75 units in the targeted direction, or in front of the target otherwise, and then becomes able to act again「 after 0.165 seconds. 」「 1.087 seconds total after the start of the cast with 4 bounces. 」If the primary target dies or is too far away during the delay, Master Yi will reappear at the initial cast location instead. Master Yi then detonates the marks to deal physical damage and apply on-hit effects, with on-hit damage reduced to 75% effectiveness. Marks after the first on the same target instead detonate instantly upon application to deal 25% damage and apply on-hit effects, with on-hit damage reduced to 18.75% effectiveness. Alpha Strike deals bonus physical damage to monsters per hit. Alpha Strike's primary and lesser damage can critically strike for「 (200% + 30%) damage. 」「 100% + 100% of bonus critical damage. 」 [wiki-q rev-4032850, fetched 2026-09-18]
- damage by rank: Primary Physical Damage: 20 / 40 / 60 / 80 / 100 (+ 70% AD) Reduced Damage per hit: 5 / 10 / 15 / 20 / 25 (+ 17.5% AD) Maximum Single-Target Damage: 35 / 70 / 105 / 140 / 175 (+ 122.5% AD) Primary Bonus Monster Damage: 60 / 85 / 110 / 135 / 160 Combined Primary Monster Damage: 80 / 125 / 170 / 215 / 260 (+ 70% AD) Reduced Monster Damage per hit: 20 / 31.25 / 42.5 / 53.75 / 65 (+ 17.5% AD) Max Single-Target Monster Damage: 140 / 218.75 / 297.5 / 376.25 / 455 (+ 122.5% AD) [wiki-q rev-4032850, fetched 2026-09-18]
- target range: 600 [wiki-q rev-4032850, fetched 2026-09-18]
- cast time: none [wiki-q rev-4032850, fetched 2026-09-18]
- effect radius: 600 [wiki-q rev-4032850, fetched 2026-09-18]
- targeting: Unit [wiki-q rev-4032850, fetched 2026-09-18]
- damage type: Physical [wiki-q rev-4032850, fetched 2026-09-18]
- spell shield: Special [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike's primary damage applies after Master Yi reappears. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike's cooldown reduction applies on structures. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: When Master Yi bounces from a unit it will grant vision in a 600 radius around it for up to 0.627 seconds after Alpha Strike ends, including across terrain, though not into brush. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: It will always grant vision around the primary target, even if he doesn't bounce off it. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike's damage is calculated at the moment that each mark is placed. Because of this, it is possible to inflict differing amounts of damage if Master Yi's AD changes between marks. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Master Yi will follow all his primary target's movements. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike can only follow up-to 2000 units; If the target teleports a very long distance, it will not be followed. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: While vanished, the initial cast location of Alpha Strike counts as Master Yi's position, which is considered for effects such as tethers. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: If the primary target becomes untargetable and there are no other nearby valid targets, Alpha Strike will end prematurely and will not deal the damage occurring after Master Yi's reappearance. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: The choice of exit direction occurs through an indicator anchored to the target during the time that Master Yi is vanished. You are unable to choose the exit direction after the third mark.(bug) Selection commands (default: MB1/left click) and movement commands (default: MB2/right click) are both valid. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Multiple commands can be issued, but only the final command before exiting will determine the direction. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: If the primary target is a champion, Master Yi will be automatically ordered to basic attack them after Alpha Strike ends. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Master Yi will not be able to buffer other abilities.(bug) [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Only the first instance of damage counts as a hit for effects such as Electrocute and Eclipse's Ever Rising Moon. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike does not interact with Sejuani's Permafrost. (unexpected) [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike does not stack Press the Attack as it is always tagged as dealing AoE damage. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: While basic damage on-hit can stack Conqueror multiple times regardless of cast instance, Alpha Strike is unique in that it is the only multi on-hit effect to stack just once for being a single cast instance and for not being basic damage. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Spell shield will only block a single instance of damage. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: On-hit damage applied by Alpha Strike will be negated by dodge and block, but not while Master Yi is blinded. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: Alpha Strike's own damage will not be negated. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: If Master Yi dies during Alpha Strike and he is only focusing one target, the ability will only deal the reduced damage strikes and not the final tick of damage from reappearing. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: If he is striking multiple targets the damage will be dealt immediately when dying, and if he dies before the bounce from the last target, Alpha Strike will deal reduced damage only to all units he already bounced from.(bug) [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: If Master Yi enters resurrection during Alpha Strike and he is only focusing one target, the ability will deal the reduced damage strikes as normal and the final tick of damage after being resurrected. [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: If he is striking multiple targets, Alpha Strike will sometimes deal the reduced damage from repeated bounces and the main damage after being resurrected, and sometimes only the reduced damage, unrelated to the number of targets available.(bug) [wiki-q rev-4032850, fetched 2026-09-18]
- edge case: The following table refers for interactions while Master Yi is performing Alpha Strike: [wiki-q rev-4032850, fetched 2026-09-18]
- WITHHELD (37 cells of a table in the wiki's notes): the source publishes it and it did not survive being rendered into plain text, so no value is shown. This app does not know what it is — say nothing about it.

### W
- name: Meditate [wiki-w rev-4039653, fetched 2026-09-18]
- cooldown: 10 [wiki-w rev-4039653, fetched 2026-09-18]
- cost: 40 [wiki-w rev-4039653, fetched 2026-09-18]
- what it does: Active: Master Yi channels for up to 4 seconds, healing himself every 0.5 seconds, increased by 0% – 100% (based on missing health). While channeling, Master Yi gains 70% damage reduction for the first 0.5 seconds, which is then modified to a reduced amount for the remaining duration of the channel. Meditate's damage reduction is halved against turrets and lingers for 0.5 seconds after the channel ends. Meditate resets Master Yi's basic attack timer, pauses Wuju Style's and Highlander's duration, and grants one stack of Double Strike per second during the channel. [wiki-w rev-4039653, fetched 2026-09-18]
- damage by rank: Minimum Heal Per Tick: 15 / 25 / 35 / 45 / 55 (+ 12.5% AP) Maximum Heal Per Tick: 30 / 50 / 70 / 90 / 110 (+ 25% AP) Minimum Total Heal: 120 / 200 / 280 / 360 / 440 (+ 100% AP) Maximum Total Heal: 240 / 400 / 560 / 720 / 880 (+ 200% AP) · Modified Damage Reduction: 45 / 47.5 / 50 / 52.5 / 55% Turret Modified Damage Reduction: 22.5 / 23.75 / 25 / 26.25 / 27.5% [wiki-w rev-4039653, fetched 2026-09-18]
- cast time: none [wiki-w rev-4039653, fetched 2026-09-18]
- targeting: Auto [wiki-w rev-4039653, fetched 2026-09-18]
- edge case: Meditate's healing amount updates dynamically as he heals himself, making Master Yi heal for less as his current health increases. [wiki-w rev-4039653, fetched 2026-09-18]
- edge case: The first tick of healing may occur at any moment on the first 0.5 seconds of the channel. This means immediately canceling the channel for the attack reset does not guarantee one tick of healing, though it may occur with some chance. [wiki-w rev-4039653, fetched 2026-09-18]
- edge case: The following table refers for interactions while Master Yi is channeling: [wiki-w rev-4039653, fetched 2026-09-18]
- edge case: Cast-inhibiting effects [wiki-w rev-4039653, fetched 2026-09-18]
- WITHHELD (40 cells of a table in the wiki's notes): the source publishes it and it did not survive being rendered into plain text, so no value is shown. This app does not know what it is — say nothing about it.

### E
- name: Wuju Style [wiki-e rev-3959670, fetched 2026-09-18]
- cooldown: 14 [wiki-e rev-3959670, fetched 2026-09-18]
- what it does: Active: Master Yi empowers his basic attacks within the next 5 seconds to deal bonus true damage on-hit. [wiki-e rev-3959670, fetched 2026-09-18]
- damage by rank: Bonus True Damage: 20 / 25 / 30 / 35 / 40 (+ 35% bonus AD) [wiki-e rev-3959670, fetched 2026-09-18]
- cast time: none [wiki-e rev-3959670, fetched 2026-09-18]
- targeting: Auto [wiki-e rev-3959670, fetched 2026-09-18]
- damage type: True [wiki-e rev-3959670, fetched 2026-09-18]
- edge case: Wuju Style can be cast during Alpha Strike. [wiki-e rev-3959670, fetched 2026-09-18]
- edge case: Wuju Style cannot be cast while it is already active. [wiki-e rev-3959670, fetched 2026-09-18]
- edge case: Wuju Style's bonus true damage does not interact with critical strikes. [wiki-e rev-3959670, fetched 2026-09-18]
- edge case: Wuju Style's bonus true damage cannot be blocked but can be dodged and/or missed if Master Yi is blinded. [wiki-e rev-3959670, fetched 2026-09-18]
- edge case: The attacks do not deal the bonus damage against structures. [wiki-e rev-3959670, fetched 2026-09-18]
- edge case: While Wuju Style is active, the damage will dynamically update its calculations. [wiki-e rev-3959670, fetched 2026-09-18]

### R
- name: Highlander [wiki-r rev-4060364, fetched 2026-09-18]
- cooldown: 85 [wiki-r rev-4060364, fetched 2026-09-18]
- cost: 100 [wiki-r rev-4060364, fetched 2026-09-18]
- what it does: Passive: Scoring a champion takedown reduces the current cooldowns of Master Yi's basic abilities by 70%. Active: Master Yi cleanses himself from all slows and cripples. For the next 7 seconds, he gains ghosting, bonus attack speed, bonus movement speed, slow immunity, and cripple immunity. While active, scoring a champion takedown extends Highlander's duration by 7 seconds. [wiki-r rev-4060364, fetched 2026-09-18]
- damage by rank: Bonus Attack Speed: 25 / 45 / 65% Bonus Movement Speed: 40 / 50 / 60% [wiki-r rev-4060364, fetched 2026-09-18]
- cast time: none [wiki-r rev-4060364, fetched 2026-09-18]
- targeting: Auto [wiki-r rev-4060364, fetched 2026-09-18]
- edge case: Highlander can be cast during Alpha Strike. [wiki-r rev-4060364, fetched 2026-09-18]

### What real games did this patch — counts, not advice
- win rate this patch: 49.99% (n=7,782 games, emerald_plus) [opgg 16.18, fetched 2026-09-18]
- skill order: Q > E > W > Q > Q > R > Q > E > Q > E > R > E > E > W > W (n=2,765 games, 1,635 wins, emerald_plus) [opgg 16.18, fetched 2026-09-18]

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-p: League of Legends Wiki, ability data template, revision rev-4057839, fetched 2026-09-18 — 17 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Master%20Yi%2FDouble%20Strike&prop=text
- wiki-q: League of Legends Wiki, ability data template, revision rev-4032850, fetched 2026-09-18 — 36 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Master%20Yi%2FAlpha%20Strike&prop=text
- wiki-w: League of Legends Wiki, ability data template, revision rev-4039653, fetched 2026-09-18 — 11 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Master%20Yi%2FMeditate&prop=text
- wiki-e: League of Legends Wiki, ability data template, revision rev-3959670, fetched 2026-09-18 — 13 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Master%20Yi%2FWuju%20Style&prop=text
- wiki-r: League of Legends Wiki, ability data template, revision rev-4060364, fetched 2026-09-18 — 8 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Master%20Yi%2FHighlander&prop=text
- opgg: op.gg, revision 16.18, fetched 2026-09-18 — 2 lines — https://lol-api-champion.op.gg/api/na/champions/ranked/masteryi/jungle?tier=emerald_plus
