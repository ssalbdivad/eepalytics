#!/usr/bin/env bash
#
# Launcher for the fawnsei daemon, used by the systemd --user unit.
#
# It resolves node through nvm at RUN time rather than baking a path into the unit file: nvm
# rewrites ~/.nvm/versions/node/<version>/bin on every `nvm install`, so a hardcoded
# ExecStart path breaks on the next Node upgrade. A plain `node` on PATH also works.
#
set -euo pipefail

cd "$(dirname "$(dirname "$(readlink -f "$0")")")"

# systemd --user starts with a minimal environment and no login shell, so nvm must be sourced
# explicitly. `nvm.sh` is not executable and must be dot-sourced.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	# shellcheck disable=SC1091
	. "$NVM_DIR/nvm.sh" --no-use
	# Respect .nvmrc when present, otherwise take the default alias.
	if [ -f .nvmrc ]; then nvm use >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
	else nvm use default >/dev/null 2>&1 || true
	fi
fi

if ! command -v node >/dev/null 2>&1; then
	echo "fawnsei: no 'node' on PATH and nvm did not provide one." >&2
	echo "  tried NVM_DIR=$NVM_DIR" >&2
	exit 127
fi

# node:sqlite and --experimental-strip-types both need Node 25+.
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 25 ]; then
	echo "fawnsei: node $major is too old; node:sqlite and type stripping need >= 25." >&2
	exit 1
fi

# --experimental-strip-types: TypeScript runs directly, so there is no server build step.
# --no-warnings=ExperimentalWarning: node:sqlite and type stripping are both still flagged and
#   would otherwise write a warning block into the journal on every boot.
exec node \
	--experimental-strip-types \
	--no-warnings=ExperimentalWarning \
	src/daemon/main.ts "$@"
