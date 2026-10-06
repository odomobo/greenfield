#!/usr/bin/env bash
# Shared setup for the end-to-end scripts (scripts/e2e/*.sh): sourced, not run. Sets REPO, PORT, BASE, WORK, the
# cleanup trap, fail/step helpers and gateway/browser helpers.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E_DIR/../.." && pwd)"
PORT="${GATEWAY_PORT:-8098}"
BASE="https://127.0.0.1:$PORT"
PASSWORD="test-password-$$"
ME="$(id -un)"
WORK="$(mktemp -d)"
# The gateway runs with --dev-time-scale: its failed-sign-in delay (3 s) and presence timeouts (10 s to attach, 5 s
# grace) are divided by this. Everything the tests wait for is derived from it.
TIME_SCALE=3
GATEWAY_PID=""
DBUS_PID=""
DRIVER_PID=""
DRIVER_PORT=""
EXTRA_PIDS=()
STARTED_AT="$EPOCHREALTIME"

# wait (at most 5 s) for a process we started to exit
stop_pid() {
  local pid="$1" i
  kill "$pid" 2>/dev/null || return 0
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  [ -n "$DRIVER_PID" ] && stop_pid "$DRIVER_PID"
  # SIGTERM makes the gateway end its sessions and their apps
  [ -n "$GATEWAY_PID" ] && stop_pid "$GATEWAY_PID"
  local pid
  for pid in "${EXTRA_PIDS[@]}"; do stop_pid "$pid"; done
  [ -n "$DBUS_PID" ] && kill "$DBUS_PID" 2>/dev/null || true
  # E2E_KEEP=1: keep the logs and state for a look afterwards
  if [ "${E2E_KEEP:-}" = 1 ]; then echo "kept: $WORK" >&2; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  # what the page showed (kept with E2E_KEEP=1)
  [ -n "$DRIVER_PORT" ] && pw screenshot "$WORK/failure.png" >/dev/null 2>&1 && echo "screenshot: $WORK/failure.png" >&2
  [ -s "$WORK/driver.log" ] && { echo "--- browser driver log ---" >&2; tail -n 20 "$WORK/driver.log" >&2; }
  echo "--- gateway log (tail) ---" >&2
  # (without foot's WAYLAND_DEBUG protocol log)
  grep -av -E '^\[ *[0-9]+\.[0-9]+\]|msg:"\[ *[0-9]+\.[0-9]+\]' "$WORK/gateway.log" 2>/dev/null | tail -n 40 >&2 || true
  exit 1
}

step() {
  local ms=$(((${EPOCHREALTIME/./} - ${STARTED_AT/./}) / 1000))
  printf '[%3d.%ds] ==> %s\n' $((ms / 1000)) $((ms % 1000 / 100)) "$*"
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || fail "$tool is not installed"
  done
  [ -f "$REPO/packages/gateway/dist/main.js" ] || fail "build the gateway first: (cd packages/gateway && yarn build)"
  [ -f "$REPO/packages/viewer/dist/index.html" ] || fail "build the viewer first: (cd packages/viewer && yarn build)"
}

# Run the gateway in the foreground-ish way: gateway <args...> (no environment of its own, for refusal checks)
gateway() {
  env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" node "$REPO/packages/gateway/dist/main.js" "$@"
}

# Start a gateway in the background and wait until it answers. $1: port, $2: log file, $3...: extra arguments.
# Sets STARTED_PID. (exec, so the pid is the gateway itself and cleanup can stop it)
start_gateway() {
  # the test's own cache directory (file drops land there) would make GStreamer rebuild its plugin registry in every
  # session, which delays the video encoder by seconds: keep using the user's registry
  local GST_REGISTRY="${GST_REGISTRY:-${XDG_CACHE_HOME:-$HOME/.cache}/gstreamer-1.0/registry.$(uname -m).bin}"
  local port="$1" log="$2" scheme=https
  shift 2
  [[ " $* " == *" --insecure-plaintext "* ]] && scheme=http
  (exec env -u DISPLAY GREENFIELD_DEV_PASSWORD="$PASSWORD" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    GST_REGISTRY="$GST_REGISTRY" \
    node "$REPO/packages/gateway/dist/main.js" --dev-auth --dev-time-scale "$TIME_SCALE" --encoder "${E2E_ENCODER:-none}" --bind-ip 127.0.0.1 \
    --bind-port "$port" --state-dir "$WORK/state" "$@") >"$log" 2>&1 &
  STARTED_PID=$!
  EXTRA_PIDS+=("$STARTED_PID")
  local i
  for i in $(seq 1 200); do
    curl -sk -o /dev/null "$scheme://127.0.0.1:$port/" && return 0
    kill -0 "$STARTED_PID" 2>/dev/null || break
    sleep 0.1
  done
  fail "gateway didn't start on :$port"
}

