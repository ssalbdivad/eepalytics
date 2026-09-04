# Sanctioned sources for champion context

The refresh workflow (`.github/workflows/refresh-champion-context.yml`) is restricted to the
domains below, and a human reviewing its pull request should hold it to the same list.

This is not bureaucracy. `knowledge/` is the only part of the coaching prompt that was **not
measured from the user's own game**, so it is the one place a plausible-sounding invention can
enter the product without any check catching it. Everywhere else, a number that is not in the
digest gets rejected by `src/review/parse.ts`. Here, nothing does — except this list and the
person reading the PR.

## Tier 1 — official, authoritative

| Source | Good for | Not good for |
|---|---|---|
| `ddragon.leagueoflegends.com` | The live patch number. Unauthenticated, stable, machine-readable. | Anything about how to play. |
| `leagueoflegends.com` patch notes | What Riot actually changed, in Riot's words. The only source that is definitionally correct about a change. | What the change means in practice. |

## Tier 2 — aggregate match data

Reliable because they are **counting real games**, not opining. Prefer whichever states its
patch and its sample size; a route backed by 34,000 games is a fact about what people do, and
the win rate beside it is a fact about how it went.

- `op.gg` — pathing frequencies, matchup win rates, sample sizes, per-patch.
- `u.gg` — same shape of data.
- `lolalytics.com` — larger samples, explicit patch and rank filters.
- `jungler.gg` — jungle-specific clear routes and pathing.

Cite the sample size when the file makes a claim about what is standard. "Most-played route at
this patch across 35k games" is checkable; "the best route" is not.

## Not sanctioned

Personal blogs, YouTube titles, tier lists with no methodology, LLM recall (including mine), and
anything that does not state which patch it is describing. A guide that does not name its patch
cannot be checked for staleness, which makes it permanently unverifiable.

## What may be written down

Even from a sanctioned source, `knowledge/champions/*.md` holds only material that survives the
fence in `knowledge/README.md`: things that shape **the fix**. Specifically —

- **Yes:** clear routes and their frequency, clear times, power-spike levels, what the champion
  wants from a fight, when to commit to a fight and when to leave, when to contest an objective
  and when to trade it, where the champion is vulnerable, matchup shape against a specific enemy
  jungler.
- **Yes, but live only and keyed to a state:** what the *next item* has to buy, given what the
  enemy inventories show. The live client publishes every player's items; the post-game timeline
  publishes none, so this material is marked live-only in the file and is never a grading
  criterion. Write the property ("the burn line keeps paying into stacked health"), not a build
  path, because item names move every patch and the property does not. See `knowledge/README.md`
  for the three conditions a build rule has to meet.
- **No:** rune pages, skill order as a *grading* criterion, and any build claim in a review. The
  LCU timeline has none of those, so the coach could never check what the user actually did —
  advice about them would float free of evidence, which is the exact failure this app exists to
  prevent. (Skill and ability *roles* are fine; "he should have maxed W" is not.)
- **Note for whoever edits `src/knowledge/research.ts`:** its `RULES` prompt still bans item
  advice outright, so a research refresh will strip the build rules out of any file it
  regenerates. That prompt and this list have to be changed together.
- **No numbers that could be mistaken for measurements of his game.** A champion's base clear
  time is context. It is never a stat about him.

## Provenance is mandatory

Every file carries `patch:`, `sourcedAt:` and `source:`. `patch: durable` means the content is
champion identity rather than tuning and does not expire; use it only for material that would
survive a balance change. Anything else must name the patch it describes, so `scripts/
check-patch.ts` can flag it when the game moves on.
