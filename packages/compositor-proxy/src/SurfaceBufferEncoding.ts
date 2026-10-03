// Copyright 2019 Erik De Rijcke
//
// This file is part of Greenfield.
//
// Greenfield is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Greenfield is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Greenfield.  If not, see <https://www.gnu.org/licenses/>.

import { unmarshallArgs } from './wayland-server.js'
import { Encoder, H264Encoder } from './encoding/Encoder.js'
import appEndpointNative from './addons/proxy-encoding-addon'

import { createLogger } from './Logger.js'
import wlSurfaceInterceptor from './protocol/wl_surface_interceptor.js'
import { FrameFeedback } from './FrameFeedback.js'
import { incrementAndGetNextBufferSerial, ProxyBuffer } from './ProxyBuffer.js'
import { EncoderPool } from './encoding/EncoderPool.js'
import { EncodingContext, EncodingSink, SurfaceEncoder, SurfaceHost } from './encoding/SurfaceEncoder.js'
import { encodePng } from './encoding/png.js'
import { Rect } from './encoding/region.js'
import type { Patch } from '@gfld/scene-protocol'

const logger = createLogger('surface-buffer-encoding')

/** How many surfaces can be streamed as video at once, unless configured. */
const DEFAULT_VIDEO_STREAMS = 4

const WL_OUTPUT_TRANSFORM_NORMAL = 0

/**
 * Where encoded frames and patches go. Set by the viewer host.
 */
export type FrameSink = EncodingSink

const inactiveSink: FrameSink = {
  active: false,
  sendFrame: () => {
    /* noop */
  },
  sendPatch: (_surface: string, _patch: Patch, done: (sent: boolean) => void) => done(false),
  requireKeyFrame: () => {
    /* noop */
  },
  dropPatches: () => {
    /* noop */
  },
}

let frameSink: FrameSink = inactiveSink

/** Forwards to whatever sink is set now, the encoding context keeps this one. */
const currentSink: FrameSink = {
  get active() {
    return frameSink.active
  },
  sendFrame: (surface, frame) => frameSink.sendFrame(surface, frame),
  sendPatch: (surface, patch, done) => frameSink.sendPatch(surface, patch, done),
  requireKeyFrame: (surface) => frameSink.requireKeyFrame(surface),
  dropPatches: (surface) => frameSink.dropPatches(surface),
}

export function setFrameSink(sink: FrameSink): void {
  frameSink = sink
}

let encodingContext: EncodingContext<Encoder> | undefined
let videoStreams = DEFAULT_VIDEO_STREAMS

/**
 * Set up the session's video encoder pool (warm, so the first video frame doesn't wait for an encoder) and the
 * encoding policy's clock. Called once the session's render device is known.
 */
export function configureEncoding(config: {
  h264Encoder: H264Encoder
  drmContext: unknown
  videoStreams?: number
}): void {
  if (encodingContext) {
    return
  }
  videoStreams = Math.max(0, Math.floor(config.videoStreams ?? DEFAULT_VIDEO_STREAMS))
  const pool = new EncoderPool(() => new Encoder(config.h264Encoder, config.drmContext), videoStreams)
  pool.warm()
  encodingContext = new EncodingContext(currentSink, pool, encodePng, logger)
  encodingContext.startTicking()
}

/** The size of the video encoder pool, the viewer warms as many decoders. */
export function getVideoStreams(): number {
  return videoStreams
}

/**
 * Surfaces with a buffer, by surface key ("<clientId>/<surfaceId>"), so their current content can be sent again, e.g.
 * when a viewer (re)attaches.
 */
const surfaces = new Map<string, wlSurfaceInterceptor>()

function surfaceKey(surface: wlSurfaceInterceptor): string {
  return `${surface.userData.nativeClientSession.id}/${surface.id}`
}

/**
 * Send the whole current content of a surface again (a video key frame or a full set of patches). The proxy holds on
 * to the last committed buffer until the next one replaces it, so its content is still valid.
 */
export function requestKeyFrame(key: string): void {
  const surface = surfaces.get(key)
  if (surface === undefined || surface.destroyed || !frameSink.active) {
    return
  }
  void surface.surfaceEncoder?.refresh()
}