# POST a login; prints "<status> <seconds>" and stores the body in $WORK/$1.json
login_attempt() {
  local name="$1" user="$2" pass="$3"
  curl -sk -o "$WORK/$name.json" -w '%{http_code} %{time_total}' -H "Origin: $BASE" -H 'Content-Type: application/json' \
    --data "$(node -e 'console.log(JSON.stringify({ username: process.argv[1], password: process.argv[2] }))' "$user" "$pass")" \
    "$BASE/api/login"
  echo
}

# --- the browser ---

start_driver() {
  DRIVER_PORT=""
  node "$E2E_DIR/browser-driver.js" "$WORK/driver.port" >"$WORK/driver.log" 2>&1 &
  DRIVER_PID=$!
  local i
  for i in $(seq 1 100); do
    [ -s "$WORK/driver.port" ] && DRIVER_PORT="$(cat "$WORK/driver.port")" && return 0
    kill -0 "$DRIVER_PID" 2>/dev/null || break
    sleep 0.1
  done
  fail "the browser driver didn't start: $(cat "$WORK/driver.log")"
}

# pw <command> [arguments...]: a command to the browser driver; prints its answer, fails with its error
pw() {
  local command="$1" status
  shift
  status="$(curl -s --max-time 60 -o "$WORK/pw.out" -w '%{http_code}' --data-binary "$*" "http://127.0.0.1:$DRIVER_PORT/$command")" ||
    status=000
  if [ "$status" != 200 ]; then
    echo "pw $command failed ($status): $(cat "$WORK/pw.out" 2>/dev/null)" >&2
    return 1
  fi
  cat "$WORK/pw.out"
}

# the result of a function in the page as JSON, on one line; nothing if it failed (e.g. while navigating)
pw_eval() {
  { pw eval "$1" 2>/dev/null || true; } | tr -d '\n'
}

# Poll until an expression is true. $1: a function expression, $2: what, $3: timeout in seconds (default 30)
wait_for() {
  local expression="$1" what="$2" timeout="${3:-30}" i answer=""
  for i in $(seq 1 $((timeout * 10))); do
    answer="$(pw_eval "$expression")"
    [ "$answer" = "true" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $what (last answer: ${answer:-none}; $(pw eval "$expression" 2>&1 | head -c 300))"
}

# Poll until a command succeeds. $1: what, $2: timeout in seconds, $3...: the command
wait_until() {
  local what="$1" timeout="$2" i
  shift 2
  for i in $(seq 1 $((timeout * 10))); do
    "$@" && return 0
    sleep 0.1
  done
  fail "timed out waiting for $what"
}

visible() { echo "!document.getElementById('$1').hidden"; }

# Click in the middle of an element (real pointer events). $1: a CSS selector.
# The rectangle of the element matching the selector $1, "x y width height" (page coordinates, rounded), once it has
# settled: it's there, it's in the same place two animation frames apart, nothing next to it is animating (a sibling
# growing in or shrinking away moves it), and it's what is under its center (not covered by a popup). Pointer actions aim at the element only once it has
# settled: a position read while it moves is stale by the time a busy machine (the whole suite runs in parallel)
# delivers the click. Fails if it doesn't settle within 5 s.
settled_rect() {
  local rect
  rect="$(pw_eval "async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
    const deadline = performance.now() + 5000
    let last
    while (performance.now() < deadline) {
      const element = document.querySelector('$1')
      if (element) {
        const r = element.getBoundingClientRect()
        const rect = [r.x, r.y, r.width, r.height].map(Math.round).join(' ')
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        const around = element.parentElement ?? element
        const moving = around.getAnimations({ subtree: true }).some((a) => a.playState === 'running')
        if (rect === last && !moving && r.width > 0 && r.height > 0 && hit && element.contains(hit)) {
          return rect
        }
        last = rect
      } else {
        last = undefined
      }
      await frame()
      await frame()
    }
    return ''
  }" | tr -d '"')"
  [ -n "$rect" ] || fail "$1 didn't settle (not there, moving or covered)"
  echo "$rect"
}

# The center of the element matching $1 once it has settled (see settled_rect), "x y".
element_center() {
  local x y width height
  read -r x y width height <<<"$(settled_rect "$1")"
  echo "$((x + width / 2)) $((y + height / 2))"
}

# Wait until no window is animating (opening, closing, minimizing, restoring, maximizing): pointer actions aimed at a
# window's coordinates land beside it while it is still scaling in. (Drags may be going on.)
wait_windows_still() {
  wait_for "() => !Object.keys(window.__viewerTest.animations()).length" "the windows to stop animating" 5
}

click_element() {
  read -r CX CY <<<"$(element_center "$1")"
  pw mousemove "$CX" "$CY" >/dev/null
  pw mousedown >/dev/null
  pw mouseup >/dev/null
}

# Signing in with a real click: the page needs user activation for its history guard and leave confirmation.
browser_login() {
  wait_for "() => $(visible login-view) && !!document.querySelector('#password')" "the sign-in form"
  pw_eval "() => { document.querySelector('#username').value = '$ME'; document.querySelector('#password').value = '$PASSWORD'; return true }" >/dev/null
  click_element '#login-submit'
  wait_for "() => $(visible sessions-view)" "the session list"
}
