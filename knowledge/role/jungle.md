patch: durable
sourcedAt: 2026-09-04
source: model-knowledge — role theory only, no tuning numbers and no per-champion claims; the objective names current at this patch (Baron, Atakhan, Rift Herald, drakes, Voidgrubs) are taken from the 26.17 patch-notes reading already recorded in knowledge/champions/leesin.md, which cites leagueoflegends.com
---

# Playing the jungle — role theory

Champion notes say what *this champion* does with a state. This file says what *the role* does
with it. When both have something to say, the champion file wins: it is more specific, and
specificity is the whole product here.

## The states this file keys off

The clock and the objective timers; his level, HP against max HP, gold, CS against his own
average; who is dead and for how long; how many are alive on each side; kill events with killer,
victim and assisters, and how close together they landed; the champion names on both teams;
inventories when the live client is publishing them.

Not keyed off, because the client does not publish them: ability and summoner cooldowns, ward
positions, lane wave states, where anyone is standing, and **objective spawn times** — the app
computes timers itself, so a spawn time written here could only ever contradict a real one.

## How to use this file

Rules read `WHEN <observable> → DO <action> — WHY <reason>`.

Two tests before anything is said out loud. **Could he have got this by looking at his own
screen?** If yes, it is a readout, not coaching. **Could this exact sentence have been said in a
different game, or five minutes ago in this one?** If yes, it is filler, and filler is what a
coach with nothing to say produces instead of silence. A rule whose trigger is not on the board
did not fire — say nothing rather than saying the rule anyway.

Nothing here supplies a number. Thresholds ("above half HP", "two or more dead") are for comparing
against the block, never for reading out.

## Pathing — the first three minutes

The first clear is not a decision, it is a plan he made before the game. The decisions are what
happens **after the sixth camp** and what happens **when the plan breaks**.

- **WHEN** the enemy jungler is named in a kill event on the far side of the map from him → **DO**
  the camps nearest that side of the map are the ones that will still be there in thirty seconds;
  the ones near him are the ones at risk → **WHY** this is the one moment the game tells him where
  a jungler was, and it stops being true almost immediately. Never turn it into a claim about
  where that jungler *is*.
- **WHEN** he cannot say where the enemy jungler is and he is behind on his own camps → **DO** his
  own camps, not theirs → **WHY** counter-jungling pays when it costs the other jungler tempo. It
  costs *him* tempo when he is the one behind, and it costs him the game when he is wrong about
  where they are.
- **WHEN** his CS is meaningfully behind his own average → **DO** the next clear runs to the end
  → **WHY** the camps that decide a jungler's game are the ones nobody was watching. Dead time —
  walking, hovering, waiting for a gank that never opens — is the single largest hidden cost in
  the role, and it is invisible on his screen because nothing on the HUD counts it.

## Full clear or gank

A gank that produces nothing costs the camps *and* the walk. A gank that produces a kill and no
objective is worth less than it feels.

- **WHEN** a lane is calling and his own camps are up → **DO** the camps → **WHY** a camp is a
  known quantity and a gank is a coin flip; the exception is a gank with a real setup, not a
  gank with a hope.
- **WHEN** a gank works → **DO** the next thing is the objective or the plate, not the next lane
  → **WHY** the kill is the down payment; the structure is the purchase. A jungler who takes
  kills and no objectives is converting tempo into nothing that survives a death timer.
- **WHEN** a lane's champion has died repeatedly → **DO** treat that lane as the one that pays
  least, and say it as a fact about the lane rather than about the person playing it → **WHY**
  this is context for where the map pays, and it stops being coaching the second it becomes a
  complaint about a teammate.

## Objectives

The objective set at this patch is Baron, Atakhan, Rift Herald, the drakes and the Voidgrubs. The
timers come from the app, never from here.

- **WHEN** the numbers are in his favour and a timer is live → **DO** start it → **WHY** a
  numbers advantage is the only reliable form of objective control in solo queue; vision and
  coordination are not on offer.
- **WHEN** a timer is live, the numbers are even, and the enemy jungler is unaccounted for →
  **DO** set up the next one instead: the far-side camps, the vision on the way in, the reset →
  **WHY** an even-numbers pit fight with no information is a coin flip, and refusing a coin flip
  is a decision rather than passivity.
- **WHEN** he starts an objective at even numbers and the enemy arrives → **DO** the question is
  never "can I finish it" but "what does the fight cost if I do" → **WHY** the objective is worth
  one fight; it is not worth a fight plus the death timers plus the next objective.
- **An objective the enemy took is a fact about the game, not automatically a mistake he made.**
  If the block cannot show what he was doing instead, it cannot show that the trade was bad.

## Tempo

Tempo is the quiet one: nothing on his screen shows it, which is exactly why it is worth saying.

- **WHEN** his gold has been sitting unspent for a long time → **DO** buy on the clear before the
  next objective, not after it → **WHY** unspent gold does no damage, and the recall he keeps
  postponing gets more expensive as the fight it delays gets closer.
- **WHEN** he is dead → **DO** the useful line is the one about what will be true when he comes
  back — a timer, a window, an objective — not what just killed him → **WHY** the death is on his
  screen and the plan is not.
- **WHEN** his CS pace is ahead of his own average → **DO** say so; that is a real fact he cannot
  see, and it is the one number that says the game is going well for *him* rather than for the
  scoreboard.

## Fight selection — when his presence decides it

The role's hardest question, and the one a scoreboard cannot answer. Three checks:

1. **Is there something to fight over?** A fight at an objective is a fight the jungler is
   structurally the most important person in, because he holds the smite. A fight in a lane with
   nothing on the clock is a fight he is the fifth body in.
2. **Do the numbers already favour it?** Alive counts are published. A fight taken while behind on
   bodies is a fight taken on hope.
3. **Would his champion change the outcome?** Engage, hard CC, an objective steal, an area of
   damage across a group — those decide fights. Arriving late as a fourth damage source does not.

- **WHEN** kill events cluster and he is named nowhere in them → **DO** the next decision is the
  side of the map they are not on → **WHY** the fight is decided before he arrives; the camps and
  the objective are not.
- **WHEN** kill events cluster and the alive count came out against him → **DO** leave; the
  follow-up fight is the one he loses → **WHY** the second fight of a lost fight is where a
  survivable game becomes an unsurvivable one.
- **WHEN** two or more enemies are dead with real time left → **DO** name what the window buys —
  an objective, their jungle, a tower — rather than the death itself → **WHY** the death is a
  readout; the window is a decision.
- **WHEN** he is below a third of his HP and more than one enemy is alive → **DO** reset → **WHY**
  the fight he takes on the way to the fountain is the one that costs the reset *and* the death.

## Counter-jungling

Taking their camps is correct on exactly two conditions, and both must hold: he knows where that
jungler is, and he is not behind on his own camps. If either fails, the play is his own jungle.
That is the whole rule, and it is worth saying only when the block shows one of the conditions
failing — otherwise it is a slogan.

## Vision

This app can never see wards. Do not coach ward placements, ward clears, or where anyone warded;
there is no data behind any of it. What survives honestly: **entering a place he cannot see into
is the decision**, and a champion with a long-range ability that reveals has an executable
substitute for a ward. Coach the entry, not the ward.
