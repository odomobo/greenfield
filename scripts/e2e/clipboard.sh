#!/usr/bin/env bash
# End-to-end test of the clipboard between the browser and remote apps (wave 3 E): starts the gateway in dev-auth mode on
# $GATEWAY_PORT, signs in in a headless browser (scripts/e2e/browser-driver.js, which grants the page clipboard
# permissions), starts a session and launches foot (from the Apps menu) running a small script:
#   1. remote -> browser: the script sets the clipboard through OSC 52 (foot makes it the Wayland selection); the page's
#      clipboard (navigator.clipboard.readText) gets the text, non-ASCII included;
#   2. browser -> remote: the page's clipboard gets other text, Ctrl+Shift+V (foot's paste key, which the viewer treats
#      like Ctrl+V) in foot: the script's `cat` receives it, so the session had the browser's text before foot asked
#      for the selection;
#   3. no echo and no needless replacement: pasting again with the clipboard unchanged pastes the same text again, and
#      the text just pasted is not sent back to the browser as a new selection (the browser's clipboard is untouched).
#
# Requires: foot, playwright-cli (for its Playwright library and browser), curl, node, base64, the built packages
# (yarn build). Usage: scripts/e2e/clipboard.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools foot playwright-cli curl node base64

mkdir -p "$WORK/data/applications" "$WORK/config"
# what the terminal runs: waits for a line (the test types it, which gives foot the input serial that selections need),
# copies a text with OSC 52, then collects what's pasted into a file
cat >"$WORK/clip-app.sh" <<EOF
printf 'ready\n'
read -r line
printf '\033]52;c;%s\a' "\$(printf %s 'copied in foot, grüße ✓' | base64 -w0)"
printf 'copied\n'
cat >"$WORK/pasted"
EOF
cat >"$WORK/data/applications/test-clip.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Clipboard Terminal
Exec=foot --app-id=test-clip sh $WORK/clip-app.sh
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in, starting a session and launching foot"
pw open "$BASE/?test=1" >/dev/null
browser_login
pw_eval "() => { document.querySelector('#new-session').click(); return true }" >/dev/null
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-clip.desktop\"]') && document.activeElement.id === 'apps-search'" "the app in the Apps menu"
pw type "Test Clipboard" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-clip.desktop'" "searching"
pw press Enter >/dev/null
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 1 && w[0].placed && w[0].hasContent }" "foot's window" 40
# the page needs focus to write the clipboard: click into foot's window
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)
read -r WX WY < <(pw_eval "() => { const w = window.__viewerTest.windows()[0]; return Math.round(w.shownX + 100) + ' ' + Math.round(w.shownY + 100) }" | tr -d '"'; echo)
wait_windows_still
pw mousemove $((DESK_X + WX)) $((DESK_Y + WY)) >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
echo "    ok"

step "remote -> browser: the app's clipboard text reaches the browser's clipboard"
pw type "go" >/dev/null
pw press Enter >/dev/null
wait_for "async () => (await navigator.clipboard.readText()) === 'copied in foot, grüße ✓'" "the app's text in the browser's clipboard" 10
echo "    ok"

step "browser -> remote: the browser's text is pasted into the app (Ctrl+Shift+V)"
pw_eval "() => navigator.clipboard.writeText('typed in the browser, ß ✓').then(() => true)" | grep -q true || fail "couldn't write the browser's clipboard"
pw press Control+Shift+V >/dev/null
pw press Enter >/dev/null
pasted_is() { [ "$(cat "$WORK/pasted" 2>/dev/null)" = "$1" ]; }
wait_until "foot to receive the browser's text (got: $(cat "$WORK/pasted" 2>/dev/null))" 10 pasted_is 'typed in the browser, ß ✓'
echo "    ok"

step "pasting again: the same text again, the browser's clipboard untouched (no echo)"
pw press Control+Shift+V >/dev/null
pw press Enter >/dev/null
pasted_twice() { [ "$(cat "$WORK/pasted" 2>/dev/null)" = "$(printf 'typed in the browser, ß ✓\ntyped in the browser, ß ✓')" ]; }
wait_until "the second paste (got: $(cat "$WORK/pasted" 2>/dev/null))" 10 pasted_twice
wait_for "async () => (await navigator.clipboard.readText()) === 'typed in the browser, ß ✓'" "the browser's clipboard to be unchanged" 5
echo "    ok"

echo "PASS: clipboard: app to browser, browser to app, no echo"
