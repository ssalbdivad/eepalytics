#!/usr/bin/env bash
# Research one champion's notes. Usage: scripts/research-champion.sh "Bel'Veth"
#
# Lives in a file rather than being typed inline because `pkill -f <pattern>` and
# `pgrep -f <pattern>` match the shell running them when the pattern appears in that shell's own
# command line -- which silently kills the caller (exit 144). Keeping the pattern in a script
# keeps it out of the caller's argv.
set -uo pipefail
cd "$(dirname "$0")/.."
champ="${1:?usage: research-champion.sh <champion name>}"
log="${2:-data/logs/research.log}"

for pid in $(pgrep -f "output-format json --tools Web" 2>/dev/null); do
	[ "$pid" = "$$" ] && continue
	kill "$pid" 2>/dev/null || true
done

setsid nohup node --experimental-strip-types --no-warnings=ExperimentalWarning -e "
const {ensureChampionContext}=await import('./src/knowledge/research.ts');
console.log('refreshed:', await ensureChampionContext(process.argv[1]));
" "$champ" > "$log" 2>&1 < /dev/null &
echo "researching $champ -> $log"
