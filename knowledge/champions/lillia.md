patch: 16.17
sourcedAt: 2026-09-04
source: ddragon.leagueoflegends.com 16.17.1 — Lillia.json (ability roles, cast ranges, cooldowns) and item.json (every gold figure below, Summoner's Rift entries); op.gg — Lillia jungle-paths page, patch 16.17 Emerald+, 58,515 routed games (34,502 blue side / 24,013 red side), and the Lillia jungle build page, patch 16.17 Emerald+ (win/pick/ban, starts, boots, core items, keystone, skill order); jungler.gg — Lillia champion page, which labels itself patch 26.16 (Riot numbering; one patch behind the stat sites' 16.17) for per-route win rates and the first-clear level. Carried over from the 2026-09-03 pass: the AP-jungler nerf trend in the Riot 26.17 notes. NOT sourced and deliberately absent: per-matchup win rates — op.gg and lolalytics returned contradictory matchup tables on 2026-09-04 (each listed Skarner and Nidalee on opposite sides), so no matchup number is written down here.
---

# Lillia, jungle — a lookup, not a briefing

**Read this as a set of triggers.** Each rule names a state you can actually see in the ground
truth block. If the trigger is not in this tick's block, the rule does not exist this tick.

Two things disqualify anything you build out of this file:

- **He can already see it.** His own gold, level, CS and health are on his HUD permanently.
  This file is here to say what a number he is looking at *means*, never to read it back.
- **It would have been true five minutes ago, or in a different game.** "Lillia is a scaling
  jungler, so farm up" and "Lillia's ult is her big spike" are true, useless, and banned. The
  rules below are written as triggers precisely so that they can only fire when they apply.

## Keys this file reads

From the ground truth block, available today: **clock**, **his level**, **every other player's
level** (roster), **who is dead and for how long**, **his gold**, **his CS against his own
average**, **objective back-in timers**, **the recent-event feed** (dragon type, turret, kills).

Available from the Live Client Data API and not yet in the block (`src/shared/schema/live.ts`) —
rules that need one are tagged **[needs items]**, **[needs spells]** or **[needs role]**:
**every player's full inventory**, **summoner spells**, **rune keystone**, **his own ability
levels**, **each player's true role**.

## The kit, in the only terms that matter live

*Durable. Cast ranges and cooldowns read off Data Dragon 16.17.1.*

- **Q Blooming Blows** — 450 range, 6/5.5/5/4.5/4s. Hitting anything with a spell stacks Prance
  movement speed. This is why her clear gets faster the longer it runs, and why a route broken in
  the middle costs her more than it costs a flat-rate jungler: the speed was already paid for.
- **W Watch Out! Eep!** — 500 range, 14/13/12/11/10s. The damage centre of every camp. Its
  cooldown, not his hands, is what paces the clear; walking a long way between camps wastes a W
  that was already back.
- **E Swirlseed** — 700 cast range and it *keeps rolling* until it hits something or a wall.
  A slow, a poke, and the longest-ranged thing she owns. Pre-6 it is the whole gank setup.
- **R Lilting Lullaby** — 1600 range, **150/130/110s**. It only drowsies enemies who **already
  have Dream Dust on them** — her passive, applied by hitting them with a spell. An R thrown at a
  target she has not touched is 150 seconds spent on some damage.
- **She has no dash and no blink.** Her escape is the movement speed she is currently stacking.
  Speed does not get her out of a corridor, a pit, or a tri-brush.

## Levels — what changes, and how to see it

His level and every enemy's level are both in the block. **The enemy jungler's level is not on
his screen** — reading it costs him the scoreboard — which makes it the single most useful
comparison in this file.

- **Level 2 (W online).** Before W her clear is slow and her duel is nothing. A level-2 invade
  taken or accepted at this point is the worst state she owns.
