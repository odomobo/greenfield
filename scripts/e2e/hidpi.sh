#!/usr/bin/env bash
# End-to-end test of HiDPI: apps render at the viewer's scale. Starts the gateway in dev mode on $GATEWAY_PORT,
# signs in in a headless browser (scripts/e2e/browser-driver.js), launches foot and checks that:
#   1. at a device pixel ratio of 1, the content of foot's surface (its buffer) is the size of the surface;
#   2. when the ratio changes (the window moving to another monitor, browser zoom) to 2, and to 1.5 (wp_fractional_scale_v1
#      with wp_viewporter), foot renders at that scale: its content is that many times its surface (the scene's size,
#      in CSS pixels), which stays logical;
#   3. back at 1, the content is the surface's size again;
# (The size of client cursors is covered by unit tests.)
#
# Requires: foot, dbus-daemon, playwright-cli (for its Playwright library and browser), curl, node, the built
# packages (make). Usage: scripts/e2e/hidpi.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools foot dbus-daemon playwright-cli curl node

mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/data/applications/test-foot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Terminal
Exec=env WAYLAND_DEBUG=1 foot --app-id=test-foot
EOF
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

# the first (main) surface of the only window: its logical size, and the size of its content, as "<w>x<h> <w>x<h>"
SURFACE_JS="() => { const s = window.__viewerTest.windows()[0].surfaces[0]; const c = window.__viewerTest.contentSize(s.id); return c ? s.width + 'x' + s.height + ' ' + c.width + 'x' + c.height : '' }"
# true when the content is $1 times the surface, within a pixel
content_scale_is() {
  echo "() => { const s = window.__viewerTest.windows()[0].surfaces[0]; const c = window.__viewerTest.contentSize(s.id); return !!c && Math.abs(c.width - s.width * $1) <= 1.5 && Math.abs(c.height - s.height * $1) <= 1.5 }"
}

step "launching foot at a device pixel ratio of 1"
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-foot.desktop\"]') && document.activeElement.id === 'apps-search'" "foot in the Apps menu"
pw type "Test Terminal" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-foot.desktop'" "searching for foot"
pw press Enter >/dev/null
wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot's window" 40
wait_for "$(content_scale_is 1)" "foot's content to be the size of its surface at scale 1" 10
echo "    $(pw_eval "$SURFACE_JS")"
echo "    ok"

for ratio in 2 1.5 1; do
  step "the device pixel ratio becomes $ratio"
  pw scale "$ratio" >/dev/null
  wait_for "() => window.devicePixelRatio === $ratio" "the page's ratio" 5
  wait_for "$(content_scale_is "$ratio")" "foot's content to be $ratio times its surface" 15
  echo "    surface and content: $(pw_eval "$SURFACE_JS")"
  echo "    ok"
done

echo "PASS: HiDPI: foot renders at the viewer's scale (2, 1.5, 1), the scene stays in CSS pixels"
