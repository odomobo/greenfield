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
#   2. window management in the viewer: the taskbar's preview cards (title and close only, right-click opens the window
#      menu), the window menu's Move (pointer, click, Escape, arrow keys) and Size, fullscreen (foot, bound to F11)
#      covering the page above the taskbar and back, the cheap globals advertised; a resize follows the pointer immediately (without waiting for the server),
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
Exec=env WAYLAND_DEBUG=1 foot --app-id=test-foot -o key-bindings.fullscreen=F11
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
# The gateway runs with --encoder none (lib.sh; no GPU acceleration is assumed): there is no video at all, every surface,
# new ones included, is sent as lossless PNG patches, and the browser drew them.
grep -aq 'Video encoder: none' "$WORK/gateway.log" || fail "the gateway didn't log its encoder choice"
wait_for "() => window.__viewerTest.patches() > 0" "decoded patches of foot's window" 10
[ "$(pw_eval "() => window.__viewerTest.videoFrames().decoded")" = 0 ] || fail "video frames without a video encoder"
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

step "modifiers follow the browser: one Ctrl press, and no Ctrl stuck by a key-up the page didn't see"
# foot's keyboard events (its WAYLAND_DEBUG log) after line $1 of the gateway log, one per line: "key <evdev code>
# <1 pressed, 0 released>" or "mods <depressed> <locked>" (in the default keymap Ctrl is depressed 4; KEY_LEFTCTRL 29)
keyboard_since() {
  tail -n +"$(($1 + 1))" "$WORK/gateway.log" | grep -ao 'wl_keyboard@[0-9]*\.\(key\|modifiers\)([0-9, ]*)' |
    sed -E 's/.*\.key\([0-9]+, [0-9]+, ([0-9]+), ([0-9]+)\)/key \1 \2/; s/.*\.modifiers\([0-9]+, ([0-9]+), [0-9]+, ([0-9]+), [0-9]+\)/mods \1 \2/'
}
# $2: a JavaScript expression over ev (the events since line $1) and idx(event, from) / count(event)
keyboard_check() {
  keyboard_since "$1" | node -e "
    const ev = require('fs').readFileSync(0, 'utf8').trim().split('\n')
    const idx = (e, from = 0) => ev.indexOf(e, from)
    const count = (e) => ev.filter((x) => x === e).length
    const modsBefore = (i) => ev.slice(0, i).filter((e) => e.startsWith('mods')).pop()
    process.exit(($2) ? 0 : 1)"
}
expect_keyboard() {
  local start="$1" what="$2" check="$3" i
  for i in $(seq 1 50); do
    keyboard_check "$start" "$check" && return 0
    sleep 0.1
  done
  fail "$what (foot got: $(keyboard_since "$start" | paste -sd, -))"
}
log_end() { wc -l <"$WORK/gateway.log"; }
focus_foot() {
  pw mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
  pw mousedown >/dev/null
  pw mouseup >/dev/null
}
blur_page() { pw_eval "() => { document.activeElement.blur(); return true }" >/dev/null; }

# Ctrl+U, Ctrl+U: one Ctrl press, one modifier change each way
START="$(log_end)"
focus_foot
pw keydown Control >/dev/null
pw press u >/dev/null
pw press u >/dev/null
pw keyup Control >/dev/null
expect_keyboard "$START" "Ctrl+U twice wasn't one Ctrl press" \
  "count('key 29 1') === 1 && count('key 29 0') === 1 && count('mods 4 0') === 1 && count('key 22 1') === 2 &&
   idx('key 29 1') < idx('mods 4 0') && idx('mods 4 0') < idx('key 22 1') && ev.lastIndexOf('key 22 0') < idx('key 29 0') &&
   ev[ev.length - 1] === 'mods 0 0'"
echo "    Ctrl+U twice: one Ctrl press"

