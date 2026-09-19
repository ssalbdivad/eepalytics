# Where champion facts come from, and what was probed and found empty

Champion knowledge is FETCHED. `scripts/fetch-champions.ts` reads the sources below, caches them
under `data/champions/<patch>/` and generates `src/knowledge/champion-table.ts`; every record
carries a URL, a revision and a fetch time, and `src/knowledge/provenance.ts` re-derives every
rendered sentence from the bytes it came from before it may reach a prompt.

This page used to be a domain allowlist for an agent that went and read guides. That agent is
deleted. The allowlist survives as `TIER_HOSTS` in `provenance.ts`, where it is enforced by code
rather than by a person reading a pull request — a claim citing a host outside its tier's list is
refused, not flagged.

## Tier 1 — mechanics. Two publishers over three endpoints, and where they overlap they must agree

| Source | What it supplies | Why it is trusted |
|---|---|---|
| `ddragon.leagueoflegends.com` | Ability identity and prose, cooldown/cost burn strings, base stats, the patch itself. | Riot's own data. Definitionally correct about what Riot shipped. |
| `wiki.leagueoflegends.com` — `Module:ChampionData/data` | The join table: apiname → page name → numeric id, base stats and growth, release and last-changed patch, client positions, the ability name in each slot. | It is what removes every hand-written name map. `MonkeyKing` → Wukong and `Belveth` → Bel'Veth resolve from data. |
| `wiki.leagueoflegends.com` — `Template:Data <Champion>/<Ability>` | Cast time, queue threshold, missile speed, effect radius, width, targeting, damage classification, spell-shield behaviour, exact CC durations, unit modifiers, and the per-ability interaction notes. | None of it exists in any Riot endpoint, and it is the layer that decides whether a coaching line is true. |

**The validation is the point.** Where Data Dragon publishes a slot, the fetcher checks that it and
the wiki agree on the NAME, the COOLDOWN per rank and the COST per rank — **662 of 692 slots do**
(660 until 2026-09-19, when two of the thirty "conflicts" turned out to be Riot's pipe separator
rather than a real divergence). A slot that disagrees keeps its prose, loses every number, and says
out loud, in the champion's own file, that the number was withheld. A disagreement means a patch
landed mid-fetch or one source is stale, and **shipping either one alone is how a wrong number
sounds like a right one.**

**692 is not every ability, and that gap is the honest limit of this page.** The table carries 937
abilities. Data Dragon publishes one spell per slot, so the cross-check reaches the FIRST form of
each of the 692 non-passive slots and no further: the other **245** — 181 passives and 64
second-form abilities like Lee Sin's Resonating Strike or Elise's spider-form Q — are transcribed
from the wiki alone and were never compared with anything. Their delivered lines are honest about
it, because the citation on each one names the single wiki revision it came from
(`- cost: 25 [wiki-q2 rev-4026428, fetched 2026-09-18]`). What is NOT honest is the ledger behind
them: `claims-from-row.ts` sets `agreed` from "no conflict was recorded", which is vacuously true
when nobody looked, so **294 claims (245 names, 29 cooldowns, 20 costs) are minted carrying
`agreesWith: ["ddragon"]` where Data Dragon said nothing at all**. `agreesWith` never reaches a
prompt — it is only read by the `crossChecked` gate in `provenance.ts` — so no player has been told
a wrong thing by it. It means the gate is weaker than its name. Fixing it is a one-line change in
`claims-from-row.ts`: carry "was a second source consulted" as its own field rather than inferring
it from an empty conflict list.

**Community Dragon supplies no champion facts.** It is in `TIER_HOSTS` and it is fetched by
`src/server/routes/assets.ts` for champion ART. `scripts/fetch-champions.ts` never calls it: the
five fetches are the wiki module, Data Dragon `championFull.json`, the wiki's per-ability
`Template:Data` pages, Data Dragon's rune and summoner names, and op.gg. This page said "Community
Dragon is read only for per-rank cooldown arrays" until 2026-09-19 and that was left over from a
probe, not from the pipeline.

## Tier 2 — what real games did. One endpoint, fenced hard

