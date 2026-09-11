# knowledge/ — champion context for the coach

Markdown the coach reads at review time, the same way `AGENTS.md` Part 2 is the persona.
**Editing a file here changes the coaching with no code change.** They are meant to be edited.

## The one rule that matters

Everything in here is *general champion knowledge*. **None of it is measured from the user's
game.** The app's whole guarantee is that a number in a review came from the digest, and a
guide cannot be checked against anything.

So the prompt fences these notes hard, on every path that reads them:

- they may justify **a fix** — "full clear first, Lillia's clear accelerates as she chains camps";
- they may **never** become a number, a stat, or a claim about what happened in the game. A base
  clear time written here is context about the champion; it is never a measurement of his game;
- if a note and the digest disagree, **the digest wins and the note is dropped**.

**That fence is about the USER's game, and the distinction decides what you may write.** A note
may never become a number about HIM, and it may never grade his build path, his runes or his
skill order: the LCU timeline carries none of those (see `AGENTS.md`), so a recommendation about
them could not be checked against what he actually did — advice floating free of evidence, the
exact failure this app exists to avoid.

What the fence does **not** ban is prose that carries a number, or an item named on the **enemy
jungler**. The live client reports item IDENTITY exactly once a player has been seen — Jaccard
100% against the post-game blob, all ten players — so "he finished Sunfire, he wants to sit on
you" is a reading of a fact the coach was handed, not a guess. That is the whole point of a
counterpart file. The two sections below say it again in their own terms; this paragraph exists
so the opening does not appear to forbid them.

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

## Counterpart files — what "know your enemy jungler" means

The coach's central comparison is against the **enemy jungler**, and `fullKnowledge` in
`src/review/live-knowledge-full.ts` loads two champion files per game: his, and the counterpart's.

A file here is therefore read in one of two roles, and the newer ones are written for the second.

**The race that is real in the live feed is LEVEL and ITEMS, not CS.** The client's
`scores.creepScore` for the enemy jungler is a count of what the player's own team witnessed him
kill — measured at 70 against a true 183 by the end of one game, and exact in 3.3% of checkpoints
across fifteen paired games. The app does not render it anywhere, so a counterpart file that leans
on a farm comparison is writing about a number the coach will never be given. Write about what his
level and his completed items mean instead; both of those are exact once he has been seen.

A **counterpart file** answers, in prose, the questions a jungler actually has about the other
jungler: what the clear looks like and how fast, the power spikes named **by level and by item
rather than by clock**, how they gank and what makes it fail, what their presence means for drake
and grubs, what their items TELL you when they show up in the live client's feed, and — the section
that earns the file — **how the Lillia matchup actually plays**: who wins the early duel, who wins
the race, and when she may contest a crab or an objective and when she must not.

Three conventions, and they are deliberate:

- **No `## Live coaching` section.** Those tagged clauses are keyed to the PLAYER's champion
  (`src/server/routes/live.ts` parses `championNote(me.championName)`), so clauses in a counterpart
  file would never be read. The full-knowledge path strips the section anyway.
- **Numbers are allowed, mechanics are preferred.** These files are prose for a reader, not clauses
  for a parser, so the digit fence does not apply — but a mechanic you are sure of still beats a
  number you are guessing, and anything patch-mobile says so in the sentence.
- **Every file ends by saying what it left out.** A gap named in the file is a gap the coach can
  hedge around. A confident wrong claim here is worse than a gap, because the coach speaks it as
  knowledge.

### What is on disk, and which of it has ever been exercised

On disk as of 2026-09-11, and this list is checked against the directory rather than remembered:

**Counterparts** — `briar`, `fiddlesticks`, `jarvaniv`, `karthus`, `kayn`, `malphite`, `masteryi`,
`morgana`, `quinn`, `shaco`, `shyvana`, `sylas`, `tryndamere`, `udyr`, `viego`, `wukong`,
`xinzhao`, `zed`.

**The player's own champion** — `gwen` and `lillia`, which are the only two champions he plays in
the recorded corpus; `belveth`, `leesin` and `trundle`, written earlier for champions he has not
played on record.

**`_default.md`** is neither: it is the role file, and it is treated as *no notes at all* on the
pre-game brief path.

`quinn.md` is deliberately the least confident of the counterpart files and says so in its own
closing section.

**Three counterpart files have never been exercised: `jarvaniv`, `quinn` and `wukong`.** No
recorded game has that champion in it, so no line the coach has ever spoken was shaped by them.
They are sourced exactly as the rest are and they are kept — a file that is right the first time
he meets that jungler is worth more than a tidy directory — but the fact is written into each
file's `source:` header, which a reader sees and the coach never does (`stripHeader` in
`src/review/live-knowledge-full.ts` drops the header before the prose goes to the model). Say the
same of `belveth`, `leesin` and `trundle` on the player's side: written, sourced, and never used
in a game on record.

**Every champion in the corpus now has a file.** That was checked by joining the 19 recorded games'
champions and counterparts against this directory; `shyvana.md` was written on 2026-09-11 because
that join found a benchable game with no notes at all.

## The `## Live coaching` section

A champion file may end with a `## Live coaching` section, and that section is a **different
thing from the prose above it**. The prose is sent to the post-game reviewer AND, whole, to the
default live coach (`src/review/live-knowledge-full.ts`); these lines are spoken out loud,
mid-game, attached to a fact the live client just proved (`src/shared/champion-advice.ts`).

Five files carry one as of 2026-09-11 — `_default`, `belveth`, `leesin`, `lillia` and `trundle` —
and no counterpart file does, because the clauses are keyed to the PLAYER's champion and one in a
counterpart file would never be read. `gwen.md` deliberately does not have one either: the shipped
mode is `trusted`, which takes the prose and strips this section, so a Gwen clause set would change
nothing about what he actually hears and would owe the bet register two dozen new entries.

**The tagged clauses are read only by the two ranked coach modes**, `cite-or-quiet` and `fenced`.
The default `trusted` mode strips this section and takes the prose above it entire — it is prose
for a reader, not clauses for a parser. So the digit fence below is a property of the CLAUSE
PATH, not of champion knowledge: the prose may carry numbers and always could. Keep the clause
sections on disk byte-identical anyway, because the stored runs that justified those two modes
are only meaningful while the text they were given still exists.

The format is `<fact kind>: <clause>`, one per line, and the rules are hard:

- **Keyed by fact kind**, so a clause can only be said once the client has established the
  situation it is about. Unknown keys are ignored rather than trusted.
- **No digits.** A clause with a number in it is refused at load time, and a spelled-out number
  used as a game fact is the same fabrication with the fence walked around.
- **A clause completes a sentence the client started** — "Kayn just finished Sunfire — *your clear
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
