import { DecodedFrame, DecodedPatch } from '../decoder'

const VERTEX_SHADER = `
  precision mediump float;
  // unit quad corner (0..1)
  attribute vec2 a_corner;
  // destination rectangle in clip space: x0, y0, x1, y1
  uniform vec4 u_dest;
  // source rectangle in texture space: u0, v0, u1, v1
  uniform vec4 u_src;
  varying vec2 v_texCoord;
  void main() {
    v_texCoord = mix(u_src.xy, u_src.zw, a_corner);
    gl_Position = vec4(mix(u_dest.xy, u_dest.zw, a_corner), 0.0, 1.0);
  }
`

const FRAGMENT_RGBA = `
  precision mediump float;
  uniform sampler2D u_texture;
  uniform float u_opacity;
  varying vec2 v_texCoord;
  void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
  }
`

// BT.601 limited range, like the encoder
const FRAGMENT_YUVA = `
  precision mediump float;
  uniform sampler2D u_y;
  uniform sampler2D u_u;
  uniform sampler2D u_v;
  uniform sampler2D u_alpha;
  uniform bool u_hasAlpha;
  uniform float u_opacity;
  varying vec2 v_texCoord;
  const vec3 offset = vec3(-0.0625, -0.5, -0.5);
  const vec3 rcoeff = vec3(1.164, 0.000, 1.596);
  const vec3 gcoeff = vec3(1.164,-0.391,-0.813);
  const vec3 bcoeff = vec3(1.164, 2.018, 0.000);
  void main() {
    vec3 yuv = vec3(
      texture2D(u_y, v_texCoord).r,
      texture2D(u_u, v_texCoord).r,
      texture2D(u_v, v_texCoord).r
    ) + offset;
    vec3 rgb = vec3(dot(yuv, rcoeff), dot(yuv, gcoeff), dot(yuv, bcoeff));
    float alpha = 1.0;
    if (u_hasAlpha) {
      alpha = clamp((texture2D(u_alpha, v_texCoord).r + offset.x) * 1.164, 0.0, 1.0);
    }
    gl_FragColor = vec4(rgb, alpha * u_opacity);
  }
`

type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null>; corner: number }

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compilation failed: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

function link(gl: WebGLRenderingContext, fragmentSource: string, uniformNames: string[]): Program {
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  for (const name of ['u_dest', 'u_src', ...uniformNames]) {
    uniforms[name] = gl.getUniformLocation(program, name)
  }
  return { program, uniforms, corner: gl.getAttribLocation(program, 'a_corner') }
}

