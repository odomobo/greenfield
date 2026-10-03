import { CompositorPlatform } from '../Platform'
import { createWasmFrameDecoder } from '../remote/wasm-buffer-decoder'
import { softwareDecoderConfig, webCodecFrameDecoderFactory } from '../remote/webcodec-buffer-decoder'
import Renderer, { createRenderFrame } from '../render/Renderer'
import { GreenfieldLogger, FrameDecoderFactory } from '../Session'
import { capabilities } from './capabilities'
import { addInputOutput } from './input'

async function webVideoDecoderConfig(): Promise<VideoDecoderConfig | undefined> {
  if ('VideoDecoder' in window) {
    // FIXME hardware decoding frame offset is wrong
    // const hardwareDecoderSupport = await VideoDecoder.isConfigSupported(hardwareDecoderConfig)
    // if (hardwareDecoderSupport.supported) {
    //   return hardwareDecoderConfig
    // }

    const softwareDecoderSupport = await VideoDecoder.isConfigSupported(softwareDecoderConfig)
    if (softwareDecoderSupport) {
      return softwareDecoderConfig
    }
  }

  return undefined
}

export async function createBrowserPlatform(logger: Pick<GreenfieldLogger, 'info'>): Promise<CompositorPlatform> {
  let decoderFactory: FrameDecoderFactory
  const webCodecSupport = await webVideoDecoderConfig()
  if (webCodecSupport) {
    decoderFactory = webCodecFrameDecoderFactory(webCodecSupport)
    logger.info('Will use H.264 WebCodecs Decoder.')
  } else {
    logger.info('Will use H.264 WASM Decoder.')
    decoderFactory = createWasmFrameDecoder
  }

  return {
    createRenderer: (session) => Renderer.create(session),
    createFrameDecoder: decoderFactory,
    nextFrame: createRenderFrame,
    viewportSize: () => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }),
    keyboardLanguage: () => navigator.language,
    initScene: addInputOutput,
    hasTouch: capabilities.hasTouch,
    userAgent: capabilities.userAgent,
    orientationType: capabilities.orientationType,
  }
}