# Ctrl released while the page had no focus: released when the focus went, typing afterwards is plain
START="$(log_end)"
focus_foot
pw keydown Control >/dev/null
expect_keyboard "$START" "foot didn't get the Ctrl press" "idx('key 29 1') >= 0"
blur_page
pw keyup Control >/dev/null
focus_foot
pw press x >/dev/null
expect_keyboard "$START" "Ctrl stuck after the page lost focus" \
  "idx('key 45 1') >= 0 && count('key 29 0') === 1 && idx('key 29 0') < idx('key 45 1') && modsBefore(idx('key 45 1')) === 'mods 0 0'"
echo "    Ctrl released while the page had no focus: released"

# Ctrl released without the page seeing it, focus kept: the next key's modifier state (none) releases it
START="$(log_end)"
focus_foot
pw keydown Control >/dev/null
expect_keyboard "$START" "foot didn't get the Ctrl press" "idx('key 29 1') >= 0"
pw_eval "() => { for (const type of ['keydown', 'keyup']) document.activeElement.dispatchEvent(new KeyboardEvent(type, { code: 'KeyY', key: 'y', bubbles: true, cancelable: true })); return true }" >/dev/null
pw keyup Control >/dev/null
expect_keyboard "$START" "Ctrl stuck after a key-up the page didn't see" \
  "idx('key 21 1') >= 0 && count('key 29 0') === 1 && idx('key 29 0') < idx('key 21 1') && modsBefore(idx('key 21 1')) === 'mods 0 0'"
echo "    Ctrl released without the page seeing it: released before the next key"

# Ctrl pressed while the page had no focus: held (no key press made up), Ctrl+U works, then released with the key
START="$(log_end)"
blur_page
pw keydown Control >/dev/null
focus_foot
pw press u >/dev/null
pw keyup Control >/dev/null
expect_keyboard "$START" "Ctrl pressed while the page had no focus isn't held" \
  "count('key 29 1') === 0 && count('key 29 0') === 0 && idx('mods 4 0') >= 0 && idx('mods 4 0') < idx('key 22 1') &&
   modsBefore(idx('key 22 1')) === 'mods 4 0' && ev[ev.length - 1] === 'mods 0 0'"
echo "    Ctrl pressed while the page had no focus: held, then released"

# --- window management ---

# foot's window geometry as shown: "x y width height" (output coordinates)
shown_geometry() {
  # (with a trailing newline, so `read` succeeds)
  echo "$(pw_eval "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') }" | tr -d '"')"
}

CANVAS_Y="$(pw_eval "() => Math.round(document.querySelector('canvas').getBoundingClientRect().y)")"

# xdg_toplevel.configure events foot has received so far
configure_count() {
  grep -ac 'xdg_toplevel@[0-9]*\.configure(' "$WORK/gateway.log" || true
}

# Press on one of foot's resize borders (page coordinates) and drag by (dx, dy) in 3 steps. Prints the shown geometry
# right after each step, without waiting for the server. The app is told nothing while dragging: the window.resize
# messages the viewer sent during the drag and in total (after the window settled) are read with drag_sent, the
# configures foot got while dragging are CONFIGURES_DURING - CONFIGURES_BEFORE (set in a subshell: read them from
# the files instead, see drag_configures).
resize_drag() {
  local px="$1" py="$2" dx="$3" dy="$4" i
  pw mousemove "$px" "$py" >/dev/null
  pw mousedown >/dev/null
  # the client starts the resize in response to the press
  wait_for "() => window.__viewerTest.interaction() === 'resize'" "the resize to start" 10
  pw_eval "() => { window.__sent0 = window.__viewerTest.resizesSent(); return true }" >/dev/null
  configure_count >"$WORK/configures-before"
  for i in 1 2 3; do
    pw mousemove $((px + dx * i / 3)) $((py + dy * i / 3)) >/dev/null
    echo "$(shown_geometry)"
  done
  pw_eval "() => { window.__sentDuring = window.__viewerTest.resizesSent() - window.__sent0; return true }" >/dev/null
  configure_count >"$WORK/configures-during"
  pw mouseup >/dev/null
  wait_for "() => !window.__viewerTest.resizing()" "the client to commit the final size" 10
}
# "during total": window.resize messages sent during the last drag, and for all of it
drag_sent() {
  echo "$(pw_eval "() => window.__sentDuring + ' ' + (window.__viewerTest.resizesSent() - window.__sent0)" | tr -d '"')"
}
# the configures foot got while the last drag was in progress
drag_configures() {
  echo $(($(cat "$WORK/configures-during") - $(cat "$WORK/configures-before")))
}
# fail unless the last drag sent nothing while dragging, one window.resize in total, and configured the app not at all
# while dragging
check_drag_quiet() {
  local during total
  read -r during total < <(drag_sent)
  echo "    window.resize sent during the drag / in total: $during / $total; configures during the drag: $(drag_configures)"
  [ "$during" = 0 ] || fail "the viewer sent $during window.resize messages while dragging"
  [ "$total" = 1 ] || fail "the viewer sent $total window.resize messages for the whole drag, expected 1"
  [ "$(drag_configures)" = 0 ] || fail "the app was configured while dragging"
}