export function requestKeyFramesForAllSurfaces(): void {
  for (const key of surfaces.keys()) {
    requestKeyFrame(key)
  }
}

function ensureFrameFeedback(wlSurfaceInterceptor: wlSurfaceInterceptor): FrameFeedback {
  const nativeClientSession = wlSurfaceInterceptor.userData.nativeClientSession
  if (nativeClientSession === undefined) {
    throw new Error('BUG. Created a wlSurfaceInterceptor without a nativeClientSession')
  }

  if (wlSurfaceInterceptor.frameFeedback === undefined) {
    const frameFeedback = new FrameFeedback(
      wlSurfaceInterceptor.wlClient,
      wlSurfaceInterceptor.userData.messageInterceptors,
    )
    wlSurfaceInterceptor.frameFeedback = frameFeedback
    nativeClientSession.destroyListeners.push(() => {
      frameFeedback.destroy()
      wlSurfaceInterceptor.surfaceEncoder?.destroy()
      surfaces.delete(surfaceKey(wlSurfaceInterceptor))
    })
  }
  return wlSurfaceInterceptor.frameFeedback
}

function ensureSurfaceEncoder(surface: wlSurfaceInterceptor): SurfaceEncoder<Encoder> | undefined {
  if (surface.surfaceEncoder === undefined && encodingContext) {
    const host: SurfaceHost<Encoder> = {
      currentBuffer: () => {
        const state = surface.surfaceState
        if (state === undefined || state.width === 0 || state.height === 0) {
          return undefined
        }
        const proxyBuffer = surface.userData.messageInterceptors[state.bufferResourceId] as ProxyBuffer | undefined
        if (proxyBuffer === undefined || proxyBuffer.destroyed) {
          return undefined
        }
        return {
          bufferId: state.bufferResourceId,
          creationSerial: state.bufferCreationSerial,
          contentSerial: state.bufferContentSerial,
          width: state.width,
          height: state.height,
        }
      },
      readPixels: (rect) => {
        const state = surface.surfaceState
        if (state === undefined) {
          return undefined
        }
        return appEndpointNative.readPixels(
          surface.wlClient,
          surface.userData.drmContext,
          state.bufferResourceId,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        )
      },
      encodeVideo: (encoder, buffer) =>
        encoder.encodeBuffer({
          wlClient: surface.wlClient,
          bufferResourceId: buffer.bufferId,
          bufferCreationSerial: buffer.creationSerial,
          bufferContentSerial: buffer.contentSerial,
        }),
    }
    surface.surfaceEncoder = new SurfaceEncoder(surfaceKey(surface), host, encodingContext)
  }
  return surface.surfaceEncoder
}

type WireMessage = {
  buffer: ArrayBuffer
  fds: Array<number>
  bufferOffset: number
  consumed: number
  size: number
}

function readRect(message: WireMessage): Rect {
  const [x, y, width, height] = unmarshallArgs(message, 'iiii') as number[]
  return { x, y, width, height }
}

/**
 * The commit's damage in buffer coordinates. Everything is damaged when there was no buffer before, its size changed,
 * or the buffer scale or transform changed (or a transform is set, those aren't mapped).
 */
function commitDamage(
  surface: wlSurfaceInterceptor,
  previousSize: { width: number; height: number } | undefined,
  size: { width: number; height: number },
  scaleOrTransformChanged: boolean,
): Rect[] {
  const damage = surface.pendingDamage ?? []
  const full = [{ x: 0, y: 0, width: size.width, height: size.height }]
  if (
    previousSize === undefined ||
    previousSize.width !== size.width ||
    previousSize.height !== size.height ||
    scaleOrTransformChanged ||
    (surface.bufferTransform ?? WL_OUTPUT_TRANSFORM_NORMAL) !== WL_OUTPUT_TRANSFORM_NORMAL
  ) {
    return full
  }
  const scale = surface.bufferScale ?? 1
  return damage.map(({ rect, bufferCoordinates }) => {
    if (bufferCoordinates || scale === 1) {
      return rect
    }
    return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale }
  })
}

