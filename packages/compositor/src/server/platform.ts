import { Size } from '../math/Size'
import { CompositorPlatform } from '../Platform'
import { ServerRenderer } from './ServerRenderer'

export type ServerPlatformOptions = {
  /**
   * Initial output size, replaced by the attached viewer's output size.
   */
  outputSize: Size
  keyboardLanguage: string
}

export function createServerPlatform(
  options: Omit<ServerPlatformOptions, 'outputSize'> & { outputSize: () => Size },
): CompositorPlatform {
  return {
    createRenderer: (session) => new ServerRenderer(session),
    nextFrame: () => new Promise((resolve) => setTimeout(() => resolve(Date.now()), 16)),
    viewportSize: options.outputSize,
    keyboardLanguage: () => options.keyboardLanguage,
    hasTouch: false,
    userAgent: 'server',
    orientationType: 'landscape-primary',
  }
}
