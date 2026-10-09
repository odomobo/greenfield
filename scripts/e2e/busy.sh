#!/usr/bin/env bash
# End-to-end test of a relentless client (core item 2a): starts the gateway in dev mode on $GATEWAY_PORT, signs in
# in a headless browser (scripts/e2e/browser-driver.js), starts a session and launches
#   1. a busy client (scripts/e2e/busy-client.c, built here with wayland-scanner and gcc) that behaves like a vsync game:
#      it commits a new full-surface frame on every frame callback, forever. The test checks that it is shown (patches
#      arrive) and that frame callbacks pace it (it keeps committing, but not unboundedly: its frame rate is what the
#      stream's readiness, the link and the CPU allow);
#   2. foot, an interactive terminal: while the busy client runs, typing into foot reaches the screen within a few
#      seconds. (The busy surface becomes a streaming surface, so its patches go out behind normal ones.)
# No GPU acceleration is assumed: the gateway runs with --encoder none (lib.sh).
#
# Requires: gcc, wayland-scanner (libwayland-dev), wayland-protocols, foot, playwright-cli, curl, node, the built
# packages (make). Usage: scripts/e2e/busy.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc wayland-scanner foot playwright-cli curl node

XDG_SHELL=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
[ -f "$XDG_SHELL" ] || fail "wayland-protocols is not installed ($XDG_SHELL)"
step "building the busy client"
wayland-scanner client-header "$XDG_SHELL" "$WORK/xdg-shell-client-protocol.h"
wayland-scanner private-code "$XDG_SHELL" "$WORK/xdg-shell-protocol.c"
gcc -Wall -Wno-unused-result -O2 -I"$WORK" -o "$WORK/busy-client" "$E2E_DIR/busy-client.c" "$WORK/xdg-shell-protocol.c" \
  -lwayland-client || fail "couldn't build the busy client"

mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/run-busy" <<EOF
#!/bin/sh
exec "$WORK/busy-client" "$WORK/busy-frames" ${BUSY_W:-1920} ${BUSY_H:-1080} >"$WORK/busy.log" 2>&1
EOF
chmod +x "$WORK/run-busy"
cat >"$WORK/data/applications/test-busy.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Busy Client
Exec=$WORK/run-busy
StartupWMClass=test-busy
EOF
cat >"$WORK/data/applications/test-foot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Terminal
Exec=foot --app-id=test-foot
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
grep -aq 'Video encoder: none' "$WORK/gateway.log" || fail "the gateway didn't log its encoder choice"

# $1: the app's desktop entry, $2: its name (searched for: the list of all apps is longer than the menu)
launch() {
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"$1\"]') && document.activeElement.id === 'apps-search'" "$1 in the Apps menu"
  pw type "$2" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === '$1'" "searching for $1"
  pw press Enter >/dev/null
  wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
}
frames() { cat "$WORK/busy-frames" 2>/dev/null || echo 0; }

