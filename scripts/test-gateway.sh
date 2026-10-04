#!/usr/bin/env bash
# End-to-end test of the gateway: runs the independent scripts in scripts/e2e/ in parallel, each with its own gateway
# on its own ports, state and browser, and fails if any of them does. A run takes well under a minute.
#
#   scripts/e2e/auth.sh      login and isolation: no leaks, failed-login timing and throttling, access control,
#                            per-page sign-ins, plaintext mode (curl and WebSocket probes, no browser);
#   scripts/e2e/desktop.sh   the desktop in a headless browser: sign-in, Apps menu, taskbar, notifications, window
#                            management, surviving the browser and reattaching, session list, logging out;
#   scripts/e2e/clipboard.sh the clipboard between the browser and a remote app (foot), both ways;
#   scripts/e2e/dnd.sh       drag and drop between remote apps (a small test client built with gcc);
#   scripts/e2e/x11.sh       X11 apps (XWayland) in a headless browser: their windows, input, menus, closing.
#
# Each can also be run on its own (they take GATEWAY_PORT). They start the gateway with --dev-auth --dev-time-scale,
# which shortens its sign-in delays; see the header of scripts/e2e/auth.sh. Requires foot, dbus-daemon, notify-send,
# Xwayland and x11-utils (xev, xfontsel, xwininfo), playwright-cli (for its Playwright library and Chrome), curl,
# node, and the built packages (yarn build).
#
#   scripts/test-gateway.sh
# The first of the ports used can be changed with GATEWAY_PORT (default 8098; auth uses it and the next one, desktop
# and x11 the ones two and four after it, clipboard six, dnd eight).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e"
BASE_PORT="${GATEWAY_PORT:-8098}"
START="$EPOCHREALTIME"

pids=()
names=()
i=0
for part in auth desktop x11 clipboard dnd; do
  port=$((BASE_PORT + i * 2))
  i=$((i + 1))
  # prefix every line with the script's name; the exit status is the script's, not sed's
  (
    set -o pipefail
    GATEWAY_PORT="$port" timeout 120 bash "$DIR/$part.sh" 2>&1 | sed -u "s/^/[$part] /"
  ) &
  pids+=("$!")
  names+=("$part")
done

# stop whatever is left if we're interrupted (each script cleans up after itself on SIGTERM)
trap 'kill "${pids[@]}" 2>/dev/null; exit 130' INT TERM

status=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "FAILED: ${names[$i]}" >&2
    status=1
  fi
done

seconds=$(((${EPOCHREALTIME/./} - ${START/./}) / 10000))
printf 'all end-to-end scripts took %d.%02d s\n' $((seconds / 100)) $((seconds % 100))
if [ "$status" = 0 ]; then
  echo "PASS: login, isolation checks, per-page sign-in, session survival, desktop shell, window management, renaming, logging out, X11 apps, the clipboard and drag and drop"
fi
exit "$status"
