## JAX — FETCHED FACTS (copied from the sources named on each line)

Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap.

### Identity
- title: Grandmaster at Arms [wikiModule raw@2026-09-18, fetched 2026-09-18]
- resource: Mana [wikiModule raw@2026-09-18, fetched 2026-09-18]
- melee or ranged: Melee [wikiModule raw@2026-09-18, fetched 2026-09-18]
- positions Riot's client lists: Top, Jungle [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released in patch: Alpha Week 2 [wikiModule raw@2026-09-18, fetched 2026-09-18]
- last changed in patch: V26.12 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Base stats
- base stat: hp_base 650, hp_lvl 103, mp_base 339, mp_lvl 52, arm_base 36, arm_lvl 4.2, mr_base 32, mr_lvl 2.05, hp5_base 8.5, hp5_lvl 0.55, mp5_base 8.2, mp5_lvl 0.7, dam_base 68, dam_lvl 4.25, as_base 0.638, as_lvl 3.4, range 125, ms 350 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### Passive
- name: Relentless Assault [wiki-p rev-4038387, fetched 2026-09-18]
- what it does: Innate: Jax's basic attacks generate a stack of Relentless Assault on-attack for 2.5 seconds, refreshing on subsequent attacks and stacking up to 8 times. Stacks expire one by one every 0.25 seconds when the duration ends. Relentless Assault: For each stack, Jax gains 5% – 12.5% (based on level) bonus attack speed, up to a maximum of 40% – 100% (based on level). Grandmaster at Angling: While out-of-combat with champions and idle in the river for 10 seconds, Jax will occasionally catch a fish, granting him 1 and 1 ability power for 5 seconds. He catches a fish at an average rate of one every 15 seconds. He also has a 5% chance to catch a rare fish that grants 10 and 10 ability power for 5 seconds. [wiki-p rev-4038387, fetched 2026-09-18]
- targeting: Passive [wiki-p rev-4038387, fetched 2026-09-18]
- edge case: Jax will start fishing while idle in the river if he is in-combat with only monsters (e.g. Epic monsters).(bug) [wiki-p rev-4038387, fetched 2026-09-18]
- edge case: Jax catching a fish is a random event and will play a special animation. [wiki-p rev-4038387, fetched 2026-09-18]
- edge case: The total number of fish caught during the game is displayed when fishing as Grandmaster at Angling passive. [wiki-p rev-4038387, fetched 2026-09-18]
- edge case: Relentless Assault uses its old icon in the Death Recap. [wiki-p rev-4038387, fetched 2026-09-18]

### Q
- name: Leap Strike [wiki-q rev-4026413, fetched 2026-09-18]
- cooldown: 8 / 7.5 / 7 / 6.5 / 6 [wiki-q rev-4026413, fetched 2026-09-18]
- cost: 50 [wiki-q rev-4026413, fetched 2026-09-18]
- what it does: Active: Jax dashes to the target unit's location. If the target is an enemy and they are in range upon arrival, Jax deals physical damage to them. Jax can cast any of his abilities during the dash. [wiki-q rev-4026413, fetched 2026-09-18]
- damage by rank: Physical Damage: 65 / 105 / 145 / 185 / 225 (+ 100% bonus AD) [wiki-q rev-4026413, fetched 2026-09-18]
- target range: 700 [wiki-q rev-4026413, fetched 2026-09-18]
- cast time: false [wiki-q rev-4026413, fetched 2026-09-18]
- targeting: Unit [wiki-q rev-4026413, fetched 2026-09-18]
- damage type: physical [wiki-q rev-4026413, fetched 2026-09-18]
- spell shield: true [wiki-q rev-4026413, fetched 2026-09-18]
- edge case: Leap Strike cannot be cast on structures. [wiki-q rev-4026413, fetched 2026-09-18]
- edge case: If the target is an enemy champion, Jax will be ordered to basic attack them after the dash ends. [wiki-q rev-4026413, fetched 2026-09-18]
- edge case: Spell shield will block the damage, including when empowered. [wiki-q rev-4026413, fetched 2026-09-18]

