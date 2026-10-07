#!/usr/bin/env bash
# End-to-end test of the gateway's sign-in and isolation: no browser, only curl and WebSocket probes (probe.js), which
# speak the in-band sign-in on the page's WebSocket (see "Sign-in" in libs/scene-protocol).
#
# Starts the gateway (the dev login helper, see lib.sh) on $GATEWAY_PORT, then checks:
#   - unsafe flag combinations are refused, and there is no plain-HTTP mode; the production entry point (main.js) and
#     the web process take no dev options;
#   - the sign-in page leaks nothing: no product names, no cookies;
#   - an unknown user and a wrong password look the same: the same message and timing, at least the minimum failure
#     time;
#   - nothing is reachable without signing in: no API, the WebSocket refuses a foreign Origin, anything but the
#     sign-in before it succeeded, and other WebSocket paths;
#   - failed sign-ins are throttled per IP (for any username), last since it blocks this IP.
# Successful sign-ins, reattaching, takeover and logging out are in desktop.sh (they start a desktop).
#
# The dev login helper runs with --dev-time-scale, which shortens its failed-sign-in delay (3 s) so this finishes in
# seconds; the assertions are the same, just scaled. (The web process's per-IP throttle refuses blocked addresses
# without asking the helper, so without that delay.)
#
# Requires: curl, node, the built gateway and viewer. Usage: scripts/e2e/auth.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools curl node
mkdir -p "$WORK/data" "$WORK/config"

step "refusing unsafe configurations"
# the dev login helper
gateway --bind-ip 0.0.0.0 --bind-port "$PORT" --state-dir "$WORK/state" >/dev/null 2>&1 &&
  fail "the dev login helper started on a public address"
gateway --insecure-plaintext --bind-ip 127.0.0.1 --bind-port "$PORT" --state-dir "$WORK/state" >/dev/null 2>&1 &&
  fail "the removed plaintext mode was accepted"
GREENFIELD_DEV_PASSWORD=short "$LOGIN_HELPER" --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "the dev login helper started with a weak password"
gateway --dev-time-scale 0 --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "an invalid time scale was accepted"
# the production entry point (the monitor) has no dev mode any more, and needs root
node "$REPO/packages/gateway/dist/main.js" --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "PAM mode started without root"
node "$REPO/packages/gateway/dist/main.js" --dev-auth --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "the production gateway accepted --dev-auth"
node "$REPO/packages/gateway/dist/main.js" --dev-time-scale 3 --bind-ip 127.0.0.1 --bind-port "$PORT" >/dev/null 2>&1 &&
  fail "the production gateway accepted a dev option"
# the web process takes no dev options either
node "$REPO/packages/gateway/dist/web.js" --listen-fd 3 --login-socket /nonexistent --dev-time-scale 3 >/dev/null 2>&1 &&
  fail "the web process accepted a dev option"
echo "    ok"

step "starting the gateway on :$PORT"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
WSS="wss://127.0.0.1:$PORT"

step "the sign-in page reveals nothing; TLS only"
HEADERS="$(curl -sk -D - -o "$WORK/login.html" "$BASE/")"
echo "$HEADERS" | grep -qi '^server:' && fail "Server header present"
echo "$HEADERS" | grep -qi '^set-cookie:' && fail "a cookie is set"
grep -qi -E 'greenfield|gateway|compositor|wayland|node' "$WORK/login.html" && fail "product name on the login page"
echo "$HEADERS" | grep -qi -E 'greenfield|express|node' && fail "product name in headers"
echo "$HEADERS" | grep -qi '^cache-control: no-store' || fail "the page may be cached"
echo "$HEADERS" | grep -qi '^strict-transport-security:' || fail "no HSTS"
grep -q "$(hostname)" "$WORK/login.html" || fail "hostname not shown"
[ "$(curl -sk -o /dev/null -w '%{redirect_url}' "$BASE/login")" = "$BASE/" ] || fail "/login doesn't lead to the page"
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" || true)" = 200 ] && fail "the page is served over plain HTTP"
echo "    ok"

