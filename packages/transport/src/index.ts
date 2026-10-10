/**
 * @nebula/transport: the connection to one viewer. The fair-queueing mechanism across streams (deficit round-robin
 * over the send tiers given to it, round-robin over the streams of a tier), stream readiness, chunking, and the link
 * (the WebSocket and its socket options, the simulated link, receive decoding). It doesn't look into the items it
 * sends, doesn't know why a tier has its weight, and doesn't judge the link: it exposes link stats (data held back,
 * unsent bytes per stream and tier) for traffic policy to judge. The congestion controller is passed in.
 */
export { CHUNK_MAX_BYTES, CHUNK_MIN_BYTES, CHUNK_MS } from './chunking.js'
export type { ChunkBounds } from './chunking.js'
export type { TierConfig } from './FairQueue.js'
export type { SimulatedLink, TransportLogger } from './link.js'
export { WebSocketViewerTransport } from './ViewerTransport.js'
export type { ControlMessage, OutgoingMessage, ViewerTransport } from './ViewerTransport.js'
