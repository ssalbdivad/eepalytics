# analytics prototype

Reference implementations for `.research/analytics.md`. Python 3, deps: `pillow`, `numpy`
(only for `heat.py`). These are *evidence artifacts*, not production code — port the algorithms
to TypeScript per the spec.

## Expected data layout

`sr.py` resolves `BASE` to its parent directory and expects:

```
<BASE>/games/<gameId>.json   # GET /lol-match-history/v1/games/{gameId}
<BASE>/tls/<gameId>.json     # GET /lol-match-history/v1/game-timelines/{gameId}
```

Fetch them with (note the `|| true` — the lockfile has no trailing newline):

```bash
{ IFS=':' read -r n pid port pass proto < "/mnt/c/Games/Riot Games/League of Legends/lockfile" || true; }
CURL=/mnt/c/WINDOWS/system32/curl.exe
mkdir -p games tls
$CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20" -o mh.json
for id in $(python3 -c "import json;print(' '.join(str(g['gameId']) for g in json.load(open('mh.json'))['games']['games']))"); do
  $CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-match-history/v1/games/$id"          -o games/$id.json
  $CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-match-history/v1/game-timelines/$id" -o tls/$id.json
done
```

`sr.py` hard-codes `PUUID` for Gooskaffur#NA1 — change it for another account.

## Files

- `sr.py` — geometry (`uv`, `lane_dist`, `zone`, `side_half`), interpolation
  (`interp_pos`, `interp_scalar`, `step_scalar`), role inference (`infer_roles`).
- `moments.py` — teachable-moment mining and ranking. `python3 moments.py <gameId>`.
  **Known gap:** does not yet exclude game-ending deaths (spec §8.3 rule 4).
- `heat.py` — heatmap renderer. Needs `map11.png`:
  `curl -o map11.png https://ddragon.leagueoflegends.com/cdn/16.17.1/img/map/map11.png`
- `calib.png` — the 14 turret/pit anchors rendered onto map11.png. This is the visual proof
  that the world→pixel transform and the y-flip are correct.
- `heat_deaths.png` — 112 real deaths, 22 games.
- `heat_presence.png` — 666 position samples, 22 games.
