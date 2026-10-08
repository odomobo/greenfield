/**
 * Parses the stream GStreamer's `rtpstreampay` writes (RFC 4571): every RTP packet is preceded by its length as a
 * 16 bit big endian number. Chunks of the stream arrive in any size; whole packets come out.
 */

export type RtpPacket = { seq: number; timestamp: number; payload: Uint8Array }

export class RtpStreamParser {
  private pending: Buffer = Buffer.alloc(0)

  /** The packets completed by this chunk. Throws on bytes that are no RTP (the stream can't be resynchronized). */
  push(chunk: Buffer): RtpPacket[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const packets: RtpPacket[] = []
    let offset = 0
    while (this.pending.length - offset >= 2) {
      const length = this.pending.readUInt16BE(offset)
      if (this.pending.length - offset - 2 < length) {
        break
      }
      packets.push(parseRtp(this.pending.subarray(offset + 2, offset + 2 + length)))
      offset += 2 + length
    }
    this.pending = this.pending.subarray(offset)
    return packets
  }
}

/** The sequence number, timestamp and payload of an RTP packet (RFC 3550 section 5.1). */
export function parseRtp(packet: Uint8Array): RtpPacket {
  if (packet.length < 12 || packet[0] >> 6 !== 2) {
    throw new Error('Not an RTP packet.')
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const csrcCount = packet[0] & 0x0f
  const extension = (packet[0] & 0x10) !== 0
  const padding = (packet[0] & 0x20) !== 0
  let start = 12 + 4 * csrcCount
  if (extension) {
    if (packet.length < start + 4) {
      throw new Error('Truncated RTP header extension.')
    }
    start += 4 + 4 * view.getUint16(start + 2)
  }
  const end = padding ? packet.length - packet[packet.length - 1] : packet.length
  if (start > end) {
    throw new Error('Truncated RTP packet.')
  }
  return { seq: view.getUint16(2), timestamp: view.getUint32(4), payload: packet.subarray(start, end) }
}
