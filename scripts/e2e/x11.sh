#!/usr/bin/env bash
# End-to-end test of X11 apps (XWayland) in the desktop: starts the gateway in dev-auth mode on $GATEWAY_PORT, signs in
# in a headless browser (scripts/e2e/browser-driver.js), starts a session and, from the Apps menu:
#   1. launches xev: its window is a desktop window with its X11 title, and the X11 app knows where the viewer put it
#      (xwininfo's absolute position is the window's position in the viewer);
#   2. clicks and types into it: xev gets the button and the key;
#   3. launches xfontsel: its WM_CLASS is its app id (its taskbar button is its desktop entry's, by StartupWMClass);
#      opens one of its menus (an override-redirect window): it's shown with xfontsel's window, where xfontsel put it,
#      and not as a window of its own; choosing from it closes it;
#   4. closes both windows from their taskbar menus (WM_DELETE_WINDOW): the apps exit.
#
# Requires: xev, xfontsel, xwininfo (x11-utils), Xwayland, playwright-cli (for its Playwright library and browser),
# curl, node, the built packages (yarn build). Usage: scripts/e2e/x11.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools xev xfontsel xwininfo Xwayland stdbuf playwright-cli curl node

# The apps the test launches from the Apps menu, each logging to a file of ours (and, for xev, its DISPLAY: the
# session's X11 display, which this test queries with xwininfo).
mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/run-xev" <<EOF
#!/bin/sh
printf %s "\$DISPLAY" >"$WORK/display.tmp" && mv "$WORK/display.tmp" "$WORK/display"
exec stdbuf -oL xev -geometry 400x300 -event keyboard -event button >"$WORK/xev.log" 2>&1
EOF
cat >"$WORK/run-xfontsel" <<EOF
#!/bin/sh
exec xfontsel -geometry 500x200 >"$WORK/xfontsel.log" 2>&1
EOF
chmod +x "$WORK/run-xev" "$WORK/run-xfontsel"
cat >"$WORK/data/applications/test-xev.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test X11 Events
Exec=$WORK/run-xev
EOF
cat >"$WORK/data/applications/test-xfontsel.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test X11 Fonts
Exec=$WORK/run-xfontsel
StartupWMClass=XFontSel
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in and starting a session"
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
grep -aq 'DISPLAY=":[0-9]*"' "$WORK/gateway.log" || fail "the session has no X11 display"
# window positions are on the desktop (the output), which is below the taskbar: this is where it is on the page
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)
# move the pointer to desktop coordinates
pointer_at() {
  wait_windows_still
  pw mousemove $((DESK_X + $1)) $((DESK_Y + $2)) >/dev/null
}

# $1: the app's desktop entry, $2: its name (searched for: the list of all apps is longer than the menu)
launch() {
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"$1\"]') && document.activeElement.id === 'apps-search'" "$1 in the Apps menu"
  pw type "$2" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === '$1'" "searching for $1"
  pw press Enter >/dev/null
  wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
}
# the viewer's window with this title, as JSON (empty if there's none)
window_titled() {
  pw_eval "() => window.__viewerTest.windows().filter((w) => w.title === '$1').map((w) => ({ id: w.id, x: w.shownX, y: w.shownY, appId: w.appId, surfaces: w.surfaces.map((s) => [s.id, s.x, s.y, s.width, s.height]), placed: w.placed, hasContent: w.hasContent }))[0] ?? null"
}
json() { node -e 'const v = JSON.parse(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o?.[k], v))' "$1" "$2"; }

step "launching xev: an X11 window on the desktop"
launch test-xev.desktop "Test X11 Events"
wait_for "() => window.__viewerTest.windows().some((w) => w.title === 'Event Tester' && w.placed && w.hasContent)" "xev's window" 20
XEV="$(window_titled 'Event Tester')"
XEV_X="$(json "$XEV" x)"
XEV_Y="$(json "$XEV" y)"
echo "    window $(json "$XEV" id) at $XEV_X,$XEV_Y"
# the X11 app is told where its window is
X11_DISPLAY="$(cat "$WORK/display")"
x11_position() { DISPLAY="$X11_DISPLAY" xwininfo -name 'Event Tester' | awk '/Absolute upper-left X/ { x = $NF } /Absolute upper-left Y/ { y = $NF } END { print x "," y }'; }
x11_knows_position() { [ "$(x11_position)" = "$XEV_X,$XEV_Y" ]; }
wait_until "xev to be told its position ($XEV_X,$XEV_Y, X11 says $(x11_position))" 5 x11_knows_position
echo "    ok"

