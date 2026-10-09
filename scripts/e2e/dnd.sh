#!/usr/bin/env bash
# End-to-end test of drag and drop (wave 3 E): starts the gateway in dev mode on $GATEWAY_PORT, signs in in a
# headless browser (scripts/e2e/browser-driver.js), starts a session and launches a small test client
# (scripts/e2e/dnd-client.c, built here with wayland-scanner and gcc) from the Apps menu: two windows, a drag source and
# a drop target.
#   1. drag between remote apps: pressing on the source window starts the app's drag; the viewer shows the app's drag
#      icon at the pointer (surface content, following the pointer); moving over the target window and releasing drops
#      the text there (the target app reads it through the data offer and writes it to a file);
#   2. the drag is over afterwards: the viewer shows no icon, and a click on the source starts another drag;
#      once it's cancelled the app destroys its icon and opens a window whose surface gets the icon's freed protocol id
#      (as Qt does: Knights' dialogs after dragging a piece): the window has an id of its own in the scene, its content
#      is shown where it is (not where the icon was) and gets the pointer, and the icon's content is gone;
#   3. files from the user's computer (the page gets the drag events the browser would send, with File objects):
#      moving them over the target window makes the app see a drag with a text/uri-list offer, moving them away
#      cancels it, dropping them uploads them into the session's drop directory ($XDG_CACHE_HOME/greenfield/drops) and
#      the app receives their file:// URIs.
#
# Requires: gcc, wayland-scanner (libwayland-dev), wayland-protocols, playwright-cli (for its Playwright library and
# browser), curl, node, the built packages (make). Usage: scripts/e2e/dnd.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gcc wayland-scanner playwright-cli curl node

XDG_SHELL=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
[ -f "$XDG_SHELL" ] || fail "wayland-protocols is not installed ($XDG_SHELL)"
step "building the test client"
wayland-scanner client-header "$XDG_SHELL" "$WORK/xdg-shell-client-protocol.h"
wayland-scanner private-code "$XDG_SHELL" "$WORK/xdg-shell-protocol.c"
gcc -Wall -Wno-unused-result -I"$WORK" -o "$WORK/dnd-client" "$E2E_DIR/dnd-client.c" "$WORK/xdg-shell-protocol.c" \
  -lwayland-client || fail "couldn't build the test client"

mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/run-dnd" <<EOF
#!/bin/sh
exec "$WORK/dnd-client" "$WORK/dropped" >"$WORK/dnd.log" 2>&1
EOF
chmod +x "$WORK/run-dnd"
cat >"$WORK/data/applications/test-dnd.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Drag and Drop
Exec=$WORK/run-dnd
StartupWMClass=test-dnd
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in, starting a session and launching the test client"
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-dnd.desktop\"]') && document.activeElement.id === 'apps-search'" "the app in the Apps menu"
pw type "Test Drag" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-dnd.desktop'" "searching"
pw press Enter >/dev/null
wait_for "() => { const w = window.__viewerTest.windows(); return w.length === 2 && w.every((w) => w.placed && w.hasContent) }" "both windows" 40
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)
pointer_at() {
  wait_windows_still
  pw mousemove $((DESK_X + $1)) $((DESK_Y + $2)) >/dev/null
}
# where a window (by title) is, on the desktop: "x y"
window_at() { pw_eval "() => { const w = window.__viewerTest.windows().find((w) => w.title === '$1'); return Math.round(w.shownX) + ' ' + Math.round(w.shownY) }" | tr -d '"'; }
read -r SX SY < <(window_at dnd-source; echo)
read -r TX TY < <(window_at dnd-target; echo)
echo "    source at $SX,$SY, target at $TX,$TY (200x200 each)"
echo "    ok"

# the windows overlap (a cascade): press on a part of the source the target doesn't cover, release on a part of the
# target the source doesn't cover (the press raises the source above the target)
SOURCE_X=$((SX + 10)); SOURCE_Y=$((SY + 10))
TARGET_X=$((TX + 190)); TARGET_Y=$((TY + 190))

step "dragging from one window to another: the icon follows the pointer, the drop delivers the text"
pointer_at "$SOURCE_X" "$SOURCE_Y"
pw mousedown >/dev/null
wait_for "() => { const d = window.__viewerTest.drag(); return d !== null && !!d.icon && d.icon.width === 32 }" "the drag (with its icon)" 10
for i in 1 2 3 4 5; do
  pointer_at $((SOURCE_X + (TARGET_X - SOURCE_X) * i / 5)) $((SOURCE_Y + (TARGET_Y - SOURCE_Y) * i / 5))
done
wait_until "the target to be entered" 5 grep -q 'target entered' "$WORK/dnd.log"
pw mouseup >/dev/null
dropped_text() { [ "$(cat "$WORK/dropped" 2>/dev/null)" = "dragged text" ]; }
wait_until "the drop (file has: $(cat "$WORK/dropped" 2>/dev/null))" 10 dropped_text
wait_until "the drag to finish" 5 grep -q 'drag finished' "$WORK/dnd.log"
wait_for "() => window.__viewerTest.drag() === null" "the viewer to be told the drag is over" 5
echo "    ok"

step "after the drop: a new drag starts and a release over nothing cancels it"
rm -f "$WORK/dropped"
pointer_at "$SOURCE_X" "$SOURCE_Y"
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.drag() !== null" "the second drag" 10
ICON="$(pw_eval "() => window.__viewerTest.drag().icon.surface" | tr -d '"')"
pointer_at 600 500
pw mouseup >/dev/null
wait_until "the drag to be cancelled" 5 grep -q 'drag cancelled' "$WORK/dnd.log"
wait_for "() => window.__viewerTest.drag() === null" "the viewer to be told the drag is over" 5
[ ! -e "$WORK/dropped" ] || fail "text was dropped outside the target"
echo "    ok"

