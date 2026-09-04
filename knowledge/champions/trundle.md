patch: durable
sourcedAt: 2026-09-04
source: model-knowledge — champion identity and role decisions only; no tuning numbers, no ratios, no build path
---

# Trundle — jungle

**In one line:** an early-game duellist who wins the fight the other jungler did not want, on
ground he chose. He is read from both sides here — the user meets him often and occasionally
plays him.

## The states this file keys off

His level and HP; the clock; alive counts and respawn timers; kill events with killer, victim and
assisters; objective timers; the champion names on both teams; inventories when the live client is
publishing them. Never cooldowns, wards, or where anyone is standing.

## How to use this file

Rules read `WHEN <observable> → DO <action> — WHY <reason>`. **A trigger you cannot see did not
fire** — "watch out for his ganks" is true in every game he has ever been in and is therefore
worth nothing. Thresholds are for comparing against the block, never for saying out loud.

## The kit, in the terms that decide a fight — durable

- **Bite** is sustain and a stat steal in one button, which is why a duel that looks even on paper
  is not.
- **His zone** is the reason he wants the fight to happen *where he put it*: standing in it he is
  faster, hits faster and heals more. Out of it he is a melee champion with no gap-closer.
- **The pillar is terrain.** It cuts a corridor in half, which makes the places he is dangerous
  predictable: pits, tri-brush, river chokes, jungle entrances — anywhere a wall across the middle
  turns a retreat into a trap.
- **His ultimate takes from the biggest body on the other side.** It is aimed at whoever has the
  most health and the most resistances, not at the squishiest target, and it makes him
  *harder to kill* as well as stronger.

## Against him — the useful half

- **WHEN** the user's level is under 6 and Trundle is the enemy jungler → **DO** take the camp on
  the other side of the map rather than the contested one → **WHY** the early even fight is the
  entire champion; declining it costs a camp and denies him the only phase he is favoured in.
- **WHEN** an objective timer is live and Trundle is unaccounted for → **DO** treat the pit as
  contested and set up the next one instead → **WHY** the sustain and the steal make him
  comfortable duelling on a pit, so an uncontested-looking objective is a bigger gamble against him
  than against most junglers.
- **WHEN** the fight would happen inside a corridor — a pit, a river choke, a jungle mouth →
  **DO** move it into open ground or do not take it → **WHY** his terrain button only exists
  where there is terrain to add to. Against a champion whose escape is movement speed rather than
  a dash, that pairing is the death.
- **WHEN** the block shows him ahead on kills early → **DO** the answer is camps and objectives on
  the other side of the map, not a rematch → **WHY** he converts early pressure into permanence;
  a jungler who scales beats him by refusing to be where he is.
- **WHEN** the game has run long and he has not converted → **DO** this is the phase the user was
  farming toward; take the even fight now, not at minute 8 → **WHY** he falls off relative to most
  of the field, so the fight he wanted early is the fight to accept late.

## Playing him

- **WHEN** his level is at or above the enemy jungler's and an early objective is on the clock →
  **DO** start it or contest it → **WHY** his best window is the one where duelling on a pit is
  favourable, and it does not come back later.
- **WHEN** a fight is starting → **DO** the terrain goes down to cut off the retreat, not to
  arrive → **WHY** the pillar is worth a kill when it removes the exit and nothing when it is
  used as a wall to hide behind.
- **WHEN** their team has an obvious biggest health bar → **DO** that is the ultimate target →
  **WHY** it takes the most from the target it takes the most from — pointing it at a squishy
  is spending the fight-defining button on the person who was going to die anyway.

## Tells that a decision has gone wrong

- Repeated kill events where the user is the victim and Trundle is the killer, all early — he keeps
  accepting the fight that is designed for him.
- An objective conceded shortly after a fight he was in — the sustain means his post-fight health
  is not the same currency as everyone else's.
