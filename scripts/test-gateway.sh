#!/usr/bin/env bash
# End-to-end test of the gateway: login, isolation checks, and a session surviving the browser.
#
# Starts the gateway in dev-auth mode (sessions run as the current user) with TLS on a test port, then:
#   1. checks the login page leaks nothing: same response for an unknown user and a wrong password, no product
#      names, nothing reachable without logging in, WebSockets refused without a valid cookie / with a foreign Origin,
#      CSRF enforced, and unsafe flag combinations refused;
#   2. in a browser: logs in, starts a session, launches foot from the viewer, types a command, closes the browser,
#      logs in again, finds the session listed, opens it and checks the same window comes back with the earlier
#      output, with foot still running;
#   3. window management in the viewer: a resize follows the pointer immediately (without waiting for the server),
#      resizing from the left/top edge keeps the right/bottom edge in place, and shrinking the viewport moves a window
#      back into view;
#   4. renaming the session from the session list (a name with HTML in it shows as text).
#
# Requires: foot, playwright-cli (with its Chromium), curl, node, built packages (yarn build in packages/compositor
# (incl. build:server), compositor-proxy, viewer, gateway). Run from anywhere:
#   scripts/test-gateway.sh
# The port can be changed with GATEWAY_PORT.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${GATEWAY_PORT:-8098}"
BASE="https://127.0.0.1:$PORT"
PASSWORD="test-password-$$"
ME="$(id -un)"
PWS="gateway-test-$$"
PW="playwright-cli -s=$PWS"
WORK="$(mktemp -d)"
GATEWAY_PID=""

cleanup() {
  $PW close >/dev/null 2>&1 || true
  # SIGTERM makes the gateway end its sessions and their apps
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
  sleep 2
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- gateway log (tail) ---" >&2
  tail -n 40 "$WORK/gateway.log" >&2 || true
  exit 1
}

step() { echo "==> $*"; }

for tool in foot playwright-cli curl node; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done
[ -f "$REPO/packages/gateway/dist/main.js" ] || fail "build the gateway first: (cd packages/gateway && yarn build)"
[ -f "$REPO/packages/viewer/dist/index.html" ] || fail "build the viewer first: (cd packages/viewer && yarn build)"

# playwright-cli writes its logs to the current directory
cd "$WORK"

cat >"$WORK/apps.json" <<EOF
{ "/foot": { "name": "Foot", "executable": "foot", "args": [], "env": {} } }
EOF
cat >"$WORK/playwright.json" <<EOF
{ "browser": { "contextOptions": { "ignoreHTTPSErrors": true, "viewport": null } } }
EOF

gateway() {
  env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" node "$REPO/packages/gateway/dist/main.js" "$@"
}

step "refusing unsafe configurations"
gateway --dev-auth --bind-ip 0.0.0.0 --bind-port "$PORT" --state-dir "$WORK/state" >/dev/null 2>&1 &&
  fail "dev auth started on a public address"
gateway --insecure-plaintext --dev-auth --bind-ip 0.0.0.0 --bind-port "$PORT" --state-dir "$WORK/state" >/dev/null 2>&1 &&
  fail "plaintext started on a public address"
GREENFIELD_DEV_PASSWORD=short node "$REPO/packages/gateway/dist/main.js" --dev-auth --bind-ip 127.0.0.1 \
  --bind-port "$PORT" >/dev/null 2>&1 && fail "dev auth started with a weak password"
gateway --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 && fail "PAM mode started without root"
echo "    ok"

