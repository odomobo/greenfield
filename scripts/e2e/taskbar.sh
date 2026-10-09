#!/usr/bin/env bash
# End-to-end test of the taskbar and its popups: starts the gateway in dev mode on $GATEWAY_PORT with 12 pinned test
# apps (pinned.json in its config dir), signs in in a headless browser (scripts/e2e/browser-driver.js) whose time zone
# differs from the host's, and checks that:
#   1. the clock shows the session host's time in the host's time zone, not the browser's;
#   2. in a narrow page, the buttons that don't fit go into a flyout under a '…' button (more of them in a narrower
#      page, none in a wide one), nothing is cut off; dragging a button moves it (the others make room), the click that ends the drag doesn't launch the app,
#      and the new pinned order is saved;
#   3. Unpin in the Apps menu's context menu keeps the Apps menu open;
#   4. a group's preview cards are in the order the windows were created, whatever their stacking; resting on a card
#      shows only its window (the others fade out) until the pointer leaves; the context menu of a card keeps the
#      preview open while the pointer is on the menu;
#   5. a narrow window's title bar keeps the close button: minimize and maximize slide under the icon's edge;
#   6. the browser's own context menu never opens, except on text fields.
#
# Requires: foot, dbus-daemon, playwright-cli (for its Playwright library and browser), curl, node, the built packages
# (make). Usage: scripts/e2e/taskbar.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools foot dbus-daemon playwright-cli curl node

PINNED_COUNT=12
mkdir -p "$WORK/data/applications" "$WORK/config/greenfield"
pinned=()
for i in $(seq -w 1 "$PINNED_COUNT"); do
  cat >"$WORK/data/applications/test-pin-$i.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pinned $i
Exec=foot --app-id=test-pin-$i
EOF
  pinned+=("\"test-pin-$i.desktop\"")
done
(IFS=,; echo "[${pinned[*]}]") >"$WORK/config/greenfield/pinned.json"
cat >"$WORK/data/applications/test-foot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Terminal
Exec=foot --app-id=test-foot
EOF
read -r DBUS_ADDRESS DBUS_PID < <(dbus-daemon --session --fork --nopidfile --print-address=1 --print-pid=1 | tr '\n' ' '; echo)
[ -n "$DBUS_PID" ] || fail "couldn't start a D-Bus session bus"
export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS"

# the host's time zone as the session reads it (TZ, else /etc/localtime); the browser gets one that's surely another
HOST_TZ="${TZ:-}"
HOST_TZ="${HOST_TZ#:}"
[ -n "$HOST_TZ" ] || HOST_TZ="$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*zoneinfo/##p')"
[ -n "$HOST_TZ" ] || HOST_TZ=UTC
BROWSER_TZ=Pacific/Chatham
[ "$HOST_TZ" = "$BROWSER_TZ" ] && BROWSER_TZ=America/St_Johns

step "starting the gateway on :$PORT and the browser (in $BROWSER_TZ, the host is in $HOST_TZ)"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
E2E_BROWSER_TZ="$BROWSER_TZ" start_driver
pw open "$BASE/?test=1" >/dev/null
# (narrow: the pinned apps don't all fit)
pw resize 640 800 >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40

step "the clock shows the host's time, in its time zone"
# (either of two minutes: the clock may tick between the two readings)
clock_ok="() => { const shown = document.querySelector('#notifications-button .clock').textContent; const format = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: '$HOST_TZ' }); return shown === format(Date.now()) || shown === format(Date.now() - 60000) }"
wait_for "$clock_ok" "the host's time on the clock" 5
[ "$(pw_eval "() => Intl.DateTimeFormat().resolvedOptions().timeZone")" = "\"$BROWSER_TZ\"" ] || fail "the browser isn't in $BROWSER_TZ"
echo "    ok"

BUTTONS="#taskbar-items .taskbar-button.app[data-group]"
OVERFLOW="#taskbar-overflow-button"
shown_keys="() => [...document.querySelectorAll('$BUTTONS')].map((b) => b.dataset.group).join(' ')"
# nothing on the taskbar is cut off: the last button (the '…' one) ends inside the strip
fits="() => { const strip = document.getElementById('taskbar-items').getBoundingClientRect(); const last = [...document.querySelectorAll('#taskbar-items > button')].pop().getBoundingClientRect(); return last.right <= strip.right + 0.5 }"

step "the buttons that don't fit go into the '…' flyout"
wait_for "() => document.querySelectorAll('$BUTTONS').length > 0 && !!document.querySelector('$OVERFLOW')" "the pinned apps and the '…' button" 10
wait_for "$fits" "the taskbar's buttons to fit" 5
SHOWN="$(pw_eval "() => document.querySelectorAll('$BUTTONS').length")"
click_element "$OVERFLOW"
wait_for "() => document.querySelectorAll('#taskbar-overflow [data-group]').length === $PINNED_COUNT - $SHOWN" "the flyout with the other $((PINNED_COUNT - SHOWN)) apps" 5
[ "$(pw_eval "() => document.querySelector('#taskbar-overflow [data-group]').dataset.group")" = "\"test-pin-$(printf %02d $((SHOWN + 1))).desktop\"" ] ||
  fail "the flyout doesn't start with the first app that didn't fit"
