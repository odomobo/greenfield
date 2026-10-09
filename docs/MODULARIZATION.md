# Modularization of the session's streaming stack

The design behind the coming refactoring: what each component of the session's streaming stack is responsible for,
where the boundaries are and how they're enforced, and how the send queue works. Decided points and open questions are
kept apart; the step-by-step plan is drawn from this document once the open questions are settled.

The browser viewer gets the same treatment later, not as part of this work.

## Goal

Separation of concerns. Each component has one job behind a clean interface, so its implementation can change without
the components that use it noticing:

- **QoS** analyzes the data stream and estimates the link (its speed, whether it's short). Others use what it
  concludes; how it reaches its conclusions is its own business.
- **Rendering** turns a surface's content into items to send (patches or video frames). How something is encoded is
  orthogonal to how it's consumed.
- **Everything between rendering and the viewer passes items through** without caring what they are. Only the
  receiving end in the viewer needs to understand them.
- **The protocol** is a cross-cutting concern, kept as small as reasonable and isolated in one place, so it is easy to
  reason about.

## Components

| Component | Responsible for | Must not know about |
|---|---|---|
| **Protocol** (`@gfld/scene-protocol`, exists) | Message schema, envelope and chunk formats; the one place both ends agree on | Tiers, classes, sockets, scheduling |
| **Capture** (the compositor) | Surfaces, their buffers and damage | How content is encoded or sent |
| **Rendering** (per surface; today the per-surface part of `SurfaceEncoder`) | What to send next and in what order; its own internal queue of work (see below); the video stream's state | The link, other surfaces |
| **Patch codec** (today `patch-encoder`, `png`, the worker pools) | Pixels in, bytes out | Which surface, patch order, priority |
| **Scheduler** (today `PatchPump` and `FramePacing`) | Which surface's work runs next; when an app gets its frame callback | Why a surface has its priority |
| **QoS** | Analyzing the stream, estimating the link | Pixels, encoders |
| **Transport** | Fair queueing across streams, chunking, the socket | What an item contains (patch, key frame, delta) |

Patch codec and patch order are separate concerns: the codec only encodes the pixels it's given; which region is
captured when, and in what order, is rendering's.

## What's wrong today

Found while reviewing the code (2026-10-09):

- QoS is spread over five places: surface classes and `RelentlessMeter` (`encoding/policy.ts`), `BandwidthMonitor`
  (`viewer/bandwidth.ts`, which imports `BURST_MS` back from encoding), burst promotion (`EncodingContext`), the tier
  weights (inside `ViewerTransport`), frame-rate limits (`FramePacing.ts`).
- `EncodingSink` is both the output channel (`sendPatch`, `sendFrame`, drops) and a QoS signal feed
  (`bandwidthLimited`, `linkBandwidth`, `queuedBytes`); `SurfaceEncoder` decides lossiness itself from link state.
- `SurfaceEncoder.ts` holds three layers: per-surface state, the session-wide scheduler (`PatchPump`) and
  session-wide policy (`EncodingContext`).
- `ViewerTransport.ts` holds wire framing and chunking, the send scheduler, congestion pacing, socket tuning, the
  simulated link and receive decoding. It also inspects content (`isKeyFrame`), knows that a key frame supersedes
  queued items, and gates undecodable deltas: rendering concerns living in the transport.
- `FramePacing.ts` keeps its state in module globals, driven from `ViewerHost`.
- `WlrCompositor` also wires the whole encoding stack together.
- The transport's invalidation logic is left over from before per-surface slots existed (see "The send queue").

## The send queue

### Nothing in the queue is ever invalidated

The transport queue is short, so nothing queued ever needs replacing, dropping or revising. In steady streaming there
are no drops. Every case where the code drops or invalidates queued items today is a lifecycle edge, and none needs
the queue to change:

| Case | Today | In this design |
|---|---|---|
| Viewer disconnects | The transport drops everything (`dropAll`) | The transport is gone; a new viewer starts over from a key frame. This is the only time an item is reported unsent |
| The viewer's video decoder fails (`keyframe` message) | The transport purges the surface's queue and refuses deltas until a key frame | Rendering makes its next frame a key frame; the viewer discards the deltas it can't decode (one or two at most) |
| Surface destroyed | `forgetSurface` drops its queued items | Nothing: the viewer ignores items of surfaces it has forgotten |
| Video starts, or the whole surface is sent again (`refresh`) | `dropPatches` | Nothing: the few queued patches go out first and the newer content paints over them |
| Buffer detached | `dropPatches` | Nothing |
| Video stops while a frame is encoding | Rendering discards the result before queueing it (epoch) | Unchanged: that's rendering's own work, not the queue |

So `dropPatches`, the key-frame purge, the decodability gate (`needsKeyFrame`, `keyFrameSent`) and
`MAX_UNSENT_FRAMES_PER_SURFACE` (which can't trigger since slots exist) go away. The queue's only failure report is
"the transport closed".

### Rendering's own queue is where invalidation lives

Rendering keeps a queue of work still to be rendered (today `SurfaceEncoder.queued`). That queue may be revised:

- A new request for a region that's already queued doesn't duplicate the work: it merges into the queued region.
- A queued region reads its pixels only when it's captured, so it always sends the latest content.

This already exists today and stays.

### The transport says when a stream is ready

The fixed per-surface slot count goes away. Instead, the transport tells each stream when it may enqueue its next
item: **when at most one chunk of that stream's data remains unsent** (counted in bytes). The transport does the
chunking, so it knows how much of each stream is left.

- A large item (a key frame) isn't followed by another until it's nearly sent, so the next item is rendered from
  fresher content.
- Small items (patches) can be enqueued until about one chunk's worth is waiting.
- It's the same idea as `TCP_NOTSENT_LOWAT`, which the transport already sets on the socket, one level up.
- Frame callbacks follow it: an app's frame callback waits for its stream to be ready, so the app draws at the rate its
  output leaves.

The interface is simple, e.g. "ready?" plus a callback when the stream becomes ready, and enqueue. No reservations are
needed: each stream has a single producer (its surface's rendering), and rendering runs one encode at a time per
surface, started only when the stream is ready, so nothing else can use that readiness before the encode finishes.

One chunk of lead time is enough: a chunk is about 10 ms of the link (longer in wall time when streams share it), and
producing the next item is faster than that. Hardware H.264 at 1440p takes roughly 5–8 ms including the GL upload and
color conversion (typical figures, not measured here: no GPU on the development machine); patches are at most 64K
pixels each.

### Producing items

- **Video** is only used with a hardware encoder. A frame is produced nearly on demand: when the stream is ready,
  there is something to render, and at most 30 frames per second.
- **One encode at a time per surface**, for patches and video alike. Parallel encoding within one surface isn't
  needed; different surfaces still encode in parallel.

### Chunking

Chunking belongs to the transport's lowest layer. It exists only because everything shares one ordered byte stream (a
WebSocket over TCP): without it a large item would block audio, control messages and other surfaces until it was all
sent. Over WebTransport, with a stream per surface, it would disappear.

- The queue holds whole items; chunks are cut when sent, never queued.
- The fair scheduler decides who gets the next bytes; the framing wraps them in `CHUNK` envelopes.
- The protocol defines the chunk format; the viewer reassembles.

## Packages and enforced boundaries

The components become workspace packages so the compiler enforces the boundaries, not convention:

- **Scope**: new packages are `@nebula/*`; existing `@gfld/*` names stay.
- **Shared contracts**: the interfaces and shared types between components live in one contracts package. Implementation
  packages depend only on it (plus `@gfld/scene-protocol`, npm packages and Node), never on each other. Only `session`
  imports them all and connects them.
- **Public API only**: each package's `exports` map exposes only its entry point.
- **No cycles**: `tsc -b` project references; a circular reference fails the build.
- **Declared dependencies only**: npm links every workspace package into the shared `node_modules`, so an undeclared
  import would still resolve. ESLint's `import/no-extraneous-dependencies` catches it, and lint becomes part of the
  test gate (`session` currently has 54 lint errors, almost all formatting fixable with `--fix`).
- **Build**: the new packages are CommonJS-only if possible (only Node loads them, `session` is CommonJS), built
  incrementally by `tsc -b`.
- **Native code** lives with the component that owns the concern. The architecture isn't bent to make tests faster or
  builds simpler.
- **Boundaries follow dependencies, not categories.** The video encoder is a codec by category, but it reads
  compositor-owned buffers in place (GPU memory, locked until it's done). No buffer is ever passed between packages to
  make a categorical split work; see the open question below.

## How the work is done

- **Fix interfaces in place, then extract.** A step first changes a component's interface while its code is still in
  `session`, until it depends on nothing outside its target package; then moving it into the package is mechanical
  and the compiler locks the boundary in. A pure file-move step first makes no sense: today's interfaces cut across
  the target boundaries.
- Every step leaves all tests green (unit tests, `scripts/test-gateway.sh`, lint) and keeps behavior, logging and
  `--dev-*` flags.
- Steps are done by agents (Sonnet by default, Opus for tricky ones), one per step on its own branch and worktree,
  merged and tested by the orchestrator after each, run in parallel where the dependencies allow.

## Open questions

1. **Video encoding and capture.** The video encoder needs the surface's buffer in place. Options discussed:
   - It stays with capture in `session` (the wlroots addon it lives in today); rendering asks capture for an encoded
     frame through an interface (today `SurfaceHost.encodeVideo`) and gets bytes back.
   - A first-class **frame** concept: capture produces frames (the surface's content at a point in time, holding its
     buffer until released); encoders consume them; everything between passes the frame through opaquely. The native
     side already has a neutral buffer description (`struct frame_buffer` in `encoder.h`).

   Not a TypeScript problem as such: the constraint (read a compositor-owned buffer in place, release it when done)
   exists in any language. Rust crates would express the handoff as a borrowed type checked at compile time; here the
   components between capture and encoder are TypeScript, and a native buffer crossing them is an opaque value.
2. **Which component owns what in QoS.** QoS is defined as analyzing the stream and estimating the link. Undecided:
   - whether the congestion controller's bandwidth estimation (today inside the transport, tied to send pacing) is
     QoS or transport;
   - whether surface classification (`RelentlessMeter`: is a surface constantly busy?) and burst promotion are QoS or
     rendering policy;
   - where a stream's priority tier comes from.
3. **The package list.** Provisionally: contracts, QoS, scheduler, rendering, transport, patch codec, plus the existing
   protocol package and `session`. To be redrawn once 1 and 2 are settled.
4. **The step plan**, drawn from this document once the above are settled.
