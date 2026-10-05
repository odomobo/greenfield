#!/usr/bin/env bash
# End-to-end test of lossy encoding when bandwidth is short (roadmap item 5b phase 2): starts the gateway in dev-auth mode
# on $GATEWAY_PORT with a simulated 8 Mbit/s link to the viewer (--dev-link-kbps), signs in in a headless browser and
# launches the busy client (scripts/e2e/busy-client.c, a vsync-game-like client committing a full 640x480 frame on
# every frame callback). The test checks that
#   1. it becomes a streaming surface, the link becomes bandwidth-limited, and its patches arrive as JPEG;
#   2. once it stops drawing (its pause file), bandwidth recovers and its lossy areas are sent again losslessly: the
#      viewer then shows exactly the client's last frame, pixel for pixel.
# No GPU acceleration is assumed: the gateway runs with --encoder none (lib.sh).
#
# Requires: gcc, wayland-scanner (libwayland-dev), wayland-protocols, playwright-cli, curl, node, the built packages
# (yarn build). Usage: scripts/e2e/lossy.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc wayland-scanner playwright-cli curl node

XDG_SHELL=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
[ -f "$XDG_SHELL" ] || fail "wayland-protocols is not installed ($XDG_SHELL)"
step "building the busy client"
wayland-scanner client-header "$XDG_SHELL" "$WORK/xdg-shell-client-protocol.h"
wayland-scanner private-code "$XDG_SHELL" "$WORK/xdg-shell-protocol.c"
gcc -Wall -Wno-unused-result -O2 -I"$WORK" -o "$WORK/busy-client" "$E2E_DIR/busy-client.c" "$WORK/xdg-shell-protocol.c" \
  -lwayland-client || fail "couldn't build the busy client"

W=640
H=480
PAUSE="$WORK/busy-pause"
mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/run-busy" <<EOF
#!/bin/sh
exec "$WORK/busy-client" "$WORK/busy-frames" $W $H "$PAUSE" >"$WORK/busy.log" 2>&1
EOF
chmod +x "$WORK/run-busy"
cat >"$WORK/data/applications/test-busy.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Busy Client
Exec=$WORK/run-busy
StartupWMClass=test-busy
EOF

step "starting the gateway on :$PORT with an 8 Mbit/s link, and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log" --dev-link-kbps 8000
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in and starting a session"
pw open "$BASE/?test=1" >/dev/null
browser_login
pw_eval "() => { document.querySelector('#new-session').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
grep -aq 'simulated link of 8000 kbit/s' "$WORK/gateway.log" || fail "the session didn't log its simulated link"

step "the busy client on a slow link: streaming, bandwidth-limited, JPEG patches"
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-busy.desktop\"]') && document.activeElement.id === 'apps-search'" "the busy client in the Apps menu"
pw type "Test Busy" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-busy.desktop'" "searching for it"
pw press Enter >/dev/null
wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-busy' && w.placed && w.hasContent)" "the busy window" 30
promoted() { grep -aq 'is now streaming' "$WORK/gateway.log"; }
wait_until "the busy surface to be promoted to the streaming class" 20 promoted
limited() { grep -aq 'Bandwidth-limited' "$WORK/gateway.log"; }
wait_until "the link to be judged bandwidth-limited" 20 limited
echo "    $(grep -a 'Bandwidth-limited' "$WORK/gateway.log" | head -1 | sed 's/.*msg:"//; s/"}$//')"
# JPEG (format 3) with 3 channels: the client's pixels are opaque
wait_for "() => window.__viewerTest.patchKinds()['3/3'] > 0" "JPEG patches of the busy window" 20
echo "    patch kinds: $(pw_eval "() => JSON.stringify(window.__viewerTest.patchKinds())")"
echo "    ok"

step "the client stops drawing: bandwidth recovers and the lossy areas are sent again losslessly"
touch "$PAUSE"
dumped() { [ -s "$PAUSE.rgba" ]; }
wait_until "the busy client to write its last frame" 10 dumped
recovered() { grep -aq 'No longer bandwidth-limited' "$WORK/gateway.log"; }
wait_until "bandwidth to recover" 20 recovered
echo "    $(grep -a 'No longer bandwidth-limited' "$WORK/gateway.log" | head -1 | sed 's/.*msg:"//; s/"}$//')"
refreshed() { grep -aq 'lossy pixels again, losslessly' "$WORK/gateway.log"; }
wait_until "the lossy areas to be sent again" 10 refreshed
# FNV-1a over the RGBA bytes, in the page and of the client's dump
HASH_JS='(bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0 } return h }'
EXPECTED="$(node -e "const bytes = require('fs').readFileSync(process.argv[1]); console.log(($HASH_JS)(bytes))" "$PAUSE.rgba")"
SURFACE="$(pw_eval "() => window.__viewerTest.windows().find((w) => w.appId === 'test-busy').id" | tr -d '"')"
shown_hash() {
  pw_eval "() => { const size = window.__viewerTest.contentSize('$SURFACE'); if (!size || size.width !== $W || size.height !== $H) return 0; return ($HASH_JS)(window.__viewerTest.surfacePixels('$SURFACE', 0, 0, $W, $H)) }"
}
exact() { [ "$(shown_hash)" = "$EXPECTED" ]; }
wait_until "the viewer to show the client's last frame exactly" 20 exact
echo "    the viewer shows the last frame pixel for pixel; patch kinds: $(pw_eval "() => JSON.stringify(window.__viewerTest.patchKinds())")"
echo "    ok"

echo "PASS: a streaming surface goes lossy (JPEG) on a slow link and is sent again losslessly once bandwidth recovers"
