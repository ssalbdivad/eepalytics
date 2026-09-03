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
