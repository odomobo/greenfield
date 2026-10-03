#!/usr/bin/env bash
# End-to-end test: a session survives its viewer going away.
#
# Starts a proxy and the viewer on test ports, launches foot, types a command, closes the browser, reconnects and
# checks that the same window comes back at the same place, showing the earlier output, with foot still running.
#
# Requires: foot, playwright-cli (with its Chromium), built packages (compositor build:server, compositor-proxy,
# compositor-proxy-cli). Run from anywhere:
#   scripts/test-reattach.sh
# Ports can be changed with PROXY_PORT and VIEWER_PORT.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY_PORT="${PROXY_PORT:-8095}"
VIEWER_PORT="${VIEWER_PORT:-8096}"
SESSION="reattach-test-$$"
PW="playwright-cli -s=$SESSION"
WORK="$(mktemp -d)"
URL="http://localhost:$VIEWER_PORT/?server=localhost:$PROXY_PORT&session=$SESSION&test=1"

PROXY_PID=""
VIEWER_PID=""

cleanup() {
  $PW close >/dev/null 2>&1 || true
  # SIGTERM makes the proxy stop its sessions and their apps
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "$VIEWER_PID" ] && kill "$VIEWER_PID" 2>/dev/null || true
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- proxy log (tail) ---" >&2
  tail -n 30 "$WORK/proxy.log" >&2 || true
  exit 1
}

step() { echo "==> $*"; }

for tool in foot playwright-cli curl node; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done
[ -f "$REPO/packages/compositor/dist-server/index.mjs" ] || fail "build the compositor first: (cd packages/compositor && yarn build:server)"
[ -f "$REPO/packages/compositor-proxy-cli/dist/main.js" ] || fail "build the proxy first: yarn build in packages/compositor-proxy and packages/compositor-proxy-cli"

# Evaluate a JS expression in the viewer page and print its JSON result on one line.
pw_eval() {
  $PW eval "$1" 2>/dev/null | sed -n '/^### Result/,/^### /{/^### /d;p}' | tr -d '\n'
}

# Wait until a JS expression evaluates to true.
wait_for() {
  local expression="$1" what="$2" timeout="${3:-30}"
  for _ in $(seq 1 $((timeout * 2))); do
    [ "$(pw_eval "$expression")" = "true" ] && return 0
    sleep 0.5
  done
  fail "timed out waiting for $what"
}

# playwright-cli writes its logs to the current directory
cd "$WORK"

cat >"$WORK/apps.json" <<EOF
{ "/foot": { "name": "Foot", "executable": "foot", "args": [], "env": {} } }
EOF

step "starting proxy on :$PROXY_PORT and viewer on :$VIEWER_PORT"
(cd "$REPO/packages/compositor-proxy-cli" &&
  exec env -u DISPLAY yarn node dist/main.js --applications="$WORK/apps.json" --bind-port="$PROXY_PORT" \
    --base-url="ws://localhost:$PROXY_PORT" --allow-origin="http://localhost:$VIEWER_PORT") >"$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
(cd "$REPO/packages/viewer" && exec yarn vite --port "$VIEWER_PORT" --strictPort) >"$WORK/viewer.log" 2>&1 &
VIEWER_PID=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "localhost:$PROXY_PORT/apps" && curl -s -o /dev/null "localhost:$VIEWER_PORT" && break
  sleep 0.5
done
curl -s -o /dev/null "localhost:$PROXY_PORT/apps" || fail "proxy didn't start"

step "opening viewer"
$PW open "$URL" >/dev/null
# the first load can be reloaded by the dev server while it optimizes dependencies
sleep 2
wait_for "() => !!window.__viewerTest && window.__viewerTest.connected()" "viewer connection"

step "launching foot"
FOOT_PID="$(curl -s "localhost:$PROXY_PORT/launch?session=$SESSION&app=/foot" | sed -n 's/.*"pid":"\([0-9]*\)".*/\1/p')"
[ -n "$FOOT_PID" ] || fail "launching foot failed"
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot window"
sleep 1

# The terminal's main surface, in output coordinates.
TERMINAL="$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; const s = w.surfaces.find((s) => s.id === w.id); return [w.id, w.shownX + s.x, w.shownY + s.y, s.width, s.height] }")"
read -r WINDOW_ID TX TY TW TH < <(echo "$TERMINAL" | tr -d '[]"' | tr ',' ' ')
echo "    window $WINDOW_ID at $TX,$TY (${TW}x${TH})"
# first two text lines: the command and its output (the third line has the cursor, which depends on focus)
REGION="$TX, $TY, $((TW < 600 ? TW : 600)), 26"
pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$WORK/before-typing.json"

step "typing a command"
$PW mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
$PW mousedown >/dev/null
$PW mouseup >/dev/null
$PW type "clear; echo reattach-marker-$$" >/dev/null
$PW press Enter >/dev/null
sleep 2
pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$WORK/after-typing.json"

step "closing the browser"
$PW close >/dev/null
for _ in $(seq 1 20); do
  grep -q "Viewer detached" "$WORK/proxy.log" && break
  sleep 0.5
done
grep -q "Viewer detached" "$WORK/proxy.log" || fail "server didn't notice the viewer leaving"
sleep 2
kill -0 "$FOOT_PID" 2>/dev/null || fail "foot didn't survive the viewer going away"

step "reopening the viewer"
$PW open "$URL" >/dev/null
sleep 2
wait_for "() => !!window.__viewerTest && window.__viewerTest.connected()" "viewer reconnection"
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].hasContent }" "foot window after reattach"
sleep 1

AFTER="$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; const s = w.surfaces.find((s) => s.id === w.id); return [w.id, w.shownX + s.x, w.shownY + s.y] }")"
read -r WINDOW_ID2 TX2 TY2 < <(echo "$AFTER" | tr -d '[]"' | tr ',' ' ')
[ "$WINDOW_ID2" = "$WINDOW_ID" ] || fail "a different window came back ($WINDOW_ID2 instead of $WINDOW_ID)"
[ "$TX2,$TY2" = "$TX,$TY" ] || fail "window moved from $TX,$TY to $TX2,$TY2"
pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$WORK/after-reattach.json"

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
// lossy re-encoding of the same content may differ a little
if (reattached > typed / 4) {
  console.error('FAIL: the earlier output is not shown after reattaching')
  process.exit(1)
}
EOF

echo "PASS: session survived closing the viewer"
