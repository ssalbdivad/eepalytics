#!/usr/bin/env bash
#
# Install (or refresh) the fawnsei systemd --user unit.
#
#   bash scripts/install-service.sh            # install + enable + start
#   bash scripts/install-service.sh --no-start # install + enable only
#
set -euo pipefail

REPO="$(dirname "$(dirname "$(readlink -f "$0")")")"
UNIT_SRC="$REPO/systemd/fawnsei.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_DST="$UNIT_DIR/fawnsei.service"

if ! command -v systemctl >/dev/null 2>&1; then
	echo "systemctl not found. Run the daemon directly instead:" >&2
	echo "  $REPO/scripts/run-daemon.sh" >&2
	exit 1
fi

echo "==> repo:  $REPO"
mkdir -p "$UNIT_DIR"
chmod +x "$REPO/scripts/run-daemon.sh"

# %h expands to the user's home, so the unit is portable, but WorkingDirectory must point at
# THIS checkout — which may not be ~/fawnsei.
sed -e "s#%h/fawnsei#$REPO#g" "$UNIT_SRC" >"$UNIT_DST"
echo "==> wrote $UNIT_DST"

# Lingering is what lets the unit run without an interactive login. It is already enabled on
# this machine; check rather than assume, and never fail the install over it.
if command -v loginctl >/dev/null 2>&1; then
	if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" = "yes" ]; then
		echo "==> lingering: enabled"
	else
		echo "==> lingering: NOT enabled — the daemon will stop when your last session ends."
		echo "    enable it with:  sudo loginctl enable-linger $USER"
	fi
fi

systemctl --user daemon-reload
systemctl --user enable fawnsei.service
echo "==> enabled"

if [ "${1:-}" != "--no-start" ]; then
	systemctl --user restart fawnsei.service
	sleep 1
	systemctl --user --no-pager --lines=0 status fawnsei.service || true
fi

cat <<'TIPS'

  logs:     journalctl --user -u fawnsei -f
  stop:     systemctl --user stop fawnsei
  disable:  systemctl --user disable --now fawnsei
  UI:       http://127.0.0.1:7700

  WSL2 caveat: lingering starts the unit once WSL boots, but it cannot make Windows boot WSL.
  For daemon-on-login, add a shortcut in `shell:startup` running:
      wsl.exe -d Ubuntu -u $USER --exec /bin/true
TIPS
