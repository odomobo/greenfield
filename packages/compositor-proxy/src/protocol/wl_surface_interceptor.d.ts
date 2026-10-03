import { Encoder } from '../encoding/Encoder'
import { SurfaceEncoder } from '../encoding/SurfaceEncoder'
import { Rect } from '../encoding/region'
import { FrameFeedback } from '../FrameFeedback'
import { NativeClientSession } from '../NativeClientSession'
import type { Channel } from '../../Channel'
import type { WlClient, MessageDestination } from '../wayland-server'

export default class wl_surface_interceptor {
  destroyed: boolean
  frameFeedback?: FrameFeedback

  pendingBufferResourceId?: number
  pendingBufferDestroyListener?: () => void
  pendingFrameCallbacksIds: number[]

  surfaceState?: {
    readonly bufferResourceId: number
    readonly bufferCreationSerial: number
    readonly bufferContentSerial: number
    /** buffer size in pixels, 0 if unknown */
    readonly width: number
    readonly height: number
  }
  bufferDestroyListener?: () => void

  /** damage of the next commit, in surface (wl_surface.damage) or buffer (damage_buffer) coordinates */
  pendingDamage?: { rect: Rect; bufferCoordinates: boolean }[]
  pendingBufferScale?: number
  bufferScale?: number
  pendingBufferTransform?: number
  bufferTransform?: number

  surfaceEncoder?: SurfaceEncoder<Encoder>
  userData: {
    protocolChannel: Channel
    drmContext: unknown
    messageInterceptors: Record<number, any>
    nativeClientSession: NativeClientSession
  }
  wlClient: WlClient
  id: number

  /**
   * destroy
   */
  R0(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * attach
   */
  R1(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * damage
   */
  R2(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * frame
   */
  R3(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * set_opaque_region
   */
  R4(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * set_input_region
   */
  R5(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * commit
   */
  R6(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * enter
   */
  R7(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * leave
   */
  R8(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * set_buffer_transform
   */
  R9(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * set_buffer_scale
   */
  R10(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination

  /**
   * damage_buffer
   */
  R11(message: {
    buffer: ArrayBuffer
    fds: Array<number>
    bufferOffset: number
    consumed: number
    size: number
  }): MessageDestination
}
