/**
 * Chunking: data items larger than the chunk size go out in CHUNK envelopes (the scene protocol's chunk format), cut
 * when they're sent, never queued. It exists only because everything shares one ordered byte stream (a WebSocket over
 * TCP): without it a large item would block audio, control messages and other streams until it was all sent.
 */
import { CHUNK_HEADER_BYTES, encodeChunk } from '@gfld/scene-protocol'

// Items larger than this are sent in chunks of this size: about 10 ms of the link at the congestion controller's
// bandwidth estimate, at least CHUNK_MIN_BYTES (a slow link, or no estimate yet) and at most CHUNK_MAX_BYTES (an
// overestimate). So nothing else waits behind one data item for long, and the message (and ack) rate stays moderate.
export const CHUNK_MS = 10
export const CHUNK_MIN_BYTES = 10 * 1024
export const CHUNK_MAX_BYTES = 300 * 1024

/** The chunk size's bounds (see CHUNK_MS). */
export type ChunkBounds = { readonly min: number; readonly max: number }

export const DEFAULT_CHUNK_BOUNDS: ChunkBounds = { min: CHUNK_MIN_BYTES, max: CHUNK_MAX_BYTES }

/** The chunk size for the congestion controller's bandwidth estimate (bytes per ms; undefined while it has none). */
export function chunkSize(bandwidthEstimate: number | undefined, { min, max }: ChunkBounds): number {
  return Math.min(max, Math.max(min, Math.round((bandwidthEstimate ?? 0) * CHUNK_MS)))
}

/** The CHUNK envelope of the item's bytes from `from` (up to `size` of them), and where the next chunk starts. */
export function cutChunk(
  id: number,
  envelope: Uint8Array,
  from: number,
  size: number,
): { data: Uint8Array; end: number } {
  const end = Math.min(envelope.length, from + size)
  return { data: encodeChunk(id, envelope, from, end), end }
}

/** The item's bytes a piece on the wire carries: all of a whole envelope, a chunk's without its header. */
export function payloadBytes(data: Uint8Array, whole: boolean): number {
  return whole ? data.length : data.length - CHUNK_HEADER_BYTES
}
