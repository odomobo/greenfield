#!/usr/bin/env bash
# End-to-end test of the window decorations (our own title bars, drawn by the viewer): starts the gateway in dev
# mode on $GATEWAY_PORT, signs in in a headless browser (scripts/e2e/browser-driver.js), starts a session and, from the
# Apps menu:
#   1. launches foot: it asks for server side decorations (xdg-decoration), the scene says it's decorated, it draws no
#      title bar of its own (one surface, no client side decoration subsurfaces) and the viewer draws ours: its title,
#      active while foot has the focus and inactive when another window has;
#   2. moves foot by dragging the title bar (one window.move on the drop, Escape puts it back), opens the window menu by
#      right clicking it, maximizes and restores it with the button and with a double click: maximized, the title bar is
#      on screen below the taskbar and the content fills the output under it;
#   3. launches xclock (X11, no _MOTIF_WM_HINTS): decorated, moved by its title bar (it has no way to be moved
#      otherwise); once it says it has no decorations (xprop sets the hint) the frame goes;
#   4. stretches foot by its resize margin: the content stretches while dragging, the frame keeps its real size, and the
#      app is told once on release;
#   5. launches a GTK4 app (gtk4-demo, if installed): it keeps its own decorations, no frame;
#   (GSettings: an app of the session reads button-layout ':minimize,maximize,close' from nebula's dconf defaults)
#   (popups: shown above the frame and above other windows, checked with stand-in canvases)
#   6. launches a second foot that asks for client side decorations (like Chrome): it keeps its own, no frame;
#   7. closes foot with the title bar's close button.
# E2E_SHOTS=<directory> saves screenshots of the steps there (at device pixel ratios 1 and 2, look at them).
#
# Requires: foot, xclock, xprop, dbus-daemon, playwright-cli (for its Playwright library and browser), curl, node, the
# built packages (yarn build); gtk4-demo and gsettings are optional. Usage: scripts/e2e/decorations.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools foot xclock xprop Xwayland dbus-daemon playwright-cli curl node

mkdir -p "$WORK/data/applications" "$WORK/config"
cat >"$WORK/data/applications/test-foot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Terminal
Exec=env WAYLAND_DEBUG=1 foot --app-id=test-foot
EOF
cat >"$WORK/data/applications/test-xclock.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Clock
Exec=xclock -geometry 220x220
EOF
cat >"$WORK/data/applications/test-foot-csd.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Selfdrawn Console
Exec=foot --app-id=test-foot-csd -o csd.preferred=client
EOF
cat >"$WORK/settings-probe.sh" <<EOF
gsettings get org.gnome.desktop.wm.preferences button-layout >"$WORK/gsettings.out" 2>&1
gsettings get org.gnome.desktop.interface color-scheme >"$WORK/color-scheme.out" 2>&1
echo "\$QT_QPA_PLATFORMTHEME" >"$WORK/qt-theme.out"
if command -v kreadconfig5 >/dev/null; then
  kreadconfig5 --file kdeglobals --group Colors:Selection --key BackgroundNormal >"$WORK/kde-selection.out" 2>&1
  kreadconfig5 --file kdeglobals --group Colors:Window --key BackgroundNormal >"$WORK/kde-window.out" 2>&1
fi
echo "\$DCONF_PROFILE" >"$WORK/dconf-profile.out"
EOF
cat >"$WORK/data/applications/test-gsettings.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Settings Probe
Exec=sh $WORK/settings-probe.sh
EOF
HAVE_GTK=0
if command -v gtk4-demo >/dev/null; then
  HAVE_GTK=1
  cat >"$WORK/data/applications/test-gtk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Decorations GTK Probe
Exec=env GDK_BACKEND=wayland gtk4-demo
EOF
fi
read -r DBUS_ADDRESS DBUS_PID < <(dbus-daemon --session --fork --nopidfile --print-address=1 --print-pid=1 | tr '\n' ' '; echo)
[ -n "$DBUS_PID" ] || fail "couldn't start a D-Bus session bus"
export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS"

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
read -r DESK_X DESK_Y < <(pw_eval "() => { const r = document.getElementById('output').getBoundingClientRect(); return Math.round(r.x) + ' ' + Math.round(r.y) }" | tr -d '"'; echo)

