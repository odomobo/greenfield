#!/usr/bin/env bash
# End-to-end test of the server's video path (capture -> GStreamer -> transport -> viewer), which the other scripts
# skip (they run with --encoder none) and video.sh only tests from the viewer's side. The gateway runs with the dev
# software encoder (--dev-software-encoder: GStreamer's x264enc on the CPU, in the stream layout of the hardware
# encoders; no GPU needed), and a relentless client (scripts/e2e/busy-client.c, "flat": four flat color squares in
# moving noise) is promoted to the streaming class, so that its frames go out as video.
# Checks that the viewer decodes video frames for it (none fail), and that what it shows has the client's colors (within
# the tolerance of lossy video).
#
# Requires: gcc, wayland-scanner (libwayland-dev), wayland-protocols, gst-launch-1.0 with x264enc, playwright-cli, curl,
# node, the built packages (make). Usage: scripts/e2e/stream-video.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc wayland-scanner gst-inspect-1.0 playwright-cli curl node
gst-inspect-1.0 --exists x264enc || fail "GStreamer's x264enc is not installed"

XDG_SHELL=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
[ -f "$XDG_SHELL" ] || fail "wayland-protocols is not installed ($XDG_SHELL)"
step "building the busy client"
wayland-scanner client-header "$XDG_SHELL" "$WORK/xdg-shell-client-protocol.h"
wayland-scanner private-code "$XDG_SHELL" "$WORK/xdg-shell-protocol.c"
gcc -Wall -Wno-unused-result -O2 -I"$WORK" -o "$WORK/busy-client" "$E2E_DIR/busy-client.c" "$WORK/xdg-shell-protocol.c" \
  -lwayland-client || fail "couldn't build the busy client"

# the client's size: costly enough as patches for it to be relentless (as in busy.sh), little as video
W=1920
H=1080
mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/run-busy" <<EOF2
#!/bin/sh
exec "$WORK/busy-client" "$WORK/busy-frames" $W $H "$WORK/pause" flat >"$WORK/busy.log" 2>&1
EOF2
chmod +x "$WORK/run-busy"
cat >"$WORK/data/applications/test-busy.desktop" <<EOF2
[Desktop Entry]
Type=Application
Name=Test Busy Client
Exec=$WORK/run-busy
StartupWMClass=test-busy
EOF2

step "starting the gateway with the software encoder on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log" --dev-software-encoder
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in and starting a session"
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
grep -aq 'Video encoder: x264, in software' "$WORK/gateway.log" || fail "the session didn't log the software encoder"

frames() { cat "$WORK/busy-frames" 2>/dev/null || echo 0; }

step "a busy client with known colors streams as video"
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-busy.desktop\"]') && document.activeElement.id === 'apps-search'" "the busy client in the Apps menu"
pw type "Test Busy" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-busy.desktop'" "searching for it"
pw press Enter >/dev/null
wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-busy' && w.placed && w.hasContent)" "the busy window" 30
busy_running() { [ "$(frames)" -gt 20 ]; }
wait_until "the busy client to commit frames" 20 busy_running
promoted() { grep -aq 'is now streaming' "$WORK/gateway.log"; }
wait_until "the busy surface to be promoted to the streaming class" 20 promoted
# the video arrives: frames decoded, none failed
wait_for "() => window.__viewerTest.videoFrames().decoded >= 10" "the viewer to decode video frames" 30
FAILED="$(pw_eval "() => window.__viewerTest.videoFrames().failed")"
[ "$FAILED" = 0 ] || fail "$FAILED video frames failed to decode"
# it keeps coming
D0="$(pw_eval "() => window.__viewerTest.videoFrames().decoded")"
wait_for "() => window.__viewerTest.videoFrames().decoded >= $D0 + 10" "more video frames" 20
echo "    ok: $(pw_eval "() => window.__viewerTest.videoFrames().decoded") video frames decoded"

step "what the video shows has the client's colors"
SURFACE="$(pw_eval "() => window.__viewerTest.windows().find((w) => w.appId === 'test-busy').id" | tr -d '"')"
# a pixel of a surface: "r,g,b,a"
pixel() {
  pw_eval "() => { const p = window.__viewerTest.surfacePixels('$SURFACE', $1, $2, 1, 1); return p ? p.join(',') : 'none' }" | tr -d '"'
}
# $1: actual, $2: expected, within the tolerance of lossy video
near() {
  node -e '
    const a = process.argv[1].split(",").map(Number), e = process.argv[2].split(",").map(Number)
    process.exit(a.length === 4 && a.every((v, i) => Math.abs(v - e[i]) <= 24) ? 0 : 1)
  ' "$1" "$2"
}
# the middle of each colored square
LAST=""
shows_squares() {
  local size
  size="$(pw_eval "() => { const s = window.__viewerTest.contentSize('$SURFACE'); return s ? s.width + 'x' + s.height : 'none' }" | tr -d '"')"
  [ "$size" = "${W}x${H}" ] || { LAST="size $size"; return 1; }
  local x0=$((W / 4)) x1=$((W * 3 / 4)) y0=$((H / 4)) y1=$((H * 3 / 4))
  LAST="$(pixel $x0 $y0) $(pixel $x1 $y0) $(pixel $x0 $y1) $(pixel $x1 $y1)"
  local got
  read -ra got <<<"$LAST"
  near "${got[0]}" "255,0,0,255" && near "${got[1]}" "0,255,0,255" && near "${got[2]}" "0,0,255,255" && near "${got[3]}" "255,255,0,255"
}
shows_squares_or_say() { shows_squares || { echo "    (last seen: $LAST)" >&2; return 1; }; }
wait_until "the surface to show red, green, blue and yellow squares (255,0,0,255 0,255,0,255 0,0,255,255 255,255,0,255)" 20 shows_squares_or_say
echo "    top left, top right, bottom left, bottom right: $LAST"
echo "    ok"

echo "PASS: a busy client streams as video from the software encoder to the viewer, in the right colors"
