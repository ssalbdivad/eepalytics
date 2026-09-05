patch: durable
sourcedAt: 2026-09-05
source: ddragon 16.17.1 Belveth.json + wiki.leagueoflegends.com/en-us/Bel%27Veth (passive, Q, W, E and R mechanics, checked 2026-09-05)
---
Bel'Veth is a **scaling skirmisher** built around stacking. She wants repeated fights and
objective takes that feed her, and she gets stronger the longer the game runs and the more she
has eaten. This makes her the opposite of a champion you coach toward safety.

**Her attack-speed stacks are permanent and they survive her death.** Nothing about being
behind, or about dying, takes power back off her — which is exactly why the fix on her is always
"go and take something" and never "win this one back".

**Her early game is the weak part and it is the part that does not come back.** Before she has
stacks, and before anything has died to leave her a coral, forcing an invade or a coin-flip fight
is the most common way the game is lost outright.

**Her power comes from the objective loop, not from lanes.** An epic monster leaves her an
enhanced Void Coral and gives the largest stacks in the game, so pathing that keeps her near
contestable objectives compounds in a way that ganking a losing lane does not.

**True Form is rented; the stacks are owned.** A coral buys the form and the form runs out —
it only stops running out once she is deep into her stacks. So the fix is always the next coral
and the next takedown, never preserving a form that was going to end anyway. This is the one
thing to get right about her: a note that treats True Form as permanent, or the stacks as
losable, has it exactly backwards.

**She wants long fights in open space** — four directional dashes, each on its own cooldown, a
tail knock-up that refunds the dash in the direction it lands, and a channel that pays her back
while damage is on her. A short fight in a corridor is her worst case.

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

race-behind: you get paid for the long game, so take the camps and stop trading tempo for a coin flip
race-behind: your clear speeds up as the stacks build, so finish the early routes
race-behind: you have no true form yet, so farm the side he is not on until the pit comes up

race-ahead: baron and herald leave the coral that matters, so line one up while you are ahead
race-ahead: your stacks are the part that stays, so keep the takedowns coming and skip the duel
race-ahead: every large monster is another permanent stack, so keep the route full and take his camps

restraint: without a coral you have no true form, so go and take camps until you can get one
restraint: every camp adds a stack you keep, so farm the level back and come again
restraint: a level down your dashes are your exit and not your entry, so walk away and clear

fight-lost: your dashes need room, so pull it into open ground rather than a corridor
fight-lost: the tail refunds that dash only when it lands on a champion, so aim it at one
fight-lost: hold the spin while their damage is on you, not while you are chasing someone

fight-absent: that one was decided before you could reach it, so go and set up the epic monster
fight-absent: an epic monster leaves a coral and stacks, so go take one instead of chasing this
fight-absent: be at the pit before it starts, arriving late is the thing your dashes cannot fix

death: your stacks are permanent, so being behind is never a reason to force it back.
death: each dash direction has its own cooldown, so keep one pointed at the way out.
death: true form ends and the stacks do not, so play for the next coral rather than this fight.

build: he spikes and you compound, so take the objective now and the fight later
build: if that makes the duel worse, go and stack somewhere he is not standing
build: his item is a clock on the phase you are weak in, so farm through it rather than test it

farm-behind: every camp you finish is a permanent stack, so run the route out rather than cut it
farm-behind: each dash direction has its own timer, so clear with one still pointed at the way out
farm-behind: stacks are the only thing you keep through a death, so bank them before contesting