moves_sent() { echo "$(pw_eval "() => window.__viewerTest.movesSent()")"; }

step "moving with a slow server: late scenes never pull the window back"
read -r GX GY GW GH < <(shown_geometry)
# every scene arrives 300 ms late; record where the window is shown while it's dragged right and settles
pw_eval "() => { window.__viewerTest.delayScenes(300); window.__shownX = []; clearInterval(window.__mover); window.__mover = setInterval(() => window.__shownX.push(window.__viewerTest.windows()[0].shownGeometry.x), 5); return true }" >/dev/null
# foot's title bar
pw mousemove $((GX + GW / 2)) $((CANVAS_Y + GY + 12)) >/dev/null
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.interaction() === 'move'" "the move to start" 10
MOVES0="$(moves_sent)"
for i in 1 2 3 4; do
  pw mousemove $((GX + GW / 2 + 15 * i)) $((CANVAS_Y + GY + 12)) >/dev/null
done
# the window follows the pointer, but the server hears nothing until the drop
wait_for "() => window.__viewerTest.windows()[0].shownGeometry.x === $((GX + 60))" "the window to follow the pointer" 10
[ "$(moves_sent)" = "$MOVES0" ] || fail "the viewer sent window.move while dragging"
pw mouseup >/dev/null
wait_for "() => { const w = window.__viewerTest.windows()[0]; return w.x === w.shownX && w.y === w.shownY && w.shownGeometry.x === $((GX + 60)) }" \
  "the server to store the final position" 10
MOVES="$(pw_eval "() => { clearInterval(window.__mover); window.__viewerTest.delayScenes(0); const xs = window.__shownX; return [xs.length, xs.every((x, i) => i === 0 || x >= xs[i - 1])].join(' ') }" | tr -d '"')"
echo "    samples, never moved back: $MOVES"
[ "$(moves_sent)" = "$((MOVES0 + 1))" ] || fail "the drop should send exactly one window.move ($MOVES0 -> $(moves_sent))"
[ "${MOVES#* }" = true ] || fail "the window was pulled back by a late scene"

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
check_drag_quiet
# foot snaps to its cell grid: the final size is near the dragged one
[ "$((GW2 - (GW - 60)))" -ge -24 ] && [ "$((GW2 - (GW - 60)))" -le 24 ] || fail "the window settled at ${GW2}px wide, not near $((GW - 60))"

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
check_drag_quiet

