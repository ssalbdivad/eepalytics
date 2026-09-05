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

## The `## Live coaching` section

A champion file may end with a `## Live coaching` section, and that section is a **different
thing from the prose above it**. The prose is sent to the post-game reviewer; these lines are
spoken out loud, mid-game, attached to a number the live client just proved
(`src/shared/champion-advice.ts`).

The format is `<fact kind>: <clause>`, one per line, and the rules are hard:

- **Keyed by fact kind**, so a clause can only be said once the client has established the
  situation it is about. Unknown keys are ignored rather than trusted.
- **No digits.** A clause with a number in it is refused at load time, and a spelled-out number
  used as a game fact is the same fabrication with the fence walked around.
- **A clause completes a sentence the client started** — "Kayn is 23 CS up on you — *your clear
  only gets faster while it keeps running, so finish the whole route*". `death` is the exception
  and stands alone.
- **Three or more clauses per kind**, different in content rather than in phrasing. One clause per
  kind means the identical half-sentence every time that kind fires, and sameness is what makes a
  coach stop being listened to.
- **Under 110 characters, and shorter on a long fact.** The whole spoken line is one breath about
  a second behind the game; `farm-behind` and `fight-absent` already spend forty and thirty-four
  characters before the clause starts, so their clauses are the shortest in the file.
- **Every clause ends on something he can do in the next thirty seconds.** An observation is not
  advice, however true it is.
- **A clause that would read identically on another champion belongs in `_default.md`.** That is
  the whole test for whether champion knowledge is earning its place; `_default.md` carries the
  role version of every kind.
- **Every clause is pinned in `src/knowledge/champion-claims.test.ts`.** Add one, reword one or
  move one and that test goes red until the mechanic it leans on is written down there, with
  where that mechanic was checked. See below.

## What the digit fence does NOT do

The parser refuses a clause with a number in it, which kills every benchmark, price and cooldown
at load time. It validates the FORM of a clause and never its SUBJECT — a digit-free sentence can
still be flatly false about the champion.

It has already been walked through. `belveth.md` shipped `death: your stacks die with you`. Death
in Lavender stacks are permanent and survive death, and the same file said so two paragraphs
earlier. Nothing caught it, because nothing in the repo knew what the clause depended on.

So `src/knowledge/champion-claims.test.ts` is a **bet register**: every shipped clause cites one
or more entries in a `FACTS` table, and every fact carries the mechanic in one sentence plus where
it was checked (a source from `SOURCES.md`, or an explicit "community consensus" that must also
say `judgment` in its own id). It cannot verify truth — no test can, the game is patched and the
test is a string. What it can do is make the bet explicit: when a patch changes a champion, that
table is where you find out which clauses just became false.

## Staleness

`patch` is compared against the game's patch. When they differ the prompt says so and tells the
coach to hedge. `durable` never triggers that warning.

The seeded files were written from model knowledge with a **May 2026 training cutoff**, so they
deliberately contain only champion identity and no tuning. If you want current specifics, edit
the file and set `source:` to where you got it.
