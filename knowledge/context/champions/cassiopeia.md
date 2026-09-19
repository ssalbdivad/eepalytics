## CASSIOPEIA — FETCHED FACTS (copied from the sources named on each line)

Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap.

### Identity
- title: The Serpent's Embrace [wikiModule raw@2026-09-18, fetched 2026-09-18]
- resource: Mana [wikiModule raw@2026-09-18, fetched 2026-09-18]
- melee or ranged: Ranged [wikiModule raw@2026-09-18, fetched 2026-09-18]
- positions Riot's client lists: Middle [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released in patch: V1.0.0.107 [wikiModule raw@2026-09-18, fetched 2026-09-18]
- last changed in patch: V26.18 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Base stats
- base stat: hp_base 630, hp_lvl 98, mp_base 480, mp_lvl 40, arm_base 18, arm_lvl 4.7, mr_base 32, mr_lvl 1.3, hp5_base 5.5, hp5_lvl 0.5, mp5_base 8, mp5_lvl 0.8, dam_base 53, dam_lvl 3, as_base 0.647, as_lvl 1.5, range 550, ms 335 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Passive
- name: Serpentine Grace [wiki-p rev-4060357, fetched 2026-09-18]
- what it does: Innate: Cassiopeia increases the effectiveness of all movement speed bonuses by 5% – 36% (based on level). [wiki-p rev-4060357, fetched 2026-09-18]
- targeting: Passive [wiki-p rev-4060357, fetched 2026-09-18]