step "shrinking below the app's minimum size stops at it, with the fixed edges in place"
read -r GX GY GW GH < <(shown_geometry)
ORIGW=$GW ORIGH=$GH
read -r MINW MINH < <(echo "$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; return (w.minWidth || 0) + ' ' + (w.minHeight || 0) }" | tr -d '"')")
echo "    the scene reports the minimum size ${MINW}x${MINH} (foot's xdg_toplevel.set_min_size)"
[ "$MINW" -gt 0 ] && [ "$MINH" -gt 0 ] || fail "the scene has no minimum size for foot"
grep -aq "set_min_size($MINW, $MINH)" "$WORK/gateway.log" || fail "foot didn't set the minimum size ${MINW}x${MINH} the scene reports"
# drag the top border down by more than the window is high
BOTTOM=$((GY + GH))
STEPS="$(resize_drag $((GX + GW / 2)) $((CANVAS_Y + GY - 3)) 0 $((GH + 60)) | awk '{ printf "%s,%s,%s ", $2, $2 + $4, $4 }')"
echo "    during the drag (top,bottom,height): $STEPS"
for STEP in $STEPS; do
  IFS=, read -r T B H <<<"$STEP"
  [ "$B" = "$BOTTOM" ] || fail "the bottom edge moved while clamping: $STEPS"
  [ "$H" -ge "$MINH" ] || fail "the dragged height $H went below the minimum $MINH: $STEPS"
done
[ "$H" = "$MINH" ] || fail "the drag didn't stop at the minimum height $MINH: $STEPS"
check_drag_quiet
read -r GX2 GY2 GW2 GH2 < <(shown_geometry; echo)
echo "    settled at $GX2,$GY2 ${GW2}x${GH2}"
[ "$GH2" -ge "$MINH" ] && [ $((GY2 + GH2)) = "$BOTTOM" ] || fail "after clamping the window is ${GH2}px high with its bottom edge at $((GY2 + GH2)) (minimum $MINH, bottom edge $BOTTOM)"
# the same for the width, from the left border
GX=$GX2 GY=$GY2 GW=$GW2 GH=$GH2
RIGHT=$((GX + GW))
STEPS="$(resize_drag $((GX - 3)) $((CANVAS_Y + GY + GH / 2)) $((GW + 60)) 0 | awk '{ printf "%s,%s,%s ", $1, $1 + $3, $3 }')"
echo "    during the drag (left,right,width): $STEPS"
for STEP in $STEPS; do
  IFS=, read -r L R W <<<"$STEP"
  [ "$R" = "$RIGHT" ] || fail "the right edge moved while clamping: $STEPS"
  [ "$W" -ge "$MINW" ] || fail "the dragged width $W went below the minimum $MINW: $STEPS"
done
[ "$W" = "$MINW" ] || fail "the drag didn't stop at the minimum width $MINW: $STEPS"
check_drag_quiet
read -r GX2 GY2 GW2 GH2 < <(shown_geometry; echo)
echo "    settled at $GX2,$GY2 ${GW2}x${GH2}"
[ "$GW2" -ge "$MINW" ] && [ $((GX2 + GW2)) = "$RIGHT" ] || fail "after clamping the window is ${GW2}px wide with its right edge at $((GX2 + GW2)) (minimum $MINW, right edge $RIGHT)"
# back to the size it had (growing; the left and top borders of the tiny window)
resize_drag $((GX2 - 3)) $((CANVAS_Y + GY2 + GH2 / 2)) $((GW2 - ORIGW)) 0 >/dev/null
read -r GX2 GY2 GW2 GH2 < <(shown_geometry; echo)
resize_drag $((GX2 + GW2 / 2)) $((CANVAS_Y + GY2 - 3)) 0 $((GH2 - ORIGH)) >/dev/null

step "taskbar preview cards: the title and a close button only; right-clicking a card opens the window menu"
read -r CARD_X CARD_Y < <(pw_eval "() => { const r = document.querySelector('$TASKBAR_BUTTON').getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ' ' + Math.round(r.bottom - 4) }" | tr -d '"'; echo)
pw mousemove "$CARD_X" "$CARD_Y" >/dev/null
wait_for "() => !!document.querySelector('#window-preview .preview-card')" "the window preview" 10
[ "$(pw_eval "() => [...document.querySelectorAll('#window-preview .preview-card button')].map((b) => b.dataset.action).join(',')")" = '"close"' ] ||
  fail "the preview card has controls besides close"