# screenshots of a step, at both pixel ratios (E2E_SHOTS)
shot() {
  [ -n "${E2E_SHOTS:-}" ] || return 0
  mkdir -p "$E2E_SHOTS"
  local ratio
  for ratio in 1 2; do
    pw scale "$ratio" >/dev/null
    wait_for "() => window.devicePixelRatio === $ratio" "the page's ratio" 5
    sleep 0.4
    pw screenshot-device "$E2E_SHOTS/$1-dpr$ratio.png" >/dev/null
  done
  pw scale 1 >/dev/null
}

# $1: the app's desktop entry, $2: its name
launch() {
  click_element '#apps-button'
  wait_for "() => !!document.querySelector('.app-row[data-app=\"$1\"]') && document.activeElement.id === 'apps-search'" "$1 in the Apps menu"
  pw type "$2" >/dev/null
  wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === '$1'" "searching for $1"
  pw press Enter >/dev/null
  wait_for "() => !$(visible apps-menu)" "the Apps menu to close"
}
# an expression of `w`, the viewer's window of an app (by app id), as JSON
win() { pw_eval "() => { const w = window.__viewerTest.windows().find((w) => w.appId === '$1'); return w ? ($2) : null }"; }
# true when `$2` (an expression of `w`) is true of the app's window
win_is() { echo "() => { const w = window.__viewerTest.windows().find((w) => w.appId === '$1'); return !!w && !!($2) }"; }
# the app's window frame element's id, a selector for its parts
frame_of() { echo ".frame[data-frame-window=\"$(win "$1" w.id | tr -d '"')\"]"; }
# the center of a frame part (page coordinates)
center_of() { element_center "$1"; }
# the shown geometry of the app's window, "x y width height" (output coordinates)
geometry_of() { echo "$(win "$1" "[w.shownGeometry.x, w.shownGeometry.y, w.shownGeometry.width, w.shownGeometry.height].join(' ')" | tr -d '"')"; }
moves_sent() { pw_eval "() => window.__viewerTest.movesSent()"; }
settled() { echo "() => !window.__viewerTest.interaction() && !Object.keys(window.__viewerTest.animations()).length && !window.__viewerTest.resizing()"; }
FRAME_T="" # the title bar's height, learned from the first frame

# ---------------------------------------------------------------------------------------------------------------------

step "foot gets our frame: it asks for server side decorations and draws no title bar of its own"
launch test-foot.desktop "Test Terminal"
wait_for "$(win_is test-foot 'w.placed && w.hasContent && w.decorated')" "foot's decorated window" 40
[ "$(win test-foot w.surfaces.length)" = 1 ] || fail "foot has more than one surface: it draws its own decorations ($(win test-foot 'w.surfaces.map((s) => [s.x, s.y, s.width, s.height].join(\",\")).join(\" \")'))"
# (foot's Wayland log: the compositor answered its decoration object with server side mode, 2)
grep -aq 'zxdg_toplevel_decoration_v1@[0-9]*\.configure(2)' "$WORK/gateway.log" || fail "foot wasn't told server side decorations"
FOOT="$(frame_of test-foot)"
wait_for "() => !!document.querySelector('$FOOT .frame-title')" "foot's title bar"
# (measured once foot has finished opening: it scales in)
wait_windows_still
FRAME_T="$(pw_eval "() => Math.round(document.querySelector('$FOOT .frame-title').getBoundingClientRect().height)")"
[ "$FRAME_T" -ge 44 ] && [ "$FRAME_T" -le 50 ] || fail "the title bar is $FRAME_T px high"
# the frame is outside the content: the title bar is right above the geometry and as wide as it (plus the borders)
wait_for "() => { const w = window.__viewerTest.windows().find((w) => w.appId === 'test-foot'); const g = w.shownGeometry; const d = document.getElementById('output').getBoundingClientRect(); const t = document.querySelector('$FOOT .frame-title').getBoundingClientRect(); return Math.abs(t.bottom - d.top - g.y) <= 1 && Math.abs(t.width - g.width - 2) <= 1 && Math.abs(t.left - d.left - g.x + 1) <= 1 }" "the title bar to sit on the window" 5
[ "$(pw_eval "() => document.querySelector('$FOOT .frame-text').textContent === window.__viewerTest.windows().find((w) => w.appId === 'test-foot').title")" = true ] || fail "the title bar doesn't show the window's title"
[ "$(pw_eval "() => document.querySelector('$FOOT').classList.contains('active')")" = true ] || fail "foot's frame isn't active while foot has the focus"
# xdg-shell 4 and 5: foot was told its bounds (the output minus our frame: the title bar and a border on each other
# side) and what we support (window menu, maximize, fullscreen, minimize: four u32, 16 bytes)
read -r OUT_W OUT_H < <(pw_eval "() => window.__viewerTest.output().width + ' ' + window.__viewerTest.output().height" | tr -d '"'; echo)
grep -aq "xdg_toplevel@[0-9]*\.configure_bounds($((OUT_W - 2)), $((OUT_H - FRAME_T - 1)))" "$WORK/gateway.log" ||
  fail "foot wasn't told its bounds ($((OUT_W - 2))x$((OUT_H - FRAME_T - 1))): $(grep -ao 'configure_bounds([^)]*)' "$WORK/gateway.log" | head -3)"
grep -aq 'xdg_toplevel@[0-9]*\.wm_capabilities(array\[16\])' "$WORK/gateway.log" || fail "foot wasn't told our four capabilities"
echo "    title bar ${FRAME_T}px; foot has one surface and was told server side mode, bounds $((OUT_W - 2))x$((OUT_H - FRAME_T - 1)) and four capabilities"
shot foot-active

step "a popup reaching past the window's edge covers the frame (a stand-in canvas over the bottom border)"
# foot's popups' element, in the layer above all windows (moved with foot); a stand-in canvas there is where a menu goes
FOOT_POPUPS=".window-popups[data-window=\"$(win test-foot w.id | tr -d '"')\"]"
[ "$(pw_eval "() => !!document.querySelector('.popup-layer > $FOOT_POPUPS')")" = true ] || fail "foot has no popups' element in the popup layer"
# hit testing follows the painting order: the border (normally click through) takes pointer events for the check
[ "$(pw_eval "() => { const frame = document.querySelector('$FOOT'); const border = frame.querySelector('.frame-border'); const b = border.getBoundingClientRect(); const popup = document.createElement('canvas'); popup.className = 'surface'; const popups = document.querySelector('$FOOT_POPUPS'); popups.append(popup); const w = popups.getBoundingClientRect(); Object.assign(popup.style, { left: (b.left - w.left + 20) + 'px', top: (b.bottom - w.top - 20) + 'px', width: '40px', height: '40px' }); border.style.pointerEvents = 'auto'; const top = document.elementFromPoint(b.left + 30, b.bottom - 0.5); border.style.pointerEvents = ''; popup.remove(); return top === popup }")" = true ] ||
  fail "the frame's border is drawn over a popup reaching past the window's edge"
echo "    ok"

step "the frame of an inactive window"
launch test-xclock.desktop "Test Clock"
wait_for "$(win_is XClock 'w.placed && w.hasContent')" "xclock's window" 40
wait_for "$(win_is test-foot '!w.activated')" "foot to lose the focus" 5
[ "$(pw_eval "() => document.querySelector('$FOOT').classList.contains('active')")" = false ] || fail "foot's frame is active while another window has the focus"
echo "    ok"
shot foot-inactive-xclock-active

step "a popup of a window that isn't on top is shown above the ones that are (a stand-in canvas of foot's over xclock)"
[ "$(pw_eval "() => { const clock = document.querySelector('$(frame_of XClock)').getBoundingClientRect(); const popups = document.querySelector('$FOOT_POPUPS'); const o = popups.getBoundingClientRect(); const popup = document.createElement('canvas'); popup.className = 'surface'; popups.append(popup); Object.assign(popup.style, { left: (clock.left - o.left + 30) + 'px', top: (clock.top - o.top + 60) + 'px', width: '40px', height: '40px' }); const top = document.elementFromPoint(clock.left + 50, clock.top + 80); popup.remove(); return top === popup }")" = true ] ||
  fail "a popup of foot is covered by xclock, which is above foot"
echo "    ok"

step "clicking foot's title bar activates it"
read -r TX TY < <(center_of "$FOOT .frame-title"; echo)
# (away from the middle: the next press there would be the second of a double click)
pw mousemove $((TX - 60)) "$TY" >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
wait_for "$(win_is test-foot w.activated)" "foot to be activated by its title bar" 5
wait_for "() => document.querySelector('$FOOT').classList.contains('active')" "foot's frame to be active" 5
echo "    ok"

# ---------------------------------------------------------------------------------------------------------------------

step "dragging foot's title bar moves it: one window.move on the drop, Escape puts it back"
read -r GX GY GW GH < <(geometry_of test-foot; echo)
read -r TX TY < <(center_of "$FOOT .frame-title"; echo)
MOVES0="$(moves_sent)"
pw mousemove "$TX" "$TY" >/dev/null
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.interaction() === 'move'" "the move to start" 5
pw mousemove $((TX + 50)) $((TY + 30)) >/dev/null
pw mousemove $((TX + 120)) $((TY + 80)) >/dev/null
wait_for "$(win_is test-foot "w.shownGeometry.x === $((GX + 120)) && w.shownGeometry.y === $((GY + 80))")" "the window to follow the pointer" 5
[ "$(moves_sent)" = "$MOVES0" ] || fail "window.move was sent while dragging"
pw mouseup >/dev/null
wait_for "$(win_is test-foot "w.x === w.shownX && w.y === w.shownY && w.shownGeometry.x === $((GX + 120))")" "the server to store the position" 10
[ "$(moves_sent)" = "$((MOVES0 + 1))" ] || fail "the drop should send one window.move ($MOVES0 -> $(moves_sent))"
read -r GX GY GW GH < <(geometry_of test-foot; echo)
read -r TX TY < <(center_of "$FOOT .frame-title"; echo)
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.interaction() === 'move'" "the second move to start" 5
pw mousemove $((TX + 90)) $((TY + 40)) >/dev/null
wait_for "$(win_is test-foot "w.shownGeometry.x === $((GX + 90))")" "the window to follow the pointer" 5
pw press Escape >/dev/null
wait_for "$(win_is test-foot "w.shownGeometry.x === $GX && w.shownGeometry.y === $GY")" "Escape to put the window back" 5
pw mouseup >/dev/null
wait_for "$(settled)" "the interaction to end" 5
[ "$(moves_sent)" = "$((MOVES0 + 1))" ] || fail "Escape sent a window.move"
# foot never saw any of it: no pointer button reached it
echo "    moved by 120,80, Escape went back to $GX,$GY"

step "right clicking the title bar opens the window menu"
read -r TX TY < <(center_of "$FOOT .frame-title"; echo)
pw mousemove "$TX" "$TY" >/dev/null
pw mousedown right >/dev/null
pw mouseup right >/dev/null
wait_for "() => [...document.querySelectorAll('.context-menu button')].map((b) => b.dataset.action).join(',') === 'minimize,maximize,move,size,close'" "the window menu" 5
pw press Escape >/dev/null
wait_for "() => !document.querySelector('.context-menu')" "the menu to close" 5
echo "    ok"

step "the maximize button: the title bar stays on screen below the taskbar, the content fills the output under it"
read -r OX OY OW OH < <(geometry_of test-foot; echo)
click_element "$FOOT .frame-button.maximize"
wait_for "$(win_is test-foot 'w.maximized')" "foot to be maximized" 10
wait_for "$(settled)" "the animation to end" 5
wait_for "() => { const w = window.__viewerTest.windows().find((w) => w.appId === 'test-foot'); const o = window.__viewerTest.output(); const g = w.shownGeometry; const t = document.querySelector('$FOOT .frame-title').getBoundingClientRect(); const d = document.getElementById('output').getBoundingClientRect(); const bar = document.getElementById('taskbar').getBoundingClientRect(); return g.x === 0 && g.y === $FRAME_T && g.width === o.width && g.height === o.height - $FRAME_T && Math.round(t.top - d.top) === 0 && t.top >= bar.bottom - 1 && t.width === o.width }" "the title bar on screen and the content below it" 10
[ "$(pw_eval "() => document.querySelector('$FOOT .frame-button.maximize').title")" = '"Restore down"' ] || fail "the maximize button doesn't offer to restore"
echo "    ok"
shot foot-maximized
# a double click on the title bar restores it
read -r TX TY < <(center_of "$FOOT .frame-title"; echo)
pw mousemove "$TX" "$TY" >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
wait_for "$(win_is test-foot '!w.maximized')" "foot to be restored by the double click" 10
wait_for "$(settled)" "the animation to end" 5
wait_for "$(win_is test-foot "[w.shownGeometry.x, w.shownGeometry.y, w.shownGeometry.width, w.shownGeometry.height].join(' ') === '$OX $OY $OW $OH'")" "foot to be back where it was" 10
# ... and again to maximize
read -r TX TY < <(center_of "$FOOT .frame-title"; echo)
pw mousemove "$TX" "$TY" >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
pw mousedown >/dev/null
pw mouseup >/dev/null
wait_for "$(win_is test-foot 'w.maximized')" "foot to be maximized by the double click" 10
wait_for "$(settled)" "the animation to end" 5
click_element "$FOOT .frame-button.maximize"
wait_for "$(win_is test-foot '!w.maximized')" "the restore button" 10
wait_for "$(settled)" "the animation to end" 5

# ---------------------------------------------------------------------------------------------------------------------

step "the minimize button hides foot (so it isn't over xclock)"
click_element "$FOOT .frame-button.minimize"
wait_for "$(win_is test-foot 'w.minimized')" "foot to be minimized" 10
wait_for "$(settled)" "the animation to end" 5
echo "    ok"

step "xclock (X11, no hints): decorated, and moved by its title bar"
wait_for "$(win_is XClock w.decorated)" "xclock to be decorated" 5
XCLOCK="$(frame_of XClock)"
wait_for "() => !!document.querySelector('$XCLOCK .frame-title') && getComputedStyle(document.querySelector('$XCLOCK')).display !== 'none'" "xclock's frame" 5
read -r GX GY GW GH < <(geometry_of XClock; echo)
# (xclock is narrow: the middle of its title bar is under its buttons, the title text is the part to grab)
read -r TX TY < <(center_of "$XCLOCK .frame-text"; echo)
pw mousemove "$TX" "$TY" >/dev/null
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.interaction() === 'move'" "xclock's move to start" 5
pw mousemove $((TX + 30)) $((TY + 60)) >/dev/null
pw mousemove $((TX + 60)) $((TY + 120)) >/dev/null
pw mouseup >/dev/null
wait_for "$(win_is XClock "w.x === w.shownX && w.shownGeometry.x === $((GX + 60)) && w.shownGeometry.y === $((GY + 120))")" "xclock to be moved" 10
echo "    moved from $GX,$GY to $(geometry_of XClock)"
shot xclock-decorated
X11_DISPLAY="$(grep -ao 'DISPLAY=":[0-9]*"' "$WORK/gateway.log" | head -1 | cut -d'"' -f2)"
[ -n "$X11_DISPLAY" ] || fail "the session has no X11 display"
step "an X11 window that says it has no decorations (_MOTIF_WM_HINTS) loses the frame"
DISPLAY="$X11_DISPLAY" xprop -name xclock -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "2, 0, 0, 0, 0" || fail "xprop couldn't set the hint"
wait_for "$(win_is XClock '!w.decorated')" "xclock to be undecorated" 10
wait_for "() => getComputedStyle(document.querySelector('$XCLOCK')).display === 'none'" "xclock's frame to go" 5
echo "    ok"

# ---------------------------------------------------------------------------------------------------------------------

step "stretching foot by its resize margin: the content stretches, the frame keeps its real size, the app is told on release"
click_element '#taskbar-items button[data-group="test-foot.desktop"]'
wait_for "$(win_is test-foot 'w.activated && !w.minimized')" "foot to be restored from the taskbar" 5
wait_for "$(settled)" "the animation to end" 5
read -r GX GY GW GH < <(geometry_of test-foot; echo)
RESIZES0="$(pw_eval "() => window.__viewerTest.resizesSent()")"
# the east margin: a few pixels right of the border, in the middle of the side
MX=$((DESK_X + GX + GW + 3))
MY=$((DESK_Y + GY + GH / 2))
pw mousemove "$MX" "$MY" >/dev/null
pw mousedown >/dev/null
wait_for "() => window.__viewerTest.interaction() === 'resize'" "the resize to start" 5
pw mousemove $((MX + 40)) "$MY" >/dev/null
pw mousemove $((MX + 80)) "$MY" >/dev/null
wait_for "$(win_is test-foot "w.shownGeometry.width === $((GW + 80))")" "the window to be stretched" 5
wait_for "() => { const t = document.querySelector('$FOOT .frame-title').getBoundingClientRect(); return Math.round(t.height) === $FRAME_T && Math.round(t.width) === $((GW + 80 + 2)) }" "the title bar to be $((GW + 82)) x $FRAME_T" 5
[ "$(pw_eval "() => window.__viewerTest.resizesSent()")" = "$RESIZES0" ] || fail "window.resize was sent while dragging"
shot foot-stretching
pw mouseup >/dev/null
wait_for "() => !window.__viewerTest.resizing()" "the client to commit the new size" 10
[ "$(pw_eval "() => window.__viewerTest.resizesSent()")" = "$((RESIZES0 + 1))" ] || fail "the release should send one window.resize"
read -r GX2 GY2 GW2 GH2 < <(geometry_of test-foot; echo)
echo "    ${GW}x${GH} -> ${GW2}x${GH2} (dragged to $((GW + 80)) wide)"
[ "$GX2" = "$GX" ] && [ "$GY2" = "$GY" ] || fail "the window moved while resizing from the east edge"
[ "$((GW2 - GW))" -ge 56 ] || fail "foot didn't grow by about 80 px: ${GW2}"
echo "    ok"

# ---------------------------------------------------------------------------------------------------------------------

if command -v gsettings >/dev/null; then
  step "the session's apps get nebula's desktop defaults: GSettings button-layout ':minimize,maximize,close', dark (GSettings, KDE)"
  launch test-gsettings.desktop "Settings Probe"
  wait_until "the app's GSettings answer" 20 test -s "$WORK/gsettings.out" -a -s "$WORK/dconf-profile.out"
  [ "$(cat "$WORK/gsettings.out")" = "':minimize,maximize,close'" ] || fail "button-layout in the session: $(cat "$WORK/gsettings.out")"
  grep -q '^/' "$WORK/dconf-profile.out" || fail "DCONF_PROFILE isn't an absolute path: $(cat "$WORK/dconf-profile.out")"
  [ "$(cat "$WORK/color-scheme.out")" = "'prefer-dark'" ] || fail "color-scheme in the session: $(cat "$WORK/color-scheme.out")"
  [ "$(cat "$WORK/qt-theme.out")" = kde ] || fail "QT_QPA_PLATFORMTHEME in the session: $(cat "$WORK/qt-theme.out")"
  # KDE apps read nebula's kdeglobals (dark, nebula's accent); the test's own ~/.config has none
  if [ -e "$WORK/kde-selection.out" ]; then
    ACCENT="$(node -e "console.log(require('$REPO/packages/gateway/dist/nebula-settings.js').NEBULA_ACCENT.join(','))")"
    [ "$(cat "$WORK/kde-selection.out")" = "$ACCENT" ] || fail "KDE selection color in the session: $(cat "$WORK/kde-selection.out") (not $ACCENT)"
    [ "$(cat "$WORK/kde-window.out")" = 42,46,50 ] || fail "KDE window color in the session: $(cat "$WORK/kde-window.out")"
  else
    echo "    (kreadconfig5 isn't installed: the KDE colors aren't checked)"
  fi
  echo "    ok"
else
  echo "(gsettings isn't installed: the GSettings check is skipped)"
fi

if [ "$HAVE_GTK" = 1 ]; then
  step "a GTK4 app (no xdg-decoration) keeps its own decorations: no frame"
  launch test-gtk.desktop "Decorations GTK Probe"
  wait_for "() => window.__viewerTest.windows().some((w) => w.appId.startsWith('org.gtk') && w.placed && w.hasContent)" "the GTK window" 40
  [ "$(pw_eval "() => window.__viewerTest.windows().filter((w) => w.appId.startsWith('org.gtk')).some((w) => w.decorated)")" = false ] || fail "a GTK window is decorated"
  [ "$(pw_eval "() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').length")" = 1 ] ||
    fail "only foot's frame should be shown (xclock's is gone, the GTK app has none): $(pw_eval "() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').map((f) => f.dataset.frameWindow)")"
  wait_for "$(settled)" "the GTK window to settle" 5
  shot gtk-demo-buttons
  echo "    ok"
  step "right clicking the GTK app's header bar (show_window_menu) opens our window menu"
  wait_for "$(settled)" "the window to settle" 5
  read -r HX HY HW HH < <(pw_eval "() => { const w = window.__viewerTest.windows().find((w) => w.appId.startsWith('org.gtk') && !w.parent); const g = w.shownGeometry; return [g.x, g.y, g.width, g.height].join(' ') }" | tr -d '"'; echo)
  # the header bar is the top of the window geometry; its middle is the title
  pw mousemove $((DESK_X + HX + HW / 2)) $((DESK_Y + HY + 20)) >/dev/null
  pw mousedown right >/dev/null
  pw mouseup right >/dev/null
  wait_for "() => !!document.querySelector('.context-menu')" "our window menu for the GTK app's header bar" 5
  pw press Escape >/dev/null
  wait_for "() => !document.querySelector('.context-menu')" "the menu to close" 5
  echo "    ok"
else
  echo "(gtk4-demo isn't installed: the GTK app check is skipped)"
fi

step "an app that asks for client side decorations (like Chrome) keeps its own: no frame"
launch test-foot-csd.desktop "Selfdrawn Console"
wait_for "$(win_is test-foot-csd 'w.placed && w.hasContent')" "the second foot's window" 40
[ "$(win test-foot-csd w.decorated)" != true ] || fail "an app that asked for client side decorations is decorated"
# its own title bar and borders are subsurfaces
wait_for "$(win_is test-foot-csd 'w.surfaces.length > 1')" "the second foot to draw its own decorations" 10
[ "$(pw_eval "() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').length")" = 1 ] ||
  fail "only the first foot's frame should be shown: $(pw_eval "() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').map((f) => f.dataset.frameWindow)")"
echo "    ok"

step "right clicking an app's own title bar (show_window_menu) opens our window menu there"
wait_for "$(settled)" "the window to settle" 5
read -r CX CY CW CH < <(geometry_of test-foot-csd; echo)
# foot's title bar is the top of its window geometry (a subsurface), the middle of it is the title
pw mousemove $((DESK_X + CX + CW / 2)) $((DESK_Y + CY + 12)) >/dev/null
pw mousedown right >/dev/null
pw mouseup right >/dev/null
wait_for "() => [...document.querySelectorAll('.context-menu button')].map((b) => b.dataset.action).join(',') === 'minimize,maximize,move,size,close'" "our window menu for foot's title bar" 5
# where the app asked: at the pointer (once it has dropped in: its animation moves it)
wait_for "() => document.querySelector('.context-menu').getAnimations().length === 0" "the menu to settle" 5
[ "$(pw_eval "() => { const m = document.querySelector('.context-menu').getBoundingClientRect(); return Math.abs(m.left - $((DESK_X + CX + CW / 2))) <= 2 && Math.abs(m.top - $((DESK_Y + CY + 12))) <= 2 }")" = true ] ||
  fail "the menu isn't at the pointer: $(pw_eval "() => JSON.stringify(document.querySelector('.context-menu').getBoundingClientRect())")"
pw press Escape >/dev/null
wait_for "() => !document.querySelector('.context-menu')" "the menu to close" 5
echo "    ok"

step "the close button closes the window"
click_element "$FOOT .frame-button.close"
wait_for "() => !window.__viewerTest.windows().some((w) => w.appId === 'test-foot')" "foot's window to close" 10
echo "    ok"

echo "PASS: window decorations: foot and X11 apps get our frame (move, maximize, resize, menu, close), GTK and apps that ask keep their own"
