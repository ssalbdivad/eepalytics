patch: durable
sourcedAt: 2026-09-04
source: model-knowledge — champion identity and role decisions only; no tuning numbers, no ratios, no build path
---

# Bel'Veth — jungle

**In one line:** a scaling skirmisher who is paid in stacks, so every fight and every objective she
takes makes the next one easier. The opposite of a champion you coach toward safety — and the
opposite of one you fight on her schedule.

## The states this file keys off

Her level and HP; the clock; alive counts and respawn timers; kill events with killer, victim and
assisters; **epic-monster kill events**, which matter more on her than on anyone else; the champion
names on both teams; inventories when the live client is publishing them. Never cooldowns, wards,
or where anyone is standing.

## How to use this file

Rules read `WHEN <observable> → DO <action> — WHY <reason>`. **A trigger you cannot see did not
fire.** Thresholds are for comparing against the block, never for reading out.

## The kit, in the terms that decide a fight — durable

- **Her dash is her whole movement pattern** and it is the reason she wants open space: a fight
  with room is a fight she is repositioning through, and a fight in a corridor is a fight she is
  standing in.
- **Her knock-up is the setup**, not the damage — it is what makes the sustained part land.
- **Her channelled spin is sustain plus damage reduction**, which is why a *long* fight favours her
  and a burst trade does not.
- **Her true form is not a level, it is an event.** She transforms by consuming what an epic
  monster leaves behind, so the state that changes her is an epic monster taken — not a timer and
  not a level. That is a kill event the client publishes.
- **Takedowns and monsters make her permanently stronger.** The stacks do not decay, so a fed
  Bel'Veth is not "ahead this fight", she is ahead for the rest of the game.

## Playing her

- **WHEN** her level is low and the clock is early → **DO** clear and take the free objective; do
  not force an invade or a coin-flip duel → **WHY** the first minutes are the weakest part of her
  game and an early death costs both the tempo and the stacks she has not started collecting.
- **WHEN** an epic monster is on the clock and the numbers are not against her → **DO** be there;
  this is the objective loop that pays her twice → **WHY** her power comes from converting
  objectives into permanent stats, which ganking a losing lane does not do.
- **WHEN** the fight has room and lasts → **DO** commit → **WHY** dashes, resets and sustained
  damage all want time and space; a short fight in a choke is her worst case.
- **WHEN** the block shows her stacking takedowns → **DO** the coaching is to keep the loop
  running, not to bank the lead → **WHY** she is one of the few junglers where the correct answer
  to a lead is more fighting, provided the space is there.

## Against her

- **WHEN** the enemy Bel'Veth is early and unstacked → **DO** this is the window; contest her
  camps and her objectives now → **WHY** every minute of a quiet game is a minute she is being paid
  for.
- **WHEN** a kill event shows she has taken an epic monster → **DO** treat the next fight as
  happening against a different champion, and do not take it in open ground → **WHY** the
  transformation is an event, and it is the one thing about her that changes discontinuously.
- **WHEN** the fight would be long and in open space → **DO** decline it; take the objective on
  the far side instead → **WHY** duration is her currency. A fight she cannot extend is a fight
  she did not want.

## Tells that a decision has gone wrong

- Repeated early deaths on her — the champion has been played as a duellist before she was one.
- Epic monsters going to her side while the block shows the user farming — the loop that pays her
  is running unopposed, and that is a strategic fact, not a mistake in a single fight.
