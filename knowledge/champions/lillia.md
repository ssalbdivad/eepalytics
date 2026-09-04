patch: 16.17
sourcedAt: 2026-09-03
source: op.gg jungle-paths (patch 16.17, 34.8k games) + jungler.gg (26.16) + Riot 26.17 patch notes, for the routes and the patch context; model-knowledge for the kit, the spikes and the fight rules, which are champion identity and carry no tuning numbers
---

# Lillia — jungle

**In one line:** a tempo jungler whose damage is a burn and whose escape is speed. She loses the
fight that is decided in two seconds and wins the one that lasts, on ground she can keep moving
across. Every rule below is downstream of that sentence.

## The states this file keys off

Each rule fires on something the client actually publishes:

- the game clock, and the objective timers derived from it;
- his level, his HP against his max HP, his current gold, his CS against his own average;
- who is dead and for how long, and how many are alive on each side;
- kill events — killer, victim, assisters — and how close together they landed;
- the champion names on both teams;
- items in a player's inventory (the live client publishes these; a post-game review has none).

Nothing here keys off ability cooldowns, Prance stacks, whether Flash or Smite is up, or where
anybody is standing. The client does not publish those, so a rule that needed one would be a rule
that could never fire honestly.

## How to use this file

Each rule reads `WHEN <observable> → DO <action> — WHY <reason>`.

**A trigger you cannot see did not fire.** Do not say a rule because it is true of the champion;
say it because its trigger is on the board *right now*. "Lillia likes long fights" is true in every
game she has ever been in, which is exactly why it is worth nothing out loud.

**This file is never the source of a number.** Not a timer, not a cooldown, not an item he owns,
not a gold figure. Those come from the block, quoted as written. A quantity written into a rule
here ("above half HP", "two or more dead") is a **threshold to compare against the block**, never a
figure to say out loud.

**In a review, skip the build section entirely.** The post-game timeline has no item purchases, so
grading his build there would be advice floating free of any evidence.

Absorb this. Never quote it, never attribute it, never say "the guide".

## The kit, in the terms that decide a fight — durable

- **Q, Blooming Blows** — the button that makes her fast, and cheap enough to hold the speed up.
  It is her clear *and* her only mobility. Every rotation she spends standing still is speed she
  paid for and threw away.
- **W, Watch Out! Eep!** — the damage. It hits hardest through the middle and it has a wind-up, so
  it is the ability a paying-attention enemy simply walks out of. On camps it is the clear; on a
  champion it needs a reason to land — a slow, a wall, a target that cannot leave.
- **E, Swirlseed** — long range, reveals what it hits, slows it. This app can never see wards, so
  this is the honest substitute: check the entrance with E before walking into it.
- **R, Lilting Lullaby** — reaches only enemies her damage has already touched, which makes it a
  **follow-up, not an opener**. The sleep breaks on damage and the wake-up hit is the payoff, so
  its real value is decided by whether the person who breaks it meant to. Plan it as peel and
  zoning; treat a clean sleep-into-burst as a bonus rather than the plan.
- **Passive** — her abilities leave a burn. It is why her damage *arrives late*, and why a trade
  that ends after two seconds is a trade she lost even when it looked even.
- **No dash and no blink.** Her disengage is a speed number, and a speed number does not clear a
  wall, a pillar or a pit lip.

## The clear — routes are patch-sensitive, the shape is not

**The standard full clear, either side: Blue → Gromp → Wolves → Raptors → Red → Scuttle** — the
most-played route by a wide margin at this patch. The common alternative is a leashless
**Raptors → Krugs → Red → Wolves → Gromp → Blue**, which starts on the side of the map she wants to
finish on. A clean full clear lands around **3:15–3:30**; heavily optimised blue starts get nearer
2:45 with smite spent on the clear.

**Her clear accelerates as it chains.** Q's speed stacks, so the back half of a route is faster
than the front, and the correct clear kites the camp toward the *next* camp instead of standing on
it. That is why a broken clear costs her more than it costs a flat-rate jungler: hovering a lane
mid-route throws away speed that has already been paid for. Low camps-per-minute on Lillia is
almost always an interrupted route rather than a slow one.

- **WHEN** his CS is behind his own average and his gold is sitting unspent → **DO** finish the
  route he is on and buy on the way past, rather than answering the map → **WHY** on her, the two
  numbers usually have one cause: he left a clear early, and the speed he lost made the next camp
  slower too.

## Spikes

**By level.** Level 3 completes the clear, not the champion — she has every basic and still loses
an even fight. **Level 6 is the spike that matters**, because R turns a farming champion into a
pick threat, and it wants her burn already on the target. Getting to 6 on time beats almost any
individual early skirmish. R's cooldown drops again at 11 and at 16, which is when speculative
ults stop being expensive.

**By item.** Her damage is a burn, and a burn is worth roughly what the items carrying it are
worth. One completed item is a farming champion with a good ult; the point where a long
even-numbers fight becomes genuinely winnable is nearer two completed items plus level 11. This is
judgement, not a measurement — never say it as a threshold he crossed.

