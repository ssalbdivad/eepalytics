patch: durable
sourcedAt: 2026-09-04
source: model-knowledge for the role principles, which are deliberately limited to material that survives a balance patch; the three objective respawn figures are this repo's own constants (`DRAGON_RESPAWN_SEC`, `BARON_RESPAWN_SEC`, `HERALD_RESPAWN_SEC` in `src/analysis/live-coach.ts`) rather than recalled, so the coach and the overlay cannot disagree; the observability claims are read off `src/shared/schema/live.ts` and `src/shared/live-state.ts`.
---

# The jungle role — a lookup keyed to the live block

Champion files say what *this champion* does with a state. This file says what *any jungler*
does with it. When both fire, the champion file wins on the fix and this file wins on the shape.

**Nothing here is a fact about his game.** It is the reasoning that turns a number he can see
into a decision he cannot. Every number he hears still comes from the ground truth block.

## The two tests, which every line has to pass

1. **Not visible.** If he could get it by looking at his own screen — his gold, his level, his
   CS, his health, which of his teammates are dead — it is not coaching, it is a monitor.
2. **Not generic.** If the same sentence could have been said five minutes ago, or in a different
   game, it is noise wearing a coach's voice. "Watch for the enemy jungler's ganks" is the
   canonical failure: true in every game ever played, actionable in none.

A rule earns its place only when a **specific observable state** produces a **specific decision**.
Knowledge alone is background. State alone is a readout. Only the product is worth interrupting
him for.

## Keys this file reads

**In the block today:** clock · his level · **every player's level** · who is dead and their
respawn seconds · his gold · his CS against his own average · **observed** objective back-in
timers · the recent-event feed (dragon type, baron, herald, turret, kills) · how many are alive
on each side.

**Published by the Live Client Data API and not yet in the block** (`src/shared/schema/live.ts`)
— rules needing one are tagged: **[needs role]** every player's true lane (`position`, which that
file notes is reliable, unlike the post-game timeline's), **[needs items]** every player's full
inventory, **[needs spells]** every player's summoner spells.

**Not available from anything, ever. Never assert one:** cooldowns, whether Flash or Smite is up,
ward positions, wave states, who is in vision of whom, what his team is saying, camp respawn
timers. A camp timer has no key in the block, so there is no rule about it in this file.

## Tempo — the only thing a jungler controls all game

Tempo is not "playing fast". It is the gap between what his map position was worth and what it
cost him in camps. Three readings of it exist in the block, and **only the third is invisible to
him**:

- His CS — on his HUD. Worthless on its own.
- His gold — on his HUD. Worthless on its own.
- **His level against the other four levels in the roster.** Not on his HUD. Reading it costs him
  the scoreboard, mid-fight, which is why he does not.

**When the enemy jungler's roster level is at or above his** → he is losing the race he is
actually in, and the fix is the next camp rather than the next lane. *Why:* two junglers with the
same clear diverge only through time spent not clearing.

**When his level is 2 or more above the enemy jungler's** → this is the window where every
aggressive decision in the game is at its cheapest, and it closes on its own. It is also the only
honest moment to suggest taking their camps.

**When his CS is behind his own average and his gold is piling up** → an interrupted route, not a
slow one. A slow clear produces low CS *and* low gold; an interrupted one produces low CS with
gold sitting there because a clean back never came.

**When his CS is ahead of his own average** → say it. It is his own history, it is not on any
screen, and it is the one number that says the game is going well *for him* rather than for his
team.

## Objective priority — the whole job in one ranking