click_element "$OVERFLOW"
wait_for "() => !document.getElementById('taskbar-overflow')" "the flyout to close" 5
pw resize 520 800 >/dev/null
wait_for "() => document.querySelectorAll('$BUTTONS').length < $SHOWN && ($fits)()" "fewer buttons in a narrower page" 5
pw resize 640 800 >/dev/null
wait_for "() => document.querySelectorAll('$BUTTONS').length === $SHOWN" "the buttons back" 5
echo "    ok ($SHOWN shown at 640 px)"

step "dragging a button moves it, without launching the app, and the pinned order is saved"
read -r X0 Y0 <<<"$(element_center "$BUTTONS[data-group=\"test-pin-01.desktop\"]")"
read -r X2 _ <<<"$(element_center "$BUTTONS[data-group=\"test-pin-03.desktop\"]")"
pw mousemove "$X0" "$Y0" >/dev/null
pw mousedown >/dev/null
for step_x in $(seq "$X0" 12 "$X2") "$X2"; do
  pw mousemove "$step_x" "$Y0" >/dev/null
done
# while dragging: the others made room (02 and 03 moved one place to the left)
wait_for "() => document.querySelector('$BUTTONS[data-group=\"test-pin-03.desktop\"]').style.transform.startsWith('translateX(-')" "the other buttons to make room" 5
# (the click a release makes is dispatched with it: count those that get past the drag)
pw_eval "() => { window.__clicks = 0; document.addEventListener('click', () => window.__clicks++, { capture: true }); return true }" >/dev/null
pw mouseup >/dev/null
[ "$(pw_eval "() => window.__clicks")" = 0 ] || fail "the click that ended the drag went through (it would launch the app)"
wait_for "() => ($shown_keys)().startsWith('test-pin-02.desktop test-pin-03.desktop test-pin-01.desktop test-pin-04.desktop')" "the new order on the taskbar" 5
saved_order() {
  node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).slice(0, 4).join(" ") === process.argv[2] ? 0 : 1)' \
    "$WORK/config/greenfield/pinned.json" "test-pin-02.desktop test-pin-03.desktop test-pin-01.desktop test-pin-04.desktop" 2>/dev/null
}
wait_until "the new pinned order to be saved" 5 saved_order
[ "$(pw_eval "() => [...document.querySelectorAll('$BUTTONS')].every((b) => !b.style.transform)")" = true ] || fail "a button kept its drag offset"
echo "    ok"

step "Unpin in the Apps menu keeps the Apps menu open"
click_element '#apps-button'
wait_for "() => $(visible apps-menu) && !!document.querySelector('.app-tile[data-app=\"test-pin-12.desktop\"]')" "the pinned apps in the Apps menu" 5
read -r TX TY <<<"$(element_center '.app-tile[data-app="test-pin-12.desktop"]')"
pw mousemove "$TX" "$TY" >/dev/null
pw mousedown right >/dev/null
pw mouseup right >/dev/null
click_element '[data-popup-owner="tile:test-pin-12.desktop"] [data-action=unpin]'
wait_for "() => !document.querySelector('.app-tile[data-app=\"test-pin-12.desktop\"]')" "the app to be unpinned" 5
[ "$(pw_eval "() => $(visible apps-menu)")" = true ] || fail "the Apps menu closed"
pw press Escape >/dev/null
wait_for "() => !$(visible apps-menu)" "the Apps menu to close" 5
echo "    ok"

# $1: the app's desktop entry, $2: its name
launch() {
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"$1\"]') && document.activeElement.id === 'apps-search'" "$1 in the Apps menu"
  pw type "$2" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === '$1'" "searching for $1"
  pw press Enter >/dev/null
  wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
}
foot_ids() { pw_eval "() => window.__viewerTest.windows().filter((w) => w.appId === 'test-foot' && w.hasContent).map((w) => w.id).join(' ')" | tr -d '"'; }

