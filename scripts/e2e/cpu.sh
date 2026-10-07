#!/usr/bin/env bash
# Opt-in measurement (not part of test-gateway.sh): the CPU the session process uses while encoding patches, over a fixed
# window. Scenario (first argument): `busy` (the relentless 1920x1080 client, BUSY_W/BUSY_H to change) or `foot` (a
# terminal printing text as fast as it can). The window is MEASURE_SECONDS (default 10). Prints the CPU of the session
# process (all its threads: the patch encoders run in its workers) in ms, the frames committed (busy), the patches the
# viewer received, and the CPU per patch. No GPU: the gateway runs with --encoder none.
# Requires the same tools as busy.sh. Usage: scripts/e2e/cpu.sh busy|foot   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc wayland-scanner foot playwright-cli curl node
SCENARIO="${1:-busy}"
SECONDS_MEASURED="${MEASURE_SECONDS:-10}"

XDG_SHELL=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
[ -f "$XDG_SHELL" ] || fail "wayland-protocols is not installed ($XDG_SHELL)"
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
cat >"$WORK/run-flood" <<EOF
#!/bin/sh
exec foot --app-id=test-flood sh -c 'while :; do cat /usr/include/stdio.h /usr/include/stdlib.h; done'
EOF
chmod +x "$WORK/run-flood"
cat >"$WORK/data/applications/test-flood.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Flood
Exec=$WORK/run-flood
EOF

curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40

launch() {
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"$1\"]') && document.activeElement.id === 'apps-search'" "$1 in the Apps menu"
  pw type "$2" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === '$1'" "searching for $1"
  pw press Enter >/dev/null
  wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
}
frames() { cat "$WORK/busy-frames" 2>/dev/null || echo 0; }

if [ "$SCENARIO" = busy ]; then
  launch test-busy.desktop "Test Busy"
  wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-busy' && w.placed && w.hasContent)" "the busy window" 30
else
  launch test-flood.desktop "Test Flood"
  wait_for "() => window.__viewerTest.windows().some((w) => w.appId === 'test-flood' && w.placed && w.hasContent)" "the flood window" 30
fi
SESSION_PID="$(ps --ppid "$GATEWAY_PID" -o pid=,args= | grep session-process | awk '{print $1}' | head -1)"
[ -n "$SESSION_PID" ] || fail "no session process"
sleep 4 # let it settle (the busy surface is promoted after 1.5 - 2.25 s)
# user + system CPU of the process, all threads, in ms (clock ticks are 100 Hz)
cpu_ms() { awk '{ rest = $0; sub(/^.*\) /, "", rest); split(rest, f, " "); print (f[12] + f[13]) * 10 }' "/proc/$SESSION_PID/stat"; }
C0="$(cpu_ms)"
P0="$(pw_eval "() => window.__viewerTest.patches()")"
F0="$(frames)"
sleep "$SECONDS_MEASURED"
C1="$(cpu_ms)"
P1="$(pw_eval "() => window.__viewerTest.patches()")"
F1="$(frames)"
CPU=$((C1 - C0))
PATCHES=$((P1 - P0))
echo "RESULT scenario=$SCENARIO seconds=$SECONDS_MEASURED session_cpu_ms=$CPU cpu_percent=$((CPU / (SECONDS_MEASURED * 10))) frames=$((F1 - F0)) patches=$PATCHES cpu_ms_per_patch=$(awk "BEGIN { printf \"%.2f\", $CPU / ($PATCHES > 0 ? $PATCHES : 1) }")"
