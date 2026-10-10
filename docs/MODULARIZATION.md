# Modularization of the session's streaming stack

The design behind the coming refactoring: what each component of the session's streaming stack is responsible for,
where the boundaries are and how they're enforced, and how the send queue works. Decided points and open questions are
kept apart; the step-by-step plan is drawn from this document once the open questions are settled.

The browser viewer gets the same treatment later, not as part of this work.

## Goal

Separation of concerns. Each component has one job behind a clean interface, so its implementation can change without
the components that use it noticing:

- **QoS** is two separate concepts (see "QoS: two concepts"):
  - **congestion estimation** analyzes the data stream and estimates the link. It's the most intricate logic in the
    stack, so it is kept on its own and as simple as possible, to keep it bug-free;
  - **traffic policy** shares the link and the CPU between surfaces: fair-queueing weights, surface priority, and
    whether a surface is CPU- or link-bound.

  Others use what they conclude; how they reach their conclusions is their own business.
- **Rendering** turns a surface's content into items to send (patches or video frames). How something is encoded is
  orthogonal to how it's consumed.
- **Capture** knows nothing about encoding: it hands out **frames** of a surface's content, and renderers consume them.
- **Everything between rendering and the viewer passes items through** without caring what they are. Only the
  receiving end in the viewer needs to understand them.
- **The protocol** is a cross-cutting concern, kept as small as reasonable and isolated in one place, so it is easy to
  reason about.

## Components

| Component | Responsible for | Must not know about |
|---|---|---|
| **Protocol** (`@gfld/scene-protocol`, exists) | Message schema, envelope and chunk formats; the one place both ends agree on | Tiers, classes, sockets, scheduling |
| **Capture** (the compositor) | Surfaces, their buffers and damage; tells renderers "content changed" and hands out frames on request | How content is encoded or sent |
| **Frames** | The frame object: a reference to a surface's buffer at a point in time, its description, its lifetime and release (see "Frames") | Who produces or consumes frames, encoding |
| **Surface** (per surface; today the class switching in `SurfaceEncoder`) | Whether the surface is sent as patches or video, from its traffic-policy decision; the switch between the two (see "The surface package") | How either renderer works, how the decision was reached |
| **Patch rendering** (per surface; today most of `SurfaceEncoder`) | What to send next and in what order; its own internal queue of work (see below); lossy and settle areas | The link, other surfaces, video |
| **Video rendering** (per surface; today the video parts of `SurfaceEncoder`) | The video stream's state: on-demand frames, key frames and recovery, quality | The link, other surfaces, patches |
| **Patch codec** (today `patch-encoder`, `png`, the worker pools) | Pixels in, bytes out | Which surface, patch order, priority |
| **Video codec** (today the GStreamer encoder in `native/encoding`) | Frames in, H.264 out | Capture, which surface, priority |
| **Scheduler** (today `PatchPump` and `FramePacing`) | Which surface's work runs next; when an app gets its frame callback | Why a surface has its priority |
| **Congestion estimation** (today `congestion.ts`) | Estimating the link (bandwidth, round-trip time) from sends and acks; how much may be in flight and how fast to send | Surfaces, priorities, content |
| **Traffic policy** | Fair-queueing tiers and weights, surface priority (relentless or not), bottleneck (CPU- or link-bound) and its consequences | Pixels, encoders, how the link is estimated |
| **Transport** | The fair-queueing mechanism across streams (with weights given to it), stream readiness, chunking, the socket | What an item contains (patch, key frame, delta), why a stream has its weight |

Patch codec and patch order are separate concerns: the codec only encodes the pixels it's given; which region is
captured when, and in what order, is rendering's.

Fair queueing is split the same way: the transport runs the mechanism (weighted round-robin over tiers, round-robin
over the streams of a tier, because it decides which bytes go out next); traffic policy decides the tiers and weights.

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

## Frames

A frame is the surface's content at a point in time: a reference to its buffer, holding it until released. Capture
produces frames, renderers consume them, and everything in between passes them through without looking inside. So
capture knows nothing about encoding, and the encoders know nothing about capture.

