patch: durable
sourcedAt: 2026-09-05
source: ddragon 16.17.1 Trundle.json + wiki.leagueoflegends.com/en-us/Trundle (passive, Q, W, E and R mechanics, checked 2026-09-05)
---
Trundle is an **early-game duelling jungler**. He wants the fight the enemy jungler does not want
to take, and he wants it before anyone has scaled. Coach the matchup as a *tempo race he is
trying to turn into a brawl*, and the fix is almost always about denying him the brawl rather
than winning it.

**He is at his strongest in a straight 1v1, early.** Chomp takes attack damage off the target
and puts it on him, so a duel that looks even on paper usually is not. The sustain is separate
and it is passive: King's Tribute heals him whenever an enemy unit dies near him, which is why
a full clear is also a heal and why he is rarely low after one. A jungler who scales — and most
junglers scale better than he does — wins by refusing the even fight and taking the map instead.
Being "passive" into him early is generally correct play, not timidity.

**His pillar is terrain, and terrain is what he actually threatens.** It becomes impassable
terrain for its duration, knocking units aside as it rises, and it cuts a corridor in half.
That makes the places he is dangerous predictable: pits, tri-brush, river chokes, jungle
entrances — anywhere a wall across the middle turns a retreat into a trap. Against a jungler
whose escape is movement speed rather than a dash, that is the pairing worth planning around.

**He contests objectives well.** Subjugate takes a share of the target's health, armour and
magic resist and gives him the same, so between that and the passive he is comfortable duelling
on a pit. A drake or a herald taken with him unaccounted for is a bigger gamble than it is
against most junglers. "Know where he is before you start it" is the executable version.

**He falls off relative to the field.** His case is early pressure converted into something
permanent. A game where nothing early goes his way is a game he has to win on someone else's
terms — which is the whole argument for farming through the phase where he is strongest.

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

race-behind: your power is now rather than later, so take the camps that put you next to him
race-behind: your best version is the early duel, so cross for his camps while it still is
race-behind: he is buying time and you have none, so shorten the route and force contact

race-ahead: you fall off relative to the field, so turn this into a tower before it stops being one
race-ahead: the lead is a clock, spend it while the phase you are strongest in is still running
race-ahead: walk at him with it, a camp is worth less to you than a fight you already win

restraint: even is your fight and a level down is not, so take the level back off your own camps
restraint: Chomp wants a duel and not a collapse, so back out and clear instead
restraint: get the level first, you win the fight on that pit once you are even

fight-lost: the field boosts your healing and speed only while you stand on it, so fight on top of it
fight-lost: the pillar goes down to cut them apart before you commit, not once you are surrounded
fight-lost: the ult wants the biggest body in the fight, so drain the tank and not the carry

fight-absent: your window is early, so start walking to the next one before it starts
fight-absent: without the pillar down first you are just another body, so set the next one up
fight-absent: you want the fight you chose, so go take a camp of his and make him come

death: you have no dash, only a wall, so the pillar goes down before you commit rather than after.
death: your field is where you win, so take the fight at your camp instead of walking into theirs.
death: a pit or a tri-brush is your best ground and your worst exit, pick which before you enter.

build: you steal stats rather than out-scale them, so take the fight before that item matters
build: the longer this runs the less of it is yours, treat the item as a clock and force now
build: if that made him tankier there is more for the ult to take, so look for him on the pit

farm-behind: a broken clear costs you the exact phase you are strongest in, so finish the route
farm-behind: you cannot duel a level down, take the camps that fix the level
farm-behind: clear toward him, your farm and your fight are the same walk
farm-behind: enemies dying near you heal you, so clear through the camp rather than backing