# right click on a card: the window menu, with Move and Size
read -r PX PY < <(pw_eval "() => { const r = document.querySelector('#window-preview .preview-image').getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ' ' + Math.round(r.y + r.height / 2) }" | tr -d '"'; echo)
pw mousemove "$PX" "$PY" >/dev/null
pw mousedown right >/dev/null
pw mouseup right >/dev/null
wait_for "() => [...document.querySelectorAll('.context-menu button')].map((b) => b.dataset.action).join(',') === 'minimize,maximize,move,size,close'" "the window menu from the card" 5
echo "    ok"

# foot's geometry as shown, "x y width height", once nothing is going on anymore
# $1: x y w h, $2: what
wait_geometry() {
  wait_for "() => { const w = window.__viewerTest.windows()[0]; const g = w.shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') === '$1' && !window.__viewerTest.interaction() && w.x === w.shownX && w.y === w.shownY }" "$2" 10
}

step "window menu, Move: follows the pointer, a click drops it"
read -r OX OY OW OH < <(shown_geometry; echo)
MOVES1="$(moves_sent)"
click_element '.context-menu button[data-action=move]'
wait_for "() => window.__viewerTest.interaction() === 'move'" "Move to start" 5
# it follows the pointer from where the menu item was clicked
MX="$CX"; MY="$CY"
pw mousemove $((MX + 100)) $((MY + 150)) >/dev/null
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return g.x === $((OX + 100)) && g.y === $((OY + 150)) }" "the window to follow the pointer" 5
pw mousemove $((MX + 120)) $((MY + 160)) >/dev/null
[ "$(moves_sent)" = "$MOVES1" ] || fail "Move sent a window.move before the drop"
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return g.x === $((OX + 120)) && g.y === $((OY + 160)) }" "the window to follow the pointer" 5
pw mousedown >/dev/null
pw mouseup >/dev/null
wait_geometry "$((OX + 120)) $((OY + 160)) $OW $OH" "the window to be dropped"
[ "$(moves_sent)" = "$((MOVES1 + 1))" ] || fail "the click should send exactly one window.move"
pw mousemove $((MX + 200)) $((MY + 200)) >/dev/null
[ "$(pw_eval "() => window.__viewerTest.windows()[0].shownGeometry.x")" = $((OX + 120)) ] || fail "the window kept following the pointer after the click"
echo "    moved from $OX,$OY to $((OX + 120)),$((OY + 160)) and dropped"

step "window menu, Move: Escape puts the window back, arrow keys nudge it"
NX=$((OX + 120)); NY=$((OY + 160))
taskbar_menu move
wait_for "() => window.__viewerTest.interaction() === 'move'" "Move to start" 5
pw mousemove $((CX + 40)) $((CY + 40)) >/dev/null
wait_for "() => window.__viewerTest.windows()[0].shownGeometry.x === $((NX + 40))" "the window to follow the pointer" 5
MOVES2="$(moves_sent)"
pw press Escape >/dev/null
wait_geometry "$NX $NY $OW $OH" "Escape to put the window back"
[ "$(moves_sent)" = "$MOVES2" ] || fail "Escape in Move sent a window.move"
taskbar_menu move
wait_for "() => window.__viewerTest.interaction() === 'move'" "Move to start" 5
pw press ArrowRight >/dev/null
pw press ArrowRight >/dev/null
pw press ArrowDown >/dev/null
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return g.x === $((NX + 20)) && g.y === $((NY + 10)) }" "the arrow keys to nudge the window" 5
pw press Enter >/dev/null
wait_geometry "$((NX + 20)) $((NY + 10)) $OW $OH" "Enter to finish the move"
echo "    ok"

