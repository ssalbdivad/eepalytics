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

That fence is why these are prose about how a champion works, and never build paths, item
names, rune pages or numbers. The timeline has no item purchases (see `AGENTS.md`), so a build
recommendation could never be checked against what he actually did — it would be advice
floating free of evidence, which is the exact failure mode this app exists to avoid.

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

## The `## Live coaching` section — the only part the live coach reads

The prose above is sent to the post-game reviewer, the watch review and the champ-select brief.
**The live voice coach reads none of it.** It speaks one sentence mid-game, and prose in a prompt
has nothing tying it to the moment — which is how you get "Viego is your jungle counterpart so
watch for his ganks" said about a game with no Viego in it.

So a note reaches the live coach through one section only, at the end of the file:

```
## Live coaching

race-behind: your clear only gets faster the longer it runs, so finish the route
race-behind: he took that lead while you were standing somewhere
death: you have no dash and no blink, so leaving is a decision you make before you are committed
```

The rules, all of them enforced by `src/shared/champion-advice.ts` and its tests:

- **Keys are a closed set.** `race-behind`, `race-ahead`, `restraint`, `fight-lost`,
  `fight-absent`, `death`, `build`, `farm-behind`. Anything else is ignored silently, so check the
  spelling. Each key names a situation the *client* has already established; the clause is the
  half no client can supply.
- **No digits. At all.** A clause containing a number is refused at load time. A mechanism that
  can express a number about the game can express a wrong one, and every figure he hears has to
  come from the block. `src/shared/champion-advice.ts` has the full story.
- **Write several clauses per key.** The app rotates through them on the game clock, so a kind
  that fires three times in a game does not end on the same half-sentence three times. A single
  clause per key is the sameness the coach gets muted for, and a test fails on it.
- **A clause completes a sentence the client started.** `race-behind` is appended to
  "Kayn is 23 CS up on you — …". `death` is the exception: it is spoken alone on the respawn
  screen, so it has to stand up as a whole sentence by itself.
- **`_default.md`'s clauses are merged in per KIND**, so a champion file only needs the clauses
  where it has something more specific than the role to say. A champion file with no
  `## Live coaching` section at all still gets the role clauses — but a champion the user actually
  plays deserves its own.

The test that decides whether a clause earns its place: **would it change what he does?**
"Lillia is a scaling jungler" changes nothing. "Your clear accelerates as it chains, so stopping
mid-route costs more than it looks like" changes a decision. Cut the first kind ruthlessly.

## Staleness

`patch` is compared against the game's patch. When they differ the prompt says so and tells the
coach to hedge. `durable` never triggers that warning.

The seeded files were written from model knowledge with a **May 2026 training cutoff**, so they
deliberately contain only champion identity and no tuning. If you want current specifics, edit
the file and set `source:` to where you got it.