step "unknown user and wrong password look the same"
# $1: the attempt's number. Both wait out the (scaled) minimum failure time of 3 s / $TIME_SCALE (a lower bound: load
# can't make them faster) and are indistinguishable by timing. A difference is checked twice before it counts: a real
# leak (another code path for a real user) shows every time, a busy machine (the suite runs in parallel) only now and then.
same_failures() {
  local unknown wrong
  unknown="$(signin_attempt "nosuchuser-$$-$1" "whatever-password")"
  wrong="$(signin_attempt "$ME" "not-the-password-$1")"
  read -r OUTCOME_UNKNOWN TIME_UNKNOWN CODE_UNKNOWN MESSAGE_UNKNOWN <<<"$unknown"
  read -r OUTCOME_WRONG TIME_WRONG CODE_WRONG MESSAGE_WRONG <<<"$wrong"
  echo "    unknown user: $OUTCOME_UNKNOWN in ${TIME_UNKNOWN}s, wrong password: $OUTCOME_WRONG in ${TIME_WRONG}s ($MESSAGE_WRONG)"
  [ "$OUTCOME_WRONG" = fail ] && [ "$CODE_WRONG" = 4001 ] || fail "a wrong password: $wrong"
  [ "$OUTCOME_UNKNOWN $CODE_UNKNOWN $MESSAGE_UNKNOWN" = "$OUTCOME_WRONG $CODE_WRONG $MESSAGE_WRONG" ] ||
    fail "different results for an unknown user and a wrong password: $unknown / $wrong"
  node -e "const [a,b,scale]=process.argv.slice(1).map(Number); if (a < 3/scale*0.9 || b < 3/scale*0.9) process.exit(2); if (Math.abs(a-b) > 0.15) process.exit(1)" \
    "$TIME_UNKNOWN" "$TIME_WRONG" "$TIME_SCALE"
}
# failed sign-ins so far (the throttling below counts them)
FAILED=2
result=0
same_failures 1 || result=$?
[ "$result" != 2 ] || fail "a failed login was faster than the minimum failure time"
if [ "$result" = 1 ]; then
  echo "    (timing differs, once more)"
  result=0
  FAILED=4
  same_failures 2 || result=$?
  [ "$result" = 0 ] || fail "failure timing differs (twice) or is too fast"
fi
echo "    ok"

step "nothing is reachable without signing in"
for path in /api/me /api/login /api/desktop; do
  [ "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE$path")" = 404 ] || fail "GET $path is there"
done
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -X POST "$BASE/api/login")" = 405 ] || fail "POST is accepted"
[ "$(probe raw "$WSS/ws" "$BASE" forged-token)" = 4001 ] || fail "a WebSocket starting with garbage"
[ "$(probe raw "$WSS/ws" "$BASE" --binary)" = 4001 ] || fail "a WebSocket sending desktop data before signing in"
[ "$(probe raw "$WSS/ws" "$BASE" '{"type":"answer","text":"x"}')" = 4001 ] || fail "a WebSocket answering before beginning"
WS_HEADERS=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
ws_status() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "${WS_HEADERS[@]}" "$@" || true; }
[ "$(ws_status -H "Origin: https://evil.example" "$BASE/ws")" = 403 ] || fail "WebSocket from a foreign origin"
[ "$(ws_status "$BASE/ws")" = 403 ] || fail "WebSocket without an origin"
[ "$(ws_status -H "Origin: $BASE" "$BASE/control")" = 404 ] || fail "the old presence WebSocket is there"
echo "    ok"

step "failed sign-ins are throttled per IP, for any username"
# (last: it blocks this IP.) 20 free failures, $FAILED of them used above; the failures wait their minimum time each,
# so side by side
probe failures "$WSS/ws" "$BASE" "nobody-$$" $((20 - FAILED)) >"$WORK/throttle.txt"
grep -q "Too many failed attempts" "$WORK/throttle.txt" && fail "throttled within the free failures: $(sort "$WORK/throttle.txt" | uniq -c)"
read -r OUTCOME _ _ MESSAGE < <(signin_attempt "someone-else-$$" "wrong-password")
[ "$OUTCOME" = fail ] && [[ "$MESSAGE" == "Too many failed attempts"* ]] || fail "the 21st failed sign-in was not throttled: $OUTCOME $MESSAGE"
read -r OUTCOME _ _ MESSAGE < <(signin_attempt "$ME" "$PASSWORD")
[ "$OUTCOME" = fail ] && [[ "$MESSAGE" == "Too many failed attempts"* ]] || fail "the right password got through the throttle: $OUTCOME $MESSAGE"
echo "    ok"

echo "PASS: sign-in page, failed sign-in timing and throttling, access control, TLS only"
