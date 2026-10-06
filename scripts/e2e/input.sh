#!/usr/bin/env bash
# End-to-end test of input and X11 gaps (wave 3 H) in a headless browser (scripts/e2e/browser-driver.js): starts the
# gateway in dev-auth mode on $GATEWAY_PORT, signs in, starts a session and launches foot (logging its Wayland traffic)
# from the Apps menu, then:
#   1. scrolling: the wheel (Playwright's wheel is a 100 px click, deltaMode 0) reaches foot as one click (15 units, v120
#      120: foot's wl_pointer is too old for axis_value120, so axis_discrete 1) with the wheel source; a small pixel
#      delta (a touchpad) as smooth scrolling (finger source, no discrete value);
#   2. X11 apps started from foot's shell (xclock, xeyes): their windows come up, the taskbar shows xclock's own
#      _NET_WM_ICON when the app sets one (not every app does; reported either way);
#   3. logging out ends the X11 app started from the terminal (xeyes' process is gone), like foot itself.
#
# Requires: foot, xeyes, xclock (x11-apps), Xwayland, playwright-cli, curl, node, the built packages (yarn build).
# Usage: scripts/e2e/input.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools foot xeyes xclock Xwayland playwright-cli curl node

mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/data/applications/test-foot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Terminal
Exec=env WAYLAND_DEBUG=1 foot --app-id=test-foot
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in, starting a session and launching foot"
pw open "$BASE/?test=1" >/dev/null
browser_login
pw_eval "() => { document.querySelector('#new-session').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-foot.desktop\"]') && document.activeElement.id === 'apps-search'" "foot in the Apps menu"
pw type "Test Terminal" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-foot.desktop'" "searching for foot"
pw press Enter >/dev/null
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot window" 40
TERMINAL="$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; const s = w.surfaces.find((s) => s.id === w.id); return [w.id, w.shownX + s.x, w.shownY + s.y, s.width, s.height] }")"
read -r WINDOW_ID TX TY TW TH < <(echo "$TERMINAL" | tr -d '[]"' | tr ',' ' ')
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)
# click into foot: focus
wait_windows_still
pw mousemove $((DESK_X + TX + TW / 2)) $((DESK_Y + TY + TH / 2)) >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null

step "scrolling: wheel clicks are v120 values, a touchpad is smooth"
# foot's axis events (its WAYLAND_DEBUG log) after line $1 of the gateway log
axis_since() { tail -n +"$(($1 + 1))" "$WORK/gateway.log" | grep -ao 'wl_pointer@[0-9]*\.\(axis_value120\|axis_discrete\|axis_source\|axis\)([0-9, .-]*)'; }
log_end() { wc -l <"$WORK/gateway.log"; }
START="$(log_end)"
pw wheel 0 100 >/dev/null
# (foot binds wl_pointer below version 8, so wlroots turns the v120 value of 120 into the older axis_discrete 1; with a
# client of version 8 or later it's axis_value120(0, 120))
got_click() {
  axis_since "$START" | grep -aq 'axis_value120(0, 120)\|axis_discrete(0, 1)' && axis_since "$START" | grep -aq 'axis([0-9]*, 0, 15\.0*)$'
}
wait_until "foot to get a wheel click (15 units, axis_discrete 1 / axis_value120 120)" 10 got_click
axis_since "$START" | grep -aq 'axis_source(0)' || fail "a wheel click isn't the wheel source: $(axis_since "$START" | paste -sd' ' -)"
START="$(log_end)"
pw wheel 0 12 >/dev/null
got_smooth() { axis_since "$START" | grep -aq 'axis_source(1)'; }
wait_until "foot to get smooth scrolling (finger source)" 10 got_smooth
axis_since "$START" | grep -aq 'axis_value120\|axis_discrete' && fail "smooth scrolling carries a value120: $(axis_since "$START" | paste -sd' ' -)"
echo "    ok"

step "X11 apps started from foot's shell"
# run in the background: "&" is Shift+7 (typing it as a character doesn't hold Shift for the page). Both on one command
# line: a new window takes the keyboard focus, so a second command typed once the first app's window is up would go to
# that window instead of the shell.
pw type "xclock " >/dev/null
pw press Shift+7 >/dev/null
pw type " xeyes " >/dev/null
pw press Shift+7 >/dev/null
pw press Enter >/dev/null
wait_for "() => window.__viewerTest.windows().some((w) => w.title === 'xclock') && window.__viewerTest.windows().some((w) => w.title === 'xeyes')" "the xclock and xeyes windows" 20
# xclock and xeyes set no _NET_WM_ICON themselves: give xclock one with xprop (a 4x4 and a 6x6 icon (xprop takes at most 64 values), red and green),
# as an app that has one would, and wait for it on the window and in the taskbar
X11_DISPLAY="$(grep -ao 'DISPLAY=":[0-9]*"' "$WORK/gateway.log" | head -1 | cut -d'"' -f2)"
[ -n "$X11_DISPLAY" ] || fail "the session has no X11 display"
icon_property() {
  node -e 'const px = (n, argb) => [n, n, ...Array(n * n).fill(argb)]; console.log([...px(4, 0xffff0000), ...px(6, 0xff00ff00)].join(", "))'
}
XCLOCK_ID="$(DISPLAY="$X11_DISPLAY" xwininfo -name xclock | awk '/Window id:/ { print $4 }')"
DISPLAY="$X11_DISPLAY" xprop -id "$XCLOCK_ID" -f _NET_WM_ICON 32c -set _NET_WM_ICON "$(icon_property)"
wait_for "() => window.__viewerTest.shellWindows().some((w) => w.title === 'xclock' && /^data:image\\/png;base64,/.test(w.icon ?? ''))" "xclock's _NET_WM_ICON on its window" 10
wait_for "() => !!document.querySelector('#taskbar-items img[src^=\"data:image/png\"]')" "xclock's own icon in the taskbar" 10
echo "    ok"

# Our xeyes is the one that descends from this test's gateway (other xeyes, e.g. the user's own, aren't ours).
descends_from() {
  local pid="$1" ancestor="$2"
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
EYES_PID=""
for pid in $(pgrep -x xeyes -u "$ME" || true); do
  descends_from "$pid" "$GATEWAY_PID" && EYES_PID="$pid"
done
[ -n "$EYES_PID" ] || fail "xeyes isn't running"

step "logging out ends the X11 app started from the terminal"
click_element '#apps-button'
wait_for "() => $(visible apps-menu)" "the Apps menu" 5
click_element '#session-menu-button'
wait_for "() => !!document.querySelector('#session-menu button[data-action=logout]')" "the session menu" 5
click_element "#session-menu button[data-action=logout]"
wait_for "() => $(visible login-view)" "the sign-in form"
eyes_gone() { ! kill -0 "$EYES_PID" 2>/dev/null; }
wait_until "xeyes (pid $EYES_PID) to end after logging out" 15 eyes_gone
echo "    ok"

echo "PASS: wheel and touchpad scrolling, X11 apps started from a terminal, ended at logout"
