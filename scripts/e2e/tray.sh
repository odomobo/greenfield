#!/usr/bin/env bash
# End-to-end test of the system tray (StatusNotifierItems). Starts the gateway in dev mode on $GATEWAY_PORT with its
# own D-Bus session bus, signs in in a headless browser (scripts/e2e/browser-driver.js) and checks that:
#   1. a test app (packages/session/src/test-fixtures/tray-item.ts) launched from the Apps menu puts its icon in the
#      taskbar's tray, with its tooltip; the same item from a process outside the desktop isn't shown;
#   2. a left click activates it, a middle click is its secondary action, the wheel scrolls it;
#   3. a right click shows its menu (dbusmenu) as our context menu: mnemonics gone, the check box checked, the disabled
#      entry disabled, the hidden one missing; pointing at a submenu opens it; an entry the app adds while the menu is
#      open shows up; clicking an entry reaches the app and closes the menu (the app hears that too);
#   4. needing attention changes the icon; the icon goes when the app ends.
#
# Requires: dbus-daemon, playwright-cli (for its Playwright library and browser), curl, node, the built packages
# (make). Usage: scripts/e2e/tray.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools dbus-daemon playwright-cli curl node

FIXTURE="$REPO/packages/session/dist/test-fixtures/tray-item.js"
EVENTS="$WORK/events"
mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/data/applications/test-tray.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Test Tray
Exec=node $FIXTURE $EVENTS "Test Tray"
DESKTOP
read -r DBUS_ADDRESS DBUS_PID < <(dbus-daemon --session --fork --nopidfile --print-address=1 --print-pid=1 | tr '\n' ' '; echo)
[ -n "$DBUS_PID" ] || fail "couldn't start a D-Bus session bus"
export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS"

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40

# the lines the test app wrote
has_event() { grep -qx -- "$1" "$EVENTS" 2>/dev/null; }
wait_event() { wait_until "the app to get \"$1\"" 5 has_event "$1"; }
ITEM="[data-tray-item]"
MENU="[data-popup-owner^=\"tray-menu:\"]"
# the labels of the entries of the (first) menu matching $1, joined with |
labels_js() { echo "[...(document.querySelector('$1')?.querySelectorAll('[role^=menuitem]') ?? [])].map((e) => e.textContent).join('|')"; }
menu_labels() { echo "() => $(labels_js "$1")"; }

step "a tray item from outside the desktop isn't shown"
node "$FIXTURE" "$WORK/foreign-events" "Foreign" >/dev/null 2>&1 &
EXTRA_PIDS+=("$!")
foreign_seen() { grep -q "belongs to another desktop" "$WORK/gateway.log"; }
wait_until "the session to see the foreign item" 10 foreign_seen
echo "    ok"

step "the test app's icon shows in the tray, with its tooltip"
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-tray.desktop\"]') && document.activeElement.id === 'apps-search'" "the test app in the Apps menu"
pw type "Test Tray" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-tray.desktop'" "searching for the test app"
pw press Enter >/dev/null
wait_for "() => document.querySelectorAll('$ITEM').length === 1 && document.querySelector('$ITEM img')?.src.startsWith('data:image/png')" "the tray icon" 10
[ "$(pw_eval "() => document.querySelector('$ITEM').title")" = '"Test Tray tip\nTooltip body & more"' ] ||
  fail "the tooltip is wrong: $(pw_eval "() => document.querySelector('$ITEM').title")"
ITEM_PID="$(awk '/^started/ { print $2 }' "$EVENTS")"
[ -n "$ITEM_PID" ] || fail "the test app didn't start"
echo "    ok"

step "left click, middle click and the wheel reach the app"
read -r CX CY <<<"$(element_center "$ITEM")"
pw mousemove "$CX" "$CY" >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
activated() { grep -q '^Activate ' "$EVENTS"; }
wait_until "the app to be activated" 5 activated
pw mousedown middle >/dev/null
pw mouseup middle >/dev/null
secondary() { grep -q '^SecondaryActivate ' "$EVENTS"; }
wait_until "the secondary activation" 5 secondary
pw wheel 0 100 >/dev/null
wait_event "Scroll -120 vertical"
echo "    ok"

step "a right click shows its menu"
pw mousedown right >/dev/null
pw mouseup right >/dev/null
wait_for "() => !!document.querySelector('$MENU')" "the tray menu" 5
[ "$(pw_eval "$(menu_labels "$MENU")")" = '"Open Window|Enabled|More|Disabled|Quit"' ] ||
  fail "the menu's entries are wrong: $(pw_eval "$(menu_labels "$MENU")")"
[ "$(pw_eval "() => document.querySelector('$MENU [data-action=entry-2]').getAttribute('aria-checked') + ' ' + document.querySelector('$MENU [data-action=entry-6]').disabled")" = '"true true"' ] ||
  fail "the check box isn't checked or the disabled entry isn't disabled"
wait_event "AboutToShow 0"
echo "    ok"

step "the submenu opens, an entry added meanwhile shows, a click reaches the app"
read -r MX MY <<<"$(element_center "$MENU [data-action=entry-4]")"
pw mousemove "$MX" "$MY" >/dev/null
SUBMENU="[data-popup-owner\$=\"/4\"]"
wait_for "() => !!document.querySelector('$SUBMENU')" "the submenu" 5
[ "$(pw_eval "$(menu_labels "$SUBMENU")")" = '"Sub entry"' ] || fail "the submenu's entries are wrong"
wait_event "Event 4 opened"
kill -USR2 "$ITEM_PID"
wait_for "() => $(labels_js "$MENU") === 'Open Window|Enabled|More|Disabled|Quit|Added 1'" "the added entry in the open menu" 5
click_element "$SUBMENU [data-action=entry-5]"
wait_event "Event 5 clicked"
wait_for "() => !document.querySelector('$MENU')" "the menu to close" 5
wait_event "Event 0 closed"
echo "    ok"

step "needing attention changes the icon; it goes when the app ends"
pw_eval "() => { window.__trayIcon = document.querySelector('$ITEM img').src; return true }" >/dev/null
kill -USR1 "$ITEM_PID"
wait_for "() => document.querySelector('$ITEM').classList.contains('attention') && document.querySelector('$ITEM img').src !== window.__trayIcon" "the attention icon" 5
kill "$ITEM_PID"
wait_for "() => document.querySelectorAll('$ITEM').length === 0" "the icon to go" 5
echo "    ok"

echo "PASS: the system tray: icons, tooltips, clicks, the wheel, menus and submenus, updates, only this desktop's items"
