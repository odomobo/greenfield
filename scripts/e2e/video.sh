#!/usr/bin/env bash
# End-to-end test of the viewer's video path in a headless browser (the other scripts run with --encoder none, so no video
# reaches the viewer there). Needs no session: H.264 frames encoded with GStreamer's x264enc, the way the server's CPU
# encode path does (scripts/e2e/video-fixture.js), are fed to the viewer through its test hook, and the pixels of the surface's
# canvas are checked:
#   1. opaque video: the image is cropped out of the padded frame (the bottom right corner) and its colors are right
#      (red left, blue right), drawn straight from the decoder's frame;
#   2. video with alpha: the left half is transparent, the right half opaque, the bottom rows half transparent, and the colors
#      are right (the shared WebGL context combines the color and alpha streams);
#   3. patches drawn over video replace its pixels (transparent ones too), and a patch of another size stretches what was there.
#
# Requires: gst-launch-1.0 with x264enc, playwright-cli (for its Playwright library and Chrome), curl, node, the built
# packages (yarn build). Usage: scripts/e2e/video.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools gst-launch-1.0 playwright-cli curl node

step "encoding the test frames"
FRAMES="$(node "$E2E_DIR/video-fixture.js" "$WORK")" || fail "couldn't encode the test frames (is x264enc installed?)"

step "starting the gateway on :$PORT and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log"
GATEWAY_PID="$STARTED_PID"
start_driver
pw open "$BASE/?test=1" >/dev/null
wait_for "() => !!window.__viewerTest" "the page's test hooks"

# Feed a frame to a surface and read back all its pixels as "r,g,b,a" of a few sample points, one per line.
# $1: surface, $2: the frame (opaque or withAlpha)
SAMPLES='[[2, 2], [10, 5], [30, 5], [10, 25], [30, 25], [38, 28]]'
sample() {
  pw_eval "async () => {
    const frames = $FRAMES
    await window.__viewerTest.injectFrame('$1', frames.$2)
    const size = window.__viewerTest.contentSize('$1')
    if (!size) return 'no content'
    const all = window.__viewerTest.surfacePixels('$1', 0, 0, size.width, size.height)
    return size.width + 'x' + size.height + ' ' + $SAMPLES.map(([x, y]) => all.slice((y * size.width + x) * 4, (y * size.width + x) * 4 + 4).join(',')).join(' ')
  }"
}

# check that a sample ("r,g,b,a") is within a few levels of what's expected. $1: what, $2: actual, $3: expected
near() {
  node -e '
    const [what, actual, expected] = process.argv.slice(1)
    const a = actual.split(",").map(Number), e = expected.split(",").map(Number)
    if (a.length !== 4 || a.some((v, i) => Math.abs(v - e[i]) > 14)) {
      console.error(`FAIL: ${what}: ${actual}, expected about ${expected}`)
      process.exit(1)
    }
  ' "$1" "$2" "$3" || fail "wrong pixels"
}

step "opaque video: cropped out of the padded frame, in the right colors"
RESULT="$(sample test/opaque opaque | tr -d '"')"
echo "    $RESULT"
read -r SIZE P0 P1 P2 P3 P4 P5 <<<"$RESULT"
[ "$SIZE" = "40x30" ] || fail "the image should be 40x30 (the real size), not the padded size: $SIZE"
near "red, left half" "$P1" "255,0,0,255"
near "blue, right half" "$P2" "0,0,255,255"
near "red, bottom left" "$P3" "255,0,0,255"
near "blue, bottom right" "$P4" "0,0,255,255"
near "the top left corner (the image's own pixel, not the padding)" "$P0" "255,0,0,255"
echo "    ok"

step "video with alpha: transparent where the alpha stream says so, in the right colors"
RESULT="$(sample test/alpha withAlpha | tr -d '"')"
echo "    $RESULT"
read -r SIZE P0 P1 P2 P3 P4 P5 <<<"$RESULT"
[ "$SIZE" = "40x30" ] || fail "the image should be 40x30: $SIZE"
# (the canvas holds premultiplied colors, the readback un-premultiplies: half transparent pixels keep their color)
near "left half transparent, top left" "$P0" "0,0,0,0"
near "left half transparent" "$P1" "0,0,0,0"
near "right half opaque and blue" "$P2" "0,0,255,255"
near "bottom left half transparent, red" "$P3" "255,0,0,128"
near "bottom right half transparent, blue" "$P4" "0,0,255,128"
echo "    ok"

step "patches over video replace the pixels, transparent ones too; a patch of another size stretches what was there"
# a PNG (made by the page) of a rectangle filled with one color, as base64
PNG_JS='async (r, g, b, a, width, height) => {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext("2d")
    context.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`
    context.fillRect(0, 0, width, height)
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())
    return btoa(String.fromCharCode(...bytes))
  }'
alpha_pixel() { pw_eval "() => window.__viewerTest.surfacePixels('test/alpha', $1, $2, 1, 1).join(',')" | tr -d '"'; }
pw_eval "async () => {
  const transparent = await ($PNG_JS)(0, 0, 0, 0, 10, 10)
  await window.__viewerTest.injectPatch('test/alpha', { width: 40, height: 30 }, { x: 25, y: 0, width: 10, height: 10 }, transparent)
  const green = await ($PNG_JS)(0, 255, 0, 255, 10, 10)
  await window.__viewerTest.injectPatch('test/alpha', { width: 40, height: 30 }, { x: 0, y: 0, width: 10, height: 10 }, green)
  return true
}" >/dev/null
near "a transparent patch over opaque video" "$(alpha_pixel 30 5)" "0,0,0,0"
near "an opaque patch over transparent video" "$(alpha_pixel 5 5)" "0,255,0,255"
near "the video elsewhere stays" "$(alpha_pixel 38 28)" "0,0,255,128"
# the surface becomes twice as big: the old content is stretched, the patch lands in it
pw_eval "async () => {
  const yellow = await ($PNG_JS)(255, 255, 0, 255, 4, 4)
  await window.__viewerTest.injectPatch('test/alpha', { width: 80, height: 60 }, { x: 0, y: 0, width: 4, height: 4 }, yellow)
  return true
}" >/dev/null
[ "$(pw_eval "() => { const s = window.__viewerTest.contentSize('test/alpha'); return s.width + 'x' + s.height }" | tr -d '"')" = 80x60 ] ||
  fail "the surface should be 80x60 now"
near "the old content, stretched" "$(alpha_pixel 76 56)" "0,0,255,128"
near "the patch" "$(alpha_pixel 1 1)" "255,255,0,255"
echo "    ok"

echo "PASS: video: opaque frames are cropped and colored right, video with alpha is transparent where it should be, patches replace pixels"