An objective is the only thing on the map that pays the *team* for something only the jungler can
schedule. The block gives back-in timers for objectives **this session actually saw taken**, and
respawns are fixed: **drake 5:00, baron 6:00, herald 6:00** (this repo's own constants).

Ranked by what the block can support:

1. **A window.** Two or more enemies dead, and the shortest respawn is longer than the objective
   timer. This is the highest-value thing any of these files produce: it is exact, it is
   invisible without the scoreboard, and it expires in seconds. Say the window and where to be.
2. **A timer inside a minute.** "Where to be in thirty seconds" is the only sentence that changes
   a jungler's next thirty seconds. Everything else describes the past.
3. **A timer inside a minute *and* gold worth spending.** The back is now, not during. This is
   the one place two facts belong in one sentence, because they are one decision.
4. **Nothing.** An objective four minutes out is not actionable and repeating it is nagging.

**When he is outnumbered on the map** → there is no window, whatever the timers say. A jungler
told he has a free objective while four of them are alive walks into four of them. The code
already suppresses this; do not reintroduce it in prose.

**When the event feed shows an objective was taken and he was not there** → that is a fact about
the game, not a fault. He may have been dead, or trading elsewhere, and the block cannot tell you
which. This app has already shipped the wrong version of this sentence once.

## Full clear versus gank

The honest position is that **the client publishes nothing about a lane** — no wave, no health
bars, no cooldowns, no summoner spells burnt — so *"go gank bot"* is a sentence with nothing
behind it. Almost every gank call a live coach can make is invented.

What survives:

**When an enemy is dead with real time on the clock** → their part of the map is uncontested for
that long. **[needs role]** is what makes this sayable as a place rather than a name: with
`position` in the block, "Viego is down 32s" becomes "Viego is down 32s — their blue side is
yours", which is a decision. Without it, naming a side of the map is inventing, however natural
it sounds after a true fact.

**When his level is behind and no window is open** → the full clear is the answer, and it is the
answer *because* nothing in the block supports anything else. Saying "clear" with a reason beats
saying "gank" with none.

**When a gank happened and the camps did not** → the cost shows up two minutes later as a level
gap in the roster. That is where to say it, not at the moment he walks into the lane, because at
that moment nothing in the block knew whether it was right.

## Counter-jungling — the two conditions, both observable

Taking the enemy's camps is correct when **both** hold, and it is a coin flip when either fails:

1. **He knows where the enemy jungler is.** The exact form of that is *dead, with seconds on the
   clock* — the only version the block can support. "He hasn't shown" is not knowledge, it is
   absence of knowledge, and the two get confused precisely when it matters.
2. **He is not behind on his own camps.** His CS against his own average is the check. Crossing
   the map to take one camp while three of his own are up is a trade he loses twice.

**When the enemy jungler is dead for longer than a crossing and his CS is at or above his
average** → this is the counter-jungle, and it is the only time to say so.

**When his CS is behind his average** → the answer is his own camps, whatever the enemy jungler
is doing. Being full HP and on level for the next objective beats one stolen camp.

## When to walk away

The most valuable thing a coach can say to a jungler is usually a subtraction, and it is also the
hardest to support. These are the ones the block can carry:

- **He is outnumbered** → no objective, no cross-map, no window.
- **He is dead, or about to be back** → any window shorter than his own respawn is not his. The
  block's respawn line for *him* is what makes this checkable; a window handed to a corpse is
  worse than silence.
- **An objective is up and the enemy jungler is alive and unaccounted for** → starting it alone is
  a coin flip on a smite. The executable version names the condition, not the outcome: "not
  alone".
- **Two of his own team are dead** → same arithmetic as being outnumbered, applied to a fight
  nobody has called yet.

## Tells that a decision has already gone wrong

These are the anchors that make criticism legitimate rather than a hunch. Each is a specific fact
in the block, and each should be said **once**:

- **The enemy jungler two or more levels up** → the route is being abandoned somewhere.
- **His death while the enemy jungler is at or above his level** → the fight was lost before it
  started, and the level is the reason to name.
- **Gold above a completed item's price for minutes** → the back never happened. Name the item,
  not the quantity: a number is a readout, an item is a decision. **[needs items]** to know which
  item; the champion file's price table is the fallback.
- **CS behind his own average and gold piling** → interrupted route (above).

## Never say these

Every one is true in every jungle game ever played, which is exactly what makes it worthless:

- "Watch out for the enemy jungler / he might be nearby."
- "Track the enemy jungler's pathing."
- "Look for a gank opportunity."
- "Get objectives when you can."
- "Ward the river."  (There is no ward data. There has never been ward data.)
- "Farm up and scale."
- "Play around your team."
- Anything naming a lane, a role or a side of the map before **[needs role]** ships.
- Anything about how he executed a clear, a fight, or an ability. The client does not send it.
