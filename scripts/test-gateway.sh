#!/usr/bin/env bash
# End-to-end test of the gateway: login, isolation checks, and a session surviving the browser.
#
# Starts the gateway in dev-auth mode (sessions run as the current user) with TLS on a test port, then:
#   1. checks the login page leaks nothing: same response for an unknown user and a wrong password, no product
#      names, no cookies, nothing reachable without signing in, WebSockets refused without a valid token / with a
#      foreign Origin, unsafe flag combinations refused; and that a sign-in only lasts while its page's presence
#      connection is open (expires without one, survives a short blip, revoked a few seconds after it closes);
#   2. in a browser: signs in (a second tab stays signed out), starts a session, launches foot from the viewer,
#      types a command; history.back() and the mouse's back button over the desktop don't leave the page (foot gets
#      BTN_SIDE); reloading asks to confirm first (dismiss keeps the page), then asks to sign in again and the old
#      token stops working; closes the browser, signs in
#      again, finds the session listed, opens it by clicking its row and checks the same window comes back with the
#      earlier output, with foot still running;
#   3. window management in the viewer: a resize follows the pointer immediately (without waiting for the server),
#      resizing from the left/top edge keeps the right/bottom edge in place, and shrinking the viewport moves a window
#      back into view;
#   4. Disconnect goes back to the session list without signing in again; renaming the session by clicking its name
#      (a name with HTML in it shows as text, Escape cancels); signing out; Log out ends the session.
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
  # (without foot's WAYLAND_DEBUG protocol log)
  grep -av -E '^\[ *[0-9]+\.[0-9]+\]|msg:"\[ *[0-9]+\.[0-9]+\]' "$WORK/gateway.log" | tail -n 40 >&2 || true
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
{ "/foot": { "name": "Foot", "executable": "foot", "args": [], "env": { "WAYLAND_DEBUG": "1" } } }
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
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
# exec, so $! is the gateway itself and cleanup can stop it
(exec env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" node "$REPO/packages/gateway/dist/main.js" --dev-auth \
  --bind-ip 127.0.0.1 --bind-port "$PORT" --state-dir "$WORK/state" --applications="$WORK/apps.json") \
  >"$WORK/gateway.log" 2>&1 &
GATEWAY_PID=$!
for _ in $(seq 1 40); do
  curl -sk -o /dev/null "$BASE/" && break
  sleep 0.5
done
curl -sk -o /dev/null "$BASE/" || fail "gateway didn't start"

# --- 1. leak and access checks ---

cat >"$WORK/probe.js" <<'EOF'
// WebSocket and sign-in probes. Usage:
//   probe.js ws <url> <origin> <first message>   prints the close code (or "open" if the socket stays up)
//   probe.js presence <base> <user> <password>   prints /api/me statuses: past the attach deadline with a presence,
//                                                after a reconnect blip, after the presence closed for good
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const WebSocket = require(process.env.WS_MODULE)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const [mode, a, b, c] = process.argv.slice(2)

function open(url, origin, first) {
  const ws = new WebSocket(url, { origin, rejectUnauthorized: false })
  ws.on('open', () => ws.send(first))
  ws.on('error', () => {})
  return ws
}

async function main() {
  if (mode === 'ws') {
    const ws = open(a, b, c)
    console.log(await Promise.race([new Promise((resolve) => ws.on('close', resolve)), sleep(5000).then(() => 'open')]))
    process.exit(0)
  }
  const login = await fetch(`${a}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: a },
    body: JSON.stringify({ username: b, password: c }),
  })
  const { token } = await login.json()
  const me = async () => (await fetch(`${a}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status
  const control = a.replace(/^http/, 'ws') + '/control'
  let presence = open(control, a, token)
  await new Promise((resolve) => presence.once('message', resolve))
  await sleep(11000)
  const withPresence = await me()
  presence.terminate()
  await sleep(1000)
  presence = open(control, a, token)
  await new Promise((resolve) => presence.once('message', resolve))
  const afterBlip = await me()
  presence.close()
  await sleep(7000)
  console.log(withPresence, afterBlip, await me())
  process.exit(0)
}
main()
EOF
probe() { NODE_NO_WARNINGS=1 WS_MODULE="$REPO/packages/gateway/node_modules/ws" node "$WORK/probe.js" "$@"; }
WSS="wss://127.0.0.1:$PORT"

# POST a login; prints "<status> <seconds>" and stores the body in $WORK/$1.json
login_attempt() {
  local name="$1" user="$2" pass="$3"
  curl -sk -o "$WORK/$name.json" -w '%{http_code} %{time_total}' -H "Origin: $BASE" -H 'Content-Type: application/json' \
    --data "$(node -e 'console.log(JSON.stringify({ username: process.argv[1], password: process.argv[2] }))' "$user" "$pass")" \
    "$BASE/api/login"
  echo
}

step "login page reveals nothing"
HEADERS="$(curl -sk -D - -o "$WORK/login.html" "$BASE/")"
echo "$HEADERS" | grep -qi '^server:' && fail "Server header present"
echo "$HEADERS" | grep -qi '^set-cookie:' && fail "a cookie is set"
grep -qi -E 'greenfield|gateway|compositor|wayland|node' "$WORK/login.html" && fail "product name on the login page"
echo "$HEADERS" | grep -qi -E 'greenfield|express|node' && fail "product name in headers"
echo "$HEADERS" | grep -qi '^cache-control: no-store' || fail "the page may be cached"
grep -q "$(hostname)" "$WORK/login.html" || fail "hostname not shown"
[ "$(curl -sk -o /dev/null -w '%{redirect_url}' "$BASE/login")" = "$BASE/" ] || fail "/login doesn't lead to the page"
echo "    ok"

step "unknown user and wrong password look the same"
read -r STATUS_UNKNOWN TIME_UNKNOWN < <(login_attempt unknown "nosuchuser-$$" "whatever-password")
read -r STATUS_WRONG TIME_WRONG < <(login_attempt wrong "$ME" "not-the-password")
echo "    unknown user: $STATUS_UNKNOWN in ${TIME_UNKNOWN}s, wrong password: $STATUS_WRONG in ${TIME_WRONG}s"
[ "$STATUS_UNKNOWN" = "$STATUS_WRONG" ] || fail "different status codes"
cmp -s "$WORK/unknown.json" "$WORK/wrong.json" || fail "different response bodies for unknown user and wrong password"
node -e "const [a,b]=process.argv.slice(1).map(Number); if (a<2.9||b<2.9||Math.abs(a-b)>0.5) process.exit(1)" \
  "$TIME_UNKNOWN" "$TIME_WRONG" || fail "failure timing differs or is too fast"
echo "    ok"

step "failed logins are throttled, for any username"
THROTTLED_USER="nobody-$$"
for i in 1 2 3 4 5; do
  login_attempt "throttle$i" "$THROTTLED_USER" "wrong-$i" >/dev/null
done
login_attempt throttled "$THROTTLED_USER" "wrong-6" >/dev/null
grep -q "Too many failed attempts" "$WORK/throttled.json" || fail "6th failed login was not throttled"
echo "    ok"

step "nothing is reachable without signing in"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/me")" = 401 ] || fail "/api/me without a token"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/sessions")" = 401 ] || fail "/api/sessions without a token"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer forged' "$BASE/api/sessions")" = 401 ] ||
  fail "/api/sessions with a forged token"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -X POST "$BASE/api/sessions")" = 401 ] ||
  fail "creating a session without a token"