- **Level 3 (E online).** First moment she can do anything to a lane from range.
- **Level 4.** Where a six-camp full clear ends (jungler.gg's route pages, 26.16).
- **Level 6 (R, 150s).** Not "her spike" in the abstract — specifically, the first time she can
  start a fight instead of arriving at one.
- **Level 9.** Q is maxed on the standard order (op.gg 16.17: `Q W E Q Q R Q W Q W R W W E E`,
  76.34% of games). Q at 4s is when the map speed and the clear both hit their real rate.
- **Level 11 → R 130s. Level 16 → R 110s.** At rank 1 the ult is *150 seconds*, which is longer
  than half a drake cycle (`DRAGON_RESPAWN_SEC` is 300).

**When his level is 6 and the enemy jungler's roster level is 5** → this is the one window where
her duel is genuinely favoured, because the ult exists on one side only. It closes the moment he
clears a camp. *Why:* R is her only lockdown; without it she is a damage-over-time champion with
no burst.

**When the enemy jungler's roster level is 2 or more above his** → the clear has been interrupted,
whatever it felt like. Say the level gap; do not guess at the cause.

**When a drake timer is inside 40s and he is level 6+** → the ult is worth more at the pit than
on a lane. *Why:* it lands on everyone already carrying Dream Dust, so a pit fight where she has
hit two people is the highest-value R in the game; a solo pick spends 150s of it.

## Gold — what the number he is staring at actually buys

*All figures are Data Dragon 16.17.1 shop prices. **These are facts about the shop, never about
his game.** Never cite one in a post-game review, where nothing can check what he bought.*

The build the data agrees on is **Liandry's Torment first, Riftmaker second** (op.gg 16.17:
Liandry's → Riftmaker → Zhonya's is the most-played completed trio at 28.80% of games, 51.20%
win rate; lolalytics 16.17 lists the same first two). Boots are contested between sources —
op.gg has Sorcerer's Shoes most-played at 45.75% but Mercury's Treads winning more (54.31%),
lolalytics has Gluttonous Greaves — so **do not tell him which boots to buy**; the sites disagree
and there is no defensible answer to hand him mid-game.

| gold in the block | what it is |
|---|---|
| 900 | **Fated Ashes** |
| 1300 | **Haunting Guise** — the component that builds into *both* Liandry's and Riftmaker |
| 2200 | Haunting Guise **+** Fated Ashes, i.e. everything but the 800 combine |
| 3000 | **Liandry's Torment**, complete |
| 3100 | **Riftmaker**, complete |
| 3250 | **Zhonya's Hourglass**, complete |

Components, for the awkward totals: Amplifying Tome 400, Blasting Wand 850, Fiendish Codex 850
(Riftmaker's other half), Ruby Crystal 400, Needlessly Large Rod 1200, Seeker's Armguard 1600.

**When his gold is between 1300 and 2199** → that is a whole Haunting Guise standing still, and
it is the one purchase that goes into both of his first two items. **[needs items]** to say
whether he already has it; without the inventory, phrase it as what the number buys, never as
what he is missing.

**When his gold is 3000 or more and no objective timer is inside a minute** → the item is
finished and sitting in his wallet. This is the strongest version of the unspent-gold line
because it names a completed item rather than a quantity.

**When his gold is below 900** → say nothing about gold. There is no purchase in it.

**When a drake or baron timer is inside 60s and he is above 1300g** → the back is now, not after.
*Why:* the walk back is free before an objective and expensive during one.

**[needs items] When his inventory shows Liandry's complete and Riftmaker not started** → the
next 1300 is Haunting Guise again, not boots.

## The clear, and what a broken one looks like

**The route.** op.gg's 16.17 pathing data (58,515 games) has one dominant route on **both** sides
of the map: **Blue → Gromp → Wolves → Raptors → Red → Scuttle**. The rest of the volume is a
family of **Raptors-first** clears. jungler.gg's per-route win rates (26.16, one patch behind, so
treat the numbers as shape rather than fact) split those two families cleanly: the blue full clear
is 11% of games at 54.2%, the Raptors → Krugs → Red → Wolves → Gromp → Blue full clear is 6.6% at
54.8% — and the straight *mirror* of the blue route, Red → Krugs → Raptors → Wolves → Blue → Gromp,
is 7.3% at 44.8%. **If he starts red, the Raptors-first ordering is the one that performs; the
plain mirror is the one that does not.**

