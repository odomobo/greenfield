/*
 * The frame library's lifetime logic (see nebula_frame.h): reference counting, the release back to the creating
 * thread, and the held-too-long warning.
 *
 * Threads
 *   - The creating thread (Node's main thread) creates the source and its frames, and is the only thread that destroys
 *     them.
 *   - Any thread may retain or release. The last release on another thread is queued to the creating thread through a
 *     N-API thread-safe function (it runs from Node's event loop).
 *   - A watchdog thread per source sleeps until the oldest frame not yet warned about reaches the limit, and logs the
 *     warning. It only reads the list of live frames, under the source's mutex; a frame leaves the list (under the
 *     mutex) before it is destroyed, so the watchdog never sees a freed frame.
 */
#define _POSIX_C_SOURCE 200809L
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "nebula_frame.h"

struct nebula_frame_source {
    pthread_t thread;
    napi_threadsafe_function destroy_on_thread;
    uint32_t held_limit_ms;
    nebula_frame_log_func log;

    /* guards everything below, and the list links and `warned` of every live frame */
    pthread_mutex_t mutex;
    /* signalled when a frame is added (the watchdog may be waiting with no deadline) */
    pthread_cond_t changed;
    struct nebula_frame *live;
    uint32_t live_count;
};

static int64_t
monotonic_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t) now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void
log_message(struct nebula_frame_source *source, const char *message) {
    if (source->log) {
        source->log(message);
    } else {
        fprintf(stderr, "%s\n", message);
    }
}

/* On the creating thread: the last reference is gone. */
static void
frame_destroy(struct nebula_frame *frame) {
    struct nebula_frame_source *source = frame->source;
    pthread_mutex_lock(&source->mutex);
    if (frame->prev) {
        frame->prev->next = frame->next;
    } else {
        source->live = frame->next;
    }
    if (frame->next) {
        frame->next->prev = frame->prev;
    }
    source->live_count--;
    bool warned = frame->warned;
    pthread_mutex_unlock(&source->mutex);
    if (warned) {
        char message[160];
        snprintf(message, sizeof(message), "frames: the frame of content serial %" PRIu32 " was released after %" PRId64
                 " ms", frame->content_serial, monotonic_ms() - frame->created_ms);
        log_message(source, message);
    }
    frame->magic = 0;
    frame->destroy(frame);
}

/* On the creating thread, from Node's event loop: a release from another thread. */
static void
destroy_on_thread_cb(napi_env env, napi_value js_callback, void *context, void *data) {
    (void) env, (void) js_callback, (void) context;
    frame_destroy(data);
}

static void
frame_retain(struct nebula_frame *frame) {
    // a new reference is always made from an existing one, so the count can't be 0 here: no ordering needed
    atomic_fetch_add_explicit(&frame->references, 1, memory_order_relaxed);
}

static void
frame_release(struct nebula_frame *frame) {
    // release/acquire: every read by the other holders happens before the destroy
    if (atomic_fetch_sub_explicit(&frame->references, 1, memory_order_acq_rel) != 1) {
        return;
    }
    struct nebula_frame_source *source = frame->source;
    if (pthread_equal(pthread_self(), source->thread)) {
        frame_destroy(frame);
    } else if (napi_call_threadsafe_function(source->destroy_on_thread, frame, napi_tsfn_blocking) != napi_ok) {
        // only when Node is shutting down: the buffer goes with the process
        log_message(source, "frames: can't queue a frame's release to its thread, it is leaked");
    }
}

/* The watchdog: warns once about every frame held longer than the limit. */
static void *
watchdog(void *data) {
    struct nebula_frame_source *source = data;
    pthread_mutex_lock(&source->mutex);
    for (;;) {
        int64_t now = monotonic_ms();
        int64_t next = INT64_MAX;
        for (struct nebula_frame *frame = source->live; frame; frame = frame->next) {
            if (frame->warned) {
                continue;
            }
            int64_t deadline = frame->created_ms + source->held_limit_ms;
            if (deadline <= now) {
                frame->warned = true;
                char message[200];
                snprintf(message, sizeof(message), "frames: the frame of content serial %" PRIu32 " (%" PRIu32 "x%" PRIu32
                         ") has been held for over %" PRIu32 " ms: a consumer hasn't released it", frame->content_serial,
                         frame->width, frame->height, source->held_limit_ms);
                log_message(source, message);
            } else if (deadline < next) {
                next = deadline;
            }
        }
        if (next == INT64_MAX) {
            pthread_cond_wait(&source->changed, &source->mutex);
        } else {
            struct timespec until = {.tv_sec = next / 1000, .tv_nsec = (long) (next % 1000) * 1000000};
            pthread_cond_timedwait(&source->changed, &source->mutex, &until);
        }
    }
    return NULL;
}

struct nebula_frame_source *
nebula_frame_source_create(napi_env env, uint32_t held_limit_ms, nebula_frame_log_func log) {
    struct nebula_frame_source *source = calloc(1, sizeof(*source));
    source->thread = pthread_self();
    source->held_limit_ms = held_limit_ms;
    source->log = log;
    pthread_mutex_init(&source->mutex, NULL);
    pthread_condattr_t cond_attributes;
    pthread_condattr_init(&cond_attributes);
    pthread_condattr_setclock(&cond_attributes, CLOCK_MONOTONIC);
    pthread_cond_init(&source->changed, &cond_attributes);
    pthread_condattr_destroy(&cond_attributes);

    napi_value name;
    napi_create_string_utf8(env, "nebula_frame_release", NAPI_AUTO_LENGTH, &name);
    napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, destroy_on_thread_cb,
                                    &source->destroy_on_thread);
    // queued releases don't keep Node running
    napi_unref_threadsafe_function(env, source->destroy_on_thread);

    pthread_t thread;
    pthread_create(&thread, NULL, watchdog, source);
    pthread_detach(thread);
    return source;
}

