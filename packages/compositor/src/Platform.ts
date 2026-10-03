import { Size } from './math/Size'
import type { CompositorRenderer } from './render/CompositorRenderer'
import type Session from './Session'

/**
 * Everything the protocol implementation needs from its environment. The browser implementation lives in
 * browser/platform.ts, the server implementation in server/platform.ts.
 */
export interface CompositorPlatform {
  createRenderer(session: Session): CompositorRenderer


  /**
   * Resolves on the next display frame. Used to batch input.
   */
  nextFrame(): Promise<number>

  /**
   * Area available to (maximized or constrained) windows.
   * TODO on the server this should be the output size reported by the attached viewer.
   */
  viewportSize(): Size

  /**
   * Language tag (e.g. en-US) used to pick a default keyboard layout.
   */
  keyboardLanguage(): string


  readonly hasTouch: boolean
  readonly userAgent: string
  readonly orientationType: string
}