**The clear accelerates as it chains** (Prance stacks on Q) and **its pacing constraint is the W
cooldown**, 14s at rank 1 down to 10s at rank 5. Two consequences worth saying, once each:

- A camp skipped in the middle of a route is not one camp, it is the stacks for everything after
  it.
- Hovering a lane while a camp is up is the specific way Lillia loses tempo. She is the champion
  that is punished most by standing still, because standing still is when her movement speed
  decays and her W comes back with nothing to hit.

**When his CS is behind his own average AND his gold is over 1300** → these are two readings of
one problem: the route is being interrupted, not run slowly. Say the pair, not either alone.
*Why:* a slow clear produces low CS with low gold; an interrupted one produces low CS with gold
piling up because he never gets a clean back.

**When his CS is ahead of his own average and his gold is over 2200** → the opposite failure, and
a much happier one. He is farming well and spending badly.

## The 1v1 — when to take it and when to leave

*Durable.* She has no burst, no dash, and damage that arrives over time. Even fights are the
category of fight she is worst at, and refusing them early is correct play, not timidity.

- **Take it** when his level is above the enemy jungler's in the roster and his R is up (level 6+
  against their 5 is the clean case), or when a teammate is visibly already committed.
- **Leave it** when levels are within one and both are below 6. There is nothing to win: her
  damage needs time and the enemy gets to choose when to leave.
- **Leave it regardless** in a corridor, a pit or a tri-brush. Movement speed is her only exit and
  terrain deletes it. This is why an enemy with a wall or a pull — Trundle's pillar is the exact
  case — turns a fight she was winning into one she cannot leave.
- **When he is already in the fight**, the kit wants the long version: keep hitting things with
  spells (Prance, and Dream Dust for the ult), and never open with R on someone he has not touched.

## Objectives — contest, or walk

**When two or more enemies are dead and the shorter respawn is longer than the objective timer** →
this is a free take and it is the highest-value thing this file produces. Say the window.

**When the objective is up and the enemy jungler is alive and unaccounted for** → Lillia is a poor
late-smite contester: no dash to steal from over a wall, no burst, and her damage arrives as a
tick rather than a hit. A pit she starts alone is a pit she loses. The executable version is
"start it only with someone else already there".

**When he is level 6+ and a fight has started at a pit** → hit them with a spell *before* the ult.
R only drowsies targets carrying Dream Dust.

**When an enemy took an objective and he was somewhere else** → that is a fact about the game, not
a fault, and this app has been wrong about exactly that before. Do not attach blame to a timer.

## Tells that a decision has already gone wrong

Each of these is an anchor for criticism — a specific fact in the block, not a hunch.

- **A death while the enemy jungler's roster level is at or above his** → he took the fight she
  loses. Name the level, not the play.
- **The enemy jungler two or more levels up** → the route is being abandoned somewhere.
- **CS behind his own average with gold piling** → interrupted clear (above).
- **Gold above 3000 across several minutes** → a finished item never bought.

## Never say these

They are true in every Lillia game ever played, which is what makes them noise:

- "Lillia scales, so just farm."
- "Your ult is your big spike / remember you have R at 6."
- "Watch out for the enemy jungler."
- "Use your speed to rotate."
- Anything about how well he executed a clear, which ability he used, or when he bought
  something. The client does not send it and the video does not show it.

## Patch context

AP junglers took another small-to-moderate nerf in the 26.17 notes, the latest in a run of them
(carried over from the 2026-09-03 pass and not re-verified). This is background for expectations.
It is never an excuse to offer him and it never explains a number.
