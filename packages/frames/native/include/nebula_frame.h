/*
 * The frame library (@nebula/frames): a frame is a surface's content at a point in time, a reference to its buffer
 * that keeps the buffer from being reused until the frame is released. Capture creates frames; renderers (the patch
 * path, the video encoder) read them. This header is the one native contract between them (see "Frames" in
 * docs/MODULARIZATION.md).
 *
 * Lifetime
 *   A frame is reference counted. Its creator returns it with one reference; nebula_frame_retain() adds one,
 *   nebula_frame_release() drops one. When the last one is dropped the frame is destroyed (the creator's destroy
 *   function: e.g. unlock the compositor's buffer) on the thread that created it, whichever thread dropped it: a
 *   release from another thread (a GStreamer thread done encoding) is queued back to the creating thread, because
 *   wlroots buffers may only be unlocked there.
 *
 * Several copies of the library
 *   The library is linked statically into every addon that uses it, so capture and a consumer may each have their own
 *   copy. Every frame carries its creator's retain and release functions, and consumers call through them (the inline
 *   functions below), so the lifetime logic always runs in the creator's copy. `magic` and `size` let a consumer
 *   check that a pointer is a frame of a compatible build before using it (nebula_frame_is_valid()).
 *
 * Held too long
 *   The library notes when each frame was created and logs a warning (once per frame) when one is still held after a
 *   limit (about a second): a frame that is never released (a hung encoder) would otherwise go unnoticed until the app
 *   runs out of buffers. It never frees anything by force: a slow consumer may still be reading.
 */
#ifndef NEBULA_FRAME_H
#define NEBULA_FRAME_H

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "node_api.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The type tag at the start of every frame ("nFRM"). */
#define NEBULA_FRAME_MAGIC 0x4d52466eu
/* The layout version of struct nebula_frame: bumped when a field changes meaning; added fields grow `size`. */
#define NEBULA_FRAME_VERSION 2u

#define NEBULA_FRAME_MAX_PLANES 4

enum nebula_frame_memory {
    /* CPU-readable memory: description.shm */
    NEBULA_FRAME_SHM = 1,
    /* a Linux dmabuf (GPU memory): description.dmabuf */
    NEBULA_FRAME_DMABUF = 2,
};

struct nebula_frame_plane {
    int32_t fd;
    uint32_t offset;
    uint32_t stride;
};

struct nebula_frame_source;

struct nebula_frame {
    /* NEBULA_FRAME_MAGIC */
    uint32_t magic;
    /* NEBULA_FRAME_VERSION of the creator's build */
    uint32_t version;
    /* sizeof(struct nebula_frame) in the creator's build: a consumer reads only fields that fit in it */
    uint32_t size;

    /* --- the description: set by the creator before handing the frame out, constant afterwards --- */

    enum nebula_frame_memory memory;
    /* in buffer pixels */
    uint32_t width;
    uint32_t height;
    /* DRM fourcc (drm_fourcc.h), for either memory type */
    uint32_t format;
    /* increases with every new buffer content of the surface (capture's numbering) */
    uint32_t content_serial;
    /*
     * The GPU the buffer lives on: the dev_t of its DRM device (a consumer such as the video encoder opens its own GPU
     * context there, on the device's render node; a dmabuf can be imported by any context on the same device). 0: not
     * known, or not GPU memory (shared memory frames don't need it).
     */
    uint64_t device;
    union {
        struct {
            /*
             * Valid while the frame is held, from any thread. Not protected against a client shrinking its pool
             * (SIGBUS): readers on the creator's thread wrap their reads in begin_access/end_access when they're set.
             */
            const void *data;
            size_t stride;
            /*
             * Optional (may be NULL), creator's thread only: begin_access returns the memory to read (NULL: it can't be
             * read), end_access ends the read (wlroots: SIGBUS protection while reading).
             */
            const void *(*begin_access)(struct nebula_frame *frame);
            void (*end_access)(struct nebula_frame *frame);
        } shm;
        struct {
            uint64_t modifier;
            uint32_t n_planes;
            struct nebula_frame_plane planes[NEBULA_FRAME_MAX_PLANES];
        } dmabuf;
    } description;
    /*
     * The surface's opaque region when the frame was taken (wl_surface.set_opaque_region: alpha is 1 there), in buffer
     * pixels, as disjoint rectangles x, y, width, height (n_opaque_rects of them). Empty when there is none, or when it
     * can't be mapped to buffer pixels simply (a transform or a viewport). Owned by the creator (freed by its destroy).
     */
    int32_t *opaque_rects;
    uint32_t n_opaque_rects;