The need for this isn't a TypeScript problem as such: the constraint (read a compositor-owned buffer in place, release
it when done) exists in any language. Rust crates would express the handoff as a shared borrowed type checked at
compile time; here the components between capture and the encoders are TypeScript, so a frame crossing them is an
opaque handle, and the frame library is the shared type.

### Shape

A small native frame library, plus a TypeScript handle:

- The native library owns the frame object: the buffer description (shared memory or dmabuf planes, size, format,
  content serial), the reference count, and the release. A release can come from another thread (GStreamer finishes
  on its own) while wlroots buffers may only be unlocked on the main thread; the library queues the release back to
  capture's thread. Today `wlr_core_encoder.c` does that by hand. This lifetime logic, the classic source of
  use-after-free bugs, exists once and is tested by itself.
- Capture links the library to create frames; the video codec links it to read them. Its header is the one native
  contract between them.
- **Each frame carries its own retain and release functions** (its creator's). The library is linked statically into
  each addon that uses it, and every consumer calls through the frame's own function pointers, so the operations always
  run in the creator's code (including the hop back to capture's thread), whichever copy of the library the consumer
  has. No shared library has to be found or loaded at runtime; it's the usual C pattern for objects crossing library
  boundaries (GStreamer's memory objects work this way). The header has a size or version field next to the type tag,
  so a mismatched build is caught, not misread.
- The TypeScript handle exposes what the TypeScript components need without native code: `width`, `height`,
  `contentSerial`, `release()`, and `readPixels(rect)` for the patch renderer. Handles are type-tagged, so a native
  consumer rejects anything that isn't a frame.
- Both renderers consume frames: the patch renderer reads its pixels from a frame instead of calling into the
  compositor.

### Frames are pulled, on demand

Capture doesn't hand out a frame on every commit. It tells renderers that content changed (with the damage); a
renderer takes a frame when it decides to render: its stream is ready and something changed. Commits in between never
become frames. Apps that ignore frame callbacks and commit faster than we pull are fine: we take the latest content
when ready, and they get their buffers back as newer ones replace them.

### Holding buffers

- **Capture holds the surface's latest buffer** until the app commits a newer one (today `gsurf->buffer` in
  `wlr_core.c`). That's what lets a patch read the latest pixels whenever it's captured. This hold can last long; that's
  accepted: nearly all apps use more than one buffer, and it fits how the system works. (An app with a single
  shared-memory buffer would stall waiting for its release. A GPU compositor copies such buffers on commit instead; we
  don't.)
- **A renderer holds a frame only while it reads from it.** When new content arrives, the renderer's next work takes a
  frame of the new buffer, and the old one is released as soon as the patch or video frame reading it is done. With one
  encode at a time per surface, at most one frame per surface is held beyond capture's own.
- New damage always arrives with a new buffer (an app may not write into a buffer it hasn't had back), and a Wayland
  buffer is a complete image. So rendering's queued regions, which read their pixels when captured, are correct
  whichever buffer they end up reading.
- **A frame held too long is logged as a warning.** Nothing today notices a frame that is never released (a hung
  encoder, a GPU reset): the app eventually runs out of buffers. The frame library records when each frame was taken
  and warns when one is held longer than a limit (say a second). It can't tell a hang from a slow consumer, and it
  doesn't need to: either is a bug. It never forces a buffer free (an encoder might still read it).

### The GPU context comes from the frame

Today the video encoder is created with the compositor's EGL handle (`frame_encoder_create(..., westfield_egl)`), so it
shares the compositor's GPU context. Instead, a frame says which GPU its buffer lives on, and the video codec opens its
own context there (a dmabuf can be imported by any context on the same device). That removes the last link between the
video codec and capture. The GPU path can't be tested on the development machine.

## QoS: two concepts

### Congestion estimation

The BBR-style controller (today `congestion.ts`): estimates bandwidth and round-trip time from sends and acks, and says
how much may be in flight and how fast to send. Its own package with nothing else in it, because it's the most
intricate logic in the stack. The transport consults it on every send (that's how pacing works); the rest of the system
reads its estimates.

### Traffic policy

How the link and the CPU are shared between surfaces. Two independent axes, today merged into one verdict by
`RelentlessMeter`:

- **Priority: is the surface relentless?** A surface that keeps producing work uses whatever resources it's given,
  which is itself the reason it gets low priority: its encodes always run on the low-priority pool, and it sends in a
  lower tier. Burst promotion and settling at the lowest priority belong here too.
- **Bottleneck: is the surface CPU-bound or link-bound?** We consider ourselves CPU-bound until the link becomes the
  limit. Link-bound means going lossy (spend CPU to save bandwidth). The "link is short" judgment (today
  `BandwidthMonitor`) is derived from congestion estimation's output, so it is traffic policy, not estimation.

Today `RelentlessMeter` measures "busy" (work produced faster than it's encoded: the CPU side) and "backlogged" (output
waiting to be sent: the link side) and combines them. Separated, each can be measured and named for what it is, and its
consequences are visible.

## The surface package

Choosing between patches and video for a surface, and switching, is a concern of its own: when video starts, the patch
queue is cleared and the whole surface counts as lossy; when it stops, a full lossless image of the surface goes out.
The two renderer packages never import each other, so a small surface package owns the renderers of a surface,
creating each when it's needed, and the switch between them.

It receives its surface's traffic-policy decision (priority and bottleneck) through the contracts; from that, plus
whether a hardware encoder is free and whether the surface is small, it picks patches or video. It doesn't know how the
decision was reached.

## Packages and enforced boundaries

The components become workspace packages so the compiler enforces the boundaries, not convention:

- **Scope**: new packages are `@nebula/*`; existing `@gfld/*` names stay.
- **Shared contracts**: the interfaces and shared types between components live in one package,
  `@nebula/session-contracts` (named for the session side: the viewer gets its own later, and the wire format both
  share stays in `scene-protocol`). - **Dependencies are fine; inversion where it's genuinely cleaner.** A package may depend on another directly
  when that is the natural relationship, e.g. a component that owns and creates another (the surface package creates
  its renderers when it needs them). Dependency inversion (an interface in the contracts, the implementation passed
  in by `session`) is used where it is the cleaner approach: a shared, session-wide resource (the encoder pools,
  traffic policy's decisions), or a component that should be swappable and testable on its own (the transport uses
  the congestion estimator through an interface; its tests pass one that never holds anything back). The goal is few
  dependencies, not none.
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
  compositor-owned buffers in place (GPU memory, locked until it's done). That's why frames are their own component
  (see "Frames"), not a buffer handed around by workarounds.

### Adding a package

`packages/session-contracts` is the template: copy it, then:

- **`package.json`**: name `@nebula/<name>`, `"type": "commonjs"`, `"private": true`, license `AGPL-3.0-or-later`,
  `main`/`types` pointing at `dist/index.js` and `types/index.d.ts`, and an `exports` map with only `"."`. Every
  package it imports goes in `dependencies` (`"*"` for workspace packages), the tooling in `devDependencies` (as in the
  template). Scripts: `build` (`npx tsc -b`), `test` (`node --test --test-force-exit dist/test/`), `lint`
  (`eslint src --ext .ts`), `format`.
- **`tsconfig.json`**: extends `@tsconfig/node18`, `composite: true`, `rootDir` `src`, `outDir` `dist`, `declarationDir`
  `types`. For each workspace package it imports, add `"references": [{ "path": "../<package>" }]`, to this package's
  tsconfig and to the tsconfig of each package that imports it (`session`'s lists `../session-contracts`). `tsc -b`
  then builds in dependency order and a cycle fails the build. Packages that only exist as `scene-protocol` (not
  composite) are used by their built `types/` and need a Makefile dependency instead.
- **Lint**: copy `.eslintrc.js` and `.prettierrc.js` (same rules as `session`, including
  `import/no-extraneous-dependencies`), and `.gitignore` (`dist`, `types`, `*.tsbuildinfo`).
- **Tests**: unit tests in `src/test/*.test.ts` with `node:test`, run from the compiled `dist/`. They must be fast
  (see `CLAUDE.md`).
- **Native code** lives in the package that owns it, under `native/`, with its own `CMakeLists.txt` and a
  `build:native` script (`mkdir -p build && cmake -G Ninja -B./build -S./ && ninja -C ./build install`) that installs
  the `.node` addon under `dist/addons/`. The Makefile target runs it before `tsc -b`, as `session`'s does.
- **Root**: add a target to the `Makefile` (after the packages it depends on), and the package to the `lint` and `test`
  targets that `make check` runs. Run `npm install` at the repo root afterwards: npm links the new workspace package
  into `node_modules`, and without it nothing can import it (also in a new worktree).
- `make check` builds, lints and runs every package's unit tests; it is the test gate, together with
  `scripts/test-gateway.sh`.

## Package list

| Package | Contains | Depends on |
|---|---|---|
| `@gfld/scene-protocol` (exists) | Wire format: messages, envelopes, chunks | — |
| `@nebula/session-contracts` | The interfaces between the packages: the `Frame` handle's TypeScript interface, item and stream interfaces, the congestion estimator's interface, traffic-policy decisions, `Rect`, ... | `scene-protocol` (wire types such as `ViewerAck`) |
| `@nebula/frames` | The native frame library (frame object, reference count, cross-thread release, held-too-long warning) and the TypeScript handle | contracts |
| `@nebula/congestion` | The BBR-style estimator, nothing else | contracts |
| `@nebula/traffic-policy` | Priority (relentless meter, burst promotion, settling), bottleneck (CPU- or link-bound, today's `BandwidthMonitor`), tiers and weights | contracts |
| `@nebula/scheduler` | Which surface gets the next free patch worker, by tier; frame pacing (frame callbacks gated on stream readiness, rate limits) | contracts |
| `@nebula/surface` | Patches or video for a surface, and the switch; creates its renderers as needed | contracts, patch-renderer, video-renderer |
| `@nebula/patch-renderer` | Per surface: damage queue, patch planning and order, lossy and settle areas | contracts |
| `@nebula/video-renderer` | Per surface: on-demand frames, key frames and recovery, quality | contracts |
| `@nebula/patch-codec` | PNG, QOI and JPEG with the native patch addon, the worker pools | contracts |
| `@nebula/video-codec` | The GStreamer encoder (native), the pool of hardware encoder instances, encoder detection | contracts, frames |
| `@nebula/transport` | Fair-queueing mechanism, stream readiness, chunking, the WebSocket and simulated link, receive decoding | contracts, `scene-protocol` |
| `@gfld/session` | Capture (wlroots, creates frames), `ViewerHost`, audio, shell, everything else; connects the packages | all of them |

## How the work is done

- **Fix interfaces in place, then extract.** A step first changes a component's interface while its code is still in
  `session`, until it depends on nothing outside its target package; then moving it into the package is mechanical
  and the compiler locks the boundary in. A pure file-move step first makes no sense: today's interfaces cut across
  the target boundaries.
- **Behavior changes are steps of their own.** Only steps 4 and 5 (the send queue's redesign) change behavior; every
  other step is restructuring that keeps behavior, logging and `--dev-*` flags. So a regression after 4 or 5 is the
  redesign's, and one after any other step is a restructuring mistake.
- Every step leaves all tests green: unit tests of every package, `scripts/test-gateway.sh`, lint.
- Steps are done by agents (Sonnet by default, Opus for tricky ones), one per step on its own branch and worktree.
  Claude, as the orchestrator, merges each agent's branch into the `modularization` integration branch (merged into
  `master` when done), and tests after each merge (rebuild, all tests, compare test counts with the agent's report),
  run in parallel where the dependencies allow, at most three at a time (they touch overlapping files: the transport,
  `SurfaceEncoder`, the CMake build).
- In a worktree: `git submodule update --init` (wlroots), copy `packages/gatekeeper/target` from the main checkout
  (the e2e tests need `nebula-dev-login`; the gatekeeper isn't changed), `npm install` at the worktree root (new
  workspace packages must be linked there, not resolved from the main checkout's `node_modules`), then `make all`.
  Each agent runs `scripts/test-gateway.sh` with its own `GATEWAY_PORT` (it uses about 32 ports from there).
- Agents take obvious simple approaches for open details, but stop and report "not completed" on a real design gap;
  steps that depend on a stopped step don't start.
- `CLAUDE.md` applies: tests under a minute with timeouts of about two minutes, never kill processes by name.

## Step plan

| # | Step | Changes behavior | After | Agent |
|---|---|---|---|---|
| 0 | Scaffolding | No | — | Sonnet |
| 1 | Software video encoder for tests | No (test only) | 0 | Sonnet |
| 2 | `congestion` package | No | 0 | Sonnet |
| 3 | `patch-codec` package | No | 0 | Sonnet |
| 4 | Queue model: nothing queued is invalidated | **Yes** | 0 | Opus |
| 5 | Stream readiness | **Yes** | 4 | Opus |
| 6 | `frames` package | No | 0 | Opus |
| 7 | `video-codec` package | No | 1, 6 | Opus |
| 8 | `transport` package | No | 2, 5 | Opus |
| 9 | `scheduler` package | No | 3, 5 | Sonnet |
| 10 | `traffic-policy` package | No | 8 | Opus |
| 11 | Split `SurfaceEncoder` in place into surface, patch renderer and video renderer | No | 7, 9, 10 | Opus |
| 12 | Extract `surface`, `patch-renderer`, `video-renderer` | No | 11 | Sonnet |
| 13 | Wiring and docs | No | 12 | Sonnet |

Waves (the steps of a wave don't depend on each other): **0**; **1, 2, 3, 4, 6**; **5, 7**; **8, 9**; **10**; **11**;
**12**; **13**.

### 0. Scaffolding

- `packages/session-contracts` (`@nebula/session-contracts`) with build, lint and `exports` map, holding the shared
  types that already cross the future boundaries (`SurfaceClass`, `SendTier`, `Rect`, `EncodedPatch`, `VideoEncoder`,
  `VideoQuality`, ...), moved there from `session`.
- `session` builds with `tsc -b` and project references; the Makefile builds the packages first.
- `eslint-plugin-import` with `no-extraneous-dependencies`; `npm run lint` passes in `session` (54 errors today, almost
  all formatting fixable with `--fix`); one root command builds, lints and runs every package's unit tests, and is the
  test gate.
- A short "Adding a package" template in this document (package.json, tsconfig, lint, tests, native CMake if any) for
  the later steps.

### 1. Software video encoder for tests

The server's video path (capture → GStreamer → transport → viewer) has no automated test: the e2e scripts run with
`--encoder none`, and `scripts/e2e/video.sh` only tests the viewer's decoding with pre-encoded frames. Steps 7, 11 and
12 change that path.

- A dev-only software encoder, GStreamer's `x264enc`, behind a `--dev-*` flag (never a site setting: `encoder = x264`
  stays rejected), producing the same stream layout as the hardware encoders.
- An e2e script that streams a busy client as video end to end, and checks that the viewer shows it.
- The hardware-specific parts stay unverified here (dmabuf frames, `nvh264enc`/`vaapih264enc`, the GPU context): they
  are in `docs/ROADMAP.md` under "Needs verification on other hardware".

### 2. `congestion` package

`congestion.ts` is already a clean class. Its interface (what the transport and others use) goes into the contracts;
the controller and its tests (`congestion.test.ts`) move to `@nebula/congestion`. The transport keeps using it through
the interface.

### 3. `patch-codec` package

`png.ts`, `patch-encoder.ts`, `patch-worker.ts`, `PatchWorkerPool` and `native/patch` (with its own CMake build) move to
`@nebula/patch-codec`, with `patch-encoder.test.ts`, `PatchWorkerPool.test.ts`, `png.test.ts`.

### 4. Queue model: nothing queued is invalidated

As in "The send queue": the transport's `dropPatches`, the key-frame purge, the decodability gate (`needsKeyFrame`,
`keyFrameSent`) and `MAX_UNSENT_FRAMES_PER_SURFACE` go away; the queue reports an item unsent only when the transport
closes. Rendering handles key-frame recovery itself (the viewer's `keyframe` request makes its next frame a key frame).
The viewer already refuses deltas before a key frame (`KeyFrameNeeded` in `decoder.ts`); check it discards them
quietly.

### 5. Stream readiness

As in "The transport says when a stream is ready": per-stream readiness (at most one chunk of the stream's data left
unsent, in bytes) replaces the per-surface slots; one encode at a time per surface; frame callbacks wait for their
stream to be ready (rate limits unchanged).

### 6. `frames` package

As in "Frames": the native library (frame object with its creator's retain and release functions, size or version
field and type tag, cross-thread release back to capture's thread, held-too-long warning) and the TypeScript handle.
Capture creates frames; the patch path reads its pixels through `frame.readPixels` instead of calling the compositor.

### 7. `video-codec` package

The GStreamer encoder (`native/encoding`), the pool of hardware encoder instances (`EncoderPool`) and encoder detection
(`encoder.ts`) move to `@nebula/video-codec`, as its own addon consuming frames. It opens its own GPU context on the
frame's device instead of using the compositor's EGL handle. `wlr_core_encoder.c` goes away. Verified with step 1's
software encoder.

### 8. `transport` package

`ViewerTransport` split into the fair-queueing mechanism (tiers and weights passed in), chunking and the link (WebSocket,
socket options, the simulated link, receive decoding); it exposes link stats instead of judging them. `BandwidthMonitor`
moves out to `session` (step 10 packages it). `ViewerHost` stays in `session`. Tests: `ViewerTransport.test.ts`,
`SendScheduler.test.ts`, `transport-congestion.test.ts`, `audio-transport.test.ts`, `sim-link.ts`.

### 9. `scheduler` package

`PatchPump` (which surface gets the next free patch worker, by tier) and `FramePacing`, as an instance owned by the
scheduler instead of module globals; `ViewerHost` reports viewer attach and refresh rate through `session`'s wiring.
Tests: `FramePacing.test.ts`, the pump parts of `SurfaceEncoder.test.ts`.

### 10. `traffic-policy` package

As in "Traffic policy": priority (relentless or not; burst promotion; settling) and bottleneck (CPU- or link-bound,
`BandwidthMonitor`) as separate measurements, tiers and weights; a decision published per surface. `SurfaceEncoder`
stops judging the link and promoting itself: it reads its decision. Tests: `policy.test.ts`, `bandwidth.test.ts`, the
burst parts of `SurfaceEncoder.test.ts`.

### 11. Split `SurfaceEncoder` in place

Inside `session`, `SurfaceEncoder` becomes three modules: the surface (patches or video, the switch), the patch renderer
and the video renderer, with the interfaces between them settled. Nothing moves to a package yet, so the riskier
refactor can be reviewed on its own.

### 12. Extract `surface`, `patch-renderer`, `video-renderer`

The three modules move to their packages (the surface package depends on both renderers). Tests: the rest of
`SurfaceEncoder.test.ts`.

### 13. Wiring and docs

`WlrCompositor` only provides capture; a `session` wiring module creates and connects the packages. `docs/ARCHITECTURE.md`
updated where it names files or modules that moved; this document's status updated.

## Status

Design and step plan agreed (2026-10-09). All 14 steps (0-13) are done and merged into the `modularization` branch: the
session's streaming stack lives in the packages above, `WlrCompositor` only captures, and `src/streaming.ts` in
`packages/session` creates and connects the packages.

Open follow-ups, for the user to decide:

- **Separate CPU and link measurements.** Priority and bottleneck are separate in the code's structure (step 10), but
  `RelentlessMeter` still combines "busy" (which also counts items waiting in the transport) and "backlogged" into
  one priority verdict. Measuring the CPU and link sides separately would change when surfaces are promoted, so it
  would be a step of its own.
- **`@nebula/congestion/sim-link`.** The link simulator used by congestion's and traffic-policy's tests is exported
  from congestion through a test-only subpath, an exception to "exports only `.`". Alternatives: a test-support
  package, or accepting the exception.
- **`lossy.sh`'s audio-wait check** (no audio packet waits over 60 ms, wall clock) occasionally fails when the full
  suite loads the machine (seen twice, 67 ms; never alone). It needs a more robust form (e.g. fail only when it
  happens twice, or a wider margin).
