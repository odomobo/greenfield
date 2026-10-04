#!/usr/bin/env bash
# End-to-end test of the desktop in a browser: sign-in, shell, window management, and a session surviving the browser.
#
# Starts the gateway in dev-auth mode (sessions run as the current user) with TLS on $GATEWAY_PORT, then, in a headless
# browser (scripts/e2e/browser-driver.js):
#   1. signs in (a second tab stays signed out), starts a session, launches foot from the Apps menu,
#      renames the session there, pins foot (kept in the config dir), minimizes and restores it from the taskbar,
#      maximizes and restores it down, shows a notification (notify-send) as a toast and in the history, types a
#      command; history.back() and the mouse's back button over the desktop don't leave the page (foot gets
#      BTN_SIDE); reloading asks to confirm first (dismiss keeps the page), then asks to sign in again and the old
#      token stops working; closes the browser, signs in again, finds the session listed, opens it by clicking its
#      row and checks the same window comes back with the earlier output, with foot still running, still pinned, and
#      the notification still in the history;
#   2. window management in the viewer: a resize follows the pointer immediately (without waiting for the server),
#      resizing from the left/top edge keeps the right/bottom edge in place, and shrinking the viewport moves a window
#      back into view;
#   3. Disconnect (in the Apps menu's session menu) goes back to the session list without signing in again; renaming
#      the session by clicking its name (a name with HTML in it shows as text, Escape cancels); signing out; Log out
#      (session menu) ends the session.
#
# The gateway gets its own D-Bus session bus (for notifications), config dir (pinned apps) and a test app
# (a .desktop file for foot with WAYLAND_DEBUG) in its own data dir. It runs with --dev-time-scale (see auth.sh).
#
# Requires: foot, dbus-daemon, notify-send, curl, node, playwright-cli (for its Playwright library and browser), the
# built packages (yarn build). Usage: scripts/e2e/desktop.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools foot dbus-daemon notify-send playwright-cli curl node

# the app the test launches from the Apps menu: foot logging its Wayland traffic, with an app_id of its own
mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/data/applications/test-foot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Terminal
GenericName=Terminal
Exec=env WAYLAND_DEBUG=1 foot --app-id=test-foot
Icon=foot
Categories=System;TerminalEmulator;
EOF
# a session bus of our own: notifications go to this test's session, not to whatever owns the user's bus
read -r DBUS_ADDRESS DBUS_PID < <(dbus-daemon --session --fork --nopidfile --print-address=1 --print-pid=1 | tr '\n' ' '; echo)
[ -n "$DBUS_PID" ] || fail "couldn't start a D-Bus session bus"
export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS"

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

# Click in the middle of an element (real pointer events). $1: a CSS selector.
click_element() {
  local center
  center="$(pw_eval "() => { const r = document.querySelector('$1').getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ' ' + Math.round(r.y + r.height / 2) }" | tr -d '"')"
  read -r CX CY <<<"$center"
  pw mousemove "$CX" "$CY" >/dev/null
  pw mousedown >/dev/null
  pw mouseup >/dev/null
}

# Signing in with a real click: the page needs user activation for its history guard and leave confirmation.
browser_login() {
  wait_for "() => $(visible login-view) && !!document.querySelector('#password')" "the sign-in form"
  pw_eval "() => { document.querySelector('#username').value = '$ME'; document.querySelector('#password').value = '$PASSWORD'; return true }" >/dev/null
  click_element '#login-submit'
  wait_for "() => $(visible sessions-view)" "the session list"
}

# Reload without waiting for the load (a "Leave site?" dialog may block it). $1: dialog-accept or dialog-dismiss
reload_with_dialog() {
  pw_eval "() => { setTimeout(() => location.reload(), 100); return true }" >/dev/null
  dialog_pending() { [ -n "$(pw dialog)" ]; }
  wait_until "the confirmation before leaving the signed-in page" 5 dialog_pending ||
    fail "no confirmation before leaving the signed-in page"
  pw "$1" >/dev/null
}

# Press and release a mouse button the Playwright API doesn't have (back/forward) at page coordinates.
cdp_click() {
  pw cdpclick "$1" "$2" "$3" >/dev/null
}

