#!/usr/bin/env bash
# End-to-end test of X11 apps that move their own windows (XMoveWindow), with scripts/e2e/x11-move-client.c (built
# here with gcc): starts the gateway in dev-auth mode on $GATEWAY_PORT, signs in in a headless browser
# (scripts/e2e/browser-driver.js), starts a session and, from the Apps menu:
#   1. launches a borderless square that drags itself: it moves itself on every pointer motion while button 1 is held,
#      and the window follows (the server takes the position the app asks for, the viewer shows it), over a slow link
#      (scenes held back) too, never jumping to where the pointer didn't put it;
#   2. launches a window that moves itself back and forth on a timer and resizes it from our frame meanwhile: while
#      the resize is dragged the window stays exactly where the pointer puts it (the app's moves happen on the server,
#      not on screen), and after the release it ends where it was dragged to, at the new size (the viewer's move is the
#      last word).
#
# Requires: gcc, libx11-dev, Xwayland, playwright-cli (for its Playwright library and browser), curl, node, the built
# packages (yarn build). Usage: scripts/e2e/x11-move.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc Xwayland playwright-cli curl node

gcc -O2 -o "$WORK/x11-move-client" "$E2E_DIR/x11-move-client.c" -lX11 || fail "couldn't build the test client (libx11-dev?)"
mkdir -p "$WORK/data/applications" "$WORK/config"
# (each logging to a file of ours, through a script: desktop entries' Exec doesn't do redirections)
cat >"$WORK/run-drag" <<EOF
#!/bin/sh
exec "$WORK/x11-move-client" drag >"$WORK/drag.log" 2>&1
EOF
cat >"$WORK/run-wander" <<EOF
#!/bin/sh
exec "$WORK/x11-move-client" wander "$WORK/wander.flag" >"$WORK/wander.log" 2>&1
EOF
chmod +x "$WORK/run-drag" "$WORK/run-wander"
cat >"$WORK/data/applications/test-self-drag.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Self Drag Probe
Exec=$WORK/run-drag
EOF
cat >"$WORK/data/applications/test-self-wander.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Self Wander Probe
Exec=$WORK/run-wander
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)
pointer_at() { pw mousemove $((DESK_X + $1)) $((DESK_Y + $2)) >/dev/null; }

# $1: the app's desktop entry, $2: its name
launch() {
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"$1\"]') && document.activeElement.id === 'apps-search'" "$1 in the Apps menu"
  pw type "$2" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === '$1'" "searching for $1"
  pw press Enter >/dev/null
  wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
}
# an expression of `w`, the viewer's window with this title
win() { pw_eval "() => { const w = window.__viewerTest.windows().find((w) => w.title === '$1'); return w ? ($2) : null }"; }
win_is() { echo "() => { const w = window.__viewerTest.windows().find((w) => w.title === '$1'); return !!w && !!($2) }"; }
# the shown geometry of the window, "x y width height" (output coordinates)
geometry_of() { win "$1" "[w.shownGeometry.x, w.shownGeometry.y, w.shownGeometry.width, w.shownGeometry.height].join(' ')" | tr -d '"'; }
settled() { echo "() => !window.__viewerTest.interaction() && !Object.keys(window.__viewerTest.animations()).length && !window.__viewerTest.resizing()"; }
# how often the app moved itself (its log's "moved" lines)
moves() {
  local count
  count="$(grep -c moved "$WORK/$1.log" 2>/dev/null)"
  echo "${count:-0}"
}

# ---------------------------------------------------------------------------------------------------------------------

step "a borderless square that drags itself (XMoveWindow on every motion) follows the pointer"
launch test-self-drag.desktop "Self Drag Probe"
wait_for "$(win_is 'Self Drag' 'w.placed && w.hasContent && !w.decorated')" "the square" 20
wait_for "$(settled)" "the window to settle" 5
read -r GX GY GW GH < <(geometry_of 'Self Drag'; echo)
# a slow link: scenes reach the viewer 150 ms late, so it shows the square a while behind where the app moved it (the
# pointer's position on the square must still be by where X11 has it, or the app sees the pointer off by its last move
# and jumps there: the square would flicker to places the pointer never put it)
pw_eval "() => { window.__viewerTest.delayScenes(150); return true }" >/dev/null
pw_eval "() => { const t = window.__dragTrace = { at: new Set(), on: true }; const tick = () => { const w = window.__viewerTest.windows().find((w) => w.title === 'Self Drag'); if (w) t.at.add(w.x + ',' + w.y); if (t.on) requestAnimationFrame(tick) }; tick(); return true }" >/dev/null
pointer_at $((GX + 100)) $((GY + 100))
pw mousedown >/dev/null
for step in $(seq 1 12); do
  pointer_at $((GX + 100 + step * 5)) $((GY + 100 + step * 3))