[ "$(probe ws "$WSS/ws?session=x" "$BASE" forged)" = 4001 ] || fail "viewer WebSocket with a forged token"
[ "$(probe ws "$WSS/control" "$BASE" forged)" = 4001 ] || fail "presence WebSocket with a forged token"
WS_HEADERS=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
ws_status() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "${WS_HEADERS[@]}" "$@" || true; }
[ "$(ws_status -H "Origin: https://evil.example" "$BASE/ws?session=x")" = 403 ] || fail "WebSocket from a foreign origin"
[ "$(ws_status -H "Origin: https://evil.example" "$BASE/control")" = 403 ] || fail "presence from a foreign origin"
echo "    ok"

step "signing in with curl"
read -r STATUS _ < <(login_attempt good "$ME" "$PASSWORD")
[ "$STATUS" = 200 ] || fail "login failed ($STATUS)"
TOKEN="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$WORK/good.json")"
[ -n "$TOKEN" ] || fail "no token: $(cat "$WORK/good.json")"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/me")" = 200 ] ||
  fail "/api/me with the token"
[ "$(probe ws "$WSS/ws?session=not-mine" "$BASE" "$TOKEN")" = 4004 ] || fail "WebSocket to someone else's session"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H "Origin: https://evil.example" -X POST "$BASE/api/sessions")" = 403 ] ||
  fail "creating a session from a foreign origin"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -H 'Content-Type: application/json' --data '{"app":"/foot"}' "$BASE/api/sessions/x/launch")" = 401 ] ||
  fail "launching without the token"
