import type { DecodedFrame } from './decoder'
import { videoSourceRect } from './surface-geometry'

const VERTEX_SHADER = `
  attribute vec2 a_corner; // unit quad corner (0..1), y up
  // source rectangle in texture space: u0, v0, u1, v1 (v0 is the top row of the image)
  uniform vec4 u_src;
  varying vec2 v_texCoord;
  void main() {
    v_texCoord = vec2(mix(u_src.x, u_src.z, a_corner.x), mix(u_src.w, u_src.y, a_corner.y));
    gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0);
  }
`

// The browser converts both frames to RGB (the alpha stream's frame is gray: its luma is the alpha channel, in the
// same limited range as everything the encoder writes, which the conversion expands). The canvas wants premultiplied
// colors, the encoder's are not.
const FRAGMENT_SHADER = `
  precision mediump float;
  uniform sampler2D u_color;
  uniform sampler2D u_alpha;
  varying vec2 v_texCoord;
  void main() {
    float alpha = clamp(texture2D(u_alpha, v_texCoord).r, 0.0, 1.0);
    gl_FragColor = vec4(texture2D(u_color, v_texCoord).rgb * alpha, alpha);
  }
`

type Gpu = {
  gl: WebGLRenderingContext
  color: WebGLTexture
  alpha: WebGLTexture
  src: WebGLUniformLocation | null
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compilation failed: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

function createTexture(gl: WebGLRenderingContext): WebGLTexture {
  const texture = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, texture)
  // the output has the size of the image: every pixel samples exactly one texel
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

/**
 * Combines the color and alpha streams of a video frame with alpha into one image. The only WebGL context of the page,
 * shared by all windows (browsers allow few contexts per page, so never one per window): each frame is drawn into
 * it and handed over as an ImageBitmap, which the window's own 2D canvas draws.
 */
export class AlphaCompositor {
  private canvas = new OffscreenCanvas(1, 1)
  private gpu?: Gpu
  private unavailable = false

  /**
   * The frame's image (real size, premultiplied alpha). The caller closes it, and the frame's VideoFrames. Undefined if
   * WebGL isn't available: the caller shows the color stream without its alpha then.
   */
  combine(frame: DecodedFrame): ImageBitmap | undefined {
    const gpu = this.setup()
    if (gpu === undefined || frame.alpha === undefined) {
      return undefined
    }
    const { gl } = gpu
    const { width, height } = frame.size
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    const upload = (texture: WebGLTexture, unit: number, video: VideoFrame) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    }
    upload(gpu.color, 0, frame.opaque)
    upload(gpu.alpha, 1, frame.alpha)
    // texture coordinates of the image inside the padded frame
    const visible = frame.opaque.visibleRect
    const frameWidth = visible?.width ?? frame.opaque.codedWidth
    const frameHeight = visible?.height ?? frame.opaque.codedHeight
    const source = videoSourceRect(frame.size, frame.encodedSize)
    gl.uniform4f(
      gpu.src,
      source.x / frameWidth,
      source.y / frameHeight,
      (source.x + source.width) / frameWidth,
      (source.y + source.height) / frameHeight,
    )
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return this.canvas.transferToImageBitmap()
  }

  private setup(): Gpu | undefined {
    if (this.gpu?.gl.isContextLost()) {
      // (the GPU process crashed, say) start over with a new canvas
      this.gpu = undefined
      this.canvas = new OffscreenCanvas(1, 1)
    }
    if (this.gpu !== undefined || this.unavailable) {
      return this.gpu
    }
    try {
      const gl = this.canvas.getContext('webgl', {
        antialias: false,
        depth: false,
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
      })
      if (gl === null) {
        throw new Error("This browser doesn't support WebGL.")
      }
      const program = gl.createProgram()!
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
      }
      gl.useProgram(program)
      const quad = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
      const corner = gl.getAttribLocation(program, 'a_corner')
      gl.enableVertexAttribArray(corner)
      gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
      gl.uniform1i(gl.getUniformLocation(program, 'u_color'), 0)
      gl.uniform1i(gl.getUniformLocation(program, 'u_alpha'), 1)
      gl.disable(gl.BLEND)
      this.gpu = {
        gl,
        color: createTexture(gl),
        alpha: createTexture(gl),
        src: gl.getUniformLocation(program, 'u_src'),
      }
    } catch (e) {
      console.warn('Windows with transparency are shown without it:', e)
      this.unavailable = true
    }
    return this.gpu
  }
}