step "a group's preview cards are in creation order"
# (a wide page: everything fits, foot's button is on the taskbar)
pw resize 1280 800 >/dev/null
wait_for "() => !document.querySelector('$OVERFLOW') && ($fits)()" "all buttons on the taskbar, no '…'" 5
launch test-foot.desktop "Test Terminal"
wait_for "() => window.__viewerTest.windows().filter((w) => w.appId === 'test-foot' && w.hasContent && w.placed).length === 1" "the first foot window" 40
FIRST="$(foot_ids)"
launch test-foot.desktop "Test Terminal"
wait_for "() => window.__viewerTest.windows().filter((w) => w.appId === 'test-foot' && w.hasContent && w.placed).length === 2" "the second foot window" 40
SECOND="$(foot_ids | tr ' ' '\n' | grep -vx "$FIRST")"
wait_windows_still
FOOT_BUTTON="#taskbar-items [data-group=\"test-foot.desktop\"]"
wait_for "() => !!document.querySelector('$FOOT_BUTTON')" "foot's taskbar button" 5
cards="() => [...document.querySelectorAll('#window-preview .preview-card')].map((c) => c.dataset.window).join(' ')"
# the second window is on top now; activate the first, which puts it on top, and look again
for _ in 1 2; do
  click_element "$FOOT_BUTTON"
  wait_for "() => ($cards)() === '$FIRST $SECOND'" "the preview cards in creation order" 5
  click_element "#window-preview .preview-card[data-window=\"$FIRST\"]"
  wait_for "() => !document.getElementById('window-preview')" "the preview to close" 5
done
echo "    ok"

step "resting on a card shows only its window; leaving shows them all again"
read -r BX BY <<<"$(element_center "$FOOT_BUTTON")"
pw mousemove "$BX" "$BY" >/dev/null
wait_for "() => !!document.querySelector('#window-preview .preview-card[data-window=\"$SECOND\"]')" "the hover preview" 5
read -r CX CY <<<"$(element_center "#window-preview .preview-card[data-window=\"$SECOND\"]")"
pw mousemove "$CX" "$CY" >/dev/null
peeking="() => document.querySelector('#output .window[data-window=\"$FIRST\"]').classList.contains('peek-faded') && !document.querySelector('#output .window[data-window=\"$SECOND\"]').classList.contains('peek-faded')"
wait_for "$peeking" "the other window to fade out" 5
pw mousemove "$BX" "$BY" >/dev/null
wait_for "() => !document.querySelector('#output .peek-faded')" "all windows shown again" 5
echo "    ok"

step "a card's context menu keeps the preview open while the pointer is on it"
read -r CX CY <<<"$(element_center "#window-preview .preview-card[data-window=\"$SECOND\"]")"
pw mousemove "$CX" "$CY" >/dev/null
pw mousedown right >/dev/null
pw mouseup right >/dev/null
MENU="[data-popup-owner=\"preview:$SECOND\"]"
wait_for "() => !!document.querySelector('$MENU [data-action=minimize]')" "the card's menu" 5
read -r MX MY <<<"$(element_center "$MENU [data-action=minimize]")"
pw mousemove "$MX" "$MY" >/dev/null
# the preview closed 300 ms after the pointer left it: still there well after that
[ "$(pw_eval "async () => { await new Promise((resolve) => setTimeout(resolve, 600)); return !!document.getElementById('window-preview') && !!document.querySelector('$MENU') }")" = true ] ||
  fail "the preview or its menu closed while the pointer was on the menu"
pw mousedown >/dev/null
pw mouseup >/dev/null
wait_for "() => window.__viewerTest.windows().find((w) => w.id === '$SECOND')?.minimized" "the window to be minimized from the menu" 5
echo "    ok"

step "a narrow title bar keeps close: minimize and maximize slide under the icon's edge"
FRAME=".frame[data-frame-window=\"$FIRST\"]"
narrow="$(pw_eval "() => {
  const frame = document.querySelector('$FRAME')
  const width = frame.style.width
  const result = []
  for (const w of [400, 140, 100]) {
    frame.style.width = w + 'px'
    const title = frame.querySelector('.frame-title').getBoundingClientRect()
    const box = frame.querySelector('.frame-buttons').getBoundingClientRect()
    const close = frame.querySelector('.frame-button.close').getBoundingClientRect()
    const icon = title.left + title.height
    result.push(Math.abs(close.right - title.right) <= 1 && box.left >= icon - 1 && box.right <= title.right + 1)
  }
  frame.style.width = width
  return result.join(' ')
}")"
[ "$narrow" = '"true true true"' ] || fail "the title bar's buttons don't fit right at 400, 140 and 100 px: $narrow"
echo "    ok"

step "the browser's context menu never opens, except on text fields"
default_kept() { pw_eval "() => document.querySelector('$1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))"; }
[ "$(default_kept '#taskbar')" = false ] || fail "the taskbar lets the browser's context menu open"
[ "$(default_kept '#tray')" = false ] || fail "the tray lets the browser's context menu open"
[ "$(default_kept '#apps-search')" = true ] || fail "the Apps menu's search field doesn't have the browser's context menu"
echo "    ok"

echo "PASS: the taskbar: the host's clock, overflow, reordering, Unpin, preview order, peeking, preview menus, narrow title bars, no browser context menu"
