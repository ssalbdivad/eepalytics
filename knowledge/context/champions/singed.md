## SINGED — FETCHED FACTS (copied from the sources named on each line)

Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap.

### Identity
- title: the Mad Chemist [wikiModule raw@2026-09-18, fetched 2026-09-18]
- resource: Mana [wikiModule raw@2026-09-18, fetched 2026-09-18]
- melee or ranged: Melee [wikiModule raw@2026-09-18, fetched 2026-09-18]
- positions Riot's client lists: Top [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released / last changed: April 18, 2009 Patch [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released / last changed: V26.07 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Base stats
- base stat: hp_base 650, hp_lvl 96, mp_base 330, mp_lvl 45, arm_base 34, arm_lvl 4.2, mr_base 32, mr_lvl 2.05, hp5_base 9.5, hp5_lvl 0.55, mp5_base 7.5, mp5_lvl 0.55, dam_base 63, dam_lvl 3.4, as_base 0.7, as_lvl 1.9, range 125, ms 345 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Passive
- name: Noxious Slipstream [wiki-p rev-3985843, fetched 2026-09-18]
- what it does: Innate: Whenever Singed moves near a champion, he gains a stack of Noxious Slipstream for 2 seconds, refreshing on subsequent passes and stacking up to 25 times. Noxious Slipstream: For each stack, Singed gains 25% bonus movement speed, up to a maximum of 625%. This effect cannot occur on the same target more than once every few seconds. [wiki-p rev-3985843, fetched 2026-09-18]
- effect radius: 225 [wiki-p rev-3985843, fetched 2026-09-18]
- targeting: Passive [wiki-p rev-3985843, fetched 2026-09-18]