step "window menu, Size: arrow keys pick and move edges, Escape cancels"
read -r SX SY SW SH < <(shown_geometry; echo)
resizes_sent() { echo "$(pw_eval "() => window.__viewerTest.resizesSent()")"; }
SENT0="$(resizes_sent)"
taskbar_menu size
wait_for "() => window.__viewerTest.interaction() === 'resize'" "Size to start" 5
# the first arrow key picks the right edge, a vertical one then adds the bottom edge
pw press ArrowRight >/dev/null
pw press ArrowRight >/dev/null
pw press ArrowDown >/dev/null
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return g.x === $SX && g.y === $SY && g.width === $((SW + 20)) && g.height === $((SH + 10)) }" "the arrow keys to size the window" 5
[ "$(resizes_sent)" = "$SENT0" ] || fail "the viewer sent a window.resize while Size was still running"
pw press Enter >/dev/null
wait_for "() => !window.__viewerTest.interaction() && !window.__viewerTest.resizing()" "the size to be applied" 10
[ "$(resizes_sent)" = "$((SENT0 + 1))" ] || fail "Enter should send exactly one window.resize ($SENT0 -> $(resizes_sent))"
read -r X2 Y2 W2 H2 < <(shown_geometry; echo)
echo "    $SW x $SH -> $W2 x $H2 (asked for $((SW + 20)) x $((SH + 10)))"
[ "$X2" = "$SX" ] && [ "$Y2" = "$SY" ] || fail "the window's top left moved while its right and bottom edges were sized"
[ "$W2" -ge $((SW + 4)) ] && [ "$H2" -ge $((SH + 2)) ] || fail "the window didn't grow"
taskbar_menu size
wait_for "() => window.__viewerTest.interaction() === 'resize'" "Size to start" 5
pw press ArrowLeft >/dev/null
pw press ArrowLeft >/dev/null
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return g.x === $((X2 - 20)) && g.width === $((W2 + 20)) }" "the left edge to move" 5
pw press Escape >/dev/null
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return !window.__viewerTest.interaction() && !window.__viewerTest.resizing() && [g.x, g.y, g.width, g.height].join(' ') === '$X2 $Y2 $W2 $H2' }" "Escape to cancel the size" 10
[ "$(resizes_sent)" = "$((SENT0 + 1))" ] || fail "Escape in Size sent a window.resize"
echo "    ok"

step "fullscreen: the window covers the output, never the taskbar, and goes back"
read -r FX FY FW FH < <(shown_geometry; echo)
# the key the test app binds to fullscreen
pw press F11 >/dev/null
wait_for "() => window.__viewerTest.windows()[0].fullscreen && getComputedStyle(document.getElementById('taskbar')).display !== 'none' && document.getElementById('taskbar').getBoundingClientRect().height > 0" "foot to go fullscreen" 10
wait_for "() => { const o = window.__viewerTest.output(); const g = window.__viewerTest.windows()[0].shownGeometry; return g.x === 0 && g.y === 0 && g.width === o.width && g.height === o.height }" "the window to cover the output" 10
# the taskbar is never covered: still fully in view, and the output (below it) doesn't grow over it
wait_for "() => { const t = document.getElementById('taskbar').getBoundingClientRect(); const o = window.__viewerTest.output(); return t.top >= 0 && t.height > 0 && o.height <= window.innerHeight - t.height }" "the taskbar to stay in view" 5
pw press F11 >/dev/null
wait_for "() => !window.__viewerTest.windows()[0].fullscreen" "foot to leave fullscreen" 10
wait_for "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') === '$FX $FY $FW $FH' && document.getElementById('taskbar').getBoundingClientRect().bottom > 0 }" "the window to be restored" 10
echo "    ok"

step "the cheap globals are advertised (foot's Wayland log lists them)"
for global in wp_viewporter wp_presentation xdg_activation_v1 wp_single_pixel_buffer_manager_v1 zwp_idle_inhibit_manager_v1 zxdg_output_manager_v1; do
  grep -aq "wl_registry@[0-9]*.global([0-9]*, \"$global\"" "$WORK/gateway.log" || fail "the compositor doesn't advertise $global"
done
echo "    ok"

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