step "starting the gateway on :$PORT"
curl -sk -o /dev/null "$BASE/login" && fail "port $PORT is already in use"
# exec, so $! is the gateway itself and cleanup can stop it
(exec env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" node "$REPO/packages/gateway/dist/main.js" --dev-auth \
  --bind-ip 127.0.0.1 --bind-port "$PORT" --state-dir "$WORK/state" --applications="$WORK/apps.json") \
  >"$WORK/gateway.log" 2>&1 &
GATEWAY_PID=$!
for _ in $(seq 1 40); do
  curl -sk -o /dev/null "$BASE/login" && break
  sleep 0.5
done
curl -sk -o /dev/null "$BASE/login" || fail "gateway didn't start"

# --- 1. leak and access checks ---

# Fetch the login form; sets $JAR and $CSRF
login_form() {
  JAR="$WORK/jar-$1"
  rm -f "$JAR"
  CSRF="$(curl -sk -c "$JAR" "$BASE/login" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p')"
  [ -n "$CSRF" ] || fail "no csrf token in login form"
}

# POST a login; prints "<status> <seconds>" and stores the body in $WORK/$1.html
login_attempt() {
  local name="$1" user="$2" pass="$3"
  login_form "$name"
  curl -sk -b "$JAR" -c "$JAR" -o "$WORK/$name.html" -w '%{http_code} %{time_total}' \
    -H "Origin: $BASE" --data-urlencode "csrf=$CSRF" --data-urlencode "username=$user" \
    --data-urlencode "password=$pass" "$BASE/login"
  echo
}

step "login page reveals nothing"
HEADERS="$(curl -sk -D - -o "$WORK/login.html" "$BASE/login")"
echo "$HEADERS" | grep -qi '^server:' && fail "Server header present"
grep -qi -E 'greenfield|gateway|compositor|wayland|node' "$WORK/login.html" && fail "product name on the login page"
echo "$HEADERS" | grep -qi -E 'greenfield|express|node' && fail "product name in headers"
grep -q "$(hostname)" "$WORK/login.html" || fail "hostname not shown"
echo "    ok"

step "unknown user and wrong password look the same"
read -r STATUS_UNKNOWN TIME_UNKNOWN < <(login_attempt unknown "nosuchuser-$$" "whatever-password")
read -r STATUS_WRONG TIME_WRONG < <(login_attempt wrong "$ME" "not-the-password")
echo "    unknown user: $STATUS_UNKNOWN in ${TIME_UNKNOWN}s, wrong password: $STATUS_WRONG in ${TIME_WRONG}s"
[ "$STATUS_UNKNOWN" = "$STATUS_WRONG" ] || fail "different status codes"
normalize() { sed -e 's/name="csrf" value="[^"]*"/CSRF/' -e "s/value=\"$2\"/USER/" "$1"; }
diff <(normalize "$WORK/unknown.html" "nosuchuser-$$") <(normalize "$WORK/wrong.html" "$ME") >/dev/null ||
  fail "different response bodies for unknown user and wrong password"
node -e "const [a,b]=process.argv.slice(1).map(Number); if (a<2.9||b<2.9||Math.abs(a-b)>0.5) process.exit(1)" \
  "$TIME_UNKNOWN" "$TIME_WRONG" || fail "failure timing differs or is too fast"
echo "    ok"

step "failed logins are throttled, for any username"
THROTTLED_USER="nobody-$$"
for i in 1 2 3 4 5; do
  login_attempt "throttle$i" "$THROTTLED_USER" "wrong-$i" >/dev/null
done
login_attempt throttled "$THROTTLED_USER" "wrong-6" >/dev/null
grep -q "Too many failed attempts" "$WORK/throttled.html" || fail "6th failed login was not throttled"
echo "    ok"

step "nothing is reachable without logging in"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/me")" = 401 ] || fail "/api/me without login"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/sessions")" = 401 ] || fail "/api/sessions without login"
[ "$(curl -sk -o /dev/null -w '%{redirect_url}' "$BASE/desktop/")" = "$BASE/login" ] || fail "/desktop/ without login"
[ "$(curl -sk -o /dev/null -w '%{redirect_url}' "$BASE/sessions")" = "$BASE/login" ] || fail "/sessions without login"
WS_HEADERS=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
ws_status() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "${WS_HEADERS[@]}" "$@" || true; }
[ "$(ws_status -H "Origin: $BASE" "$BASE/ws?session=x")" = 401 ] || fail "WebSocket without cookie"
[ "$(ws_status -H "Origin: $BASE" -b "__Host-gf_session=forged" "$BASE/ws?session=x")" = 401 ] || fail "WebSocket with forged cookie"
echo "    ok"