### Q
- what it does: Toggle: Singed continually creates a toxic cloud in his wake that lingers for 3.25 seconds. The cloud inflicts poison to enemies within. Poison Trail is toggled off automatically if Singed becomes unable to pay its mana cost. poison: The target takes magic damage every 0.25 seconds over 2 seconds as well as upon being hit if not currently affected. Subsequent inflictions refresh the duration. Singed earns the kill credit of enemy minions that are poisoned and would die to the damage of allied minions within the time before the next damage instance. [wiki-q rev-4006737, fetched 2026-09-18]
- targeting: Auto [wiki-q rev-4006737, fetched 2026-09-18]
- damage type: Magic [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: Toggled abilities do not count as ability activations for the purposes of on-cast effects such as Spellblade and triggering Force Pulse's passive. [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: When Poison Trail's debuff is applied instead of refreshed, the target is dealt one additional instance of the debuff at the same time as the application. This is done by delaying the actual debuff by 0.1 seconds. [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: If the target is already affected by the debuff, its duration is refreshed to the maximum (2 seconds). [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: While active after spawning, a cloud checks for valid targets who remain in or re-enter a cloud every 0.25 seconds. [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: Valid targets already afflicted with the poison will have their debuff's duration refreshed every 0.25 seconds if applicable. [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: If Singed has moved fewer than 90 units since spawning the last poison cloud, it will spawn 35 units in front of him. They also only spawn every 1 second in this case. [wiki-q rev-4006737, fetched 2026-09-18]
- edge case: When Singed is moving faster than that, the poison clouds spawn more frequently and on top of himself. [wiki-q rev-4006737, fetched 2026-09-18]

### W
- name: Mega Adhesive [wiki-w rev-4001677, fetched 2026-09-18]
- cooldown: 17 / 16 / 15 / 14 / 13 [wiki-w rev-4001677, fetched 2026-09-18]
- cost: 60 / 70 / 80 / 90 / 100 [wiki-w rev-4001677, fetched 2026-09-18]
- what it does: Active: Singed spills a potent adhesive that lands at the target location after 0.375 seconds, creating a field for 3 seconds that grounds enemies within and slows them. [wiki-w rev-4001677, fetched 2026-09-18]
- damage by rank: Slow: 50 / 55 / 60 / 65 / 70% [wiki-w rev-4001677, fetched 2026-09-18]
- target range: 1000 [wiki-w rev-4001677, fetched 2026-09-18]
- cast time: 0.25 [wiki-w rev-4001677, fetched 2026-09-18]
- effect radius: 265 [wiki-w rev-4001677, fetched 2026-09-18]
- targeting: Location [wiki-w rev-4001677, fetched 2026-09-18]
- spell shield: false [wiki-w rev-4001677, fetched 2026-09-18]
- edge case: The goo missile is a projectile. It has a fixed travel time but is independent from when the zone is established. It is destructible by effects such as Wind Wall and will destroy item spell shields if the goo missile is thrown past an enemy champion. [wiki-w rev-4001677, fetched 2026-09-18]
- edge case: Mega Adhesive's slow and ground debuffs are each marked as non-dispellable, so they are not removed by most cleanses. Each is however allowed to be removed by cleanses that also grant immunity to the debuff type, such as Olaf's Ragnarok. [wiki-w rev-4001677, fetched 2026-09-18]

### E
- name: Fling [wiki-e rev-4026605, fetched 2026-09-18]
- cooldown: 10 / 9.5 / 9 / 8.5 / 8 [wiki-e rev-4026605, fetched 2026-09-18]
- cost: 60 / 70 / 80 / 90 / 100 [wiki-e rev-4026605, fetched 2026-09-18]
- what it does: Active: Singed flings the target enemy 550 units over himself over 0.693 seconds, dealing magic damage. The damage based on the target's health ratio is capped at 300 against minions and monsters. If the target lands on Mega Adhesive's area of effect after the displacement, they are rooted for a duration. [wiki-e rev-4026605, fetched 2026-09-18]
- damage by rank: Magic Damage: 50 / 60 / 70 / 80 / 90 (+ 6 / 6.5 / 7 / 7.5 / 8% of target's maximum health) (+ 55% AP) · Root Duration: 1 / 1.25 / 1.5 / 1.75 / 2 seconds [wiki-e rev-4026605, fetched 2026-09-18]
- target range: 125 [wiki-e rev-4026605, fetched 2026-09-18]
- cast time: 0.25 [wiki-e rev-4026605, fetched 2026-09-18]
- targeting: Unit [wiki-e rev-4026605, fetched 2026-09-18]
- damage type: Magic [wiki-e rev-4026605, fetched 2026-09-18]
- spell shield: True [wiki-e rev-4026605, fetched 2026-09-18]
- edge case: During Fling cast time (the windup not during the actual fling) the enemy's flash is already locked, making it a non reactable spell. [wiki-e rev-4026605, fetched 2026-09-18]
- edge case: Fling can throw enemies over walls (circumstances permitting). [wiki-e rev-4026605, fetched 2026-09-18]
- edge case: Slow-immune enemies will not be rooted when flung into Mega Adhesive. [wiki-e rev-4026605, fetched 2026-09-18]
- edge case: Fling is special cased to not fling Warwick while Singed is suppressed by Infinite Duress after the cast time. [wiki-e rev-4026605, fetched 2026-09-18]
- edge case: If the target becomes untargetable, dies, or is too far away or no longer in sight during the cast time, this ability will cancel but does not go on cooldown nor pay its cost (if applicable). [wiki-e rev-4026605, fetched 2026-09-18]

### R
- name: Insanity Potion [wiki-r rev-4005000, fetched 2026-09-18]
- cooldown: 100 [wiki-r rev-4005000, fetched 2026-09-18]
- cost: 100 [wiki-r rev-4005000, fetched 2026-09-18]
- what it does: Active: Singed empowers himself for 25 seconds with ability power, bonus armor, bonus magic resistance, bonus movement speed, bonus health regeneration, and bonus mana regeneration. During this time, Poison Trail additionally applies Grievous Wounds for 1 second, which refreshes every 0.25 seconds while the poison persists. [wiki-r rev-4005000, fetched 2026-09-18]
- damage by rank: Bonus Stats: 25 / 55 / 85 HP/Mana Regenerated per 0.5 Seconds: 2.5 / 5.5 / 8.5 Total HP/Mana Regenerated over the duration: 125 / 275 / 425 [wiki-r rev-4005000, fetched 2026-09-18]
- cast time: none [wiki-r rev-4005000, fetched 2026-09-18]
- targeting: Auto [wiki-r rev-4005000, fetched 2026-09-18]
- edge case: No additional notes. [wiki-r rev-4005000, fetched 2026-09-18]

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-p: League of Legends Wiki, ability data template, revision rev-3985843, fetched 2026-09-18 — 4 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Singed%2FNoxious%20Slipstream&prop=text
- wiki-q: League of Legends Wiki, ability data template, revision rev-4006737, fetched 2026-09-18 — 10 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Singed%2FPoison%20Trail&prop=text
- wiki-w: League of Legends Wiki, ability data template, revision rev-4001677, fetched 2026-09-18 — 12 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Singed%2FMega%20Adhesive&prop=text
- wiki-e: League of Legends Wiki, ability data template, revision rev-4026605, fetched 2026-09-18 — 15 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Singed%2FFling&prop=text
- wiki-r: League of Legends Wiki, ability data template, revision rev-4005000, fetched 2026-09-18 — 8 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Singed%2FInsanity%20Potion&prop=text