echo "    ok"

step "a sign-in lasts only while its page is there"
sleep 10
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/me")" = 401 ] ||
  fail "a token without a presence connection still works"
PRESENCE="$(probe presence "$BASE" "$ME" "$PASSWORD")"
echo "    with presence, after a blip, after it closed: $PRESENCE"
[ "$PRESENCE" = "200 200 401" ] || fail "presence: $PRESENCE (expected 200 200 401)"
echo "    ok"

step "plaintext mode works on loopback, without HSTS"
PLAIN_PORT=$((PORT + 1))
(exec env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" node "$REPO/packages/gateway/dist/main.js" --dev-auth \
  --insecure-plaintext --bind-ip 127.0.0.1 --bind-port "$PLAIN_PORT" --state-dir "$WORK/state") >"$WORK/plain.log" 2>&1 &
PLAIN_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PLAIN_PORT/" && break
  sleep 0.5
done
PLAIN_HEADERS="$(curl -s -D - -o /dev/null "http://127.0.0.1:$PLAIN_PORT/")"
kill "$PLAIN_PID" 2>/dev/null || true
echo "$PLAIN_HEADERS" | grep -q '^HTTP/1.1 200' || fail "no page in plaintext mode"
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

visible() { echo "!document.getElementById('$1').hidden"; }


# Click in the middle of an element (real pointer events). $1: a CSS selector.
click_element() {
  local center
  center="$(pw_eval "() => { const r = document.querySelector('$1').getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ' ' + Math.round(r.y + r.height / 2) }" | tr -d '"')"
  read -r CX CY <<<"$center"
  $PW mousemove "$CX" "$CY" >/dev/null
  $PW mousedown >/dev/null
  $PW mouseup >/dev/null
}

# Signing in with a real click: the page needs user activation for its history guard and leave confirmation.
browser_login() {
  wait_for "() => $(visible login-view) && !!document.querySelector('#password')" "the sign-in form"
  pw_eval "() => { document.querySelector('#username').value = '$ME'; document.querySelector('#password').value = '$PASSWORD'; return true }" >/dev/null
  click_element '#login-submit'
  wait_for "() => $(visible sessions-view)" "the session list"
}

# Reload without waiting for the load (a "Leave site?" dialog may block it). $1: dialog-accept or dialog-dismiss
reload_with_dialog() {
  pw_eval "() => { setTimeout(() => location.reload(), 100); return true }" >/dev/null
  sleep 1
  $PW snapshot 2>/dev/null | grep -q '"beforeunload" dialog' || fail "no confirmation before leaving the signed-in page"
  $PW "$1" >/dev/null
}

# Press and release a mouse button the Playwright API doesn't have (back/forward) at page coordinates.
cdp_click() {
  $PW run-code "async (page) => { const cdp = await page.context().newCDPSession(page); for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: $2, y: $3, button: '$1', buttons: type === 'mousePressed' ? ('$1' === 'back' ? 8 : 16) : 0, clickCount: 1 }) }" >/dev/null
}

step "signing in in the browser"
$PW open "$BASE/?test=1" --config="$WORK/playwright.json" >/dev/null
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "unexpected sessions listed"

step "another tab is not signed in"
$PW tab-new >/dev/null
$PW goto "$BASE/" >/dev/null
wait_for "() => document.readyState === 'complete' && !!document.querySelector('#login-view')" "the second tab" 10
[ "$(pw_eval "() => $(visible login-view) && !$(visible sessions-view)")" = true ] || fail "the second tab is signed in"
$PW tab-close >/dev/null
$PW tab-select 0 >/dev/null
[ "$(pw_eval "() => $(visible sessions-view)")" = true ] || fail "the first tab was signed out"
echo "    ok"

step "starting a session"
pw_eval "() => { document.querySelector('#new-session').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
SESSION_ID="$(pw_eval "() => window.__viewerTest.session()" | tr -d '"')"
[ -n "$SESSION_ID" ] || fail "no session"

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

step "going back doesn't leave the desktop"
pw_eval "() => { window.__notReloaded = true; return true }" >/dev/null
[ "$(pw_eval "() => history.state && history.state['session-guard'] === true")" = true ] || fail "no history guard entry"
pw_eval "() => { history.back(); return true }" >/dev/null
sleep 1
[ "$(pw_eval "() => window.__notReloaded === true && $(visible desktop-view) && window.__viewerTest.connected() && history.state === null")" = true ] ||
  fail "history.back() left the desktop"
# the next input re-arms the guard
$PW mousemove $((TX + TW / 2)) $((TY + TH / 2)) >/dev/null
$PW mousedown >/dev/null
$PW mouseup >/dev/null
[ "$(pw_eval "() => history.state && history.state['session-guard'] === true")" = true ] || fail "the guard wasn't re-armed"
SIDE_BEFORE="$(grep -ac 'wl_pointer@[0-9]*\.button([0-9]*, [0-9]*, 275, [01])' "$WORK/gateway.log" || true)"
cdp_click back $((TX + TW / 2)) $((TY + TH / 2))
sleep 1
[ "$(pw_eval "() => window.__notReloaded === true && window.__viewerTest.connected() && history.state['session-guard'] === true")" = true ] ||
  fail "the mouse's back button over the desktop navigated"
SIDE_AFTER="$(grep -ac 'wl_pointer@[0-9]*\.button([0-9]*, [0-9]*, 275, [01])' "$WORK/gateway.log" || true)"
echo "    BTN_SIDE events received by foot: $((SIDE_AFTER - SIDE_BEFORE)) (expected 2)"
[ $((SIDE_AFTER - SIDE_BEFORE)) = 2 ] || fail "foot didn't get the back button as BTN_SIDE press and release"
echo "    ok"

step "reloading asks first, then asks to sign in again"
BROWSER_TOKEN="$(pw_eval "() => window.__viewerTest.token()" | tr -d '"')"
[ -n "$BROWSER_TOKEN" ] || fail "no token in the page"
reload_with_dialog dialog-dismiss
sleep 1
[ "$(pw_eval "() => window.__notReloaded === true && window.__viewerTest.connected()")" = true ] ||
  fail "dismissing the confirmation didn't keep the page"
reload_with_dialog dialog-accept
wait_for "() => document.readyState === 'complete' && $(visible login-view)" "the sign-in form after reloading" 10
sleep 7
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BROWSER_TOKEN" "$BASE/api/sessions")" = 401 ] ||
  fail "the token of the reloaded page still works"
