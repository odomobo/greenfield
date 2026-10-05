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
#   scripts/e2e/x11.sh       X11 apps (XWayland) in a headless browser: their windows, input, menus, closing;
#   scripts/e2e/hidpi.sh     the viewer's device pixel ratio (2, 1.5, back to 1) reaches apps: foot renders at that scale;
#   scripts/e2e/input.sh     wheel and touchpad scrolling, X11 apps started from a terminal ending at logout, window icons.
#   scripts/e2e/video.sh     the viewer's video path: H.264 frames (x264enc, no session needed) are fed to the viewer: opaque and
#                            with alpha, cropping, colors, transparency, patches over video.
#   scripts/e2e/decorations.sh  window decorations: foot and X11 apps get our title bar (xdg-decoration, _MOTIF_WM_HINTS), moved,
#                            maximized, resized and closed by it, a GTK app keeps its own, the frame is crisp at pixel ratios 1 and 2.
#   scripts/e2e/x11-move.sh  X11 apps moving their own windows (a small test client built with gcc): a square dragging
#                            itself follows the pointer; a window moving itself while being resized stays where the
#                            pointer puts it and ends where it was dragged to.
#   scripts/e2e/busy.sh      a relentless client (a small test client built with gcc, committing a full frame on every
#                            frame callback) is shown as patches and paced, and foot stays responsive meanwhile.
#
# Each can also be run on its own (they take GATEWAY_PORT). They start the gateway with --dev-auth --dev-time-scale,
# which shortens its sign-in delays; see the header of scripts/e2e/auth.sh. Requires foot, dbus-daemon, notify-send,
# Xwayland, x11-utils (xev, xfontsel, xwininfo), gst-launch-1.0 with x264enc (video.sh), gcc, wayland-scanner and
# wayland-protocols (for the drag and drop test client), libx11-dev (for the X11 test client), playwright-cli (for its Playwright library and Chrome), curl,
# node, and the built packages (yarn build).
#
#   scripts/test-gateway.sh
# The first of the ports used can be changed with GATEWAY_PORT (default 8098; auth uses it and the next one, desktop
# and x11 the ones two and four after it, clipboard six, dnd eight, hidpi ten, input twelve, busy fourteen, video sixteen, decorations eighteen, x11-move twenty, audio twenty-two).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e"
BASE_PORT="${GATEWAY_PORT:-8098}"
START="$EPOCHREALTIME"

pids=()
names=()
i=0
for part in auth desktop x11 clipboard dnd hidpi input busy video decorations x11-move audio; do
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
  echo "PASS: login, isolation checks, per-page sign-in, session survival, desktop shell, window management, renaming, logging out, X11 apps, the clipboard, drag and drop, HiDPI, scrolling, X11 apps ending at logout, a busy client, the video path and audio"
fi
exit "$status"