### W
- name: Empower [wiki-w rev-3973571, fetched 2026-09-18]
- cooldown: 7 / 6 / 5 / 4 / 3 [wiki-w rev-3973571, fetched 2026-09-18]
- cost: 30 [wiki-w rev-3973571, fetched 2026-09-18]
- what it does: Active: Jax empowers his next basic attack or Leap Strike against an enemy within 10 seconds to deal additional magic damage, reduced to 50% against structures. If Empower is used on a basic attack, it will gain 50 bonus range and have an uncancellable windup. Empower resets Jax's basic attack timer. [wiki-w rev-3973571, fetched 2026-09-18]
- damage by rank: Additional Magic Damage: 50 / 85 / 120 / 155 / 190 (+ 60% AP) [wiki-w rev-3973571, fetched 2026-09-18]
- cast time: none [wiki-w rev-3973571, fetched 2026-09-18]
- targeting: Auto [wiki-w rev-3973571, fetched 2026-09-18]
- damage type: magic [wiki-w rev-3973571, fetched 2026-09-18]
- spell shield: true [wiki-w rev-3973571, fetched 2026-09-18]
- edge case: Empower is applied in a separate damage instance from Jax's basic attacks. [wiki-w rev-3973571, fetched 2026-09-18]
- edge case: This causes effects like Bone Plating to be applied twice.(unexpected) [wiki-w rev-3973571, fetched 2026-09-18]

### E
- name: Counter Strike [wiki-e rev-4026415, fetched 2026-09-18]
- cooldown: 17 / 15 / 13 / 11 / 9 [wiki-e rev-4026415, fetched 2026-09-18]
- cost: 50 / 60 / 70 / 80 / 90 [wiki-e rev-4026415, fetched 2026-09-18]
- what it does: Active: Jax enters Evasion for 2 seconds: a defensive stance that causes him to dodge all incoming non- turret basic attacks and take 25% reduced damage from all area of effect abilities sourced from champions. Counter Strike can be recast after 1 second, and does so automatically after the duration. Recast: Jax deals magic damage to nearby enemies, with the total damage increased by 20% for each attack dodged, up to a 100% increase, and stuns them for 1 second. [wiki-e rev-4026415, fetched 2026-09-18]
- damage by rank: Minimum Magic Damage: 40 / 70 / 100 / 130 / 160 (+ 70% AP) (+ 4% of target's maximum health) Maximum Magic Damage: 80 / 140 / 200 / 260 / 320 (+ 140% AP) (+ 8% of target's maximum health) [wiki-e rev-4026415, fetched 2026-09-18]
- cast time: None [wiki-e rev-4026415, fetched 2026-09-18]
- effect radius: 375 [wiki-e rev-4026415, fetched 2026-09-18]
- targeting: Auto [wiki-e rev-4026415, fetched 2026-09-18]
- damage type: magic [wiki-e rev-4026415, fetched 2026-09-18]
- spell shield: True [wiki-e rev-4026415, fetched 2026-09-18]
- edge case: The initial cast and the manual recast count as ability activations for the purposes of on-cast effects such as Spellblade and triggering Force Pulse's passive. [wiki-e rev-4026415, fetched 2026-09-18]
- edge case: Counter Strike will also dodge abilities that can trigger on-hit effects ( Parrrley, Mystic Shot) which will count towards Counter Strike's increased damage. There are exceptions of abilities that Counter Strike will not dodge but will dodge the damage from on-hit effects that they trigger ( Alpha Strike, Piercing Darkness). [wiki-e rev-4026415, fetched 2026-09-18]
- edge case: The damage based on the target's maximum health is capped at 9000 against monsters. This is a placeholder value and impossible to reach because it requires a monster to have over 128571 health. [wiki-e rev-4026415, fetched 2026-09-18]