step "clicking and typing into xev"
pointer_at $((XEV_X + 200)) $((XEV_Y + 150))
pw mousedown >/dev/null
pw mouseup >/dev/null
xev_got() { grep -aq "$1" "$WORK/xev.log"; }
wait_until "xev to get the button" 5 xev_got 'ButtonRelease event'
pw type "q" >/dev/null
wait_until "xev to get the key" 5 xev_got 'keysym 0x71, q'
grep -aq 'ButtonPress event' "$WORK/xev.log" || fail "xev got no ButtonPress"
echo "    ok"

step "a menu of xfontsel: shown with its window, where xfontsel put it"
launch test-xfontsel.desktop "Test X11 Fonts"
wait_for "() => window.__viewerTest.windows().some((w) => w.title === 'xfontsel' && w.placed && w.hasContent)" "xfontsel's window" 20
FONTSEL="$(window_titled xfontsel)"
FX="$(json "$FONTSEL" x)"
FY="$(json "$FONTSEL" y)"
[ "$(json "$FONTSEL" appId)" = XFontSel ] || fail "xfontsel's app id isn't its WM_CLASS: $(json "$FONTSEL" appId)"
wait_for "() => !!document.querySelector('#taskbar-items button[data-group=\"test-xfontsel.desktop\"]')" "xfontsel's taskbar button" 5
# its first field name ("fndry"), top left: a menu button
pointer_at $((FX + 12)) $((FY + 40))
pw mousedown >/dev/null
menu_shown() { [ "$(pw_eval "() => window.__viewerTest.windows().find((w) => w.title === 'xfontsel').surfaces.length")" -ge 2 ]; }
wait_until "xfontsel's menu" 5 menu_shown
FONTSEL="$(window_titled xfontsel)"
MENU="$(node -e 'const w = JSON.parse(process.argv[1]); console.log(JSON.stringify(w.surfaces[w.surfaces.length - 1]))' "$FONTSEL")"
echo "    menu surface (id, x, y, width, height relative to the window): $MENU"
[ "$(pw_eval "() => window.__viewerTest.windows().length")" = 2 ] || fail "the menu is a window of its own"
# X11 says where it is: the same place, relative to xfontsel's window
MENU_ID="$(json "$MENU" 0)"
read -r MX MY < <(node -e 'const s = JSON.parse(process.argv[1]); console.log(s[1], s[2])' "$MENU")
# (a top level X11 window's line: <id> <name>: <class>  <width>x<height>+<x>+<y>  +<x>+<y>, the size without its border)
menu_where_x11_says() {
  DISPLAY="$X11_DISPLAY" xwininfo -root -tree | grep -q "[0-9]x[0-9]*+$((FX + MX))+$((FY + MY))  +"
}
menu_where_x11_says || fail "the menu isn't where X11 has it: $(DISPLAY="$X11_DISPLAY" xwininfo -root -tree | grep -a "+[0-9]*+[0-9]*  +")"
# choosing its second entry closes the menu
pointer_at $((FX + MX + 10)) $((FY + MY + 25))
pw mouseup >/dev/null
menu_gone() { [ "$(pw_eval "() => window.__viewerTest.windows().find((w) => w.title === 'xfontsel').surfaces.some((s) => s.id === '$MENU_ID')")" = false ]; }
wait_until "the menu to close" 5 menu_gone
echo "    ok"

step "closing X11 windows from the taskbar"
# $1: the window's taskbar group (its app's desktop entry, or window:<id> for an app without one)
close_from_taskbar() {
  local button="#taskbar-items button[data-group=\"$1\"]"
  read -r CX CY <<<"$(element_center "$button")"
  pw mousemove "$CX" "$CY" >/dev/null
  pw mousedown right >/dev/null
  pw mouseup right >/dev/null
  wait_for "() => !!document.querySelector('.context-menu button[data-action=close]')" "the taskbar menu" 5
  click_element ".context-menu button[data-action=close]"
}
close_from_taskbar "window:$(json "$XEV" id)"
wait_for "() => !window.__viewerTest.windows().some((w) => w.title === 'Event Tester')" "xev's window to close" 10
# its taskbar button shrinks away and the next one slides into its place: aim at that one only once it's there (the
# window list changes first, the taskbar a moment later)
wait_for "() => !document.querySelector('#taskbar-items button[data-group=\"window:$(json "$XEV" id)\"]') && !document.querySelector('#taskbar-items .leaving')" "xev's taskbar button to go" 5
close_from_taskbar test-xfontsel.desktop
wait_for "() => window.__viewerTest.windows().length === 0" "xfontsel's window to close" 10
echo "    ok"

echo "PASS: X11 apps: windows, position, input, menus, closing"