echo "    ok"

step "closing the browser"
$PW close >/dev/null
sleep 3
kill -0 "$FOOT_PID" 2>/dev/null || fail "foot didn't survive the browser going away"

step "signing in again and reopening the session"
$PW open "$BASE/?test=1" --config="$WORK/playwright.json" >/dev/null
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 1 ] || fail "the session is not listed"
LISTED="$(pw_eval "() => document.querySelector('.sessions li').dataset.session" | tr -d '"')"
[ "$LISTED" = "$SESSION_ID" ] || fail "listed session $LISTED is not $SESSION_ID"
# clicking the row (not just the Open button) opens it
click_element '.sessions .when'
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer reconnection"
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

# --- 4. session list: disconnect, renaming, signing out, logging out ---

step "Disconnect goes back to the session list, still signed in"
pw_eval "() => { document.querySelector('#disconnect').click(); return true }" >/dev/null
wait_for "() => $(visible sessions-view) && document.querySelectorAll('.sessions li').length === 1" "the session list"
[ "$(pw_eval "() => window.__viewerTest.connected()")" = false ] || fail "still connected to the session"
kill -0 "$FOOT_PID" 2>/dev/null || fail "foot didn't survive disconnecting"
echo "    ok"

NAME_FIELD='.sessions .session-name input'
step "renaming the session by clicking its name"
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').value")" = '"Session 1"' ] ||
  fail "default session name isn't \"Session 1\""
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').getAttribute('aria-label')")" = '"Rename session"' ] ||
  fail "the name field has no accessible label"