function createTexture(gl: WebGLRenderingContext): WebGLTexture {
  const texture = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

/**
 * GPU side content of one surface: either I420(+alpha) planes or an RGBA bitmap.
 */
type SurfaceTexture =
  | {
      kind: 'yuv'
      y: WebGLTexture
      u: WebGLTexture
      v: WebGLTexture
      alpha: WebGLTexture
      hasAlpha: boolean
      /** texture coordinates of the real image inside the padded coded frame */
      src: [number, number, number, number]
      /** size of the real image */
      width: number
      height: number
    }
  | { kind: 'rgba'; texture: WebGLTexture; width: number; height: number }

export type Rect = { x: number; y: number; width: number; height: number }

/**
 * Draws in output (CSS pixel) coordinates into a drawing buffer at the device pixel ratio, so content stays sharp on
 * HiDPI screens and when zoomed.
 */
export class Renderer {
  private readonly gl: WebGLRenderingContext
  private readonly rgbaProgram: Program
  private readonly yuvaProgram: Program
  private readonly quad: WebGLBuffer
  private readonly textures = new Map<string, SurfaceTexture>()
  /** size of what's drawn into, in output coordinates */
  private width = 1
  private height = 1
  /** drawing buffer pixels per output pixel */
  private pixelRatio = 1
  private clearColor: [number, number, number] = [0.059, 0.09, 0.165]

  constructor(
    readonly canvas: HTMLCanvasElement,
    options: { preserveDrawingBuffer?: boolean } = {},
  ) {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      alpha: false,
      premultipliedAlpha: false,
      // only for tests that read pixels back
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      // low latency mode leaves the canvas blank in Chrome on Windows with GPU acceleration
      desynchronized: false,
    })
    if (gl === null) {
      throw new Error("This browser doesn't support WebGL.")
    }
    this.gl = gl
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    this.rgbaProgram = link(gl, FRAGMENT_RGBA, ['u_texture', 'u_opacity'])
    this.yuvaProgram = link(gl, FRAGMENT_YUVA, ['u_y', 'u_u', 'u_v', 'u_alpha', 'u_hasAlpha', 'u_opacity'])
    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  }

  /**
   * Luminance (0-255) of an output region, top to bottom, one value per output pixel (sampled at its center). For
   * tests.
   */
  readLuma(x: number, y: number, width: number, height: number): number[] {
    const gl = this.gl
    const ratio = this.pixelRatio
    const bufferX = Math.floor(x * ratio)
    const bufferY = Math.floor(y * ratio)
    const bufferWidth = Math.max(1, Math.ceil((x + width) * ratio) - bufferX)
    const bufferHeight = Math.max(1, Math.ceil((y + height) * ratio) - bufferY)
    const pixels = new Uint8Array(bufferWidth * bufferHeight * 4)
    // GL rows start at the bottom
    gl.readPixels(
      bufferX,
      this.canvas.height - bufferY - bufferHeight,
      bufferWidth,
      bufferHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    )
    const luma: number[] = []
    for (let row = 0; row < height; row++) {
      const bufferRow = Math.min(bufferHeight - 1, Math.floor((y + row + 0.5) * ratio) - bufferY)
      for (let column = 0; column < width; column++) {
        const bufferColumn = Math.min(bufferWidth - 1, Math.floor((x + column + 0.5) * ratio) - bufferX)
        const i = ((bufferHeight - 1 - bufferRow) * bufferWidth + bufferColumn) * 4
        luma.push(Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]))
      }
    }
    return luma
  }

  /** The desktop background, a CSS rgb()/rgba() color as getComputedStyle reports it. */
  setClearColor(cssColor: string): void {
    const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(cssColor)
    if (match) {
      this.clearColor = [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255]
    }
  }

  hasContent(surface: string): boolean {
    return this.textures.has(surface)
  }

  /**
   * Upload a decoded frame as the new content of a surface.
   */
  upload(surface: string, frame: DecodedFrame): void {
    const gl = this.gl
    let texture = this.textures.get(surface)
    if (texture?.kind !== 'yuv') {
      this.delete(surface)
      texture = {
        kind: 'yuv',
        y: createTexture(gl),
        u: createTexture(gl),
        v: createTexture(gl),
        alpha: createTexture(gl),
        hasAlpha: false,
        src: [0, 0, 1, 1],
        width: 0,
        height: 0,
      }
      this.textures.set(surface, texture)
    }
    const { opaque, alpha } = frame
    const uploadPlane = (target: WebGLTexture, width: number, height: number, data: Uint8Array) => {
      gl.bindTexture(gl.TEXTURE_2D, target)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data)
    }
    uploadPlane(texture.y, opaque.codedWidth, opaque.codedHeight, opaque.y)
    uploadPlane(texture.u, opaque.codedWidth >> 1, opaque.codedHeight >> 1, opaque.u)
    uploadPlane(texture.v, opaque.codedWidth >> 1, opaque.codedHeight >> 1, opaque.v)
    texture.hasAlpha = alpha !== undefined
    if (alpha) {
      uploadPlane(texture.alpha, alpha.codedWidth, alpha.codedHeight, alpha.y)
    }
    // The encoder pads the image to its encoded size at the top left, the image is in the bottom right corner.
    const { width, height } = frame.size
    texture.width = width
    texture.height = height
    const { width: encodedWidth, height: encodedHeight } = frame.encodedSize
    texture.src = [
      (encodedWidth - width) / opaque.codedWidth,
      (encodedHeight - height) / opaque.codedHeight,
      encodedWidth / opaque.codedWidth,
      encodedHeight / opaque.codedHeight,
    ]
  }

  /**
   * Draw a lossless patch into a surface's content. The surface keeps showing what it had elsewhere: a video frame is
   * converted to an RGBA image first, and on a size change the old content is stretched to the new size until patches
   * replace it.
   */
  patch(surface: string, patch: DecodedPatch): void {
    const gl = this.gl
    const { width, height } = patch.surfaceSize
    let texture = this.textures.get(surface)
    if (texture?.kind !== 'rgba' || texture.width !== width || texture.height !== height) {
      const next = createTexture(gl)
      gl.bindTexture(gl.TEXTURE_2D, next)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      if (texture) {
        this.drawInto(next, width, height, surface)
      }
      this.delete(surface)
      texture = { kind: 'rgba', texture: next, width, height }
      this.textures.set(surface, texture)
    }
    gl.bindTexture(gl.TEXTURE_2D, texture.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, patch.rect.x, patch.rect.y, gl.RGBA, gl.UNSIGNED_BYTE, patch.bitmap)
    patch.bitmap.close()
  }

  /** Render a surface's current content, stretched, into a texture of the given size (exact copy, no blending). */
  private drawInto(target: WebGLTexture, width: number, height: number, surface: string) {
    const gl = this.gl
    const framebuffer = gl.createFramebuffer()
    if (framebuffer === null) {
      return
    }
    const screen = { width: this.width, height: this.height, pixelRatio: this.pixelRatio }
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        return
      }
      this.width = width
      this.height = height
      this.pixelRatio = 1
      gl.viewport(0, 0, width, height)
      gl.disable(gl.BLEND)
      // drawSurface maps y down from the top, which would land upside down in a texture: flip with a negative height
      this.drawSurface(surface, { x: 0, y: height, width, height: -height })
    } finally {
      this.width = screen.width
      this.height = screen.height
      this.pixelRatio = screen.pixelRatio
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(framebuffer)
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.enable(gl.BLEND)
    }
  }

  delete(surface: string): void {
    const texture = this.textures.get(surface)
    if (texture === undefined) {
      return
    }
    const gl = this.gl
    if (texture.kind === 'rgba') {
      gl.deleteTexture(texture.texture)
    } else {
      gl.deleteTexture(texture.y)
      gl.deleteTexture(texture.u)
      gl.deleteTexture(texture.v)
      gl.deleteTexture(texture.alpha)
    }
    this.textures.delete(surface)
  }

  clearAll(): void {
    for (const surface of [...this.textures.keys()]) {
      this.delete(surface)
    }
  }

  /**
   * Match the drawing buffer to the canvas' displayed size at the device pixel ratio. Returns the output size (CSS
   * pixels) and the pixel ratio.
   */
  resize(): { width: number; height: number; scale: number } {
    const scale = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(this.canvas.clientWidth))
    const height = Math.max(1, Math.round(this.canvas.clientHeight))
    const bufferWidth = Math.max(1, Math.round(width * scale))
    const bufferHeight = Math.max(1, Math.round(height * scale))
    if (this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight) {
      this.canvas.width = bufferWidth
      this.canvas.height = bufferHeight
    }
    this.width = width
    this.height = height
    this.pixelRatio = scale
    return { width, height, scale }
  }

  beginFrame(): void {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(...this.clearColor, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  /**
   * Draw surfaces into an offscreen image of the given size (rects relative to it), e.g. a window preview. Doesn't touch
   * what's on screen.
   */
  snapshot(draws: { surface: string; rect: Rect }[], width: number, height: number): ImageData | undefined {
    const gl = this.gl
    const texture = gl.createTexture()
    const framebuffer = gl.createFramebuffer()
    if (texture === null || framebuffer === null) {
      return undefined
    }
    const screen = { width: this.width, height: this.height, pixelRatio: this.pixelRatio }
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        return undefined
      }
      this.width = width
      this.height = height
      this.pixelRatio = 1
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      for (const { surface, rect } of draws) {
        this.drawSurface(surface, rect)
      }
      const pixels = new Uint8ClampedArray(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      // GL rows start at the bottom, and drawSurface maps y down from the top: the image is upside down
      const image = new ImageData(width, height)
      const rowBytes = width * 4
      for (let row = 0; row < height; row++) {
        image.data.set(pixels.subarray((height - 1 - row) * rowBytes, (height - row) * rowBytes), row * rowBytes)
      }
      return image
    } finally {
      this.width = screen.width
      this.height = screen.height
      this.pixelRatio = screen.pixelRatio
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    }
  }

  /**
   * Draw a surface's content into a rectangle (output coordinates). Returns false if there is no content yet.
   */
  drawSurface(surface: string, dest: Rect, opacity = 1): boolean {
    const texture = this.textures.get(surface)
    if (texture === undefined) {
      return false
    }
    const gl = this.gl
    const program = texture.kind === 'rgba' ? this.rgbaProgram : this.yuvaProgram
    gl.useProgram(program.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(program.corner)
    gl.vertexAttribPointer(program.corner, 2, gl.FLOAT, false, 0, 0)

    const x0 = (dest.x / this.width) * 2 - 1
    const x1 = ((dest.x + dest.width) / this.width) * 2 - 1
    const y0 = 1 - (dest.y / this.height) * 2
    const y1 = 1 - ((dest.y + dest.height) / this.height) * 2
    gl.uniform4f(program.uniforms.u_dest, x0, y0, x1, y1)

    // Each image pixel covering a whole number of drawing buffer pixels (e.g. an unstretched window at a pixel ratio of
    // 2): sample the nearest pixel, interpolating would blur e.g. text. Chroma planes are half size, always interpolated.
    const filter = this.isWholePixelScale(dest, texture.width, texture.height) ? gl.NEAREST : gl.LINEAR
    if (texture.kind === 'rgba') {
      gl.uniform4f(program.uniforms.u_src, 0, 0, 1, 1)
      gl.uniform1f(program.uniforms.u_opacity, opacity)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture.texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
      gl.uniform1i(program.uniforms.u_texture, 0)
    } else {
      gl.uniform4f(program.uniforms.u_src, ...texture.src)
      const planes = [texture.y, texture.u, texture.v, texture.alpha]
      const names = ['u_y', 'u_u', 'u_v', 'u_alpha']
      planes.forEach((plane, i) => {
        gl.activeTexture(gl.TEXTURE0 + i)
        gl.bindTexture(gl.TEXTURE_2D, plane)
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MAG_FILTER,
          plane === texture.u || plane === texture.v ? gl.LINEAR : filter,
        )
        gl.uniform1i(program.uniforms[names[i]], i)
      })
      gl.uniform1i(program.uniforms.u_hasAlpha, texture.hasAlpha ? 1 : 0)
      gl.uniform1f(program.uniforms.u_opacity, opacity)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  /** Whether an image drawn into dest maps each of its pixels onto a whole number of drawing buffer pixels. */
  private isWholePixelScale(dest: Rect, imageWidth: number, imageHeight: number): boolean {
    if (imageWidth <= 0 || imageHeight <= 0) {
      return false
    }
    const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6
    const scaleX = (Math.abs(dest.width) * this.pixelRatio) / imageWidth
    const scaleY = (Math.abs(dest.height) * this.pixelRatio) / imageHeight
    return (
      scaleX >= 1 &&
      scaleY >= 1 &&
      isWhole(scaleX) &&
      isWhole(scaleY) &&
      isWhole(dest.x * this.pixelRatio) &&
      isWhole(dest.y * this.pixelRatio)
    )
  }
}