- **WHEN** his level is under 6 and the enemy jungler is one of the champions whose whole case is
  the early even fight (Trundle, Lee Sin, Xin Zhao, Warwick, Viego, Rek'Sai are the common ones)
  → **DO** take the camp on the other side rather than the contested one → **WHY** she has no
  button that wins that trade before her ult exists, and the camp is worth the same either way.

## Fighting — commit, or leave

This is the part the numbers cannot answer for him, and it is the part he asked for.

**Her presence decides a fight** when there is something to fight *over* that she can smite, when
the enemy has a target that cannot walk out of W, or when the numbers are already uneven. **She is
the fifth body** in a 5v5 that starts inside a choke, in a chase that has already left the
objective behind, and in any fight where the first two seconds decide it.

- **WHEN** two or more enemies are dead with a real amount of the timer left and he is above half
  HP → **DO** spend the window on the objective or on their camps, not on a chase → **WHY** numbers
  are what make her fights winnable; the window expires and the corpse does not care where he was.
- **WHEN** a fight just happened — several kill events landing close together — and the alive count
  came out in his favour → **DO** convert it into the thing on the clock rather than into a chase
  → **WHY** her clear speed means the map pays faster than the chase does.
- **WHEN** he is below about a third of his HP with two or more enemies alive and nothing on the
  objective clock → **DO** reset → **WHY** her escape is movement speed, and speed only saves her
  in open ground; low HP in a corridor is a death that buys nothing.
- **WHEN** he died and the enemy jungler is named nowhere in that kill event → **DO** make the next
  clear his own camps rather than a cross-map play → **WHY** he cannot say where that jungler is,
  and Lillia has nothing that undoes walking into him. (Never claim where the jungler *is* — the
  point is precisely that nobody knows.)
- **WHEN** the same enemy is named as his killer twice → **DO** stop taking that fight on their
  terms; make the third meeting happen with a teammate or not at all → **WHY** it is the same
  fight, and it has already been played twice.
- **WHEN** the enemy has an ace or a multi-kill and their whole team is alive → **DO** the answer
  is camps and a reset, not a defensive fight in a choke → **WHY** the fight she loses hardest is
  the one that starts where she cannot move.

## Objectives — contest, or trade

- **WHEN** an objective timer is close and the alive counts are even, with no vision and their
  jungler unaccounted for → **DO** take the far-side camps and set up the *next* one → **WHY**
  Lillia converts an objective into tempo better than nearly any jungler; an even-numbers pit
  brawl is the single fight she is worst at, and refusing it is not passivity.
- **WHEN** the numbers are in his favour and the timer is live → **DO** start it, and start it
  early enough that the burn is already on whoever contests → **WHY** her damage arrives late, so
  arriving late compounds.
- **WHEN** the objective is a multi-unit one → **DO** it is one of the fastest things on the map
  for her → **WHY** her damage is area damage; several small bodies is her best case, not her
  worst.
- An objective the enemy took is a fact about the game, not automatically his fault. If the trade
  cannot be judged from the block, phrase it as the question he should ask himself, not an
  instruction.

## Building — what the next item has to buy

Patch-sensitive; item names move and the properties do not. **Live only** — a review has no
purchases, and never grade a build from one.

The question on her is never "more AP". It is **what is stopping the burn from finishing**.

- **WHEN** their inventories show magic resistance going up across the team → **DO** the next item
  should buy *duration* — survivability, or the cooldown to be in the fight twice — rather than raw
  power → **WHY** a burn that gets an extra second of application beats a burn that starts higher
  and stops early.
- **WHEN** their frontline is stacking health → **DO** the burn line keeps paying; flat damage does
  not → **WHY** her damage profile is already the answer to big health bars.
- **WHEN** one enemy keeps appearing as his killer → **DO** the next completed item is the one that
  survives that champion's opening — the stasis or the resistance that matches their damage type
  → **WHY** her clear replaces gold quickly; her deaths do not.
- **WHEN** he is carrying a lot of unspent gold → **DO** buy on the clear *before* the objective,
  not after it → **WHY** gold in the bank is the one stat that does zero damage.
- **Boots are a real decision on her**, not a default: penetration when the burn needs to land
  through resistances, haste when the game is a run of short skirmishes and the ult cooldown is
  the thing holding him back.

## Tells that a decision has already gone wrong

- CS behind his own average *and* gold unspent at the same time — he is on the map instead of on
  camps, and not converting either.
- Deaths clustered in the minutes just before objectives spawn — he is arriving at pits early and
  alone, which is the exact place her escape does not work.
- Two deaths to the same enemy champion — a matchup he keeps re-entering on their terms.
- A fight happens with him named nowhere in it, twice — he may be farming correctly through fights
  his team chose badly, and he may be arriving too late to matter. The block cannot tell those
  apart, so ask it as a question rather than calling it a mistake.

## Patch context

AP junglers took another small-to-moderate nerf at 26.17, the latest in a run of them. This is
background for expectations. It is never an excuse to hand him, and never an explanation for a
number.
