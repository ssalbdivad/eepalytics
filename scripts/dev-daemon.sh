#!/usr/bin/env bash
# Start/restart the daemon detached from this shell.
#
# `pkill -f src/daemon/main.ts` is a trap: the pattern matches the shell that is running the
# pkill, because the path appears in its own command line, so the restart kills its own caller
# (exit 144 = SIGTERM). Match on the interpreter flag instead and exclude this script's own PID.
set -u
cd "$(dirname "$0")/.."
for pid in $(pgrep -f "strip-types.*daemon/main" 2>/dev/null); do
	[ "$pid" = "$$" ] && continue
	kill "$pid" 2>/dev/null || true
done
sleep 2
setsid nohup node --experimental-strip-types --no-warnings=ExperimentalWarning \
	src/daemon/main.ts > data/logs/daemon-live.log 2>&1 < /dev/null &
sleep 6
curl -s -m 5 http://127.0.0.1:7700/api/health | head -c 200
echo