    /* --- lifetime: the creator's functions, consumers call them through nebula_frame_retain/release --- */

    void (*retain)(struct nebula_frame *frame);
    void (*release)(struct nebula_frame *frame);

    /* --- the creator's private part: consumers don't touch it --- */

    atomic_uint_fast32_t references;
    struct nebula_frame_source *source;
    /* called once, on the creating thread, when the last reference is dropped; frees the frame */
    void (*destroy)(struct nebula_frame *frame);
    /* monotonic milliseconds when the frame was created, for the held-too-long warning */
    int64_t created_ms;
    bool warned;
    /* the source's list of live frames */
    struct nebula_frame *prev, *next;
};

/* Whether `frame` points at a frame this build can read. */
static inline bool
nebula_frame_is_valid(const struct nebula_frame *frame) {
    return frame != NULL && frame->magic == NEBULA_FRAME_MAGIC && frame->version == NEBULA_FRAME_VERSION &&
           frame->size >= offsetof(struct nebula_frame, references);
}

/* Adds a reference. Any thread. */
static inline void
nebula_frame_retain(struct nebula_frame *frame) {
    frame->retain(frame);
}

/* Drops a reference; the last one destroys the frame on its creating thread. Any thread. */
static inline void
nebula_frame_release(struct nebula_frame *frame) {
    frame->release(frame);
}

/* ---------------------------------------------------------------------------------------------------------------
 * For creators
 */

typedef void (*nebula_frame_log_func)(const char *message);

/*
 * A frame source: what a creator needs to hand out frames. Created on the creating thread (Node's main thread, from a
 * call from JavaScript), which is where its frames are destroyed. `held_limit_ms`: how long a frame may be held before
 * the warning; `log`: where the warning goes (NULL: stderr). A source lives as long as its addon.
 */
struct nebula_frame_source *
nebula_frame_source_create(napi_env env, uint32_t held_limit_ms, nebula_frame_log_func log);

/*
 * Makes `frame` (allocated by the creator, description filled in by it before or after this call) a live frame with
 * one reference. `destroy` frees it, on the source's thread.
 */
void
nebula_frame_init(struct nebula_frame *frame, struct nebula_frame_source *source,
                  void (*destroy)(struct nebula_frame *frame));

/* The number of frames of the source not yet destroyed. Any thread. */
uint32_t
nebula_frame_source_live(struct nebula_frame_source *source);

/* ---------------------------------------------------------------------------------------------------------------
 * The JavaScript handle (nebula_frame_napi.c): an object with width, height, contentSerial, readPixels(rect) and
 * release(), type-tagged so native consumers reject anything that isn't a frame.
 */

/* Wraps `frame` in a new handle, which takes over one reference (released by release(), or when collected). */
napi_value
nebula_frame_to_js(napi_env env, struct nebula_frame *frame);

/*
 * The frame of a handle, with a new reference the caller releases; NULL (and no exception) if `value` isn't a frame
 * handle or was released already.
 */
struct nebula_frame *
nebula_frame_from_js(napi_env env, napi_value value);

/*
 * RGBA copy of a rectangle of a shared-memory frame into `out` (width * height * 4 bytes), on the creating thread.
 * Returns false if it can't be read (not shared memory, an unsupported format, outside the buffer). `opaque`: all its
 * alpha is 255, because the format has no alpha, or the rectangle lies in the opaque region, or the copy found every
 * alpha byte to be 255.
 */
bool
nebula_frame_read_rgba(struct nebula_frame *frame, int32_t x, int32_t y, int32_t width, int32_t height, uint8_t *out,
                       bool *opaque);

#ifdef __cplusplus
}
#endif

#endif
