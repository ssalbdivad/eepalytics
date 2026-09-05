patch: 16.17
sourcedAt: 2026-09-05
source: ddragon.leagueoflegends.com 16.17.1 — Lillia.json, for ability ROLES only (what each spell is for; no cast ranges, no cooldowns, no tuning); op.gg — Lillia jungle-paths, patch 16.17 Emerald+, for which route families are actually played; jungler.gg (labelled 26.16, one patch behind) for the shape of the red-side split. Deliberately NOT written down here: shop prices, per-route win rates, and matchup tables — the first two are numbers a review cannot check against the digest, and on 2026-09-04 op.gg and lolalytics returned contradictory Lillia matchup tables, so there is no defensible figure to record.
---

# Lillia, jungle

Lillia is a **tempo jungler**, not a duelist. Her case for existing is that she clears fast, moves
fast, and is somewhere on the map the enemy jungler is not. Pull coaching toward *did the clear
keep moving* rather than *did the fight go well*.

## The kit, in the only terms that change a decision

Roles only. Nothing here is a cooldown, a range or a threshold, because none of those can be
checked against anything this app measures.

- **Q, Blooming Blows** — the spin. Hitting anything with it stacks Prance movement speed, which
  is why her clear gets faster the longer it runs and why she is the champion most punished by
  standing still. The speed decays when she stops.
- **W, Watch Out! Eep!** — the damage centre of every camp, and the thing that paces the route.
  Walking a long way between camps wastes a W that was already back.
- **E, Swirlseed** — thrown, and it *keeps rolling* until it hits a unit or a wall, slowing and
  revealing what it hits. This is her longest-ranged tool and it is the honest substitute for ward
  coaching in an app that can never see wards: **check the entry with it, then walk in.**
- **R, Lilting Lullaby** — it only drowsies enemies who are already carrying **Dream Dust**, her
  passive, applied by hitting them with a spell. An ult thrown at someone she has not touched is
  the cooldown spent for some damage. And the drowsy has to be allowed to become *sleep* — hitting
  the target too early wakes them and spends the ult for a fraction of what it was worth.
- **She has no dash and no blink.** Her escape is the movement speed she is currently stacking,
  which means the decision to leave has to be made before she is committed, not after.

## The clear, and what a broken one looks like

The dominant route on both sides of the map is the **six-camp full clear** — blue side runs
Blue → Gromp → Wolves → Raptors → Red → Scuttle. The main alternative is the family of
**Raptors-first** clears, which start on the side of the map she wants to finish on. Off a red
start it is the Raptors-first ordering that performs; the plain mirror of the blue route is the
one that does not.

**The clear accelerates as it chains.** Two consequences, and they are the two most useful things
in this file:

- A camp skipped in the middle of a route is not one camp, it is the speed for everything after
  it. A *broken* clear costs her more than it costs a flat-rate jungler.
- Low CS on Lillia is almost always an **interrupted** route rather than a slow one. The question
  is which clear she abandoned halfway, not whether she clears slowly.

Hovering a lane while a camp is up is the specific way this champion loses tempo: standing still
is when the movement speed decays and the cooldown comes back with nothing to hit.

## Fights — the ones she wins and the ones she is offered

She has no burst, no dash, and damage that arrives over time. **The even early fight is the
category she is worst at, and declining it is correct play rather than timidity** — being
"passive" early on Lillia is usually not a mistake, and punished early greed is.

- The fights she wins are the **long** ones with room to kite. A short trade in a corridor is her
  worst case, because terrain deletes the only exit she owns. An enemy who can wall or pull —
  Trundle's pillar is the exact case — turns a fight she was winning into one she cannot leave.
- Once she is in it, the kit wants the long version: keep landing spells, both for the speed and
  because the ult needs Dream Dust on the targets first.
- She is a poor late-smite contester: no dash to steal over a wall, no burst, and damage that
  arrives as a tick rather than a hit. A pit she starts alone is a pit she loses. The executable
  version is *start it only with someone else already there.*

## Where she dies

In a corridor, a pit, or a tri-brush — anywhere speed stops being an exit. A death in the enemy
jungle costs her more than it costs a mobile jungler, and "you had no way out of there" is a fair
champion-specific read on her death locations.

## Do not say

True in every Lillia game ever played, which is what makes them noise: *she scales, so farm.* *Your
ult is your big spike.* *Watch out for the enemy jungler.* *Use your speed to rotate.* Anything
about how well he executed a clear, which ability he used, or when he bought something — the
client does not send it and the video does not show it.

## Live coaching

One clause per situation, said out loud after the number the client proved. **No digits** — a
figure here would be a claim about the game, and every figure he hears must come from the client.
Anything with a number in it is refused at load time, deliberately.

Several clauses per key is intentional: the app rotates through them on the game clock, so a kind
that fires three times in a game does not end on the same half-sentence three times.

race-behind: your clear only gets faster the longer it runs, so the fix is finishing the route rather than hurrying it
race-behind: he took that lead while you were standing somewhere, and standing still is the one thing your kit cannot afford
race-behind: take the camps between you and him instead of the fight, you win that race and not that duel

race-ahead: keep the route running toward his side, being where he is not is the whole plan
race-ahead: spend the lead on the next objective rather than on a duel you would still lose

restraint: you have no burst and no dash, so an even fight is his to leave and yours to lose
restraint: declining that is correct play rather than timidity, take your own camps and be full for the objective

fight-lost: your damage arrives over time, so the fights you win are the long ones with room to kite
fight-lost: never open the ult on someone you have not hit yet, it only puts them under if your passive is already on them
fight-lost: a corridor or a pit takes away the movement speed that is your only exit, so make them come to open ground

fight-absent: you win by being somewhere they are not, so take the far camps while that resolves
fight-absent: that one was decided before you could reach it, the objective on the other side was not

death: you have no dash and no blink, so leaving has to be a decision you make before you are committed rather than after
death: roll a Swirlseed in ahead of you next time, it keeps going until it hits something and it shows you what is waiting
death: speed is your only exit, so it has to still be stacking when you need it, not something you go looking for in a corridor

build: read that as what it does to a long fight, because the long one is the only kind you win
build: if that makes him shorter and sharper, stop planning the duel and go take something instead

farm-behind: that is almost always an interrupted route rather than a slow clear, so finish the next one before you look at a lane
farm-behind: a camp skipped in the middle is not one camp, it is the speed for everything after it
farm-behind: hovering a lane while a camp is up is exactly how this champion loses tempo, so path to the camp
