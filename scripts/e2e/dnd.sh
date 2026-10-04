#!/usr/bin/env bash
# End-to-end test of drag and drop (wave 3 E): starts the gateway in dev-auth mode on $GATEWAY_PORT, signs in in a
# headless browser (scripts/e2e/browser-driver.js), starts a session and launches a small test client
# (scripts/e2e/dnd-client.c, built here with wayland-scanner and gcc) from the Apps menu: two windows, a drag source and
# a drop target.
#   1. drag between remote apps: pressing on the source window starts the app's drag; the viewer shows the app's drag
#      icon at the pointer (surface content, following the pointer); moving over the target window and releasing drops
#      the text there (the target app reads it through the data offer and writes it to a file);
#   2. the drag is over afterwards: the viewer shows no icon, and a click on the source starts another drag.
#
# Requires: gcc, wayland-scanner (libwayland-dev), wayland-protocols, playwright-cli (for its Playwright library and
# browser), curl, node, the built packages (yarn build). Usage: scripts/e2e/dnd.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc wayland-scanner playwright-cli curl node

XDG_SHELL=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
[ -f "$XDG_SHELL" ] || fail "wayland-protocols is not installed ($XDG_SHELL)"
step "building the test client"
wayland-scanner client-header "$XDG_SHELL" "$WORK/xdg-shell-client-protocol.h"
wayland-scanner private-code "$XDG_SHELL" "$WORK/xdg-shell-protocol.c"
gcc -Wall -Wno-unused-result -I"$WORK" -o "$WORK/dnd-client" "$E2E_DIR/dnd-client.c" "$WORK/xdg-shell-protocol.c" \
  -lwayland-client || fail "couldn't build the test client"

mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/run-dnd" <<EOF
#!/bin/sh
exec "$WORK/dnd-client" "$WORK/dropped" >"$WORK/dnd.log" 2>&1
EOF
chmod +x "$WORK/run-dnd"
cat >"$WORK/data/applications/test-dnd.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Drag and Drop
Exec=$WORK/run-dnd
StartupWMClass=test-dnd
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in, starting a session and launching the test client"
pw open "$BASE/?test=1" >/dev/null
browser_login
pw_eval "() => { document.querySelector('#new-session').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-dnd.desktop\"]') && document.activeElement.id === 'apps-search'" "the app in the Apps menu"
pw type "Test Drag" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-dnd.desktop'" "searching"
pw press Enter >/dev/null
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 2 && w.every((w) => w.placed && w.hasContent) }" "both windows" 40
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)
pointer_at() { pw mousemove $((DESK_X + $1)) $((DESK_Y + $2)) >/dev/null; }
# where a window (by title) is, on the desktop: "x y"
window_at() { pw_eval "() => { const w = window.__viewerTest.windows().find((w) => w.title === '$1'); return Math.round(w.shownX) + ' ' + Math.round(w.shownY) }" | tr -d '"'; }
read -r SX SY < <(window_at dnd-source; echo)
read -r TX TY < <(window_at dnd-target; echo)
echo "    source at $SX,$SY, target at $TX,$TY (200x200 each)"
echo "    ok"

# the windows overlap (a cascade): press on a part of the source the target doesn't cover, release on a part of the
# target the source doesn't cover (the press raises the source above the target)
SOURCE_X=$((SX + 10)); SOURCE_Y=$((SY + 10))
TARGET_X=$((TX + 190)); TARGET_Y=$((TY + 190))

step "dragging from one window to another: the icon follows the pointer, the drop delivers the text"
pointer_at "$SOURCE_X" "$SOURCE_Y"
pw mousedown >/dev/null
wait_for "() => { const d = window.__viewerTest.drag(); return d !== null && !!d.icon && d.icon.width === 32 }" "the drag (with its icon)" 10
for i in 1 2 3 4 5; do
  pointer_at $((SOURCE_X + (TARGET_X - SOURCE_X) * i / 5)) $((SOURCE_Y + (TARGET_Y - SOURCE_Y) * i / 5))
done
wait_until "the target to be entered" 5 grep -q 'target entered' "$WORK/dnd.log"
pw mouseup >/dev/null
dropped_text() { [ "$(cat "$WORK/dropped" 2>/dev/null)" = "dragged text" ]; }
wait_until "the drop (file has: $(cat "$WORK/dropped" 2>/dev/null))" 10 dropped_text
wait_until "the drag to finish" 5 grep -q 'drag finished' "$WORK/dnd.log"
wait_for "() => window.__viewerTest.drag() === null" "the viewer to be told the drag is over" 5
echo "    ok"

step "after the drop: a new drag starts and a release over nothing cancels it"
rm -f "$WORK/dropped"
pointer_at "$SOURCE_X" "$SOURCE_Y"
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.drag() !== null" "the second drag" 10
pointer_at 600 500
pw mouseup >/dev/null
wait_until "the drag to be cancelled" 5 grep -q 'drag cancelled' "$WORK/dnd.log"
wait_for "() => window.__viewerTest.drag() === null" "the viewer to be told the drag is over" 5
[ ! -e "$WORK/dropped" ] || fail "text was dropped outside the target"
echo "    ok"

echo "PASS: drag and drop between remote apps: icon, drop, cancel"