step "a busy client: its frames are shown, as lossless patches, at a pace the server sets"
launch test-busy.desktop "Test Busy"
wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-busy' && w.placed && w.hasContent)" "the busy window" 30
busy_running() { [ "$(frames)" -gt 20 ]; }
wait_until "the busy client to commit frames" 20 busy_running
wait_for "() => window.__viewerTest.patches() > 0" "patches of the busy window" 10
# (the busy client's buffers are ARGB; its pixels have alpha 255 except where it says otherwise: the patches are decoded in the viewer's worker)
wait_for "() => Object.keys(window.__viewerTest.patchKinds()).length > 0" "decoded patch kinds" 10
[ "$(pw_eval "() => window.__viewerTest.videoFrames().decoded")" = 0 ] || fail "video frames without a video encoder"
# The surface is relentless: it commits on every callback, busy in its first period and backlogged in its second, so the
# server promotes it to the streaming class at the end of the second (1.5 - 2.25 s after it started)
promoted() { grep -aq 'is now streaming' "$WORK/gateway.log"; }
wait_until "the busy surface to be promoted to the streaming class" 20 promoted
echo "    $(grep -a 'is now streaming' "$WORK/gateway.log" | head -1 | sed 's/.*msg:"//; s/"}$//')"
# Its patches are now encoded by the streaming workers, whose threads run at nice 19: those threads use CPU
SESSION_PID="$(session_pid)"
[ -n "$SESSION_PID" ] || fail "no session process"
# CPU ticks (user + system) of the session's threads at nice 19
nice19_ticks() {
  local total=0 stat line rest
  for stat in /proc/"$SESSION_PID"/task/*/stat; do
    line="$(cat "$stat" 2>/dev/null)" || continue
    rest="${line##*) }"
    set -- $rest
    [ "${17}" = 19 ] && total=$((total + ${12} + ${13}))
  done
  echo "$total"
}
workers_busy() { [ "$(nice19_ticks)" -gt 0 ]; }
wait_until "the nice-19 streaming workers to encode the busy surface's patches" 20 workers_busy
echo "    the nice-19 workers have used $(nice19_ticks) ticks of CPU"
F0="$(frames)"
START="$EPOCHREALTIME"
more_frames() { [ "$(frames)" -ge $((F0 + 30)) ]; }
wait_until "the busy client to keep committing frames" 30 more_frames
MS=$(((${EPOCHREALTIME/./} - ${START/./}) / 1000))
echo "    the busy client committed $(($(frames) - F0)) frames in $MS ms"
echo "    ok"

step "foot stays responsive while the busy client runs"
launch test-foot.desktop "Test Terminal"
wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-foot' && w.placed && w.hasContent)" "foot's window" 30
TERMINAL="$(pw_eval "() => { const w = window.__viewerTest.windows().find((w) => w.appId === 'test-foot'); const s = w.surfaces.find((s) => s.id === w.id); return [w.shownX + s.x, w.shownY + s.y, s.width, s.height] }")"
read -r TX TY TW TH < <(echo "$TERMINAL" | tr -d '[]"' | tr ',' ' ')
REGION="$TX, $TY, $((TW < 600 ? TW : 600)), 26"
luma_diff() {
  node -e '
    const [a, b] = process.argv.slice(1).map((f) => JSON.parse(require("fs").readFileSync(f, "utf8")))
    console.log((a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length).toFixed(2))
  ' "$1" "$2"
}
read_luma() { pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$1"; }
# let foot's first paint settle: three identical reads in a row
same=0
: >"$WORK/luma.prev"
for _ in $(seq 1 100); do
  read_luma "$WORK/before.json"
  if cmp -s "$WORK/before.json" "$WORK/luma.prev"; then
    same=$((same + 1))
    [ "$same" -ge 3 ] && break
  else
    same=0
  fi
  cp "$WORK/before.json" "$WORK/luma.prev"
  sleep 0.15
done
F0="$(frames)"
wait_windows_still
pw mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
START="$EPOCHREALTIME"
pw type "echo busy-marker-$$" >/dev/null
pw press Enter >/dev/null
typed_shows() {
  read_luma "$WORK/after.json"
  [ "$(luma_diff "$WORK/before.json" "$WORK/after.json" | node -e 'console.log(Number(require("fs").readFileSync(0, "utf8")) >= 2 ? 1 : 0)')" = 1 ]
}
wait_until "the typed text to reach the screen while the busy client runs" 15 typed_shows
MS=$(((${EPOCHREALTIME/./} - ${START/./}) / 1000))
echo "    the typed text showed after $MS ms (including the driver's own delays)"
# (the client writes its frame count twice a second)
F0="$(frames)"
more_frames() { [ "$(frames)" -gt "$F0" ]; }
wait_until "the busy client to keep committing frames while foot is typed into" 10 more_frames
echo "    ok"

echo "PASS: a busy client is shown as patches, paced by frame callbacks, and an interactive window stays responsive"