### Q
- name: Noxious Blast [wiki-q rev-4060358, fetched 2026-09-18]
- cooldown: 3.5 [wiki-q rev-4060358, fetched 2026-09-18]
- cost: 50 / 55 / 60 / 65 / 70 [wiki-q rev-4060358, fetched 2026-09-18]
- what it does: Active: Cassiopeia creates a blast at the target location that explodes after a 0.4-second delay. Enemies within the blast are poisoned for 3 seconds, taking magic damage every 0.429 seconds over the duration. If Noxious Blast hits an enemy champion, Cassiopeia gains bonus movement speed that decays over 3 seconds. [wiki-q rev-4060358, fetched 2026-09-18]
- damage by rank: Total Magic Damage: 65 / 100 / 135 / 170 / 205 (+ 75% AP) Magic Damage Per Tick: 9.29 / 14.29 / 19.29 / 24.29 / 29.29 (+ 10.71% AP) · Bonus Movement Speed: 30 / 35 / 40 / 45 / 50% [wiki-q rev-4060358, fetched 2026-09-18]
- target range: 850 [wiki-q rev-4060358, fetched 2026-09-18]
- cast time: 0.25 [wiki-q rev-4060358, fetched 2026-09-18]
- effect radius: 200 [wiki-q rev-4060358, fetched 2026-09-18]
- targeting: Location [wiki-q rev-4060358, fetched 2026-09-18]
- damage type: Magic [wiki-q rev-4060358, fetched 2026-09-18]
- spell shield: True [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: Noxious Blast always uses quick cast, regardless of player settings. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: The damage inflicted by Noxious Blast is calculated as follows: damage / 7 ticks rounded down to the nearest integer. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: For example: with 0 bonus AP Noxious Blast inflicts 75 damages over 7 ticks of damage, so 75/7 (≈10.71) deals first of all 10 damage, then (2 × 75/7) − 10 (≈11.43) deals in a second time 11 damages, then (3 × 75/7) − 10 − 11 (≈11.14) deals in a third time 11 damages, and so on. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: The damage displayed for Noxious Blast DOT (Damage_over_time) always remains constant and corresponds to the previously mentioned formula: damage / 7 ticks rounded down to the nearest integer. It's important not to confuse the consistent displayed damage with the actual damage, which is updated with each tick, see tick and updates. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: With the same example as above, the damage displayed is always 10. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: Occasionally, Noxious Blast may not deal the displayed damage. This discrepancy occurs when the calculated damage falls between 0.5 and 1. In such cases, rounding to the nearest integer, specifically rounding up, creates a 1-point difference. It's important to note that the damage is rounded down to the nearest integer. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: For example: with a Blasting Wand's, Noxious Blast shows so rounded to the nearest integer 116 magic damage, but really deals using the formula above 115 magic damage. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: (bug) When Cassiopeia has precisely 20 bonus AP or 40 bonus AP. In this scenario, Noxious Blast may inflict 1 less damage than intended. Importantly, this bug occurs independently of rounding considerations. [wiki-q rev-4060358, fetched 2026-09-18]
- edge case: PENDING FOR TEST: Enemies within the blast of Noxious Blast are poisoned for something between 3.2 and 3.3 seconds. [wiki-q rev-4060358, fetched 2026-09-18]

### W
- name: Miasma [wiki-w rev-3936292, fetched 2026-09-18]
- cooldown: 24 / 22 / 20 / 18 / 16 [wiki-w rev-3936292, fetched 2026-09-18]
- cost: 70 / 75 / 80 / 85 / 90 [wiki-w rev-3936292, fetched 2026-09-18]
- what it does: Active: Cassiopeia spews forth 7 bolts of venom in an arc at the target location, creating toxic clouds at the area for 5 seconds. Enemies within the clouds are poisoned to take magic damage every 0.263 seconds and become grounded and slowed by an amount that decays over the area's duration. [wiki-w rev-3936292, fetched 2026-09-18]
- damage by rank: Magic Damage Per Second: 20 / 25 / 30 / 35 / 40 (+ 10% AP) Total Magic Damage: 100 / 125 / 150 / 175 / 200 (+ 50% AP) Slow: 40 / 50 / 60 / 70 / 80% [wiki-w rev-3936292, fetched 2026-09-18]
- target range: 700 [wiki-w rev-3936292, fetched 2026-09-18]
- cast time: 0.25 [wiki-w rev-3936292, fetched 2026-09-18]
- effect radius: 200 [wiki-w rev-3936292, fetched 2026-09-18]
- missile speed: 3000 [wiki-w rev-3936292, fetched 2026-09-18]
- targeting: Location [wiki-w rev-3936292, fetched 2026-09-18]
- damage type: Magic [wiki-w rev-3936292, fetched 2026-09-18]
- spell shield: False [wiki-w rev-3936292, fetched 2026-09-18]
- edge case: Miasma's slow and ground debuffs are each marked as non-dispellable, so they are not removed by most cleanses. Each is however allowed to be removed by cleanses that also grant immunity to the debuff type, such as Olaf's Ragnarok. [wiki-w rev-3936292, fetched 2026-09-18]
- edge case: If a target becomes untargetable while affected by the ground, the debuff will refresh to 0.25 seconds. [wiki-w rev-3936292, fetched 2026-09-18]
- edge case: Wind Wall will block the portion of Miasma it destroys. [wiki-w rev-3936292, fetched 2026-09-18]
- edge case: Miasma inflicts 5 / 6.25 / 7.5 / 8.75 / 10 (+ 2.5% AP) magic damage per tick, and in fact because there is 19 ticks and not 20 ticks, the total magic damage is currently not 100 / 125 / 150 / 175 / 200 (+ 50% AP) but 95 / 118.75 / 142.5 / 166.25 / 190 (+ 47.5% AP). [wiki-w rev-3936292, fetched 2026-09-18]
- edge case: Sometimes Miasma randomly inflicts only 18 ticks of damage.(bug) [wiki-w rev-3936292, fetched 2026-09-18]

### E
- name: Twin Fang [wiki-e rev-4060419, fetched 2026-09-18]
- cooldown: 0.75 [wiki-e rev-4060419, fetched 2026-09-18]
- cost: 45 [wiki-e rev-4060419, fetched 2026-09-18]
- what it does: Active: Cassiopeia launches her fangs at the target enemy that deal 50 – 120 (based on level) (+ 20% AP) magic damage. If this kills the target, Twin Fang's mana cost is refunded. Against a poisoned target, Twin Fang deals bonus magic damage and heals Cassiopeia. The heal is reduced by 75% against minions and small and medium monsters. [wiki-e rev-4060419, fetched 2026-09-18]
- damage by rank: Bonus Magic Damage: 20 / 45 / 70 / 95 / 120 (+ 45% AP) Total Enhanced Damage: 50 – 118 (based on level) (+ 20 / 45 / 70 / 95 / 120) (+ 65% AP) Heal: 10 / 11.5 / 13 / 14.5 / 16% AP Reduced Heal: 2.5 / 2.875 / 3.25 / 3.625 / 4% AP [wiki-e rev-4060419, fetched 2026-09-18]
- target range: 700 [wiki-e rev-4060419, fetched 2026-09-18]
- cast time: 0.125 [wiki-e rev-4060419, fetched 2026-09-18]
- missile speed: 2500 [wiki-e rev-4060419, fetched 2026-09-18]
- targeting: Unit [wiki-e rev-4060419, fetched 2026-09-18]
- damage type: Magic [wiki-e rev-4060419, fetched 2026-09-18]
- spell shield: True [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: Upon reaching the target, Twin Fang will wait for an ongoing Noxious Blast to explode before dealing its damage. [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: Twin Fang's damage against poisoned targets: [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: When maxed first: 72 – 220 (based on level) (+ 65% AP). [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: When maxed second: 72 – 220 (based on level) (+ 65% AP). [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: When maxed last: 72 – 220 (based on level) (+ 65% AP). [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: Twin Fang's cast indicator is incorrectly adding her own radius to the range like an edge range ability, and is therefore slightly larger than the actual cast range Twin Fang can cast at. [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: Using Twin Fang on an out-of-range target after completing a movement order causes Cassiopeia to move back to her original location after casting, if no other order is issued during the entire process.(unexpected) [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: This may be a consequence of Twing Fang being a "Walk in range of the target" ability that does not interrupt movement commands. [wiki-e rev-4060419, fetched 2026-09-18]
- edge case: If the target becomes untargetable, dies, or is too far away or no longer in sight during the cast time, this ability will cancel but does not go on cooldown nor pay its cost (if applicable). [wiki-e rev-4060419, fetched 2026-09-18]

### R
- name: Petrifying Gaze [wiki-r rev-4060360, fetched 2026-09-18]
- cooldown: 120 / 100 / 80 [wiki-r rev-4060360, fetched 2026-09-18]
- cost: 100 [wiki-r rev-4060360, fetched 2026-09-18]
- what it does: Active: Cassiopeia blasts enemies in a cone in the target direction, dealing magic damage to enemies struck within and slowing them by 40% for 2 seconds. Enemies with their facing direction towards her are instead stunned for the same duration. [wiki-r rev-4060360, fetched 2026-09-18]
- damage by rank: Magic Damage: 125 / 225 / 325 (+ 75% AP) [wiki-r rev-4060360, fetched 2026-09-18]
- cast time: 0.5 [wiki-r rev-4060360, fetched 2026-09-18]
- effect radius: 850 [wiki-r rev-4060360, fetched 2026-09-18]
- targeting: Direction [wiki-r rev-4060360, fetched 2026-09-18]
- damage type: Magic [wiki-r rev-4060360, fetched 2026-09-18]
- spell shield: True [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: This ability will cast from wherever the caster is at the end of the cast time. [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: Regarding Petrifying Gaze applying the stun, facing Cassiopeia means facing the opposite general direction (angle) as her; this direction bisects an 180 degree arc of a radius through her and her enemy. In other words, effectively, she must be "looking" toward the enemy. [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: Cassiopeia will turn to face the target direction over the cast time. [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: Petrifying Gaze's target direction will change if Cassiopeia's facing direction changes during the cast time (i.e. through knockbacks). [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: The visual effect will not follow changes in Cassiopeia's facing direction and may not portray Petrifying Gaze's target direction accurately.(bug) [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: The facing direction of champions whose abilities/animations cause them to lock their facing or spin is always the direction they are moving in. For abilities that cause the champion to spin in place (e.g. Death Lotus, Judgment) it will factor the direction they were facing on cast. [wiki-r rev-4060360, fetched 2026-09-18]
- edge case: Lucian's The Culling is an exception and his facing direction is actually considered to be the direction he is facing. [wiki-r rev-4060360, fetched 2026-09-18]

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-p: League of Legends Wiki, ability data template, revision rev-4060357, fetched 2026-09-18 — 3 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Cassiopeia%2FSerpentine%20Grace&prop=text
- wiki-q: League of Legends Wiki, ability data template, revision rev-4060358, fetched 2026-09-18 — 20 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Cassiopeia%2FNoxious%20Blast&prop=text
- wiki-w: League of Legends Wiki, ability data template, revision rev-3936292, fetched 2026-09-18 — 17 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Cassiopeia%2FMiasma&prop=text
- wiki-e: League of Legends Wiki, ability data template, revision rev-4060419, fetched 2026-09-18 — 20 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Cassiopeia%2FTwin%20Fang&prop=text
- wiki-r: League of Legends Wiki, ability data template, revision rev-4060360, fetched 2026-09-18 — 17 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Cassiopeia%2FPetrifying%20Gaze&prop=text
