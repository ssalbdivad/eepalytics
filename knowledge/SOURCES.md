# Where champion facts come from, and what was probed and found empty

Champion knowledge is FETCHED. `scripts/fetch-champions.ts` reads the sources below, caches them
under `data/champions/<patch>/` and generates `src/knowledge/champion-table.ts`; every record
carries a URL, a revision and a fetch time, and `src/knowledge/provenance.ts` re-derives every
rendered sentence from the bytes it came from before it may reach a prompt.

This page used to be a domain allowlist for an agent that went and read guides. That agent is
deleted. The allowlist survives as `TIER_HOSTS` in `provenance.ts`, where it is enforced by code
rather than by a person reading a pull request — a claim citing a host outside its tier's list is
refused, not flagged.

## Tier 1 — mechanics. Three publishers, and they must agree

| Source | What it supplies | Why it is trusted |
|---|---|---|
| `ddragon.leagueoflegends.com` | Ability identity and prose, cooldown/cost burn strings, base stats, the patch itself. | Riot's own data. Definitionally correct about what Riot shipped. |
| `wiki.leagueoflegends.com` — `Module:ChampionData/data` | The join table: apiname → page name → numeric id, base stats and growth, release and last-changed patch, client positions, the ability name in each slot. | It is what removes every hand-written name map. `MonkeyKing` → Wukong and `Belveth` → Bel'Veth resolve from data. |
| `wiki.leagueoflegends.com` — `Template:Data <Champion>/<Ability>` | Cast time, queue threshold, missile speed, effect radius, width, targeting, damage classification, spell-shield behaviour, exact CC durations, unit modifiers, and the per-ability interaction notes. | None of it exists in any Riot endpoint, and it is the layer that decides whether a coaching line is true. |

**The validation is the point.** For every ability slot the fetcher checks that Data Dragon and the
wiki agree on the NAME, the COOLDOWN per rank and the COST per rank — 660 of 692 slots do. A slot
that disagrees keeps its prose, loses every number, and says out loud that the number was withheld.
A disagreement means a patch landed mid-fetch or one source is stale, and **shipping either one
alone is how a wrong number sounds like a right one.**

Community Dragon is read only for per-rank cooldown arrays. Its `effectAmounts` came back
zero-filled when probed, and a zero that looks like a measurement is worse than a gap.

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
See `knowledge/README.md`.
