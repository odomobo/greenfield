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

import appEndpointNative from '../addons/proxy-encoding-addon'

export type H264Encoder = 'x264' | 'nvh264' | 'vaapih264'

/**
 * A native video encoder. Not tied to a client: the encoder pool lends it to one surface at a time, and every encode
 * names the client that owns the buffer.
 */
export class Encoder {
  private readonly nativeEncoder: unknown

  private encodingQueue: {
    resolve: (frameSample: Buffer) => void
    reject: (error: Error) => void
    bufferResourceId: number
    bufferContentSerial: number
  }[] = []

  constructor(h264Encoder: H264Encoder, drmContext: unknown) {
    this.nativeEncoder = appEndpointNative.createFrameEncoder(h264Encoder, null, drmContext, (buffer: Buffer) => {
      const encodingTask = this.encodingQueue.shift()
      if (encodingTask) {
        if (buffer) {
          encodingTask.resolve(buffer)
        } else {
          const e = new Error('Buffer encoding failed.')
          console.error(`\tname: ${e.name} message: ${e.message}`)
          console.error('error object stack: ')
          console.error(e.stack ?? '')
          console.debug(`Resolve encoding ${encodingTask.bufferContentSerial} with error`)
          encodingTask.reject(e)
        }
      } else {
        console.error('BUG? No buffer callback')
      }
    })
  }

  encodeBuffer({
    wlClient,
    bufferResourceId,
    bufferCreationSerial,
    bufferContentSerial,
  }: {
    wlClient: unknown
    bufferResourceId: number
    bufferCreationSerial: number
    bufferContentSerial: number
  }): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const encodingTask = { resolve, reject, bufferResourceId, bufferContentSerial }
      this.encodingQueue.push(encodingTask)
      try {
        appEndpointNative.encodeFrame(
          this.nativeEncoder,
          bufferResourceId,
          bufferContentSerial,
          bufferCreationSerial,
          wlClient,
        )
      } catch (e) {
        // No callback will come for this frame, so it must not stay in the queue or later results get misassigned.
        this.encodingQueue.splice(this.encodingQueue.indexOf(encodingTask), 1)
        reject(e)
      }
    })
  }

  requestKeyUnit(): void {
    appEndpointNative.requestKeyUnit(this.nativeEncoder)
  }

  destroy() {
    appEndpointNative.destroyFrameEncoder(this.nativeEncoder)
  }
}