step "a window that reuses the icon's protocol id is a new surface: shown in its place, gets the pointer"
wait_until "the app to open dnd-after" 5 grep -q 'dnd-after surface' "$WORK/dnd.log"
ICON_PROTOCOL_ID="$(sed -n 's/^icon surface //p' "$WORK/dnd.log" | tail -1)"
AFTER_PROTOCOL_ID="$(sed -n 's/^dnd-after surface //p' "$WORK/dnd.log")"
[ "$ICON_PROTOCOL_ID" = "$AFTER_PROTOCOL_ID" ] ||
  fail "the window didn't get the icon's protocol id ($AFTER_PROTOCOL_ID, the icon had $ICON_PROTOCOL_ID): nothing tested"
wait_for "() => { const w = window.__viewerTest.windows().find((w) => w.title === 'dnd-after'); return !!w && w.placed && w.hasContent }" "dnd-after" 10
wait_windows_still
AFTER="$(pw_eval "() => window.__viewerTest.windows().find((w) => w.title === 'dnd-after').id" | tr -d '"')"
[ "$AFTER" != "$ICON" ] || fail "the window has the icon's id ($ICON)"
wait_for "() => !window.__viewerTest.surfaces().includes('$ICON')" "the icon's content to be freed" 5
# its content is where the window is: the canvas' box is the window's (the icon's was at the pointer)
read -r AX AY < <(window_at dnd-after; echo)
CANVAS="$(pw_eval "() => { const o = document.getElementById('output').getBoundingClientRect(), c = document.querySelector('canvas[data-surface=\"$AFTER\"]').getBoundingClientRect(); return [c.x - o.x, c.y - o.y, c.width, c.height].map(Math.round).join(' ') }" | tr -d '"')"
[ "$CANVAS" = "$AX $AY 60 60" ] || fail "dnd-after's content is shown at $CANVAS, the window is at $AX $AY (60x60)"
pointer_at $((AX + 30)) $((AY + 30))
wait_until "the pointer to reach dnd-after" 5 grep -q 'pointer entered dnd-after' "$WORK/dnd.log"
echo "    ok"

step "files dragged in from the user's computer: the app under the pointer gets their file:// URIs"
# (Playwright can't drag files from the OS: the page gets the drag events the browser would send, with real File objects)
file_drag() { # $1: dragenter, dragover, dragleave or drop; $2 $3: desktop coordinates; $4: file names (JSON array)
  pw_eval "() => {
    const c = document.getElementById('output'), r = c.getBoundingClientRect()
    const dt = new DataTransfer()
    for (const name of $4) dt.items.add(new File(['content of ' + name], name))
    c.dispatchEvent(new DragEvent('$1', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + $2, clientY: r.y + $3 }))
    return true
  }" | grep -q true || fail "couldn't send $1"
}
ENTERED="$(grep -c 'target entered' "$WORK/dnd.log")"
entered_again() { [ "$(grep -c 'target entered' "$WORK/dnd.log")" -gt "$ENTERED" ]; }
file_drag dragenter "$TARGET_X" "$TARGET_Y" '["from browser.txt", "two.txt"]'
file_drag dragover "$TARGET_X" "$TARGET_Y" '["from browser.txt", "two.txt"]'
wait_until "the target app to see the files come in" 10 entered_again
file_drag dragleave "$TARGET_X" "$TARGET_Y" '["from browser.txt"]'
wait_for "() => window.__viewerTest.drag() === null" "the drag of files to end when they leave" 5
rm -f "$WORK/dropped"
ENTERED="$(grep -c 'target entered' "$WORK/dnd.log")"
file_drag dragenter "$TARGET_X" "$TARGET_Y" '["from browser.txt", "two.txt"]'
file_drag dragover "$TARGET_X" "$TARGET_Y" '["from browser.txt", "two.txt"]'
wait_until "the target app to see the files come in again" 10 entered_again
file_drag drop "$TARGET_X" "$TARGET_Y" '["from browser.txt", "two.txt"]'
uris_dropped() { grep -q 'two.txt' "$WORK/dropped" 2>/dev/null; }
wait_until "the drop of files (the app got: $(cat "$WORK/dropped" 2>/dev/null))" 10 uris_dropped
DROP_DIR="$(ls -d "$WORK"/cache/greenfield/drops/d-* | head -n 1)"
[ "$(cat "$DROP_DIR/from browser.txt")" = "content of from browser.txt" ] || fail "the dropped file's content is wrong"
[ "$(cat "$DROP_DIR/two.txt")" = "content of two.txt" ] || fail "the second dropped file's content is wrong"
printf 'file://%s/from%%20browser.txt\r\nfile://%s/two.txt\r\n' "$DROP_DIR" "$DROP_DIR" >"$WORK/expected-uris"
cmp -s "$WORK/expected-uris" "$WORK/dropped" || fail "the app got the wrong list: $(cat -A "$WORK/dropped")"
wait_for "() => window.__viewerTest.drag() === null" "the drag to be over after the drop" 5
echo "    saved in ${DROP_DIR#$WORK/}"
echo "    ok"

echo "PASS: drag and drop: between remote apps (icon, drop, cancel) and files from the user's computer"
