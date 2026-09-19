## XAYAH — FETCHED FACTS (copied from the sources named on each line)

Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap.

### Identity
- title: The Rebel [wikiModule raw@2026-09-18, fetched 2026-09-18]
- resource: Mana [wikiModule raw@2026-09-18, fetched 2026-09-18]
- melee or ranged: Ranged [wikiModule raw@2026-09-18, fetched 2026-09-18]
- positions Riot's client lists: Bottom [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released in patch: V7.8 [wikiModule raw@2026-09-18, fetched 2026-09-18]
- last changed in patch: V26.16 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Base stats
- base stat: hp_base 630, hp_lvl 107, mp_base 340, mp_lvl 40, arm_base 25, arm_lvl 4.2, mr_base 33, mr_lvl 1.1, hp5_base 3.25, hp5_lvl 0.75, mp5_base 8.25, mp5_lvl 0.8, dam_base 60, dam_lvl 3.5, as_base 0.658, as_lvl 3.9, range 525, ms 330 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Passive
- name: Clean Cuts [wiki-p rev-4059261, fetched 2026-09-18]
- what it does: Innate: Feathers shot by Xayah will linger and be planted in the ground at maximum range for 6 seconds. Innate: Xayah's ability casts generate 3 stacks of Clean Cuts, lasting for 8 seconds, refreshing on subsequent casts, and stacking up to 5 times. Xayah's basic attacks are empowered to each consume a stack on-attack to instead shoot a Feather that deals the triggering attack's damage to the primary target and 35% / 45% / 55% (based on level) AD physical damage to other enemies hit. The secondary target damage can critically strike for (200% + 30%) damage if the triggering attack does. Innate - Lover's Leap: If either Xayah or Rakan is channeling Recall, the other may move nearby and channel their own to join alongside them. Both reach base at the time of which the initiator's Recall completes. [wiki-p rev-4059261, fetched 2026-09-18]
- effect radius: 1000 [wiki-p rev-4059261, fetched 2026-09-18]
- width: 120 [wiki-p rev-4059261, fetched 2026-09-18]
- missile or dash speed: 4000 [wiki-p rev-4059261, fetched 2026-09-18]
- targeting: Passive [wiki-p rev-4059261, fetched 2026-09-18]
- spell shield: False [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: Feathers will stop upon being intercepted by projectile-blocking effects. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Missile popping before and after striking the primary target. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: After striking their target, the attack will proceed in a line in the same direction it was already flying. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: If the target is more than 1000 units from Xayah when the empowered attack hits them, the attack will not keep flying in a line and drop the Feather at their location immediately. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: Unlike similar effects, the homing and line trajectories use the same missile. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: All her Feathers on the ground will be destroyed when Xayah dies, and while she is dead, missiles that are still in flight will not spawn new ones, either. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: Clean Cut's feathers will spawn even if the basic attack is blocked. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: The empowered attack will not trigger against structures nor wards. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: The duration will be refreshed when starting the attack windup against them. [wiki-p rev-4059261, fetched 2026-09-18]
- edge case: The number of Clean Cuts stacks available is represented by a feather counter in her ammo bar, visible to the player only. [wiki-p rev-4059261, fetched 2026-09-18]

### Q
- name: Double Daggers [wiki-q rev-4008615, fetched 2026-09-18]
- cooldown: 10 / 9.5 / 9 / 8.5 / 8 [wiki-q rev-4008615, fetched 2026-09-18]
- cost: 35 [wiki-q rev-4008615, fetched 2026-09-18]
- what it does: Active: Xayah barrages two Feathers in the target direction that each deal physical damage to enemies hit. Targets hit after the first take 50% reduced damage. [wiki-q rev-4008615, fetched 2026-09-18]
- damage by rank: Physical Damage Per Hit: 45 / 60 / 75 / 90 / 105 (+ 50% bonus AD) Total Physical Damage: 90 / 120 / 150 / 180 / 210 (+ 100% bonus AD) · Reduced Damage per Hit: 22.5 / 30 / 37.5 / 45 / 52.5 (+ 25% bonus AD) Total Reduced Damage: 45 / 60 / 75 / 90 / 105 (+ 50% bonus AD) [wiki-q rev-4008615, fetched 2026-09-18]
- cast time: 0.25 – 0.1 (based on bonus attack speed) [wiki-q rev-4008615, fetched 2026-09-18]
- width: 100 + offset [wiki-q rev-4008615, fetched 2026-09-18]
- targeting: Direction [wiki-q rev-4008615, fetched 2026-09-18]
- damage type: Physical [wiki-q rev-4008615, fetched 2026-09-18]
- spell shield: Special [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: Daggers shoot from Xayah's left and right side. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: Because of the usual tick intervals of the server, Double Daggers' minimum cast time is typically reached at 168.58% bonus attack speed already, for a cast time of 0.132 seconds (from the default 0.264 seconds), or the duration of 4 game ticks. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: If the first 3 game ticks happen to be slightly longer than normal, the minimum cast time of 0.1 seconds can actually be reached in very rare cases because of that. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: Xayah is unable to declare basic attacks for a set duration during the cast time of Double Daggers. The lock out duration is reduced by 「 0.007 seconds per every 1% bonus attack speed 」「 1 second per every 140% bonus attack speed 」. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: The Feathers will stop upon being intercepted by projectile-blocking effects. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: As the feathers are forming, they will deal damage in a small area around Xayah's before firing. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: Spell shield will only block a single instance of damage. [wiki-q rev-4008615, fetched 2026-09-18]
- edge case: This ability will cast from wherever the caster is at the end of the cast time. [wiki-q rev-4008615, fetched 2026-09-18]

### W
- name: Deadly Plumage [wiki-w rev-4062257, fetched 2026-09-18]
- cooldown: 18 / 17 / 16 / 15 / 14 [wiki-w rev-4062257, fetched 2026-09-18]
- cost: 60 / 55 / 50 / 45 / 40 [wiki-w rev-4062257, fetched 2026-09-18]
- what it does: Active: Xayah enters a frenzy for 4 seconds, gaining bonus attack speed and causing her basic attacks on-attack to be empowered to fire an additional smaller feather at the target on-hit that deals 25% damage of the triggering attack's damage. Whenever Xayah hits an enemy champion with the strike, she gains 30% bonus movement speed for 1.5 seconds. If Rakan is nearby upon cast, he also becomes empowered, and gains the bonus movement speed at the same time as Xayah. [wiki-w rev-4062257, fetched 2026-09-18]
- damage by rank: Bonus Attack Speed: 35 / 40 / 45 / 50 / 55% [wiki-w rev-4062257, fetched 2026-09-18]
- cast time: none [wiki-w rev-4062257, fetched 2026-09-18]
- missile or dash speed: 3000 [wiki-w rev-4062257, fetched 2026-09-18]
- targeting: Auto [wiki-w rev-4062257, fetched 2026-09-18]
- damage type: Physical [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: The additional missile is visually a smaller feather than the normal feather missiles that are fired by Xayah's basic attacks and does not technically count as a Feather for Clean Cuts. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: Upon casting, missiles that are already in flight will also be empowered to apply the additional feather, but Xayah will not be granted the bonus movement speed from their hit. (bug) [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: Since the additional missile's damage is based on a percentage of the triggering attack's damage, it will also benefit from the increased damage of triggering attacks that critically strike. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: The additional missile itself however cannot critically strike. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: Runaan's Hurricane's Wind's Fury interacts with Deadly Plumage by causing the additional bolts to fire their own additional missile that deals a percentage of the triggering bolt's damage. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: Deadly Plumage does not interact with Guinsoo's Rageblade's Phantom Hit. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: The empowered attack will not trigger against wards. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: The additional missile is not fired if the triggering basic attack misses while Xayah is blinded. [wiki-w rev-4062257, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Interactions with dodge and block. [wiki-w rev-4062257, fetched 2026-09-18]

### E
- name: Bladecaller [wiki-e rev-4002073, fetched 2026-09-18]
- cooldown: 12 / 11 / 10 / 9 / 8 [wiki-e rev-4002073, fetched 2026-09-18]
- cost: 20 [wiki-e rev-4002073, fetched 2026-09-18]
- what it does: Active: Xayah recalls all planted Feathers to shoot back to her, each dealing physical damage to enemies hit, increased by 0% – 50% (+ 0% – 15%) (based on critical strike chance). Bladecaller deals 50% damage to minions. An enemy takes 100% – 10% (based on previous feathers hit) damage from a Feather. A target hit by at least three Feathers is rooted for 1.25 seconds. A planted Feather is required to cast this ability. Enemies can be hit by an individual Feather only once per pass. [wiki-e rev-4002073, fetched 2026-09-18]
- damage by rank: Physical Damage Per Feather: 50 / 65 / 80 / 95 / 110 (+ 40% bonus AD) Minion Damage Per Feather: 25 / 32.5 / 40 / 47.5 / 55 (+ 20% bonus AD) [wiki-e rev-4002073, fetched 2026-09-18]
- cast time: none [wiki-e rev-4002073, fetched 2026-09-18]
- effect radius: Global [wiki-e rev-4002073, fetched 2026-09-18]
- width: 160 [wiki-e rev-4002073, fetched 2026-09-18]
- missile or dash speed: 4000 [wiki-e rev-4002073, fetched 2026-09-18]
- targeting: Auto [wiki-e rev-4002073, fetched 2026-09-18]
- damage type: Physical [wiki-e rev-4002073, fetched 2026-09-18]
- spell shield: special [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: Feathers that are 'in flight' will be called to Xayah too, but only once they've landed normally first. [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: Spell shield will only block a single instance of damage. [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: This ability cannot be ranked at Level 1. [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: The damage dealt by Bladecaller follows a diminishing returns formula not mentioned in the ability's description, successively reducing extra damage from feathers beyond the first. [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: This formula is: [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: For feathers <=19: Damage of one feather × (n − 0.05 × (n − 1) ÷ 2 × n) where n stands for the number of feathers hit. [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: For feathers >=20: Damage of one feather × (19 − 0.05 × (19 − 1) ÷ 2 × 19 + 0.1 × (n − 19)) where n stands for the number of feathers hit. [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: For example, at rank 1 Bladecaller deals 50 – 522.5 (based on feathers hit). [wiki-e rev-4002073, fetched 2026-09-18]
- edge case: Bladecaller cannot be cast without a Feather on the ground. [wiki-e rev-4002073, fetched 2026-09-18]

### R
- name: Featherstorm [wiki-r rev-4008617, fetched 2026-09-18]
- cooldown: 140 / 120 / 100 [wiki-r rev-4008617, fetched 2026-09-18]
- cost: 100 [wiki-r rev-4008617, fetched 2026-09-18]
- what it does: Active: Xayah leaps into the air, becoming ghosted and untargetable for 1.5 seconds. After 1 second, she shoots 5 Feathers in a cone in the target direction that deal physical damage to enemies hit. Xayah is unable to basic attack or cast abilities during Featherstorm, but can still move. [wiki-r rev-4008617, fetched 2026-09-18]
- damage by rank: Physical Damage: 200 / 300 / 400 (+ 100% bonus AD) [wiki-r rev-4008617, fetched 2026-09-18]
- cast time: none [wiki-r rev-4008617, fetched 2026-09-18]
- effect radius: 1060 • 1000 [wiki-r rev-4008617, fetched 2026-09-18]
- targeting: Direction [wiki-r rev-4008617, fetched 2026-09-18]
- damage type: Physical [wiki-r rev-4008617, fetched 2026-09-18]
- spell shield: True [wiki-r rev-4008617, fetched 2026-09-18]
- edge case: The individual missiles have 1100 range but start slightly behind Xayah, reducing their total range. [wiki-r rev-4008617, fetched 2026-09-18]
- edge case: The following table refers for interactions while Xayah is in Featherstorm: [wiki-r rev-4008617, fetched 2026-09-18]
- WITHHELD (37 cells of a table in the wiki's notes): the source publishes it and it did not survive being rendered into plain text, so no value is shown. This app does not know what it is — say nothing about it.

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-p: League of Legends Wiki, ability data template, revision rev-4059261, fetched 2026-09-18 — 17 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Xayah%2FClean%20Cuts&prop=text
- wiki-q: League of Legends Wiki, ability data template, revision rev-4008615, fetched 2026-09-18 — 18 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Xayah%2FDouble%20Daggers&prop=text
- wiki-w: League of Legends Wiki, ability data template, revision rev-4062257, fetched 2026-09-18 — 18 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Xayah%2FDeadly%20Plumage&prop=text
- wiki-e: League of Legends Wiki, ability data template, revision rev-4002073, fetched 2026-09-18 — 21 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Xayah%2FBladecaller&prop=text
- wiki-r: League of Legends Wiki, ability data template, revision rev-4008617, fetched 2026-09-18 — 12 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Xayah%2FFeatherstorm&prop=text