export function initSurfaceBufferEncoding(): void {
  /**
   * destroy: [R]equest w opcode [0] = R0
   */
  wlSurfaceInterceptor.prototype.R0 = function (_message: WireMessage) {
    surfaces.delete(surfaceKey(this))
    this.surfaceEncoder?.destroy()
    this.surfaceEncoder = undefined
    if (this.frameFeedback) {
      if (this.surfaceState) {
        this.frameFeedback.sendBufferReleaseEvent(this.surfaceState.bufferResourceId)
        this.surfaceState = undefined
      }
      this.frameFeedback.destroy()
      this.frameFeedback = undefined
    }
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * attach: [R]equest w opcode [1] = R1
   */
  wlSurfaceInterceptor.prototype.R1 = function (message: WireMessage) {
    if (this.pendingBufferDestroyListener === undefined) {
      this.pendingBufferDestroyListener = () => (this.pendingBufferResourceId = undefined)
    }

    if (this.pendingBufferResourceId) {
      const proxyBuffer = this.userData.messageInterceptors[this.pendingBufferResourceId] as ProxyBuffer
      proxyBuffer.destroyListeners = proxyBuffer.destroyListeners.filter(
        (listener) => listener !== this.pendingBufferDestroyListener,
      )
    }

    const [bufferResourceId] = unmarshallArgs(message, 'oii')
    this.pendingBufferResourceId = bufferResourceId as number

    if (this.pendingBufferResourceId) {
      let proxyBuffer = this.userData.messageInterceptors[this.pendingBufferResourceId]
      if (proxyBuffer === undefined) {
        proxyBuffer = new ProxyBuffer(this.userData.messageInterceptors, this.pendingBufferResourceId)
        this.userData.messageInterceptors[this.pendingBufferResourceId] = proxyBuffer
      }

      proxyBuffer.destroyListeners.push(this.pendingBufferDestroyListener)
    }

    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * damage: [R]equest w opcode [2] = R2 (surface coordinates)
   */
  wlSurfaceInterceptor.prototype.R2 = function (message: WireMessage) {
    const rect = readRect(message)
    ;(this.pendingDamage ??= []).push({ rect, bufferCoordinates: false })
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * frame: [R]equest w opcode [3] = R3
   */
  wlSurfaceInterceptor.prototype.R3 = function (message: WireMessage) {
    const [frameCallbackId] = unmarshallArgs(message, 'n')
    if (this.pendingFrameCallbacksIds) {
      this.pendingFrameCallbacksIds.push(frameCallbackId as number)
    } else {
      this.pendingFrameCallbacksIds = [frameCallbackId as number]
    }
    // @ts-ignore
    this.requestHandlers.frame(frameCallbackId)
    return {
      native: false,
      browser: false,
      neverReplies: true,
    }
  }

  /**
   * set_opaque_region: [R]equest w opcode [4] = R4
   */
  wlSurfaceInterceptor.prototype.R4 = function (_message: WireMessage) {
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * set_input_region: [R]equest w opcode [5] = R5
   */
  wlSurfaceInterceptor.prototype.R5 = function (_message: WireMessage) {
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * commit: [R]equest with opcode [6] = R6
   */
  wlSurfaceInterceptor.prototype.R6 = function (message: WireMessage) {
    if (this.bufferDestroyListener === undefined) {
      this.bufferDestroyListener = () => {
        this.surfaceState = undefined
      }
    }

    const frameFeedback = ensureFrameFeedback(this)
    const key = surfaceKey(this)
    const commitTimestamp = performance.now()

    const bufferContentSerial = incrementAndGetNextBufferSerial()
    const msg = new Uint32Array([7, new Uint32Array(message.buffer)[0], bufferContentSerial])
    this.userData.protocolChannel.send(Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength))

    // double buffered state: scale and transform apply with this commit
    let scaleOrTransformChanged = false
    if (this.pendingBufferScale !== undefined && this.pendingBufferScale !== (this.bufferScale ?? 1)) {
      this.bufferScale = this.pendingBufferScale
      scaleOrTransformChanged = true
    }
    if (
      this.pendingBufferTransform !== undefined &&
      this.pendingBufferTransform !== (this.bufferTransform ?? WL_OUTPUT_TRANSFORM_NORMAL)
    ) {
      this.bufferTransform = this.pendingBufferTransform
      scaleOrTransformChanged = true
    }
    this.pendingBufferScale = undefined
    this.pendingBufferTransform = undefined

    if (this.pendingBufferResourceId !== undefined) {
      const previousState = this.surfaceState
      const previousSize = previousState?.width
        ? { width: previousState.width, height: previousState.height }
        : undefined
      if (previousState && previousState.bufferResourceId !== this.pendingBufferResourceId) {
        const previousProxyBuffer = this.userData.messageInterceptors[previousState.bufferResourceId] as ProxyBuffer
        // Patches copy their pixels right away, only video encodings in flight still read the previous buffer.
        const idle = this.surfaceEncoder?.whenIdle() ?? Promise.resolve()
        idle.then(() => {
          if (!previousProxyBuffer.destroyed) {
            frameFeedback.sendBufferReleaseEvent(previousProxyBuffer.bufferId)
          }
        })
        previousProxyBuffer.destroyListeners = previousProxyBuffer.destroyListeners.filter(
          (listener) => listener !== this.bufferDestroyListener,
        )
      }
      this.surfaceState = undefined

      if (this.pendingBufferResourceId) {
        const proxyBuffer = this.userData.messageInterceptors[this.pendingBufferResourceId] as ProxyBuffer

        proxyBuffer.destroyListeners = proxyBuffer.destroyListeners.filter(
          (listener) => listener !== this.pendingBufferDestroyListener,
        )
        proxyBuffer.destroyListeners.push(this.bufferDestroyListener)

        const frameCallbacksIds = this.pendingFrameCallbacksIds ?? []
        this.pendingFrameCallbacksIds = []
        surfaces.set(key, this)
        const [width, height] = appEndpointNative.bufferSize(this.wlClient, this.pendingBufferResourceId) ?? [0, 0]
        this.surfaceState = {
          bufferResourceId: this.pendingBufferResourceId,
          bufferCreationSerial: proxyBuffer.creationSerial,
          bufferContentSerial,
          width,
          height,
        }
        const damage = commitDamage(this, previousSize, { width, height }, scaleOrTransformChanged)
        this.pendingDamage = []
        const surfaceEncoder = ensureSurfaceEncoder(this)
        const encoding = surfaceEncoder?.commit(damage) ?? Promise.resolve()
        encoding.then(() => frameFeedback.encodingDone(commitTimestamp))
        this.pendingBufferResourceId = undefined
        frameFeedback.commitNotify(frameCallbacksIds)
      } else {
        // null buffer: the surface is unmapped
        this.pendingDamage = []
        this.surfaceEncoder?.bufferDetached()
      }
    } else if (this.surfaceState) {
      // no new buffer, so no new content
      this.pendingDamage = []
      const frameCallbacksIds = this.pendingFrameCallbacksIds ?? []
      this.pendingFrameCallbacksIds = []
      frameFeedback.commitNotify(frameCallbacksIds)
    }

    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * enter
   */
  wlSurfaceInterceptor.prototype.R7 = function (_message: WireMessage) {
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * leave
   */
  wlSurfaceInterceptor.prototype.R8 = function (_message: WireMessage) {
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * set_buffer_transform
   */
  wlSurfaceInterceptor.prototype.R9 = function (message: WireMessage) {
    const [transform] = unmarshallArgs(message, 'i') as number[]
    this.pendingBufferTransform = transform
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * set_buffer_scale
   */
  wlSurfaceInterceptor.prototype.R10 = function (message: WireMessage) {
    const [scale] = unmarshallArgs(message, 'i') as number[]
    this.pendingBufferScale = scale
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }

  /**
   * damage_buffer (buffer coordinates)
   */
  wlSurfaceInterceptor.prototype.R11 = function (message: WireMessage) {
    const rect = readRect(message)
    ;(this.pendingDamage ??= []).push({ rect, bufferCoordinates: true })
    return {
      native: false,
      browser: true,
      neverReplies: true,
    }
  }
}