### R
- name: Grandmaster-at-Arms [wiki-r rev-3973573, fetched 2026-09-18]
- cooldown: 110 / 100 / 90 [wiki-r rev-3973573, fetched 2026-09-18]
- cost: 100 [wiki-r rev-3973573, fetched 2026-09-18]
- what it does: Passive: Jax's basic attacks generate a stack of Grandmaster-at-Arms on-hit for 2.5 seconds, refreshing on subsequent hits and stacking up to 2 times. At 2 stacks, his next basic attack on-hit is empowered to have an uncancellable windup and consume all stacks to deal additional magic damage, reduced to 50% against structures. While Grandmaster-at-Arms is active, the empowered attack triggers at 1 stack instead. Active: Jax swings his lantern around, dealing magic damage to nearby enemies. If this hits a champion, he gains bonus armor, increased for each champion hit beyond the first, and bonus magic resistance equal to 60% of that amount as well as 10% increased size for 8 seconds. Jax can move during Grandmaster-at-Arms' cast time. [wiki-r rev-3973573, fetched 2026-09-18]
- damage by rank: Additional Magic Damage: 75 / 130 / 185 (+ 60% AP) · Magic Damage: 100 / 175 / 250 (+ 100% AP) Bonus Armor: 45 / 60 / 75 (+ 40% bonus AD) Bonus Magic Resistance: 27 / 36 / 45 (+ 24% bonus AD) Bonus Armor per Champion Hit: 20 / 25 / 30 (+ 10% bonus AD) Bonus Magic Resistance per Champion Hit: 12 / 15 / 18 (+ 6% bonus AD) [wiki-r rev-3973573, fetched 2026-09-18]
- cast time: 0.25 [wiki-r rev-3973573, fetched 2026-09-18]
- effect radius: 375 [wiki-r rev-3973573, fetched 2026-09-18]
- targeting: Auto [wiki-r rev-3973573, fetched 2026-09-18]
- damage type: Magic [wiki-r rev-3973573, fetched 2026-09-18]
- spell shield: special [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: The on-hit deals proc damage. The swing deals area damage. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: The bonus resistances are represented by a glowing aura around Jax that grows with each enemy champion hit beyond the first. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: The additional magic damage can be dodged and blocked but it cannot miss. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: Spell shield will only block the additional damage from the third attack if it is empowered. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: The empowered attack will trigger but not be consumed nor apply its effects against wards. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: Stacks will still be generated when attacking them. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: The empowered attack is applied in a separate damage instance from Jax's basic attacks. [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: This causes effects like Bone Plating to be applied twice.(unexpected) [wiki-r rev-3973573, fetched 2026-09-18]
- edge case: This ability will cast from wherever the caster is at the end of the cast time. [wiki-r rev-3973573, fetched 2026-09-18]

### What real games did this patch — counts, not advice
- win rate this patch: 49.06% (n=1,700 games, emerald_plus) [opgg 16.18, fetched 2026-09-18]
- skill order: E > W > Q > W > W > R > W > E > W > E > R > E > E > Q > Q (n=475 games, 304 wins, emerald_plus) [opgg 16.18, fetched 2026-09-18]

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-p: League of Legends Wiki, ability data template, revision rev-4038387, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Jax%2FRelentless%20Assault&prop=text
- wiki-q: League of Legends Wiki, ability data template, revision rev-4026413, fetched 2026-09-18 — 13 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Jax%2FLeap%20Strike&prop=text
- wiki-w: League of Legends Wiki, ability data template, revision rev-3973571, fetched 2026-09-18 — 11 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Jax%2FEmpower&prop=text
- wiki-e: League of Legends Wiki, ability data template, revision rev-4026415, fetched 2026-09-18 — 13 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Jax%2FCounter%20Strike&prop=text
- wiki-r: League of Legends Wiki, ability data template, revision rev-3973573, fetched 2026-09-18 — 19 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Jax%2FGrandmaster-at-Arms&prop=text
- opgg: op.gg, revision 16.18, fetched 2026-09-18 — 2 lines — https://lol-api-champion.op.gg/api/na/champions/ranked/jax/jungle?tier=emerald_plus
