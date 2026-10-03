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
    createFrameDecoder: () => ({
      decode: () => Promise.reject(new Error('BUG. Frames are not decoded on the server.')),
      createH264DecoderContext: () => {
        throw new Error('BUG. Frames are not decoded on the server.')
      },
    }),
    nextFrame: () => new Promise((resolve) => setTimeout(() => resolve(Date.now()), 16)),
    viewportSize: options.outputSize,
    keyboardLanguage: () => options.keyboardLanguage,
    initScene: () => {
      throw new Error('BUG. There are no browser scenes on the server.')
    },
    hasTouch: false,
    userAgent: 'server',
    orientationType: 'landscape-primary',
  }
}
