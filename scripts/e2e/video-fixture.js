// Builds the video frames scripts/e2e/video.sh feeds to the viewer, printed as JSON ({ opaque, alpha, withAlpha } as
// base64 FRAME payloads, see scene-protocol's parseEncodedFrame), encoded by GStreamer's x264enc the way the server's CPU
// path does (compositor-proxy's gst_frame_encoder.c: I420 BT.601 limited range, High profile, byte stream).
//
// The image is 40x30 pixels in a coded frame of 48x32 (the encoder pads to a multiple of 16 at the top left, the image sits
// in the bottom right corner):
//   color:  the left half red, the right half blue (the padding black);
//   alpha:  the left half transparent, the right half opaque, except the bottom 10 rows, which are half transparent.
// Usage: node video-fixture.js <work dir>
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const [dir] = process.argv.slice(2)
const IMAGE = { width: 40, height: 30 }
const CODED = { width: 48, height: 32 }
const OFFSET = { x: CODED.width - IMAGE.width, y: CODED.height - IMAGE.height }

// BT.601 limited range
const yuv = (r, g, b) => [
  16 + 0.257 * r + 0.504 * g + 0.098 * b,
  128 - 0.148 * r - 0.291 * g + 0.439 * b,
  128 + 0.439 * r - 0.368 * g - 0.071 * b,
]

// planes of a coded frame, from a function giving each image pixel's [y, u, v] (the padding is `pad`)
function i420(pixel, pad) {
  const y = Buffer.alloc(CODED.width * CODED.height)
  const u = Buffer.alloc((CODED.width * CODED.height) / 4)
  const v = Buffer.alloc((CODED.width * CODED.height) / 4)
  for (let row = 0; row < CODED.height; row++) {
    for (let column = 0; column < CODED.width; column++) {
      const inside = column >= OFFSET.x && row >= OFFSET.y
      const [py, pu, pv] = inside ? pixel(column - OFFSET.x, row - OFFSET.y) : pad
      y[row * CODED.width + column] = Math.round(py)
      if (row % 2 === 0 && column % 2 === 0) {
        const i = (row / 2) * (CODED.width / 2) + column / 2
        u[i] = Math.round(pu)
        v[i] = Math.round(pv)
      }
    }
  }
  return Buffer.concat([y, u, v])
}

function encode(name, raw) {
  const rawFile = path.join(dir, `${name}.i420`)
  const out = path.join(dir, `${name}.h264`)
  fs.writeFileSync(rawFile, raw)
  execFileSync(
    'gst-launch-1.0',
    [
      '-q',
      'filesrc', `location=${rawFile}`, '!',
      'rawvideoparse', 'format=i420', `width=${CODED.width}`, `height=${CODED.height}`, 'framerate=60/1', 'colorimetry=bt601', '!',
      'x264enc', 'speed-preset=superfast', 'tune=zerolatency', 'bframes=0', 'byte-stream=true', 'pass=qual', 'quantizer=10', '!',
      'video/x-h264,profile=high,stream-format=byte-stream,alignment=au', '!',
      'filesink', `location=${out}`,
    ],
    { stdio: 'inherit' },
  )
  return fs.readFileSync(out)
}

const black = yuv(0, 0, 0)
const red = yuv(255, 0, 0)
const blue = yuv(0, 0, 255)
const color = encode('color', i420((x) => (x < IMAGE.width / 2 ? red : blue), black))
const alpha = encode(
  'alpha',
  i420((x, y) => [y >= IMAGE.height - 10 ? 126 : x < IMAGE.width / 2 ? 16 : 235, 128, 128], [16, 128, 128]),
)

function payload(opaque, alphaStream) {
  const header = Buffer.alloc(8 + 4 + 4 + 16 + 4)
  header.writeUInt32LE(7, 8) // content serial
  header.writeUInt32LE(IMAGE.width, 16)
  header.writeUInt32LE(IMAGE.height, 20)
  header.writeUInt32LE(CODED.width, 24)
  header.writeUInt32LE(CODED.height, 28)
  header.writeUInt32LE(opaque.length, 32)
  const alphaLength = Buffer.alloc(4)
  alphaLength.writeUInt32LE(alphaStream ? alphaStream.length : 0)
  return Buffer.concat([header, opaque, alphaLength, alphaStream ?? Buffer.alloc(0)]).toString('base64')
}

console.log(JSON.stringify({ opaque: payload(color), withAlpha: payload(color, alpha) }))
