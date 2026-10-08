#!/usr/bin/env bash
# End-to-end test of the viewer's video path in a headless browser (the other scripts run with --encoder none, so no video
# reaches the viewer there). Needs no session: H.264 frames encoded with GStreamer's x264enc in the stream layout the
# server's hardware encoders produce (scripts/e2e/video-fixture.js), are fed to the viewer through its test hook, and
# the pixels of the surface's canvas are checked:
#   1. opaque video: the image is cropped out of the padded frame (the bottom right corner) and its colors are right
#      (red left, blue right), drawn straight from the decoder's frame;
#   2. video with alpha: the left half is transparent, the right half opaque, the bottom rows half transparent, and the colors
#      are right (the shared WebGL context combines the color and alpha streams);
#   3. patches drawn over video replace its pixels (transparent ones too), and a patch of another size stretches what was there;
#   4. lossy patches: a JPEG, and a JPEG with alpha (its two images combined by the same shared WebGL context as video
#      with alpha), where alpha of 254 or more comes out fully opaque.
#
# Requires: gst-launch-1.0 with x264enc, playwright-cli (for its Playwright library and Chrome), curl, node, the built
# packages (make). Usage: scripts/e2e/video.sh   (GATEWAY_PORT)
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
# raw RGBA pixels (made by the page) of a rectangle filled with one color, as base64
RAW_JS='async (r, g, b, a, width, height) => {
    const bytes = new Uint8Array(width * height * 4)
    for (let i = 0; i < bytes.length; i += 4) bytes.set([r, g, b, a], i)
    return btoa(String.fromCharCode(...bytes))
  }'
alpha_pixel() { pw_eval "() => window.__viewerTest.surfacePixels('test/alpha', $1, $2, 1, 1).join(',')" | tr -d '"'; }
pw_eval "async () => {
  const transparent = await ($RAW_JS)(0, 0, 0, 0, 10, 10)
  await window.__viewerTest.injectPatch('test/alpha', { width: 40, height: 30 }, { x: 25, y: 0, width: 10, height: 10 }, transparent)
  const green = await ($RAW_JS)(0, 255, 0, 255, 10, 10)
  await window.__viewerTest.injectPatch('test/alpha', { width: 40, height: 30 }, { x: 0, y: 0, width: 10, height: 10 }, green)
  return true
}" >/dev/null
near "a transparent patch over opaque video" "$(alpha_pixel 30 5)" "0,0,0,0"
near "an opaque patch over transparent video" "$(alpha_pixel 5 5)" "0,255,0,255"
near "the video elsewhere stays" "$(alpha_pixel 38 28)" "0,0,255,128"
# the surface becomes twice as big: the old content is stretched, the patch lands in it
pw_eval "async () => {
  const yellow = await ($RAW_JS)(255, 255, 0, 255, 4, 4)
  await window.__viewerTest.injectPatch('test/alpha', { width: 80, height: 60 }, { x: 0, y: 0, width: 4, height: 4 }, yellow)
  return true
}" >/dev/null
[ "$(pw_eval "() => { const s = window.__viewerTest.contentSize('test/alpha'); return s.width + 'x' + s.height }" | tr -d '"')" = 80x60 ] ||
  fail "the surface should be 80x60 now"
near "the old content, stretched" "$(alpha_pixel 76 56)" "0,0,255,128"
near "the patch" "$(alpha_pixel 1 1)" "255,255,0,255"
echo "    ok"

step "lossy patches: a JPEG, and a JPEG with alpha combined like video with alpha"
# JPEGs made by the page (OffscreenCanvas), as base64: a 16x8 rectangle, the left half one color and the right half another
JPEG_JS='async (left, right) => {
    const canvas = new OffscreenCanvas(16, 8)
    const context = canvas.getContext("2d")
    context.fillStyle = left
    context.fillRect(0, 0, 8, 8)
    context.fillStyle = right
    context.fillRect(8, 0, 8, 8)
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer())
  }'
jpeg_pixel() { pw_eval "() => window.__viewerTest.surfacePixels('test/jpeg', $1, $2, 1, 1).join(',')" | tr -d '"'; }
pw_eval "async () => {
  const jpeg = $JPEG_JS
  const base64 = (bytes) => btoa(String.fromCharCode(...bytes))
  // opaque: red and blue
  await window.__viewerTest.injectPatch('test/jpeg', { width: 40, height: 30 }, { x: 0, y: 0, width: 16, height: 8 },
    base64(await jpeg('#ff0000', '#0000ff')), 3, 3)
  // with alpha: green, opaque on the left and transparent on the right
  const color = await jpeg('#00ff00', '#00ff00')
  const alpha = await jpeg('#ffffff', '#000000')
  const data = new Uint8Array(4 + color.length + alpha.length)
  new DataView(data.buffer).setUint32(0, color.length, true)
  data.set(color, 4)
  data.set(alpha, 4 + color.length)
  await window.__viewerTest.injectPatch('test/jpeg', { width: 40, height: 30 }, { x: 0, y: 16, width: 16, height: 8 },
    base64(data), 4, 4)
  return true
}" >/dev/null
[ "$(pw_eval "() => window.__viewerTest.patchKinds()['3/3'] > 0 && window.__viewerTest.patchKinds()['4/4'] > 0")" = true ] ||
  fail "the JPEG patches weren't applied: $(pw_eval "() => JSON.stringify(window.__viewerTest.patchKinds())")"
near "a JPEG, left" "$(jpeg_pixel 3 4)" "255,0,0,255"
near "a JPEG, right" "$(jpeg_pixel 12 4)" "0,0,255,255"
near "a JPEG with alpha, opaque half" "$(jpeg_pixel 3 20)" "0,255,0,255"
near "a JPEG with alpha, transparent half" "$(jpeg_pixel 12 20)" "0,0,0,0"
# the alpha JPEG rounds 255 down here and there: 254 and up count as opaque
OPAQUE_ALPHAS="$(pw_eval "() => { const p = window.__viewerTest.surfacePixels('test/jpeg', 0, 16, 6, 8); return [...new Set(p.filter((_, i) => i % 4 === 3))].join(',') }" | tr -d '"')"
[ "$OPAQUE_ALPHAS" = 255 ] || fail "the opaque half of the JPEG with alpha should be fully opaque, its alphas: $OPAQUE_ALPHAS"
echo "    ok"

echo "PASS: video: opaque frames are cropped and colored right, video with alpha is transparent where it should be, patches replace pixels, lossy patches too"
