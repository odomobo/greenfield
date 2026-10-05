import type { AlphaCompositor } from './alpha-video'
import type { DecodedFrame, DecodedPatch } from './decoder'
import { isWholePixelScale, Size, videoSourceRect } from './surface-geometry'
import type { Rect } from './windows'

/**
 * The content of one surface: a canvas with the app's buffer at its own size, in pixels (at a device pixel ratio of 2
 * an app rendering at the viewer's scale has twice the pixels of the surface's size in CSS pixels). The element is
 * drawn into straight away when frames and patches arrive, no state passes through React and nothing waits for a
 * render pass. Where and how big it is shown (a window's element holds it, or the cursor layer) is set by `place`.
 */
export class SurfaceView {
  readonly canvas = document.createElement('canvas')
  private readonly context: CanvasRenderingContext2D
  private contentDrawn = false

  constructor(readonly id: string) {
    this.canvas.className = 'surface'
    this.canvas.dataset.surface = id
    const context = this.canvas.getContext('2d')
    if (context === null) {
      throw new Error("This browser doesn't support canvas.")
    }
    this.context = context
  }

  get hasContent(): boolean {
    return this.contentDrawn && this.canvas.width > 0 && this.canvas.height > 0
  }

  /** The size of the app's buffer, in pixels, whatever size the surface is shown at. */
  get contentSize(): Size | undefined {
    return this.hasContent ? { width: this.canvas.width, height: this.canvas.height } : undefined
  }

  /**
   * Show a decoded video frame as the whole content. Opaque video is drawn straight from the decoder's frame (it stays
   * in GPU memory); with alpha the two streams are combined by the shared compositor. Closes the frame's VideoFrames.
   */
  drawFrame(frame: DecodedFrame, compositor: AlphaCompositor): void {
    try {
      const { size, encodedSize } = frame
      this.resize(size, false)
      const context = this.context
      context.imageSmoothingEnabled = false
      const combined = frame.alpha && compositor.combine(frame)
      if (combined) {
        try {
          context.clearRect(0, 0, size.width, size.height)
          context.drawImage(combined, 0, 0)
        } finally {
          combined.close()
        }
      } else {
        const source = videoSourceRect(size, encodedSize)
        context.drawImage(frame.opaque, source.x, source.y, source.width, source.height, 0, 0, size.width, size.height)
      }
      this.contentDrawn = true
    } finally {
      frame.opaque.close()
      frame.alpha?.close()
    }
  }

  /**
   * Draw a lossless patch into the content, replacing the pixels under it. The surface keeps showing what it had
   * elsewhere; on a size change the old content is stretched to the new size until patches replace it.
   */
  drawPatch(patch: DecodedPatch): void {
    try {
      this.resize(patch.surfaceSize, true)
      const { x, y, width, height } = patch.rect
      this.context.clearRect(x, y, width, height)
      this.context.drawImage(patch.bitmap, x, y)
      this.contentDrawn = true
    } finally {
      patch.bitmap.close()
    }
  }

  /** Give the canvas the surface's size (a canvas is cleared by that), keeping its old content stretched if asked. */
  private resize(size: Size, keepContent: boolean): void {
    const canvas = this.canvas
    if (canvas.width === size.width && canvas.height === size.height) {
      return
    }
    let old: HTMLCanvasElement | undefined
    if (keepContent && this.contentDrawn) {
      old = document.createElement('canvas')
      old.width = canvas.width
      old.height = canvas.height
      old.getContext('2d')?.drawImage(canvas, 0, 0)
    }
    canvas.width = size.width
    canvas.height = size.height
    if (old) {
      this.context.drawImage(old, 0, 0, old.width, old.height, 0, 0, size.width, size.height)
    }
  }

  /**
   * Show the surface at `shown` in its parent's coordinates (CSS pixels): the element has that size, a transform of
   * the window's element scales it when the window is stretched. `drawn` is where it ends up on screen, to tell
   * whether it's drawn without interpolation.
   */
  place(shown: Rect, drawn: Rect, pixelRatio: number): void {
    const style = this.canvas.style
    style.left = `${shown.x}px`
    style.top = `${shown.y}px`
    style.width = `${shown.width}px`
    style.height = `${shown.height}px`
    // Each image pixel covering a whole number of device pixels: show the nearest pixel, interpolating would blur e.g. text.
    style.imageRendering = isWholePixelScale(drawn, this.canvas, pixelRatio) ? 'pixelated' : 'auto'
  }

  /** Free the canvas' memory (a canvas of 0x0 holds none). */
  dispose(): void {
    this.canvas.remove()
    this.canvas.width = 0
    this.canvas.height = 0
    this.contentDrawn = false
  }
}
