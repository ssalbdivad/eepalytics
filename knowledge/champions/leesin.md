patch: 16.17
sourcedAt: 2026-09-03
source: op.gg — Lee Sin jungle build and counters pages, both stating patch 16.17, Emerald+ (193,824 games on the primary setup; matchup tables list per-matchup game counts); u.gg — Lee Sin jungle guide, stating patch 16.17, Emerald+, 225,404 games; lolalytics — Lee Sin build page, stating patch 16.17, Emerald+, 225,919 games; jungler.gg — Lee Sin pathing page, which labels itself patch 26.16 (Riot's own numbering; the stat sites' "16.17" corresponds to Riot's "26.17", released 2026-08-25 — the jungler.gg routes are therefore one patch stale and are flagged as such below); leagueoflegends.com — League of Legends Patch 26.17 notes (2026-08-25); ddragon.leagueoflegends.com 16.17.1 — LeeSin.json, for ability roles. The `WHEN/DO/WHY` rules are model-knowledge applied to those facts.
---

# Lee Sin, jungle — patch 16.17

## The states this file keys off

His level and HP; the clock; who is dead and for how long; alive counts; kill events with killer,
victim and assisters; the champion names on both teams; towers falling; inventories when the live
client is publishing them. Nothing here keys off cooldowns, ward positions or where anyone is
standing — the client does not publish those, and R's cooldown numbers below are the champion's
tuning, never a claim that his R is up.

## How to use this file

Rules read `WHEN <observable> → DO <action> — WHY <reason>`. **A trigger you cannot see did not
fire.** Thresholds here are for comparing against the block, never for saying out loud. The file
reads from both sides, because he plays this champion *and* meets it: **Playing him** and
**Against him** are marked separately.

## Where he sits this patch

Riot did not touch Lee Sin in the 26.17 notes, and did not touch jungle monsters, Smite, or any
objective (Baron, Atakhan, Rift Herald, drakes, Voidgrubs). Nothing about his clear or his
objective math changed from the previous patch — if a habit worked last patch, it still works, and
if it didn't, the patch is not the reason.

He is one of the most-contested junglers in the pool: op.gg has him at 13.71% pick and 17.03% ban
across its 16.17 Emerald+ sample, u.gg at 13.6% pick and 16.75% ban across 225,404 games. His win
rate sits near even — 49.25% on op.gg, 50.93% on u.gg and lolalytics, against a 51.73% Emerald+
average win rate. Read that as: he is played constantly and wins about as often as a coin flip, so
the gap between a good Lee Sin game and a bad one is almost entirely in decisions, not in the
champion.

## What the kit wants (roles only)

- **Q (Sonic Wave / Resonating Strike)** is a 1100-range skillshot that must *land* before the
  second cast exists. The recast dashes to the target and scales with their missing health, so its
  value goes up the longer a target has been fought. Every gap-close, dive and escape is downstream
  of a landed Q.
- **W (Safeguard / Iron Will)** dashes to an ally at 700 range and shields both; the recast turns
  him into a sustain unit for a few seconds. It is why a losing Lee Sin still contributes: a
  targeted dash and a shield for the carry.
- **E (Tempest / Cripple)** is a 450-range shockwave that *reveals* what it hits, and the recast
  slows it. In a chase it is information plus a slow, not damage.
- **R (Dragon's Rage)** kicks a champion backward and damages anyone the body passes through.
  110/85/60s cooldown, 375 range. His only hard displacement and his only way to remove one enemy
  from a fight.

Practical shape: **he must be in melee range to do anything, and getting there costs a landed
skillshot.** Every fight he takes should be one he chose, from a side nobody was watching.

## Clears and routes

jungler.gg's pathing data (page labeled patch 26.16, one patch behind, so treat the percentages as
approximate and the *shape* as reliable) shows no dominant route:

- **Blue → Gromp → Wolves → Raptors → Red → Krugs → Scuttle** — most-played at 9%, 52.9% win rate.
- **Red → Krugs → Raptors → Wolves → Blue → Gromp → Scuttle** — 6.1% of games, 48.2% win rate.
- **Blue → Gromp → Wolves → Raptors → Red → Krugs → Gank Bot** — 5.7%, 50.5%.

Two things to take from it. The highest-played and highest-winrate route is a **full six-camp clear
before the first real play**. And the top routes differ only in *what happens after the sixth camp*
— scuttle contest or bot gank. That is the actual decision, and it should come from where the
enemy jungler was last seen, not from habit.

## Spikes and what he wants from a fight

- **Level 3** is the first threshold: Q → recast → E exists, and the top routes are built to reach
  a gank or a scuttle with it online.
- **Level 6** is the largest single jump, because R is his only displacement. Before 6 he is a
  ganker; at 6 he is a playmaker. At rank 1 the cooldown is long enough that an R spent on a solo
  kick that secures nothing is roughly two minutes without his best ability.
- He wants **to arrive from an angle nobody is facing, on a target that is already damaged**, with
  a teammate close enough to follow up. A 5v5 he walks into from the front is his worst case: no
  range, no safety, and an escape that needs something to escape *to*.

## Playing him — commit, or leave

- **WHEN** his level is 6 or higher and a fight is happening at an objective → **DO** the R is
  worth more as a displacement into his own team than as a gap-closer → **WHY** it is the only
  hard CC he owns, and using it to arrive is spending the fight-winning button on transport.
- **WHEN** kill events show a target has already been fought → **DO** that is the target; his
  damage grows with what is missing → **WHY** the recast scales on missing health, so the second
  person into a fight does more than the first.
- **WHEN** he is on their side of the map and cannot say where their jungler is → **DO** leave
  before contact → **WHY** his disengage is a resource he may already have spent; caught with it
  gone he has no exit at all.
- **WHEN** a gank lands and a tower or plates are within reach → **DO** take the structure →
  **WHY** lolalytics' 16.17 Emerald+ data shows first tower taken in 69.17% of his wins. A gank
  that ends with everyone walking away is a fraction of one that ends with a plate.
- **WHEN** he is behind on gold and the fight is already happening → **DO** he is still useful:
  the shield and the targeted dash do not scale with his own gold the way his damage does →
  **WHY** the losing version of this champion is a peeler, not a spectator.

## Against him

- **WHEN** the enemy Lee Sin is under level 6 → **DO** the fight he wants is a short one with a
  teammate nearby; refusing contact costs almost nothing before his ult exists.
- **WHEN** he has just used a big cooldown in a fight the block recorded → **DO** never assert the
  cooldown; the client does not publish it. Coach the position instead: he is only dangerous where
  he can reach something, and a corridor is where he reaches everything.
- **WHEN** an objective is up and he is unaccounted for → **DO** treat the pit as contested; he is
  the champion most able to arrive at a pit from a direction nobody is watching.

## Where he is vulnerable, and where deaths cost extra

- **He is committed the moment he dashes.** If there is nothing to dash to, an engage becomes a
  1vN with no exit.
- **He is an early-game champion at a near-even win rate**, so the games he does not convert early
  are the ones dragging the average down. Early deaths are unusually expensive for him: they cost
  the clear, the gank and the objective at once, and unlike a scaling jungler he has no later
  phase that returns the tempo.
- **Deaths in the enemy jungle, mid-clear, are the worst kind**, because his escape depends on
  having something to escape to.
- Dying with his ultimate spent means his team's next fights happen without the only displacement
  he owns.

## Matchups against other junglers

All three stat sites agree on the direction at 16.17, Emerald+.

**Hardest:** Rek'Sai (Lee Sin at 45.66% over 1,879 games on op.gg), Taliyah (45.75%, 1,130 games),
Aatrox (45.56%, 935 games). The common thread is junglers who either match his mobility and win
the melee trade outright, or contest from range without ever letting him close. Against these the
level-3 skirmish is the losing side of the coin flip — path away and take the camps they are not
at.

**Favored:** Zed (52.45% over 2,551 games on op.gg), Ambessa (54.17%, 864 games), and Viego. These
are the matchups where forcing early contact is correct. Also favourable with usable samples:
Warwick (2,331 games) and Trundle (748). Unfavourable with smaller samples: Karthus (1,066) and
Pantheon (1,057).

Treat a few hundred games as a hint, not a plan.

## Tells that a decision has gone wrong

- Kill events where he is the victim on the enemy side of the map, more than once — he is crossing
  without knowing what is there.
- Ganks landing with no structure following them — the tempo is being spent and not banked.
- A death immediately after a fight he started alone — the entry was the whole plan.

## The one-line version

Full-clear to six camps, then decide scuttle-or-gank off where the enemy jungler actually was;
land Q before committing anything else; spend R on isolating or displacing rather than on
travelling; and remember that a death on the wrong side of the map at minute 8 is the most
expensive thing this champion can do.
