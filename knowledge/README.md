# knowledge/ — champion context for the coach

Markdown the coach reads at review time, the same way `AGENTS.md` Part 2 is the persona.
**Editing a file here changes the coaching with no code change.** They are meant to be edited.

## The one rule that matters

Everything in here is *general champion knowledge*. **None of it is measured from the user's
game.** The app's whole guarantee is that a number in a review came from the digest, and a
guide cannot be checked against anything.

So the prompt fences these notes hard:

- they may justify **a fix** — "full clear first, Lillia's clear accelerates as she chains camps";
- they may **never** become a number, a stat, or a claim about what happened in the game;
- if a note and the digest disagree, **the digest wins and the note is dropped**.

That fence is why these are prose about how a champion works, and never rune pages, skill orders
or numbers that could read as measurements of his game.

**Build guidance is the one carve-out, and it is a narrow one.** The post-game timeline has no
item purchases (see `AGENTS.md`), so a build claim in a *review* could never be checked against
what he actually did — advice floating free of evidence, which is the failure this app exists to
prevent. The **live client is different: it publishes every player's inventory.** So a file may
carry build guidance on three conditions, and every build rule in this directory meets them:

- it is **keyed to an observable state** ("their inventories show magic resistance going up"),
  never a build path recited from memory;
- it names a **property** — burn, duration, stasis, penetration — rather than depending on an item
  name still being current, because item names are the most patch-sensitive thing in the game;
- it is marked **live only** in the file, so the review coach does not grade a build it cannot see.

## Write for a lookup, not for background reading

The live coach speaks one sentence, about a second behind the game. Knowledge that reads as
background colour comes back out as *"Viego is your jungle counterpart so watch for his ganks"* —
true, sayable in any game ever played, and worthless. That line is what a model produces when it
is handed a champion name and no state to attach it to: a gap does not produce silence, it
produces plausible filler.

So every rule in these files is written as a lookup keyed by the current state:

```
**WHEN** <something the client publishes> → **DO** <the decision> — **WHY** <the reason>
```

Two tests, and a rule has to pass both:

1. **Not visible.** Could he have got this by looking at his own screen? His gold, his health, his
   CS and his items are on the HUD permanently. The *implication* of a state is not.
2. **Not generic.** Could this exact sentence have been said in a different game, or five minutes
   ago in this one? If yes, it is filler.

And the rule that makes the whole thing safe: **a trigger you cannot see did not fire.** Champion
knowledge times state produces a decision; neither factor is worth saying on its own.

## What the rules may key off

What the game client publishes, and therefore the only honest triggers:

- the game clock and the objective timers the app derives from it;
- his level, HP against max HP, gold, and CS against his own average;
- who is dead and for how long, and how many are alive on each side;
- kill events with killer, victim and assisters, and how close together they landed;
- the champion names on both teams;
- items in any player's inventory, and the summoner spells everyone selected.

Never a trigger, because nothing publishes them: ability cooldowns, summoner-spell cooldowns, ward
positions, enemy health, and x/y positions for anybody.

Some of the above are published by the client but not yet rendered into the ground-truth block the
live coach reads — inventories are the big one. A rule keyed to one of those simply never fires
until the block carries it, which is the correct failure: silence rather than a guess.

## `role/` — theory that is not about a champion

`role/jungle.md` holds what the *role* does with a state: pathing, objective priority, tempo,
counter-jungling, full-clear versus gank, and when a jungler's presence decides a fight rather
than merely joining it. When a champion file and the role file both speak to a state, the champion
file wins — it is more specific, and specificity is the product.

**Nothing loads it yet.** `src/knowledge/index.ts` resolves `champions/<key>.md` and nothing else,
so a non-champion file needs a loader before it can reach a prompt.

## The same files run the pre-game brief

`GET /api/live/matchup` builds the champ-select / loading-screen brief, and it reads these same
files — his champion's, and the enemy counterpart's. The fence does not change, but the stakes
shift: before the game there are no metrics at all, so a note is the *only* unmeasured thing in
the prompt and there are no numbers standing next to it for contrast.

Two consequences for whoever edits a file:

- **A note used pre-game shapes a plan, never a prediction.** "He wants the even early fight" is
  a plan. "You lose this matchup" is a forecast dressed as knowledge, and there is nothing behind
  it.
- **`_default.md` is treated as no notes at all** on this path. It does not describe a champion;
  it tells the coach to stop talking about the champion. The brief reports the gap in its
  `unknowns` list instead, and the coach says the role things it can stand behind.

`src/shared/matchup-prompt.ts` states this to the model, with five allowed lines and five banned
ones.

## File format

`champions/<key>.md`, where `<key>` is the champion name lowercased with non-letters stripped
(`Bel'Veth` → `belveth`). `champions/_default.md` is used when no file matches.

The header block is parsed; everything after `---` is sent verbatim.

```
patch: 16.17          # the patch this was written against, or "durable"
sourcedAt: 2026-09-03 # when a human last checked it
source: model-knowledge | <url> | <author>
---
<prose>
```

`patch: durable` means "this is champion identity, not tuning" — clear shape, ability roles,
power spikes, what the champion is for. Those survive patches. Anything that *doesn't* survive
a patch does not belong in this directory at all.

## Staleness

`patch` is compared against the game's patch. When they differ the prompt says so and tells the
coach to hedge. `durable` never triggers that warning.

The seeded files were written from model knowledge with a **May 2026 training cutoff**, so they
deliberately contain only champion identity and no tuning. If you want current specifics, edit
the file and set `source:` to where you got it.
