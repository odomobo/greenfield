#!/usr/bin/env bash
# End-to-end test of the gateway: login, isolation checks, and a session surviving the browser.
#
# Starts the gateway in dev-auth mode (sessions run as the current user) with TLS on a test port, then:
#   1. checks the login page leaks nothing: same response for an unknown user and a wrong password, no product
#      names, nothing reachable without logging in, WebSockets refused without a valid cookie / with a foreign Origin,
#      CSRF enforced, and unsafe flag combinations refused;
#   2. in a browser: logs in, starts a session, launches foot from the viewer, types a command, closes the browser,
#      logs in again, finds the session listed, opens it and checks the same window comes back with the earlier
#      output, with foot still running.
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
FOOTS_BEFORE=" $( (pgrep -x foot -u "$ME" || true) | tr '\n' ' ') "
wait_for "() => !!document.querySelector('#apps button')" "app buttons"
pw_eval "() => { document.querySelector('#apps button').click(); return true }" >/dev/null
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot window" 40
sleep 1
FOOT_PID=""
for pid in $(pgrep -x foot -u "$ME" || true); do
  case "$FOOTS_BEFORE" in *" $pid "*) ;; *) FOOT_PID="$pid" ;; esac
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

step "ending the session"
pw_eval "() => { location.href = '/sessions'; return true }" >/dev/null
wait_for "() => location.pathname === '/sessions'" "sessions page"
pw_eval "() => { document.querySelector('.sessions form').submit(); return true }" >/dev/null
sleep 3
kill -0 "$FOOT_PID" 2>/dev/null && fail "foot still runs after ending the session"
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "ended session still listed"

echo "PASS: login, isolation checks, and session survival"
