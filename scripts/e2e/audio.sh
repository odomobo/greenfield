#!/usr/bin/env bash
# End-to-end test of the session's audio: starts the gateway in dev-auth mode on $GATEWAY_PORT, signs in in a headless
# browser (which starts the user's desktop) and launches an app that plays a tone through the session's own PipeWire (PulseAudio
# protocol, like most apps). Checks, in the page:
#   1. the session has audio (the server said so) and the page's audio context runs (the sign-in click was the user
#      gesture);
#   2. the page receives audio packets and decodes non-silent audio (WebCodecs Opus decoder), which the jitter buffer in
#      the AudioWorklet plays;
#   3. the taskbar's mute toggle: muted, the packets stop and the server's capture process is gone; unmuted, they resume;
#      the mute state is remembered (localStorage) and sent again after a reload;
#   4. isolation: the session's sockets are in its own directory below the runtime dir, the app's environment points
#      there, our sink is there and in no other PipeWire, the user's runtime dir got no new PipeWire or Pulse socket,
#      and the user's own PipeWire (if one runs) doesn't see our sink;
#   5. logging out stops the session's PipeWire daemons and capture and removes the directory.
#
# Skipped (exit 0) when pipewire, wireplumber, pipewire-pulse or the GStreamer pulse and opus elements are missing.
# Requires: playwright-cli (for its Playwright library and browser), curl, node, the built packages (yarn build).
# Usage: scripts/e2e/audio.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for tool in pipewire pipewire-pulse wireplumber pw-dump gst-launch-1.0; do
  command -v "$tool" >/dev/null || { echo "SKIP: audio: $tool is not installed"; exit 0; }
done
for element in pulsesrc pulsesink opusenc rtpopuspay rtpstreampay audiotestsrc; do
  gst-inspect-1.0 "$element" >/dev/null 2>&1 || { echo "SKIP: audio: the GStreamer element $element is missing"; exit 0; }
done
require_tools playwright-cli curl node

RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# the user's own PipeWire and Pulse sockets before we start (WSLg, for one, has a pulse directory)
user_sockets() { { ls "$RUNTIME" 2>/dev/null || true; } | grep -E '^(pipewire|pulse)' | sort | tr '\n' ' '; }
USER_SOCKETS_BEFORE="$(user_sockets)"

mkdir -p "$WORK/data/applications" "$WORK/config"
# the tone app: records the audio variables it was given, then plays a sine until it's stopped
cat >"$WORK/tone.sh" <<EOF
env | grep -E '^(PIPEWIRE|PULSE)' | sort >"$WORK/app-audio-env"
exec gst-launch-1.0 -q audiotestsrc freq=440 volume=0.3 is-live=true ! audioconvert ! pulsesink
EOF
cat >"$WORK/data/applications/test-tone.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Test Tone
Exec=sh $WORK/tone.sh
EOF

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver

step "signing in and starting a session; the session has audio and the page's audio context runs"
pw open "$BASE/?test=1" >/dev/null
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 40
audio() { echo "window.__viewerTest.audio()"; }
wait_for "() => { const a = $(audio); return a.available && a.contextState === 'running' && a.sentMuted === false }" "audio to be available and the audio context to run" 30
echo "    ok"

step "launching the tone app: the page receives packets and decodes non-silent audio"
click_element '#apps-button'
wait_for "() => !!document.querySelector('.app-row[data-app=\"test-tone.desktop\"]') && document.activeElement.id === 'apps-search'" "the app in the Apps menu"
pw type "Test Tone" >/dev/null
wait_for "() => [...document.querySelectorAll('.apps-list [data-app]')].map((e) => e.dataset.app).join(' ') === 'test-tone.desktop'" "searching"
pw press Enter >/dev/null
wait_for "() => { const a = $(audio); return a.packets > 20 && a.decodedFrames > 9600 && a.peak > 0.1 && a.decoderErrors === 0 }" "decoded non-silent audio" 30
# (played, not "playing" right now: on a busy machine the headless browser's audio thread is irregular, and the buffer
# may be rebuffering at any one moment; it's a fresh page, so its count starts at 0)
plays() { echo "() => { const b = $(audio).buffer; return !!b && b.playedFrames > 24000 }"; }
wait_for "$(plays)" "the jitter buffer to play half a second" 10
[ "$(pw_eval "() => $(audio).buffer.underruns" )" = 0 ] || echo "    (the jitter buffer ran dry $(pw_eval "() => $(audio).buffer.underruns") times while starting)"
echo "    ok"

# Where the session's audio is: what the app was given. The directory is below the runtime dir and named for the session.
wait_until "the app to record its environment" 10 test -s "$WORK/app-audio-env"
APP_RUNTIME_DIR="$(sed -n 's/^PIPEWIRE_RUNTIME_DIR=//p' "$WORK/app-audio-env")"
AUDIO_DIR_PREFIX="$RUNTIME/nebula-audio-"

# the processes of the session's audio: those whose environment names its directory (pw-dump and the like excluded)
audio_pids() {
  local proc
  for proc in /proc/[0-9]*; do
    if { tr "\0" "\n" 2>/dev/null <"$proc/environ" || true; } | grep -qx "PIPEWIRE_RUNTIME_DIR=$APP_RUNTIME_DIR"; then
      echo "${proc#/proc/}"
    fi
  done
}
capture_running() {
  local pid
  for pid in $(audio_pids); do
    tr '\0' ' ' 2>/dev/null <"/proc/$pid/cmdline" | grep -q pulsesrc && return 0
  done
  return 1
}
capture_gone() { ! capture_running; }
daemons_running() {
  local pid names=""
  for pid in $(audio_pids); do names="$names $(basename "$(tr '\0' '\n' 2>/dev/null <"/proc/$pid/cmdline" | head -n 1)")"; done
  for daemon in pipewire wireplumber pipewire-pulse; do
    [[ " $names " == *" $daemon "* ]] || return 1
  done
}