# Pixel helpers: readLuma values of the region of foot's first rows, as files.
# luma_diff <a> <b>: mean absolute difference of two such files
luma_diff() {
  node -e '
    const [a, b] = process.argv.slice(1).map((f) => JSON.parse(require("fs").readFileSync(f, "utf8")))
    console.log((a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length).toFixed(2))
  ' "$1" "$2"
}
read_luma() { pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$1"; }
# wait until the region stops changing (3 identical reads in a row); result in $1
settle_luma() {
  local out="$1" i same=0
  : >"$WORK/luma.prev"
  for i in $(seq 1 100); do
    read_luma "$out"
    if cmp -s "$out" "$WORK/luma.prev"; then
      same=$((same + 1))
      [ "$same" -ge 3 ] && return 0
    else
      same=0
    fi
    cp "$out" "$WORK/luma.prev"
    sleep 0.15
  done
}
# wait until the region is within $3 of the file $2 (mean luma difference), or 8 s; result in $1
wait_luma_near() {
  local out="$1" reference="$2" within="$3" i
  for i in $(seq 1 80); do
    read_luma "$out"
    [ "$(node -e "console.log(Number(process.argv[1]) <= Number(process.argv[2]) ? 1 : 0)" "$(luma_diff "$reference" "$out")" "$within")" = 1 ] && return 0
    sleep 0.1
  done
}
# The window animations are short; record which ones ran since this was called. Checked with animation_ran.
watch_animations() {
  pw_eval "() => { window.__ran = new Set(); clearInterval(window.__watcher); window.__watcher = setInterval(() => { for (const kind of Object.values(window.__viewerTest.animations())) window.__ran.add(kind) }, 5); return true }" >/dev/null
}
animation_ran() { wait_for "() => window.__ran.has('$1')" "the $1 animation" 5; }
no_animations() { echo "() => !Object.keys(window.__viewerTest.animations()).length"; }

step "signing in in the browser"
pw open "$BASE/?test=1" >/dev/null
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "unexpected sessions listed"

step "another tab is not signed in"
pw tab-new >/dev/null
pw goto "$BASE/" >/dev/null
wait_for "() => document.readyState === 'complete' && !!document.querySelector('#login-view')" "the second tab" 10
[ "$(pw_eval "() => $(visible login-view) && !$(visible sessions-view)")" = true ] || fail "the second tab is signed in"
pw tab-close >/dev/null
pw tab-select 0 >/dev/null
[ "$(pw_eval "() => $(visible sessions-view)")" = true ] || fail "the first tab was signed out"
echo "    ok"

step "starting a session"
pw_eval "() => { document.querySelector('#new-session').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
SESSION_ID="$(pw_eval "() => window.__viewerTest.session()" | tr -d '"')"
[ -n "$SESSION_ID" ] || fail "no session"
# the session runs on wlroots
grep -aq 'WAYLAND_DISPLAY=.*(wlroots)' "$WORK/gateway.log" ||
  fail "the session isn't running on wlroots"

TEST_APP=test-foot.desktop
step "the Apps menu: you, the session, the installed apps"
click_element '#apps-button'
wait_for "() => $(visible apps-menu) && !!document.querySelector('.app-row[data-app=\"$TEST_APP\"]')" "the test app in the Apps menu"
[ "$(pw_eval "() => document.activeElement.id")" = '"apps-search"' ] || fail "the search field doesn't have the keyboard"
[ "$(pw_eval "() => document.querySelector('.apps-username').textContent")" = "\"$ME\"" ] || fail "the user isn't shown"
[ "$(pw_eval "() => document.querySelector('#apps-session-name input').value")" = '"Session 1"' ] ||
  fail "the session name isn't shown"
# searching narrows the list
pw_eval "() => { const i = document.getElementById('apps-search'); i.value = 'test term'; i.dispatchEvent(new Event('input')); return true }" >/dev/null
[ "$(pw_eval "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ')")" = "\"$TEST_APP\"" ] ||
  fail "searching didn't find just the test app"
echo "    ok"

step "renaming the session in the Apps menu"
click_element '#apps-session-name input'
pw press Control+a >/dev/null
pw type "Shell test" >/dev/null
pw press Enter >/dev/null
wait_for "() => document.querySelector('#apps-session-name input').value === 'Shell test' && document.title === 'Shell test'" "the new name"
LISTED_NAME="$(pw_eval "async () => (await (await fetch('/api/sessions', { headers: { Authorization: 'Bearer ' + window.__viewerTest.token() } })).json())[0].name")"
[ "$LISTED_NAME" = '"Shell test"' ] || fail "the rename didn't reach the session list: $LISTED_NAME"
echo "    ok"

step "pinning the test app"
click_element ".pin-toggle[data-pin=\"$TEST_APP\"]"
wait_for "() => !!document.querySelector('#taskbar-items button.pinned[data-group=\"$TEST_APP\"]')" "the pinned app in the taskbar"
pinned_saved() { grep -q "\"$TEST_APP\"" "$WORK/config/greenfield/pinned.json" 2>/dev/null; }
wait_until "the pinned app to be saved" 5 pinned_saved
echo "    ok"

step "launching foot from the Apps menu"
click_element ".app-row[data-app=\"$TEST_APP\"]"
wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot window" 40
wait_for "() => document.querySelector('#taskbar-items button[data-group=\"$TEST_APP\"]').matches('.running.active')" \
  "foot's window in its pinned taskbar button" 10
# Our foot is the one started by this test's gateway (other foots, e.g. in the user's own sessions, aren't ours).
descends_from() {
  local pid="$1" ancestor="$2"
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
FOOT_PID=""
for pid in $(pgrep -x foot -u "$ME" || true); do
  descends_from "$pid" "$GATEWAY_PID" && FOOT_PID="$pid"
done
[ -n "$FOOT_PID" ] || fail "foot is not running"

TERMINAL="$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; const s = w.surfaces.find((s) => s.id === w.id); return [w.id, w.shownX + s.x, w.shownY + s.y, s.width, s.height] }")"
read -r WINDOW_ID TX TY TW TH < <(echo "$TERMINAL" | tr -d '[]"' | tr ',' ' ')
echo "    window $WINDOW_ID at $TX,$TY (${TW}x${TH})"
REGION="$TX, $TY, $((TW < 600 ? TW : 600)), 26"
settle_luma "$WORK/before-typing.json"

# clicking the taskbar button of the active window minimizes it, clicking again restores it
TASKBAR_BUTTON="#taskbar-items button[data-group=\"$TEST_APP\"]"

step "minimizing and restoring from the taskbar"
watch_animations
click_element "$TASKBAR_BUTTON"
animation_ran minimize
wait_for "() => { const w = window.__viewerTest.shellWindows()[0]; return w.minimized && !w.activated && !Object.keys(window.__viewerTest.animations()).length }" \
  "the window to be minimized" 10
read_luma "$WORK/minimized.json"
[ "$(pw_eval "() => document.querySelector('$TASKBAR_BUTTON').matches('.running:not(.active)')")" = true ] ||
  fail "the taskbar button still shows the window as active"
click_element "$TASKBAR_BUTTON"
animation_ran restore
wait_for "() => { const w = window.__viewerTest.shellWindows()[0]; return !w.minimized && w.activated && !Object.keys(window.__viewerTest.animations()).length }" \
  "the window to be restored" 10
wait_luma_near "$WORK/restored.json" "$WORK/before-typing.json" 4
node -e '
  const [a, b, c] = process.argv.slice(1).map((f) => JSON.parse(require("fs").readFileSync(f, "utf8")))
  const diff = (x, y) => x.reduce((sum, v, i) => sum + Math.abs(v - y[i]), 0) / x.length
  console.log(`    luma difference: minimized ${diff(a, b).toFixed(1)}, restored ${diff(a, c).toFixed(1)}`)
  process.exit(diff(a, b) > 20 && diff(a, c) < 5 ? 0 : 1)
' "$WORK/before-typing.json" "$WORK/minimized.json" "$WORK/restored.json" || fail "the window didn't disappear and come back"
echo "    ok"

step "maximizing and restoring down from the taskbar menu"
read -r OX OY OW OH < <(pw_eval "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') }" | tr -d '"'; echo)
# $1: the menu item (data-action)
taskbar_menu() {
  local center
  center="$(pw_eval "() => { const r = document.querySelector('$TASKBAR_BUTTON').getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ' ' + Math.round(r.y + r.height / 2) }" | tr -d '"')"
  read -r CX CY <<<"$center"
  pw mousemove "$CX" "$CY" >/dev/null
  pw mousedown right >/dev/null
  pw mouseup right >/dev/null
  wait_for "() => !!document.querySelector('.context-menu button[data-action=$1]')" "the taskbar menu" 5
  click_element ".context-menu button[data-action=$1]"
}
watch_animations
taskbar_menu maximize
animation_ran maximize
wait_for "() => { const w = window.__viewerTest.windows()[0]; const o = window.__viewerTest.output(); const g = w.shownGeometry; return w.maximized && g.x === 0 && g.y === 0 && g.width === o.width && g.height === o.height && !Object.keys(window.__viewerTest.animations()).length }" \
  "the window to be maximized" 10
taskbar_menu unmaximize
wait_for "() => { const w = window.__viewerTest.windows()[0]; const g = w.shownGeometry; return !w.maximized && [g.x, g.y, g.width, g.height].join(' ') === '$OX $OY $OW $OH' && !Object.keys(window.__viewerTest.animations()).length }" \
  "the window to be restored down" 10
echo "    ok"

step "notifications: a toast and the history"
notify-send -a "Test suite" "Hello from test $$" "First line
<b>second</b> line &amp; more"
wait_for "() => [...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('Hello from test $$'))" "the toast" 10
[ "$(pw_eval "() => document.querySelector('#toasts .toast .notification-body').textContent")" = '"First line\nsecond line & more"' ] ||
  fail "the notification body isn't shown as plain text"
[ "$(pw_eval "() => document.querySelector('#notifications-button').classList.contains('unseen')")" = true ] ||
  fail "the bell doesn't show a new notification"
click_element '#notifications-button'
wait_for "() => $(visible notifications-panel) && document.querySelectorAll('#notifications-panel .notification').length === 1" "the notification in the history" 5
# dismissing removes it in the session too
click_element '#notifications-panel .notification-close'
wait_for "() => document.querySelectorAll('#notifications-panel .notification').length === 0" "the dismissed notification to go" 5
click_element '#notifications-button'
# one to find again after reconnecting
notify-send -a "Test suite" "Kept for later $$"
wait_for "() => document.querySelectorAll('#toasts .toast').length === 1" "the second toast" 10
echo "    ok"

step "typing a command"
pw mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
pw type "clear; echo gateway-marker-$$" >/dev/null
pw press Enter >/dev/null
# the screen changes, and stops changing
for _ in $(seq 1 100); do
  settle_luma "$WORK/after-typing.json"
  [ "$(luma_diff "$WORK/before-typing.json" "$WORK/after-typing.json" | node -e 'console.log(Number(require("fs").readFileSync(0, "utf8")) >= 2 ? 1 : 0)')" = 1 ] && break
  sleep 0.1
done

step "going back doesn't leave the desktop"
pw_eval "() => { window.__notReloaded = true; return true }" >/dev/null
[ "$(pw_eval "() => history.state && history.state['session-guard'] === true")" = true ] || fail "no history guard entry"
pw_eval "() => { history.back(); return true }" >/dev/null
wait_for "() => history.state === null" "history.back() to be handled"
[ "$(pw_eval "() => window.__notReloaded === true && $(visible desktop-view) && window.__viewerTest.connected() && history.state === null")" = true ] ||
  fail "history.back() left the desktop"
# the next input re-arms the guard
pw mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
[ "$(pw_eval "() => history.state && history.state['session-guard'] === true")" = true ] || fail "the guard wasn't re-armed"
count_side_events() { grep -ac 'wl_pointer@[0-9]*\.button([0-9]*, [0-9]*, 275, [01])' "$WORK/gateway.log" || true; }
SIDE_BEFORE="$(count_side_events)"
cdp_click back $((TX + TW / 2)) $((TY + TH / 2))
side_events_arrived() { [ "$(($(count_side_events) - SIDE_BEFORE))" -ge 2 ]; }
wait_until "foot to get the back button" 10 side_events_arrived || true
# (a navigation, if it happened, would have shown by now: give the page a moment to act on the click)
[ "$(pw_eval "() => new Promise((resolve) => setTimeout(() => resolve(window.__notReloaded === true && window.__viewerTest.connected() && history.state['session-guard'] === true), 300))")" = true ] ||
  fail "the mouse's back button over the desktop navigated"
SIDE_AFTER="$(count_side_events)"
echo "    BTN_SIDE events received by foot: $((SIDE_AFTER - SIDE_BEFORE)) (expected 2)"
[ $((SIDE_AFTER - SIDE_BEFORE)) = 2 ] || fail "foot didn't get the back button as BTN_SIDE press and release"
echo "    ok"

step "reloading asks first, then asks to sign in again"
BROWSER_TOKEN="$(pw_eval "() => window.__viewerTest.token()" | tr -d '"')"
[ -n "$BROWSER_TOKEN" ] || fail "no token in the page"
reload_with_dialog dialog-dismiss
[ "$(pw_eval "() => new Promise((resolve) => setTimeout(() => resolve(window.__notReloaded === true && window.__viewerTest.connected()), 300))")" = true ] ||
  fail "dismissing the confirmation didn't keep the page"
reload_with_dialog dialog-accept
wait_for "() => document.readyState === 'complete' && $(visible login-view)" "the sign-in form after reloading" 10
# the reloaded page's old sign-in is revoked soon after its presence connection closed
token_revoked() { [ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BROWSER_TOKEN" "$BASE/api/sessions")" = 401 ]; }
wait_until "the token of the reloaded page to stop working" $((5 / TIME_SCALE + 8)) token_revoked
echo "    ok"

step "closing the browser"
pw close >/dev/null
sleep 1
kill -0 "$FOOT_PID" 2>/dev/null || fail "foot didn't survive the browser going away"

step "signing in again and reopening the session"
pw open "$BASE/?test=1" >/dev/null
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 1 ] || fail "the session is not listed"
LISTED="$(pw_eval "() => document.querySelector('.sessions li').dataset.session" | tr -d '"')"
[ "$LISTED" = "$SESSION_ID" ] || fail "listed session $LISTED is not $SESSION_ID"
# clicking the row (not just the Open button) opens it
click_element '.sessions .when'
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer reconnection"
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].hasContent }" "foot window after reattach"