step "logging in with curl"
read -r STATUS _ < <(login_attempt good "$ME" "$PASSWORD")
[ "$STATUS" = 303 ] || fail "login failed ($STATUS)"
AUTH_JAR="$WORK/jar-good"
ME_JSON="$(curl -sk -b "$AUTH_JAR" "$BASE/api/me")"
SESSION_CSRF="$(echo "$ME_JSON" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')"
[ -n "$SESSION_CSRF" ] || fail "/api/me: $ME_JSON"
[ "$(ws_status -H "Origin: https://evil.example" -b "$AUTH_JAR" "$BASE/ws?session=x")" = 403 ] || fail "WebSocket from a foreign origin"
[ "$(ws_status -H "Origin: $BASE" -b "$AUTH_JAR" "$BASE/ws?session=not-mine")" = 404 ] || fail "WebSocket to someone else's session"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -b "$AUTH_JAR" -H "Origin: $BASE" --data "csrf=wrong" "$BASE/sessions/new")" = 403 ] ||
  fail "creating a session without the CSRF token"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -b "$AUTH_JAR" -H "Origin: https://evil.example" --data "csrf=$SESSION_CSRF" "$BASE/sessions/new")" = 403 ] ||
  fail "creating a session from a foreign origin"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -b "$AUTH_JAR" -H "Origin: $BASE" -H 'Content-Type: application/json' --data '{"app":"/foot"}' "$BASE/api/sessions/x/launch")" = 403 ] ||
  fail "launching without the CSRF header"
echo "    ok"