`lol-api-champion.op.gg` supplies win rate, skill order, rune pages, item builds, boots, starters,
summoner spells, matchup win rates, per-patch trends and win rate by game length — all as COUNTS
with their sample sizes, per role and per rank bracket.

It is undocumented and grants no terms, so it is validated with ArkType at the boundary and fails
closed **per champion**: if any tier-2 claim for a champion fails its check, every tier-2 claim for
that champion is dropped. Half a meta section is worse than none, because nothing in the payload
says which half moved. Every tier-2 figure must also carry its sample size or it cannot ship.

What op.gg publishes is **what is picked and what wins, never why**. It says Lillia loses 53% into
Shyvana. It says nothing at all about what to do about that, and the gap between those two is
exactly where a model starts writing coaching out of its own head.

## Probed and REFUTED — do not re-try these without new evidence

| Source | Result, 2026-09-18 |
|---|---|
| `raw.communitydragon.org` (`effectAmounts`) | Probed as a third tier-1 transcription for per-rank cooldown arrays. Came back ZERO-FILLED, and a zero that looks like a measurement is worse than a gap. Not read by `fetch-champions.ts`; CDragon is still fetched for champion ART by `src/server/routes/assets.ts`. |
| `stats2.u.gg` | HTTP 403 on three path shapes; `u.gg/api/champion/<id>` returns 400. |
| `lolalytics.com` (`ax.*`) | 404 behind a Cloudflare JS challenge; `axe.*` fails DNS. |
| `mobalytics.gg` | GraphQL returns 403; needs POST plus auth. |
| `blitz.gg` (`league-champion-aggregate.iesdev.com`) | DNS failure. |
| `jungler.gg` | No machine-readable endpoint found. |
| Riot `allytips` / `enemytips` | Present in the schema and EMPTY for Lillia on 16.18.1. Riot stopped populating them. |
| op.gg "jungle-paths" | **Does not exist.** `lillia.md` cited it as the source for its routes. Three plausible endpoint shapes probed: two 404, the third ignored the parameter and returned the ordinary payload. No key in op.gg's 17KB response matches path, route or camp. |

## Unsourceable — no publisher, therefore no ship

Probed for and not found anywhere. These were roughly half of the deleted prose corpus by bytes,
and they are now simply absent from every prompt:

- **jungle clear routes and pathing order** — the largest single category of the old files, and the
  one whose citation was fabricated;
- **gank-failure conditions** per champion;
- **item-to-intent inference** — op.gg says which items are bought and how often they win; nothing
  licenses "he bought X, therefore he intends Y";
- **clear tempo** — no source publishes clear times or camp order per champion;
- **objective-pressure narrative**, **power-spike timing** (op.gg's game-length curve is the
  nearest real evidence and it is far weaker than the prose claimed), and **matchup advice** as
  distinct from matchup win rate;
- **death-location patterns** — this is the app's own telemetry territory. It belongs in the stored
  timelines, not in a knowledge base.

The one channel that may carry this material is `knowledge/owner/<champion>.md`, and only from him.
The directory does not exist yet — `ownerDirDigest` returns the digest of nothing and
`champion-brief.test.ts` pins that, so the first file to appear there fails the suite and whoever
added it has to say so in a diff. See `knowledge/README.md`.

## Re-deriving this, and the one thing that is not offline

Every source above is cached under `data/champions/<patch>/` (op.gg and the wiki module under
`data/champions/wiki/`), and `scripts/fetch-champions.ts` reads the cache unless given `--refresh`.
So a re-run with a warm cache is a pure function of those bytes — which is what makes
"byte-identical across two consecutive runs" checkable rather than a boast.

One call is unconditional and therefore the pipeline cannot be re-derived with the network off:
`main()` fetches Data Dragon's `versions.json` before it reads `--patch`, even when `--patch` names
the patch already on disk. Moving that fetch behind the `--patch` check is a two-line change and is
on the list.

The generate half IS offline and IS verified continuously: `pnpm generate:context` reads the
committed table and writes `knowledge/context/`, and `src/knowledge/champion-context.test.ts`
regenerates the whole tree into a temp directory and diffs it against what is committed, in both
directions. 353 files, 4,691,665 bytes, patch 16.18.1 — the counts `knowledge/context/MANIFEST.json`
records, beside the sha256 of the tree.
