#!/usr/bin/env bash
# End-to-end test of lossy encoding when bandwidth is short (roadmap item 5b phase 2): starts the gateway in dev-auth mode
# on $GATEWAY_PORT with a simulated 8 Mbit/s link to the viewer (--dev-link-kbps), signs in in a headless browser and
# launches the busy client (scripts/e2e/busy-client.c, a vsync-game-like client committing a full 640x480 frame on
# every frame callback). The test checks that
#   1. it becomes a streaming surface, the link becomes bandwidth-limited, and its patches arrive as JPEG;
#   2. once it stops drawing (its pause file), bandwidth recovers and its lossy areas are sent again losslessly: the
#      viewer then shows exactly the client's last frame, pixel for pixel;
#   3. bursts (phase 3): now that the link was limited once, a large static page (the busy client's page mode) is
#      promoted as soon as it paints, and again as soon as it scrolls: JPEG patches at once, then it settles
#      (losslessly, at the lowest priority) and is demoted, and the viewer shows its last frame exactly;
#   4. chunks (5d): while the page's large patches cross the link, a tone app's audio packets never wait long behind
#      them (they go between chunks): the simulated link logs any audio packet that waited over 30 ms, and none may
#      have waited over 60 ms. Measured on the server: the headless browser here (software rendering) is itself slow
#      to take messages while it draws. Skipped when the session can't have audio (as scripts/e2e/audio.sh).
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
PAGE_W=1200
PAGE_H=660
PAGE_PAUSE="$WORK/page-pause"
mkdir -p "$WORK/data/applications" "$WORK/config"
# the tone app (as in audio.sh), if the session can have audio
AUDIO=1
for tool in pipewire pipewire-pulse wireplumber gst-launch-1.0; do command -v "$tool" >/dev/null || AUDIO=0; done
for element in pulsesrc pulsesink opusenc rtpopuspay rtpstreampay audiotestsrc; do
  gst-inspect-1.0 "$element" >/dev/null 2>&1 || AUDIO=0
done
if [ "$AUDIO" = 1 ]; then
  cat >"$WORK/data/applications/test-tone.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Tone
Exec=gst-launch-1.0 -q audiotestsrc freq=440 volume=0.3 is-live=true ! audioconvert ! pulsesink
EOF
fi
cat >"$WORK/run-page" <<EOF
#!/bin/sh
exec "$WORK/busy-client" "$WORK/page-frames" $PAGE_W $PAGE_H "$PAGE_PAUSE" page >"$WORK/page.log" 2>&1
EOF
chmod +x "$WORK/run-page"
cat >"$WORK/data/applications/test-page.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Page Client
Exec=$WORK/run-page
StartupWMClass=test-page
EOF
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
# the hash of what the viewer shows of surface $1 ($2 x $3)
shown_hash() {
  pw_eval "() => { const size = window.__viewerTest.contentSize('$1'); if (!size || size.width !== $2 || size.height !== $3) return 0; return ($HASH_JS)(window.__viewerTest.surfacePixels('$1', 0, 0, $2, $3)) }"
}
dump_hash() { node -e "const bytes = require('fs').readFileSync(process.argv[1]); console.log(($HASH_JS)(bytes))" "$1"; }
exact() { [ "$(shown_hash "$SURFACE" $W $H)" = "$EXPECTED" ]; }
wait_until "the viewer to show the client's last frame exactly" 20 exact
echo "    the viewer shows the last frame pixel for pixel; patch kinds: $(pw_eval "() => JSON.stringify(window.__viewerTest.patchKinds())")"
echo "    ok"

audio() { echo "window.__viewerTest.audio()"; }
if [ "$AUDIO" = 1 ]; then
  step "a tone plays (for the audio check of the page step)"
  wait_for "() => { const a = $(audio); return a.available && a.contextState === 'running' && a.sentMuted === false }" "audio to be available and the audio context to run" 30
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"test-tone.desktop\"]') && document.activeElement.id === 'apps-search'" "the tone app in the Apps menu"
  pw type "Test Tone" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-tone.desktop'" "searching for it"
  pw press Enter >/dev/null
  wait_for "() => $(audio).packets > 20" "audio packets" 30
  echo "    ok"
fi

