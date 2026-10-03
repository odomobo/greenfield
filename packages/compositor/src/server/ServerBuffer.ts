import { WlBufferResource } from '@gfld/compositor-protocol'
import BufferContents from '../BufferContents'
import BufferImplementation from '../BufferImplementation'
import { Size } from '../math/Size'
import Surface from '../Surface'

/**
 * Pixel data stays native. The protocol implementation only needs to know the size of the buffer.
 */
export type NativeBufferContents = BufferContents<undefined>

/**
 * A wl_buffer whose storage (wl_shm or dmabuf) is owned by the native (libwayland) side of the proxy. Contents are
 * available immediately on commit. Encoding for the browser happens in the proxy, independent of the protocol state.
 */
export class ServerBuffer implements BufferImplementation<NativeBufferContents> {
  released = false

  constructor(
    readonly resource: WlBufferResource,
    private readonly querySize: () => Size | undefined,
  ) {}

  getContents(_surface: Surface, serial?: number): NativeBufferContents {
    this.released = false
    // TODO dmabuf sizes, querySize only knows wl_shm buffers
    const size = this.querySize() ?? { width: 0, height: 0 }
    return {
      size,
      mimeType: 'image/argb8888',
      pixelContent: undefined,
      contentSerial: serial ?? 0,
    }
  }

  release(): void {
    // wl_buffer.release is sent by the proxy once it's done with the buffer (after encoding)
    this.released = true
  }

  destroy(resource: WlBufferResource): void {
    resource.destroy()
  }
}
