import { Size } from '../math/Size'
import { CompositorPlatform } from '../Platform'
import { ServerRenderer } from './ServerRenderer'

export type ServerPlatformOptions = {
  /**
   * TODO should follow the size of the attached browser output
   */
  outputSize: Size
  keyboardLanguage: string
}

export function createServerPlatform(options: ServerPlatformOptions): CompositorPlatform {
  return {
    createRenderer: (session) => new ServerRenderer(session),
    createFrameDecoder: () => ({
      decode: () => Promise.reject(new Error('BUG. Frames are not decoded on the server.')),
      createH264DecoderContext: () => {
        throw new Error('BUG. Frames are not decoded on the server.')
      },
    }),
    nextFrame: () => new Promise((resolve) => setTimeout(() => resolve(Date.now()), 16)),
    viewportSize: () => options.outputSize,
    keyboardLanguage: () => options.keyboardLanguage,
    initScene: () => {
      throw new Error('BUG. There are no browser scenes on the server.')
    },
    hasTouch: false,
    userAgent: 'server',
    orientationType: 'landscape-primary',
  }
}