AFTER="$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; const s = w.surfaces.find((s) => s.id === w.id); return [w.id, w.shownX + s.x, w.shownY + s.y] }")"
read -r WINDOW_ID2 TX2 TY2 < <(echo "$AFTER" | tr -d '[]"' | tr ',' ' ')
[ "$WINDOW_ID2" = "$WINDOW_ID" ] || fail "a different window came back ($WINDOW_ID2 instead of $WINDOW_ID)"
[ "$TX2,$TY2" = "$TX,$TY" ] || fail "window moved from $TX,$TY to $TX2,$TY2"
wait_for "() => !!document.querySelector('#taskbar-items button.pinned.running[data-group=\"$TEST_APP\"]')" "the pinned, running app after reattaching" 10
click_element '#notifications-button'
wait_for "() => [...document.querySelectorAll('#notifications-panel .notification')].some((n) => n.textContent.includes('Kept for later $$'))" \
  "the notification in the history after reattaching" 10
click_element '#notifications-button'
# the earlier output is painted again (the check below tells whether it is the right output)
wait_luma_near "$WORK/after-reattach.json" "$WORK/after-typing.json" 0.3

step "comparing pixels"
node - "$WORK" <<'EOF'
const fs = require('fs')
const dir = process.argv[2]
const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`, 'utf8'))
const beforeTyping = read('before-typing')
const afterTyping = read('after-typing')
const afterReattach = read('after-reattach')
const diff = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length
const bright = (a) => a.filter((value) => value > 128).length
const typed = diff(beforeTyping, afterTyping)
const reattached = diff(afterTyping, afterReattach)
console.log(`    text pixels after typing: ${bright(afterTyping)}, after reattach: ${bright(afterReattach)}`)
console.log(`    mean luma difference: typing changed ${typed.toFixed(2)}, reattach changed ${reattached.toFixed(2)}`)
if (bright(afterTyping) < 50) {
  console.error('FAIL: no text visible after typing')
  process.exit(1)
}
if (typed < 2) {
  console.error('FAIL: typing the command did not change the screen')
  process.exit(1)
}
if (reattached > typed / 4) {
  console.error('FAIL: the earlier output is not shown after reattaching')
  process.exit(1)
}
EOF

# --- window management ---

# foot's window geometry as shown: "x y width height" (output coordinates)
shown_geometry() {
  # (with a trailing newline, so `read` succeeds)
  echo "$(pw_eval "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') }" | tr -d '"')"
}

CANVAS_Y="$(pw_eval "() => Math.round(document.querySelector('canvas').getBoundingClientRect().y)")"

# Press on one of foot's resize borders (page coordinates) and drag by (dx, dy) in 3 steps. Prints the shown geometry
# right after each step, without waiting for the server.
resize_drag() {
  local px="$1" py="$2" dx="$3" dy="$4" i
  pw mousemove "$px" "$py" >/dev/null
  pw mousedown >/dev/null
  # the client starts the resize in response to the press
  wait_for "() => window.__viewerTest.interaction() === 'resize'" "the resize to start" 10
  for i in 1 2 3; do
    pw mousemove $((px + dx * i / 3)) $((py + dy * i / 3)) >/dev/null
    echo "$(shown_geometry)"
  done
  pw mouseup >/dev/null
  wait_for "() => !window.__viewerTest.resizing()" "the client to commit the final size" 10
}

step "resizing from the left edge: immediate, and the right edge stays put"
read -r GX GY GW GH < <(shown_geometry)
RIGHT=$((GX + GW))
# foot draws its left border as a 5px subsurface just outside the window geometry
STEPS="$(resize_drag $((GX - 3)) $((CANVAS_Y + GY + GH / 2)) 60 0 | awk '{ printf "%s,%s ", $1, $1 + $3 }')"
echo "    during the drag (left,right): $STEPS"
[ "$STEPS" = "$((GX + 20)),$RIGHT $((GX + 40)),$RIGHT $((GX + 60)),$RIGHT " ] ||
  fail "the window didn't follow the pointer immediately with its right edge fixed: $STEPS"
read -r GX2 GY2 GW2 GH2 < <(shown_geometry)
echo "    settled at $GX2,$GY2 ${GW2}x${GH2}"
[ $((GX2 + GW2)) = "$RIGHT" ] || fail "right edge moved from $RIGHT to $((GX2 + GW2)) after the resize"
[ "$GY2" = "$GY" ] || fail "top edge moved from $GY to $GY2"

step "resizing from the top edge keeps the bottom edge in place"
read -r GX GY GW GH < <(shown_geometry)
BOTTOM=$((GY + GH))
# the top border subsurface is just above foot's title bar
STEPS="$(resize_drag $((GX + GW / 2)) $((CANVAS_Y + GY - 3)) 0 45 | awk '{ printf "%s,%s ", $2, $2 + $4 }')"
echo "    during the drag (top,bottom): $STEPS"
[ "$STEPS" = "$((GY + 15)),$BOTTOM $((GY + 30)),$BOTTOM $((GY + 45)),$BOTTOM " ] ||
  fail "the window didn't follow the pointer immediately with its bottom edge fixed: $STEPS"
read -r GX2 GY2 GW2 GH2 < <(shown_geometry)
echo "    settled at $GX2,$GY2 ${GW2}x${GH2}"
[ $((GY2 + GH2)) = "$BOTTOM" ] || fail "bottom edge moved from $BOTTOM to $((GY2 + GH2)) after the resize"
[ $((GX2 + GW2)) = "$RIGHT" ] || fail "right edge moved during the top edge resize"

step "shrinking the viewport moves the window back into view"
read -r GX GY GW GH < <(shown_geometry)
pw resize 160 500 >/dev/null
wait_for "() => { const o = window.__viewerTest.output(); const g = window.__viewerTest.windows()[0].shownGeometry; return o.width <= 160 && g.x <= o.width - 80 && g.x + g.width >= 80 && g.y >= 0 && g.y <= o.height - 80 }" \
  "the window to be moved back into view" 10
wait_for "() => { const w = window.__viewerTest.windows()[0]; return w.x === w.shownX && w.y === w.shownY }" \
  "the server to store the new position" 10
read -r GX2 GY2 GW2 GH2 < <(shown_geometry)
echo "    moved from $GX,$GY to $GX2,$GY2"
[ "$GX2" -lt "$GX" ] || fail "the window wasn't moved"
pw resize 1280 800 >/dev/null

# --- session list: disconnect, renaming, signing out, logging out ---

# the session menu in the Apps menu. $1: disconnect or logout
session_menu() {
  click_element '#apps-button'
  wait_for "() => $(visible apps-menu)" "the Apps menu" 5
  click_element '#session-menu-button'
  wait_for "() => !!document.querySelector('#session-menu button[data-action=$1]')" "the session menu" 5
  click_element "#session-menu button[data-action=$1]"
}

step "Disconnect goes back to the session list, still signed in"
session_menu disconnect
wait_for "() => $(visible sessions-view) && document.querySelectorAll('.sessions li').length === 1" "the session list"
[ "$(pw_eval "() => window.__viewerTest.connected()")" = false ] || fail "still connected to the session"
kill -0 "$FOOT_PID" 2>/dev/null || fail "foot didn't survive disconnecting"
echo "    ok"

NAME_FIELD='.sessions .session-name input'
step "renaming the session by clicking its name"
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').value")" = '"Shell test"' ] ||
  fail "the name given in the Apps menu isn't listed"
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').getAttribute('aria-label')")" = '"Rename session"' ] ||
  fail "the name field has no accessible label"
click_element "$NAME_FIELD"
[ "$(pw_eval "() => document.activeElement === document.querySelector('$NAME_FIELD') && $(visible sessions-view)")" = true ] ||
  fail "clicking the name didn't start editing it (or opened the session)"
pw press Control+a >/dev/null
pw type "  <i>Build</i>   & tests " >/dev/null
pw press Enter >/dev/null
wait_for "() => document.querySelector('$NAME_FIELD').value === '<i>Build</i> & tests'" "the new name" 10
[ "$(pw_eval "() => document.querySelectorAll('.sessions i').length")" = 0 ] || fail "HTML in the session name was rendered"
click_element "$NAME_FIELD"
pw type "xyz" >/dev/null
pw press Escape >/dev/null
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').value")" = '"<i>Build</i> & tests"' ] ||
  fail "Escape didn't cancel the edit"
RENAME_API="$(pw_eval "async () => { const token = window.__viewerTest.token(); const id = window.__viewerTest.session() || document.querySelector('.sessions li').dataset.session; const post = (name, auth) => fetch('/api/sessions/' + id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify({ name }) }).then((r) => r.status); const listed = (await (await fetch('/api/sessions', { headers: { Authorization: 'Bearer ' + token } })).json())[0].name; return [listed, await post('Work', token), await post('   ', token), await post('x'.repeat(65), token), await post('Nope', 'wrong')].join(' ') }")"
echo "    API: $RENAME_API (expected the new name, then 200 400 400 401)"
[ "$RENAME_API" = '"<i>Build</i> & tests 200 400 400 401"' ] || fail "rename API: $RENAME_API"
echo "    ok"

step "signing out"
pw_eval "() => { document.querySelector('#sign-out').click(); return true }" >/dev/null
wait_for "() => $(visible login-view)" "the sign-in form"
browser_login
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').value")" = '"Work"' ] || fail "the API rename didn't stick"
echo "    ok"

step "Log out ends the session"
pw_eval "() => { document.querySelector('.sessions button[data-action=open]').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection"
session_menu logout
wait_for "() => $(visible login-view)" "the sign-in form"
foot_gone() { ! kill -0 "$FOOT_PID" 2>/dev/null; }
wait_until "foot to end after logging out" 15 foot_gone
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "ended session still listed"
echo "    ok"

echo "PASS: sign-in, session survival, desktop shell, window management, renaming and logging out"