void
nebula_frame_init(struct nebula_frame *frame, struct nebula_frame_source *source,
                  void (*destroy)(struct nebula_frame *frame)) {
    frame->magic = NEBULA_FRAME_MAGIC;
    frame->version = NEBULA_FRAME_VERSION;
    frame->size = sizeof(struct nebula_frame);
    frame->retain = frame_retain;
    frame->release = frame_release;
    atomic_init(&frame->references, 1);
    frame->source = source;
    frame->destroy = destroy;
    frame->created_ms = monotonic_ms();
    frame->warned = false;

    pthread_mutex_lock(&source->mutex);
    frame->prev = NULL;
    frame->next = source->live;
    if (source->live) {
        source->live->prev = frame;
    }
    source->live = frame;
    source->live_count++;
    pthread_cond_signal(&source->changed);
    pthread_mutex_unlock(&source->mutex);
}

uint32_t
nebula_frame_source_live(struct nebula_frame_source *source) {
    pthread_mutex_lock(&source->mutex);
    uint32_t live = source->live_count;
    pthread_mutex_unlock(&source->mutex);
    return live;
}

// ---------------------------------------------------------------------------------------------------------------------
// reading pixels

#define FOURCC(a, b, c, d) ((uint32_t) (a) | ((uint32_t) (b) << 8) | ((uint32_t) (c) << 16) | ((uint32_t) (d) << 24))
#define FORMAT_ARGB8888 FOURCC('A', 'R', '2', '4')
#define FORMAT_XRGB8888 FOURCC('X', 'R', '2', '4')
#define FORMAT_ABGR8888 FOURCC('A', 'B', '2', '4')
#define FORMAT_XBGR8888 FOURCC('X', 'B', '2', '4')

/* Whether the rectangle lies entirely in the frame's opaque region: its rectangles are disjoint, so it does if they
 * cover all of its area. */
static bool
rect_in_opaque_region(const struct nebula_frame *frame, int32_t x, int32_t y, int32_t width, int32_t height) {
    int64_t covered = 0;
    for (uint32_t i = 0; i < frame->n_opaque_rects; i++) {
        const int32_t *r = &frame->opaque_rects[i * 4];
        int32_t x1 = x > r[0] ? x : r[0], y1 = y > r[1] ? y : r[1];
        int32_t x2 = x + width < r[0] + r[2] ? x + width : r[0] + r[2];
        int32_t y2 = y + height < r[1] + r[3] ? y + height : r[1] + r[3];
        if (x2 > x1 && y2 > y1) {
            covered += (int64_t) (x2 - x1) * (y2 - y1);
        }
    }
    return covered == (int64_t) width * height;
}

bool
nebula_frame_read_rgba(struct nebula_frame *frame, int32_t x, int32_t y, int32_t width, int32_t height, uint8_t *out,
                       bool *opaque_out) {
    if (frame->memory != NEBULA_FRAME_SHM || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        (int64_t) x + width > frame->width || (int64_t) y + height > frame->height) {
        return false;
    }
    // byte offsets of R, G, B, A in a little endian pixel, -1: no alpha
    int r, g, b, a;
    switch (frame->format) {
        case FORMAT_ARGB8888:
            r = 2, g = 1, b = 0, a = 3;
            break;
        case FORMAT_XRGB8888:
            r = 2, g = 1, b = 0, a = -1;
            break;
        case FORMAT_ABGR8888:
            r = 0, g = 1, b = 2, a = 3;
            break;
        case FORMAT_XBGR8888:
            r = 0, g = 1, b = 2, a = -1;
            break;
        default:
            return false;
    }
    const void *data = frame->description.shm.data;
    if (frame->description.shm.begin_access) {
        data = frame->description.shm.begin_access(frame);
        if (data == NULL) {
            return false;
        }
    }
    size_t stride = frame->description.shm.stride;
    bool opaque = a < 0 || rect_in_opaque_region(frame, x, y, width, height);
    uint8_t alpha_and = 0xff;
    for (int32_t row = y; row < y + height; row++) {
        const uint8_t *in = (const uint8_t *) data + (size_t) row * stride + (size_t) x * 4;
        if (opaque) {
            // no alpha to scan: the format has none, or the client promised it is 1 here (the alpha is still set to 255)
            for (int32_t column = 0; column < width; column++, in += 4, out += 4) {
                out[0] = in[r];
                out[1] = in[g];
                out[2] = in[b];
                out[3] = 0xff;
            }
        } else {
            for (int32_t column = 0; column < width; column++, in += 4, out += 4) {
                out[0] = in[r];
                out[1] = in[g];
                out[2] = in[b];
                out[3] = in[a];
                alpha_and &= in[a];
            }
        }
    }
    if (frame->description.shm.end_access) {
        frame->description.shm.end_access(frame);
    }
    *opaque_out = opaque || alpha_and == 0xff;
    return true;
}
