patch: 16.17
sourcedAt: 2026-09-05
source: op.gg jungle-paths (patch 16.17; blue-side best path 34,502 games, re-read 2026-09-05) + jungler.gg (26.16) + wiki.leagueoflegends.com V26.17 patch notes + ddragon 16.17.1 Lillia.json and wiki.leagueoflegends.com/en-us/Lillia for ability roles
---
Lillia is a **tempo jungler**, not a duelist. Her case for existing is that she clears fast,
moves fast, and is somewhere on the map you are not. Pull coaching toward "did the clear keep
moving" rather than "did the fight go well".

**The standard full clear, on either side, is: Blue → Gromp → Wolves → Raptors → Red →
Scuttle.** That is the most-played route by a wide margin at this patch. The common alternative
is a leashless **Raptors → Krugs → Red → Wolves → Gromp → Blue**, which starts on the side of
the map she wants to end on. If his CS at ten is low, the question to ask is which of these he
abandoned halfway, not whether he clears slowly. (No clear *time* is written down here on
purpose: neither of the sources above publishes one, and a remembered one would be a number
with nothing behind it.)

**Her clear accelerates as it chains.** Blooming Blows (Q) stacks Prance movement speed, so the
back half of a route is faster than the front, and the correct clear *kites the camp toward the
next camp* while killing it rather than standing still. This is why a *broken* clear costs her
more than it costs a flat-rate jungler: stopping mid-route to hover a lane throws away the speed
she already paid for. A low CS per minute on Lillia is usually an interrupted route, not a slow
one. Watch Out! Eep! (W) is the damage centre of the clear and wants the camp stacked up.

**She is weak in an early even fight and that is correct play.** She is a scaling jungler: avoid
early duels with the enemy jungler, farm, and take the free kills rather than the coin-flip ones.
Punished early greed is worth naming as a pattern; being "passive" early on Lillia usually is not
a mistake.

**Level 6 is the real spike.** The ultimate is what turns her from a farming champion into a pick
threat, and it wants her passive already applied — so it rewards poking a target first rather
than opening with it. After scuttle, her best ganks are mid against something immobile, or a
side-lane skirmish where the AoE gets multiple targets. "Get to 6 on time" beats almost any
individual early skirmish.

**Her E is a scouting tool, not just poke.** Swirlseed travels a long way and reveals what it
hits. On a champion whose ward data this app cannot see, "check it with E before you walk in" is
advice he can actually execute, and it is the honest substitute for ward coaching.

**Where she dies.** The only reposition in the kit is the short hop built into Watch Out! Eep!
(W) — it carries her a step toward where she aimed it and it will not cross terrain, so it is a
way of landing the damage, not a way out. Everything else about leaving is the movement speed
she has already stacked. Once she is committed into a corridor, a pit or a tri-brush, neither of
those saves her. A death in the enemy jungle costs her more than it costs a mobile jungler, and
"you had no way out of there" is a fair champion-specific read on her death locations.

**What she wants from a fight.** Sustained damage over a long fight with room to kite, not a
short burst trade. The fights she wins are the long ones — worth crediting when the data shows a
strong extended fight, and worth naming when she dies early in a short one.

**Patch context (26.17, live 2026-08-26):** Lillia is not in the 26.17 notes and neither are
jungle monsters, Smite or any objective. If a habit worked last patch it still works, and the
patch is not the reason for a number either way.

## Live coaching

Half-sentences, said out loud after a number the client has already proved. **No digits** —
a figure here would be a claim about the game, and every figure he hears must come from the
client. Anything with a number in it is refused at load time, deliberately.

Several clauses per key is intentional: a fixed clause per kind means the identical half-sentence
every time that kind fires, and sameness is what made him stop listening. Each one has to end on
something he can DO in the next thirty seconds.

Every clause below is pinned in `src/knowledge/champion-claims.test.ts`: each one names the
mechanic it is betting on and where that mechanic was checked. Add a clause and the test fails
until you write down what it depends on.

race-behind: your clear only gets faster while it keeps running, so finish the whole route
race-behind: you do not win the straight early duel, so win the race on route speed instead
race-behind: the Prance stacks decay once you stop hitting things, so keep the route moving
race-behind: roll a Swirlseed down his entrance, it reveals whoever it rolls into

race-ahead: you are ahead because the route never stopped, so do not stop it to go find him
race-ahead: keep the clear running toward his camps while the speed is stacked
race-ahead: no burst means you cannot cash a lead in a duel, so cash it on a drake

restraint: you have no burst to end it early, so take your own camps and come back with the ult
restraint: get the level back off a full clear, then contest it with the ult up
restraint: your speed is for leaving, not for winning that, so path away and take camps

fight-lost: your damage arrives over time, so take the long fights with room to kite
fight-lost: the ult only sleeps someone already covered in dust, so hit them before you cast it
fight-lost: a corridor takes away the speed that is your real exit, pull them into open ground

fight-absent: your value is being where they are not, so take the far camps while that settles
fight-absent: arriving late on foot only feeds it, take the far objective instead
fight-absent: start walking to the next timer, your speed only pays in transit

death: the W hop is a step and not an escape, so the leaving has to start before you commit.
death: roll a Swirlseed in ahead of you next time, it reveals whoever it rolls into.
death: speed only saves you when it is already stacked, so start moving before you need it.
death: a pit or a corridor is where your escape stops existing, so fight at the entrance to it.

build: if that shortens the fight, stop taking the fight and go take something instead
build: you win the long one, so ask whether he can still be outlasted before you contest
build: you do not out-trade an item, you out-run it, so take camps and skip the duel

farm-behind: that is an interrupted route, not a slow one, so finish the next
farm-behind: a camp skipped mid-route costs the speed for all the ones after, so take it now
farm-behind: stop hovering the lane, the camp that is already up is the tempo