click_element "$NAME_FIELD"
[ "$(pw_eval "() => document.activeElement === document.querySelector('$NAME_FIELD') && $(visible sessions-view)")" = true ] ||
  fail "clicking the name didn't start editing it (or opened the session)"
$PW press Control+a >/dev/null
$PW type "  <i>Build</i>   & tests " >/dev/null
$PW press Enter >/dev/null
wait_for "() => document.querySelector('$NAME_FIELD').value === '<i>Build</i> & tests'" "the new name" 10
[ "$(pw_eval "() => document.querySelectorAll('.sessions i').length")" = 0 ] || fail "HTML in the session name was rendered"
click_element "$NAME_FIELD"
$PW type "xyz" >/dev/null
$PW press Escape >/dev/null
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').value")" = '"<i>Build</i> & tests"' ] ||
  fail "Escape didn't cancel the edit"
RENAME_API="$(pw_eval "async () => { const token = window.__viewerTest.token(); const id = window.__viewerTest.session() || document.querySelector('.sessions li').dataset.session; const post = (name, auth) => fetch('/api/sessions/' + id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify({ name }) }).then((r) => r.status); const listed = (await (await fetch('/api/sessions', { headers: { Authorization: 'Bearer ' + token } })).json())[0].name; return [listed, await post('Work', token), await post('   ', token), await post('x'.repeat(65), token), await post('Nope', 'wrong')].join(' ') }")"
echo "    API: $RENAME_API (expected the new name, then 200 400 400 401)"
[ "$RENAME_API" = '"<i>Build</i> & tests 200 400 400 401"' ] || fail "rename API: $RENAME_API"
echo "    ok"

step "signing out"
pw_eval "() => { document.querySelector('#sign-out').click(); return true }" >/dev/null
wait_for "() => $(visible login-view)" "the sign-in form"
browser_login
[ "$(pw_eval "() => document.querySelector('$NAME_FIELD').value")" = '"Work"' ] || fail "the API rename didn't stick"
echo "    ok"

step "Log out ends the session"
pw_eval "() => { document.querySelector('.sessions button[data-action=open]').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection"
pw_eval "() => { document.querySelector('#logout').click(); return true }" >/dev/null
wait_for "() => $(visible login-view)" "the sign-in form"
sleep 3
kill -0 "$FOOT_PID" 2>/dev/null && fail "foot still runs after logging out"
browser_login
[ "$(pw_eval "() => document.querySelectorAll('.sessions li').length")" = 0 ] || fail "ended session still listed"
echo "    ok"

echo "PASS: login, isolation checks, per-page sign-in, session survival, window management, renaming and logging out"
