#!/usr/bin/env bash
# End-to-end test of the gateway's login and isolation: no browser, only curl and WebSocket probes.
#
# Starts the gateway in dev-auth mode with TLS on $GATEWAY_PORT (and a plaintext one on the next port), then checks:
#   - unsafe flag combinations are refused;
#   - the login page leaks nothing: same response (and timing) for an unknown user and a wrong password, no product
#     names, no cookies;
#   - failed logins are throttled, for any username;
#   - nothing is reachable without signing in; WebSockets are refused without a valid token / with a foreign Origin;
#   - a sign-in only lasts while its page's presence connection is open (expires without one, survives a short blip,
#     revoked a few seconds after it closes);
#   - plaintext mode works on loopback, without HSTS.
#
# The gateway runs with --dev-time-scale, which shortens its sign-in delays (3 s for a failed login, 10 s to attach a
# presence, 5 s grace) so this finishes in seconds; the assertions are the same, just scaled.
#
# Requires: curl, node, the built gateway and viewer. Usage: scripts/e2e/auth.sh   (GATEWAY_PORT, and the next port)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools curl node
mkdir -p "$WORK/data" "$WORK/config"

step "refusing unsafe configurations"
gateway --dev-auth --bind-ip 0.0.0.0 --bind-port "$PORT" --state-dir "$WORK/state" >/dev/null 2>&1 &&
  fail "dev auth started on a public address"
gateway --insecure-plaintext --dev-auth --bind-ip 0.0.0.0 --bind-port "$PORT" --state-dir "$WORK/state" >/dev/null 2>&1 &&
  fail "plaintext started on a public address"
GREENFIELD_DEV_PASSWORD=short node "$REPO/packages/gateway/dist/main.js" --dev-auth --bind-ip 127.0.0.1 \
  --bind-port "$PORT" >/dev/null 2>&1 && fail "dev auth started with a weak password"
gateway --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 && fail "PAM mode started without root"
gateway --dev-auth --dev-time-scale 0 --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "an invalid time scale was accepted"
gateway --dev-time-scale 3 --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "a time scale was accepted without dev auth"
echo "    ok"

step "starting the gateway on :$PORT"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"

probe() { NODE_NO_WARNINGS=1 TIME_SCALE="$TIME_SCALE" WS_MODULE="$REPO/packages/gateway/node_modules/ws" node "$E2E_DIR/probe.js" "$@"; }
WSS="wss://127.0.0.1:$PORT"

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
# $1: the attempt's number. Both wait out the (scaled) minimum failure time of 3 s / $TIME_SCALE (a lower bound: load
# can't make them faster) and are indistinguishable by timing. A difference is checked twice before it counts: a real
# leak (another code path for a real user) shows every time, a busy machine (the suite runs in parallel) only now and then.
same_failures() {
  read -r STATUS_UNKNOWN TIME_UNKNOWN < <(login_attempt unknown "nosuchuser-$$-$1" "whatever-password")
  read -r STATUS_WRONG TIME_WRONG < <(login_attempt wrong "$ME" "not-the-password-$1")
  echo "    unknown user: $STATUS_UNKNOWN in ${TIME_UNKNOWN}s, wrong password: $STATUS_WRONG in ${TIME_WRONG}s"
  [ "$STATUS_UNKNOWN" = "$STATUS_WRONG" ] || fail "different status codes"
  cmp -s "$WORK/unknown.json" "$WORK/wrong.json" || fail "different response bodies for unknown user and wrong password"
  node -e "const [a,b,scale]=process.argv.slice(1).map(Number); if (a < 3/scale*0.9 || b < 3/scale*0.9) process.exit(2); if (Math.abs(a-b) > 0.15) process.exit(1)" \
    "$TIME_UNKNOWN" "$TIME_WRONG" "$TIME_SCALE"
}
result=0
same_failures 1 || result=$?
[ "$result" != 2 ] || fail "a failed login was faster than the minimum failure time"
if [ "$result" = 1 ]; then
  echo "    (timing differs, once more)"
  result=0
  same_failures 2 || result=$?
  [ "$result" = 0 ] || fail "failure timing differs (twice) or is too fast"
fi
echo "    ok"

step "failed logins are throttled, for any username"
THROTTLED_USER="nobody-$$"
# the failures wait their minimum time each; do them side by side
ATTEMPTS=()
for i in 1 2 3 4 5; do
  login_attempt "throttle$i" "$THROTTLED_USER" "wrong-$i" >/dev/null &
  ATTEMPTS+=("$!")
done
wait "${ATTEMPTS[@]}"
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
token_status() { curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/me"; }
[ "$(token_status)" = 200 ] || fail "/api/me with the token"
[ "$(probe ws "$WSS/ws?session=not-mine" "$BASE" "$TOKEN")" = 4004 ] || fail "WebSocket to someone else's session"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H "Origin: https://evil.example" -X POST "$BASE/api/sessions")" = 403 ] ||
  fail "creating a session from a foreign origin"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -H 'Content-Type: application/json' --data '{"name":"x"}' "$BASE/api/sessions/x/rename")" = 401 ] ||
  fail "renaming without the token"
echo "    ok"

step "a sign-in lasts only while its page is there"
# the token above never got a presence connection: it must expire within the (scaled) attach time of 10 s
token_expired() { [ "$(token_status)" = 401 ]; }
wait_until "a token without a presence connection to expire" $((10 / TIME_SCALE + 3)) token_expired
PRESENCE="$(probe presence "$BASE" "$ME" "$PASSWORD")"
echo "    with presence, after a blip, after it closed: $PRESENCE"
[ "$PRESENCE" = "200 200 401" ] || fail "presence: $PRESENCE (expected 200 200 401)"
echo "    ok"

step "plaintext mode works on loopback, without HSTS"
PLAIN_PORT=$((PORT + 1))
start_gateway "$PLAIN_PORT" "$WORK/plain.log" --insecure-plaintext
PLAIN_HEADERS="$(curl -s -D - -o /dev/null "http://127.0.0.1:$PLAIN_PORT/")"
echo "$PLAIN_HEADERS" | grep -q '^HTTP/1.1 200' || fail "no page in plaintext mode"
echo "$PLAIN_HEADERS" | grep -qi 'strict-transport-security' && fail "HSTS in plaintext mode"
grep -q "PLAINTEXT MODE" "$WORK/plain.log" || fail "no plaintext warning"
echo "    ok"

echo "PASS: login page, failed-login timing and throttling, access control, per-page sign-in, plaintext mode"