step "plaintext mode works on loopback, without Secure cookies"
PLAIN_PORT=$((PORT + 1))
(exec env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" node "$REPO/packages/gateway/dist/main.js" --dev-auth \
  --insecure-plaintext --bind-ip 127.0.0.1 --bind-port "$PLAIN_PORT" --state-dir "$WORK/state") >"$WORK/plain.log" 2>&1 &
PLAIN_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PLAIN_PORT/login" && break
  sleep 0.5
done
PLAIN_HEADERS="$(curl -s -D - -o /dev/null "http://127.0.0.1:$PLAIN_PORT/login")"
kill "$PLAIN_PID" 2>/dev/null || true
echo "$PLAIN_HEADERS" | grep -qi '^set-cookie: gf_login=' || fail "no login cookie in plaintext mode"
echo "$PLAIN_HEADERS" | grep -i '^set-cookie:' | grep -qi 'secure' && fail "Secure cookie in plaintext mode"
echo "$PLAIN_HEADERS" | grep -qi 'strict-transport-security' && fail "HSTS in plaintext mode"
grep -q "PLAINTEXT MODE" "$WORK/plain.log" || fail "no plaintext warning"
echo "    ok"

# --- 2. browser flow ---

pw_eval() {
  { $PW eval "$1" 2>/dev/null || true; } | sed -n '/^### Result/,/^### /{/^### /d;p}' | tr -d '\n'
}

wait_for() {
  local expression="$1" what="$2" timeout="${3:-30}"
  for _ in $(seq 1 $((timeout * 2))); do
    [ "$(pw_eval "$expression")" = "true" ] && return 0
    sleep 0.5
  done
  fail "timed out waiting for $what"
}

browser_login() {
  wait_for "() => !!document.querySelector('#password')" "login page"
  pw_eval "() => { document.querySelector('#username').value = '$ME'; document.querySelector('#password').value = '$PASSWORD'; document.querySelector('form').submit(); return true }" >/dev/null
  wait_for "() => location.pathname === '/sessions'" "sessions page"
}

step "logging in in the browser"
$PW open "$BASE/" --config="$WORK/playwright.json" >/dev/null
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "unexpected sessions listed"

step "starting a session"
pw_eval "() => { document.querySelector('form[action=\"/sessions/new\"]').submit(); return true }" >/dev/null
wait_for "() => location.pathname === '/desktop/'" "desktop page" 40
SESSION_URL="$(pw_eval "() => location.href" | tr -d '"')"
$PW goto "$SESSION_URL&test=1" >/dev/null
wait_for "() => !!window.__viewerTest && window.__viewerTest.connected()" "viewer connection"

step "launching foot from the viewer"
wait_for "() => !!document.querySelector('#apps button')" "app buttons"
pw_eval "() => { document.querySelector('#apps button').click(); return true }" >/dev/null
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot window" 40
sleep 1
# Our foot is the one started by this test's gateway (other foots, e.g. in the user's own sessions, aren't ours).
descends_from() {
  local pid="$1" ancestor="$2"
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
FOOT_PID=""
for pid in $(pgrep -x foot -u "$ME" || true); do
  descends_from "$pid" "$GATEWAY_PID" && FOOT_PID="$pid"
done
[ -n "$FOOT_PID" ] || fail "foot is not running"

TERMINAL="$(pw_eval "() => { const w = window.__viewerTest.windows()[0]; const s = w.surfaces.find((s) => s.id === w.id); return [w.id, w.shownX + s.x, w.shownY + s.y, s.width, s.height] }")"
read -r WINDOW_ID TX TY TW TH < <(echo "$TERMINAL" | tr -d '[]"' | tr ',' ' ')
echo "    window $WINDOW_ID at $TX,$TY (${TW}x${TH})"
REGION="$TX, $TY, $((TW < 600 ? TW : 600)), 26"
pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$WORK/before-typing.json"

step "typing a command"
$PW mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
$PW mousedown >/dev/null
$PW mouseup >/dev/null
$PW type "clear; echo gateway-marker-$$" >/dev/null
$PW press Enter >/dev/null
sleep 2
pw_eval "() => window.__viewerTest.readLuma($REGION)" >"$WORK/after-typing.json"

step "closing the browser"
$PW close >/dev/null
sleep 3
kill -0 "$FOOT_PID" 2>/dev/null || fail "foot didn't survive the browser going away"

step "logging in again and reopening the session"
$PW open "$BASE/" --config="$WORK/playwright.json" >/dev/null
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 1 ] || fail "the session is not listed"
OPEN_URL="$(pw_eval "() => document.querySelector('.sessions a').href" | tr -d '"')"
[ "$OPEN_URL" = "$SESSION_URL" ] || fail "listed session $OPEN_URL is not $SESSION_URL"
$PW goto "$OPEN_URL&test=1" >/dev/null
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
if (reattached > typed / 4) {
  console.error('FAIL: the earlier output is not shown after reattaching')
  process.exit(1)
}
EOF

# --- 3. window management ---

# foot's window geometry as shown: "x y width height" (output coordinates)
shown_geometry() {
  # (with a trailing newline, so `read` succeeds)
  echo "$(pw_eval "() => { const g = window.__viewerTest.windows()[0].shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') }" | tr -d '"')"
}

CANVAS_Y="$(pw_eval "() => Math.round(document.querySelector('canvas').getBoundingClientRect().y)")"

# Press on one of foot's resize borders (page coordinates) and drag by (dx, dy) in 3 steps. Prints the shown geometry
# right after each step, without waiting for the server.
resize_drag() {
  local px="$1" py="$2" dx="$3" dy="$4" i
  $PW mousemove "$px" "$py" >/dev/null
  $PW mousedown >/dev/null
  # the client starts the resize in response to the press
  wait_for "() => window.__viewerTest.interaction() === 'resize'" "the resize to start" 10
  for i in 1 2 3; do
    $PW mousemove $((px + dx * i / 3)) $((py + dy * i / 3)) >/dev/null
    echo "$(shown_geometry)"
  done
  $PW mouseup >/dev/null
  wait_for "() => !window.__viewerTest.resizing()" "the client to commit the final size" 10
}

step "resizing from the left edge: immediate, and the right edge stays put"
read -r GX GY GW GH < <(shown_geometry)
RIGHT=$((GX + GW))
# foot draws its left border as a 5px subsurface just outside the window geometry
STEPS="$(resize_drag $((GX - 3)) $((CANVAS_Y + GY + GH / 2)) 60 0 | awk '{ printf "%s,%s ", $1, $1 + $3 }')"
echo "    during the drag (left,right): $STEPS"
[ "$STEPS" = "$((GX + 20)),$RIGHT $((GX + 40)),$RIGHT $((GX + 60)),$RIGHT " ] ||
  fail "the window didn't follow the pointer immediately with its right edge fixed: $STEPS"
read -r GX2 GY2 GW2 GH2 < <(shown_geometry)
echo "    settled at $GX2,$GY2 ${GW2}x${GH2}"
[ $((GX2 + GW2)) = "$RIGHT" ] || fail "right edge moved from $RIGHT to $((GX2 + GW2)) after the resize"
[ "$GY2" = "$GY" ] || fail "top edge moved from $GY to $GY2"

step "resizing from the top edge keeps the bottom edge in place"
read -r GX GY GW GH < <(shown_geometry)
BOTTOM=$((GY + GH))
# the top border subsurface is just above foot's title bar
STEPS="$(resize_drag $((GX + GW / 2)) $((CANVAS_Y + GY - 3)) 0 45 | awk '{ printf "%s,%s ", $2, $2 + $4 }')"
echo "    during the drag (top,bottom): $STEPS"
[ "$STEPS" = "$((GY + 15)),$BOTTOM $((GY + 30)),$BOTTOM $((GY + 45)),$BOTTOM " ] ||
  fail "the window didn't follow the pointer immediately with its bottom edge fixed: $STEPS"
read -r GX2 GY2 GW2 GH2 < <(shown_geometry)
echo "    settled at $GX2,$GY2 ${GW2}x${GH2}"
[ $((GY2 + GH2)) = "$BOTTOM" ] || fail "bottom edge moved from $BOTTOM to $((GY2 + GH2)) after the resize"
[ $((GX2 + GW2)) = "$RIGHT" ] || fail "right edge moved during the top edge resize"

step "shrinking the viewport moves the window back into view"
read -r GX GY GW GH < <(shown_geometry)
$PW resize 160 500 >/dev/null
wait_for "() => { const o = window.__viewerTest.output(); const g = window.__viewerTest.windows()[0].shownGeometry; return o.width <= 160 && g.x <= o.width - 80 && g.x + g.width >= 80 && g.y >= 0 && g.y <= o.height - 80 }" \
  "the window to be moved back into view" 10
wait_for "() => { const w = window.__viewerTest.windows()[0]; return w.x === w.shownX && w.y === w.shownY }" \
  "the server to store the new position" 10
read -r GX2 GY2 GW2 GH2 < <(shown_geometry)
echo "    moved from $GX,$GY to $GX2,$GY2"
[ "$GX2" -lt "$GX" ] || fail "the window wasn't moved"
$PW resize 1280 800 >/dev/null

# --- 4. renaming ---

step "renaming the session"
pw_eval "() => { location.href = '/sessions'; return true }" >/dev/null
wait_for "() => location.pathname === '/sessions'" "sessions page"
[ "$(pw_eval "() => document.querySelector('.sessions .name').firstChild.textContent")" = '"Session 1"' ] ||
  fail "default session name isn't \"Session 1\""
pw_eval "() => { const d = document.querySelector('.sessions details'); d.open = true; d.querySelector('input[name=name]').value = '  <i>Build</i>   & tests '; d.querySelector('form').submit(); return true }" >/dev/null
wait_for "() => location.pathname === '/sessions' && document.querySelector('.sessions .name').firstChild.textContent === '<i>Build</i> & tests'" "the new name" 10
[ "$(pw_eval "() => document.querySelectorAll('.sessions i').length")" = 0 ] || fail "HTML in the session name was rendered"
RENAME_API="$(pw_eval "async () => { const me = await (await fetch('/api/me')).json(); const id = (await (await fetch('/api/sessions')).json())[0].id; const post = (name, csrf) => fetch('/api/sessions/' + id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ name }) }).then((r) => r.status); return [await post('Work', me.csrf), await post('   ', me.csrf), await post('x'.repeat(65), me.csrf), await post('Nope', 'wrong')].join(' ') }")"
echo "    API: rename $RENAME_API (expected 200 400 400 403)"
[ "$RENAME_API" = '"200 400 400 403"' ] || fail "rename API: $RENAME_API"
pw_eval "() => { location.reload(); return true }" >/dev/null
wait_for "() => document.querySelector('.sessions .name')?.firstChild.textContent === 'Work'" "the API rename to show" 10
echo "    ok"

step "ending the session"
pw_eval "() => { document.querySelector('.sessions form[action=\"/sessions/end\"]').submit(); return true }" >/dev/null
sleep 3
kill -0 "$FOOT_PID" 2>/dev/null && fail "foot still runs after ending the session"
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "ended session still listed"

echo "PASS: login, isolation checks, session survival, window management and renaming"
