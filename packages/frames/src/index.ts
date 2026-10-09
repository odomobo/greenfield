/**
 * @nebula/frames: the frame library (see "Frames" in docs/MODULARIZATION.md).
 *
 * The library itself is native (native/include/nebula_frame.h), linked statically into each addon that creates frames
 * (capture: the session's wlr-core addon) or reads them (the video encoder). Frames reach TypeScript as handles with
 * the `Frame` interface of @nebula/session-contracts, created by the library's N-API helper; nothing here needs to be
 * loaded to use them.
 */
export type { Frame } from '@nebula/session-contracts'