step "a large static page appears: a burst (its backlog needs the link too long), JPEG, then settled and demoted"
touch "$PAGE_PAUSE"
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-page.desktop\"]') && document.activeElement.id === 'apps-search'" "the page client in the Apps menu"
pw type "Test Page" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-page.desktop'" "searching for it"
# from here on, audio must not wait behind the page's patches (checked at the end)
PAGE_LOG_FROM="$(wc -l <"$WORK/gateway.log")"
pw press Enter >/dev/null
wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-page' && w.placed && w.hasContent)" "the page window" 30
PAGE="$(pw_eval "() => window.__viewerTest.windows().find((w) => w.appId === 'test-page').id" | tr -d '"')"
log_count() { grep -ac -- "$1" "$WORK/gateway.log"; }
burst() { [ "$(log_count "Surface $PAGE is now streaming (a burst")" -ge "$1" ]; }
settled() { [ "$(log_count "Surface $PAGE: sending its .* (settling)")" -ge "$1" ]; }
demoted() { [ "$(log_count "Surface $PAGE is now normal")" -ge "$1" ]; }
wait_until "the page to be promoted as a burst" 10 burst 1
echo "    $(grep -a "Surface $PAGE is now streaming (a burst" "$WORK/gateway.log" | head -1 | sed 's/.*msg:"//; s/"}$//')"
wait_until "the page to settle" 20 settled 1
wait_until "the page to be demoted" 20 demoted 1
wait_until "the page client to write its first frame" 10 test -s "$PAGE_PAUSE.rgba"
page_exact() { [ "$(shown_hash "$PAGE" $PAGE_W $PAGE_H)" = "$(dump_hash "$PAGE_PAUSE.rgba")" ]; }
wait_until "the viewer to show the page exactly" 20 page_exact
echo "    ok"

step "the page scrolls: promoted again at once, JPEG; it stops: settled, demoted, exact"
jpeg_count() { pw_eval "() => window.__viewerTest.patchKinds()['3/3'] ?? 0"; }
JPEG_BEFORE="$(jpeg_count)"
rm -f "$PAGE_PAUSE.rgba"
START_NS="$(date +%s%N)"
rm "$PAGE_PAUSE"
more_jpeg() { [ "$(jpeg_count)" -gt "$JPEG_BEFORE" ]; }
wait_until "JPEG patches of the scrolled page" 10 more_jpeg
ELAPSED_MS="$((($(date +%s%N) - START_NS) / 1000000))"
burst 2 || fail "the scrolled page wasn't promoted as a burst"
echo "    JPEG patches $ELAPSED_MS ms after the page started scrolling (polling included)"
[ "$ELAPSED_MS" -lt 1500 ] || fail "JPEG patches took $ELAPSED_MS ms"
# scroll on for a few more frames, then stop
FRAMES_AT="$(cat "$WORK/page-frames" 2>/dev/null || echo 0)"
scrolled() { [ "$(cat "$WORK/page-frames" 2>/dev/null || echo 0)" -ge "$((FRAMES_AT + 2))" ]; }
wait_until "the page to scroll on" 10 scrolled
touch "$PAGE_PAUSE"
wait_until "the page client to write its last frame" 10 test -s "$PAGE_PAUSE.rgba"
wait_until "the page to settle again" 20 settled 2
wait_until "the page to be demoted again" 20 demoted 2
wait_until "the viewer to show the scrolled page exactly" 20 page_exact
echo "    patch kinds: $(pw_eval "() => JSON.stringify(window.__viewerTest.patchKinds())")"
echo "    ok"

if [ "$AUDIO" = 1 ]; then
  step "audio didn't wait behind the page's patches (chunks)"
  [ "$(pw_eval "() => $(audio).packets")" -gt 100 ] || fail "no audio was flowing"
  WAITS="$(tail -n +"$PAGE_LOG_FROM" "$WORK/gateway.log" | { grep -a 'Simulated link: an audio packet waited' || true; } | sed 's/.*waited \([0-9]*\) ms.*/\1/' | tr '\n' ' ')"
  echo "    audio waits over 30 ms since the page appeared: ${WAITS:-none}"
  for wait in $WAITS; do
    [ "$wait" -le 60 ] || fail "an audio packet waited $wait ms in the link behind the page's patches"
  done
  echo "    ok"
fi

echo "PASS: a streaming surface goes lossy (JPEG) on a slow link and is sent again losslessly once bandwidth recovers; bursts go lossy at once, then settle"