step "the mute toggle: muted, the packets stop and the capture ends; unmuted, they resume"
capture_running || fail "no capture process while unmuted"
click_element '#audio-button'
wait_for "() => { const a = $(audio); return a.muted && a.sentMuted === true }" "the mute to be sent"
[ "$(pw_eval "() => document.querySelector('#audio-button').getAttribute('aria-pressed')")" = '"true"' ] || fail "the toggle doesn't show it's muted"
wait_until "the server to stop capturing" 10 capture_gone
wait_for "() => { const s = $(audio).sinceLastPacketMs; return s !== undefined && s > 500 }" "the packets to stop" 10
PACKETS="$(pw_eval "() => $(audio).packets")"
wait_for "() => { const s = $(audio).sinceLastPacketMs; return s > 700 }" "the packets to stay stopped" 10
[ "$(pw_eval "() => $(audio).packets")" = "$PACKETS" ] || fail "audio packets kept arriving while muted"
echo "    ok"

step "the mute is remembered by the browser and sent again after a reload"
# (a "Leave site?" confirmation guards the signed-in page)
pw_eval "() => { setTimeout(() => location.reload(), 100); return true }" >/dev/null
dialog_pending() { [ -n "$(pw dialog)" ]; }
wait_until "the confirmation before leaving the signed-in page" 5 dialog_pending
pw dialog-accept >/dev/null
wait_for "() => document.readyState === 'complete' && $(visible login-view)" "the sign-in form after reloading" 10
browser_login
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "viewer connection" 30
wait_for "() => { const a = $(audio); return a.muted && a.available && a.sentMuted === true }" "the muted state after reloading" 20
capture_running && fail "the capture runs for a muted viewer after a reload"
echo "    ok"

step "unmuting: the packets resume"
click_element '#audio-button'
wait_for "() => { const a = $(audio); return !a.muted && a.sentMuted === false }" "the unmute to be sent"
wait_until "the capture to run again" 10 capture_running
wait_for "() => { const a = $(audio); return a.packets > 20 && a.peak > 0.1 && a.decoderErrors === 0 }" "audio after unmuting" 20
wait_for "$(plays)" "the jitter buffer to play half a second again" 10
echo "    ok"

step "isolation: the session's own PipeWire, nothing in the user's"
case "$APP_RUNTIME_DIR" in
  "$AUDIO_DIR_PREFIX"*) ;;
  *) fail "the session's audio directory $APP_RUNTIME_DIR isn't a nebula-audio directory in $RUNTIME" ;;
esac
grep -qx "PULSE_SERVER=unix:$APP_RUNTIME_DIR/native" "$WORK/app-audio-env" || fail "the app's PULSE_SERVER: $(cat "$WORK/app-audio-env")"
grep -qx "PULSE_RUNTIME_PATH=$APP_RUNTIME_DIR" "$WORK/app-audio-env" || fail "the app's PULSE_RUNTIME_PATH: $(cat "$WORK/app-audio-env")"
[ -S "$APP_RUNTIME_DIR/pipewire-0" ] && [ -S "$APP_RUNTIME_DIR/native" ] || fail "the sockets aren't in $APP_RUNTIME_DIR: $(ls "$APP_RUNTIME_DIR")"
[ "$(stat -c %a "$APP_RUNTIME_DIR")" = 700 ] || fail "the audio directory isn't private: $(stat -c %a "$APP_RUNTIME_DIR")"
daemons_running || fail "pipewire, wireplumber and pipewire-pulse aren't all running for the session"
[ "$(user_sockets)" = "$USER_SOCKETS_BEFORE" ] || fail "the user's runtime dir changed: before '$USER_SOCKETS_BEFORE', now '$(user_sockets)'"
# our sink is in the session's PipeWire (with the tone's stream playing into it), the default output ...
PIPEWIRE_RUNTIME_DIR="$APP_RUNTIME_DIR" timeout 10 pw-dump >"$WORK/session-dump.json" || fail "pw-dump of the session's PipeWire failed"
grep -q '"node.name": "nebula"' "$WORK/session-dump.json" || fail "no nebula sink in the session's PipeWire"
grep -q '"application.name": "gst-launch-1.0"' "$WORK/session-dump.json" || fail "the tone app's stream isn't in the session's PipeWire"
# ... and not in the user's own PipeWire, if there is one
if env -u PIPEWIRE_RUNTIME_DIR -u PIPEWIRE_REMOTE -u PULSE_SERVER timeout 10 pw-dump >"$WORK/user-dump.json" 2>/dev/null; then
  grep -q '"nebula"' "$WORK/user-dump.json" && fail "our sink shows up in the user's PipeWire"
  grep -q '"application.name": "gst-launch-1.0"' "$WORK/user-dump.json" && fail "our tone shows up in the user's PipeWire"
  echo "    the user's own PipeWire doesn't see our sink or streams"
else
  echo "    (no PipeWire of the user's is running: nothing to compare with)"
fi
echo "    ok"

step "logging out stops the session's PipeWire and capture and removes its directory"
session_menu logout
wait_for "() => $(visible login-view)" "the sign-in form after logging out" 10
no_audio_processes() { [ -z "$(audio_pids)" ]; }
wait_until "the session's audio processes to end" 15 no_audio_processes
wait_until "the audio directory to be removed" 10 test ! -e "$APP_RUNTIME_DIR"
[ "$(user_sockets)" = "$USER_SOCKETS_BEFORE" ] || fail "the user's runtime dir changed at the end"
echo "    ok"

echo "PASS: audio: tone received and decoded, mute and unmute, remembered across a reload, isolated, cleaned up at logout"