done
# the app asks, the server moves it, the scene shows it (no viewer interaction is involved)
wait_for "$(win_is 'Self Drag' "w.x === $((GX + 60)) && w.y === $((GY + 36)) && w.shownGeometry.x === $((GX + 60)) && w.shownGeometry.y === $((GY + 36))")" "the square to follow the pointer to $((GX + 60)),$((GY + 36)) (it's at $(geometry_of 'Self Drag'))" 10
pw mouseup >/dev/null
[ "$(pw_eval "() => window.__viewerTest.interaction()")" = null ] || fail "the viewer started an interaction of its own"
AT="$(pw_eval "() => { window.__dragTrace.on = false; window.__viewerTest.delayScenes(0); return [...window.__dragTrace.at].join(' ') }" | tr -d '"')"
for position in $AT; do
  ok=0
  for step in $(seq 0 12); do
    [ "$position" = "$((GX + step * 5)),$((GY + step * 3))" ] && ok=1
  done
  [ "$ok" = 1 ] || fail "the square was at $position, where the pointer never put it (it went: $AT)"
done
echo "    moved itself $(moves drag) times, from $GX,$GY to $((GX + 60)),$((GY + 36)), only where the pointer put it: $AT"
echo "    ok"

step "a window that moves itself while it's being resized from our frame: the pointer decides, and the release"
launch test-self-wander.desktop "Self Wander Probe"
wait_for "$(win_is 'Self Wander' 'w.placed && w.hasContent && w.decorated && w.activated')" "the wandering window" 20
wait_for "$(settled)" "the window to settle" 5
read -r GX GY GW GH < <(geometry_of 'Self Wander'; echo)
# the east resize margin, a few pixels right of the border
MX=$((DESK_X + GX + GW + 3))
MY=$((DESK_Y + GY + GH / 2))
pw mousemove "$MX" "$MY" >/dev/null
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.interaction() === 'resize'" "the resize to start" 5
pw mousemove $((MX + 40)) "$MY" >/dev/null
pw mousemove $((MX + 80)) "$MY" >/dev/null
EXPECTED="$GX $GY $((GW + 80)) $GH"
wait_for "$(win_is 'Self Wander' "[w.shownGeometry.x, w.shownGeometry.y, w.shownGeometry.width, w.shownGeometry.height].join(' ') === '$EXPECTED'")" "the window to be stretched to $EXPECTED" 5
# record where the window is shown on every animation frame while the app moves it
pw_eval "() => { const t = window.__wanderTrace = { shown: new Set(), server: new Set(), on: true }; const tick = () => { const w = window.__viewerTest.windows().find((w) => w.title === 'Self Wander'); if (w) { const g = w.shownGeometry; t.shown.add([g.x, g.y, g.width, g.height].join(' ')); t.server.add(w.x + ',' + w.y) } if (t.on) requestAnimationFrame(tick) }; tick(); return true }" >/dev/null
BEFORE="$(moves wander)"
touch "$WORK/wander.flag"
wander_moved() { [ "$(($(moves wander) - BEFORE))" -ge 8 ]; }
wait_until "the app to move itself (8 moves)" 10 wander_moved
# the server has the app's positions, at least one of them 40 px right of where it was
wait_for "() => [...window.__wanderTrace.server].includes('$((GX + 40)),$GY')" "the server to move the window as the app asks (server positions: $(pw_eval "() => [...window.__wanderTrace.server].join(' ')"))" 5
rm -f "$WORK/wander.flag"
[ "$(pw_eval "() => { window.__wanderTrace.on = false; return [...window.__wanderTrace.shown].join(' | ') }")" = "\"$EXPECTED\"" ] ||
  fail "the window didn't stay where the resize puts it while the app moved it: $(pw_eval "() => [...window.__wanderTrace.shown].join(' | ')")"
echo "    the app moved itself $(($(moves wander) - BEFORE)) times; the server had it at $(pw_eval "() => [...window.__wanderTrace.server].join(' ')"), shown at $EXPECTED throughout"
pw mouseup >/dev/null
wait_for "$(settled)" "the resize to settle" 10
# where it was dragged to, at the new size, and the server agrees (the viewer's move came after the app's)
wait_for "$(win_is 'Self Wander' "[w.shownGeometry.x, w.shownGeometry.y, w.shownGeometry.width, w.shownGeometry.height].join(' ') === '$EXPECTED' && w.x === $GX && w.y === $GY && w.geometry.width === $((GW + 80))")" "the window to end at $EXPECTED with the server agreeing (shown $(geometry_of 'Self Wander'), server $(win 'Self Wander' "w.x + ',' + w.y"), app $(win 'Self Wander' "w.geometry.width + 'x' + w.geometry.height"))" 10
echo "    ok"

echo "PASS: X11 apps moving their own windows: a square dragging itself, a window moving itself while being resized"
