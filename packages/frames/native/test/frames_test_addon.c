/*
 * A test addon for the frame library (src/test/frames.test.ts): it creates frames over plain memory, so the lifetime
 * rules are tested without wlroots. Not part of any build but the frames package's own.
 */
#define _POSIX_C_SOURCE 200809L
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "nebula_frame.h"

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }
#define MAX_RECORDS 256

struct test_frame {
    struct nebula_frame base;
    uint8_t *pixels;
    bool accessed;
};

static pthread_t main_thread;
static pthread_mutex_t records_mutex = PTHREAD_MUTEX_INITIALIZER;
/* destroyed frames: content serial and whether it was destroyed on the creating thread */
static uint32_t destroyed_serials[MAX_RECORDS];
static bool destroyed_on_creating_thread[MAX_RECORDS];
static uint32_t destroyed_count;
/* warnings logged by the library */
static char *warnings[MAX_RECORDS];
static uint32_t warning_count;
/* begin/end access calls */
static uint32_t access_begun, access_ended;

static napi_value
undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static void
record_warning(const char *message) {
    pthread_mutex_lock(&records_mutex);
    if (warning_count < MAX_RECORDS) {
        warnings[warning_count++] = strdup(message);
    }
    pthread_mutex_unlock(&records_mutex);
}

static void
test_frame_destroy(struct nebula_frame *frame) {
    struct test_frame *test_frame = (struct test_frame *) frame;
    pthread_mutex_lock(&records_mutex);
    if (destroyed_count < MAX_RECORDS) {
        destroyed_serials[destroyed_count] = frame->content_serial;
        destroyed_on_creating_thread[destroyed_count] = pthread_equal(pthread_self(), main_thread);
        destroyed_count++;
    }
    pthread_mutex_unlock(&records_mutex);
    free(test_frame->pixels);
    free(frame->opaque_rects);
    free(test_frame);
}

static const void *
test_frame_begin_access(struct nebula_frame *frame) {
    access_begun++;
    return ((struct test_frame *) frame)->pixels;
}

static void
test_frame_end_access(struct nebula_frame *frame) {
    (void) frame;
    access_ended++;
}

static size_t
get_args(napi_env env, napi_callback_info info, size_t max, napi_value *argv) {
    size_t argc = max;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    return argc;
}

// createSource(heldLimitMs) -> source
static napi_value
createSource(napi_env env, napi_callback_info info) {
    napi_value argv[1], result;
    uint32_t limit = 1000;
    get_args(env, info, 1, argv);
    napi_get_value_uint32(env, argv[0], &limit);
    napi_create_external(env, nebula_frame_source_create(env, limit, record_warning), NULL, NULL, &result);
    return result;
}

/*
 * createFrame(source, { width, height, format, contentSerial, pixels: Uint8Array, stride, opaqueRects?: Int32Array,
 * access?: boolean }) -> Frame
 */
static napi_value
createFrame(napi_env env, napi_callback_info info) {
    napi_value argv[2], value;
    struct nebula_frame_source *source;
    get_args(env, info, 2, argv);
    napi_get_value_external(env, argv[0], (void **) &source);
    struct test_frame *test_frame = calloc(1, sizeof(*test_frame));
    struct nebula_frame *frame = &test_frame->base;
    uint32_t stride = 0;
    napi_get_named_property(env, argv[1], "width", &value);
    napi_get_value_uint32(env, value, &frame->width);
    napi_get_named_property(env, argv[1], "height", &value);
    napi_get_value_uint32(env, value, &frame->height);
    napi_get_named_property(env, argv[1], "format", &value);
    napi_get_value_uint32(env, value, &frame->format);
    napi_get_named_property(env, argv[1], "contentSerial", &value);
    napi_get_value_uint32(env, value, &frame->content_serial);
    napi_get_named_property(env, argv[1], "stride", &value);
    napi_get_value_uint32(env, value, &stride);

    void *data;
    size_t length;
    napi_get_named_property(env, argv[1], "pixels", &value);
    napi_get_typedarray_info(env, value, NULL, &length, &data, NULL, NULL);
    test_frame->pixels = malloc(length);
    memcpy(test_frame->pixels, data, length);
    frame->memory = NEBULA_FRAME_SHM;
    frame->description.shm.data = test_frame->pixels;
    frame->description.shm.stride = stride;

    bool has;
    napi_has_named_property(env, argv[1], "opaqueRects", &has);
    if (has) {
        napi_get_named_property(env, argv[1], "opaqueRects", &value);
        napi_get_typedarray_info(env, value, NULL, &length, &data, NULL, NULL);
        frame->opaque_rects = malloc(length * sizeof(int32_t));
        memcpy(frame->opaque_rects, data, length * sizeof(int32_t));
        frame->n_opaque_rects = (uint32_t) length / 4;
    }
    napi_has_named_property(env, argv[1], "access", &has);
    if (has) {
        frame->description.shm.begin_access = test_frame_begin_access;
        frame->description.shm.end_access = test_frame_end_access;
    }
    nebula_frame_init(frame, source, test_frame_destroy);
    return nebula_frame_to_js(env, frame);
}

static void
external_noop(napi_env env, void *data, void *hint) {
    (void) env, (void) data, (void) hint;
}

// retainFrame(handle) -> external native reference | undefined (not a frame, or released)
static napi_value
retainFrame(napi_env env, napi_callback_info info) {
    napi_value argv[1], result;
    get_args(env, info, 1, argv);
    struct nebula_frame *frame = nebula_frame_from_js(env, argv[0]);
    if (frame == NULL) {
        return undefined(env);
    }
    napi_create_external(env, frame, external_noop, NULL, &result);
    return result;
}

static void *
release_thread(void *data) {
    nebula_frame_release(data);
    return NULL;
}

// releaseNative(reference, onOtherThread): drops a reference from retainFrame, on this thread or a new one
static napi_value
releaseNative(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    struct nebula_frame *frame;
    bool other_thread = false;
    get_args(env, info, 2, argv);
    napi_get_value_external(env, argv[0], (void **) &frame);
    napi_get_value_bool(env, argv[1], &other_thread);
    if (other_thread) {
        pthread_t thread;
        pthread_create(&thread, NULL, release_thread, frame);
        pthread_join(thread, NULL);
    } else {
        nebula_frame_release(frame);
    }
    return undefined(env);
}

// liveFrames(source) -> number
static napi_value
liveFrames(napi_env env, napi_callback_info info) {
    napi_value argv[1], result;
    struct nebula_frame_source *source;
    get_args(env, info, 1, argv);
    napi_get_value_external(env, argv[0], (void **) &source);
    napi_create_uint32(env, nebula_frame_source_live(source), &result);
    return result;
}

// records() -> { destroyed: { serial, onCreatingThread }[], warnings: string[], accessBegun, accessEnded }
static napi_value
records(napi_env env, napi_callback_info info) {
    (void) info;
    napi_value result, destroyed, warning_list, item, value;
    pthread_mutex_lock(&records_mutex);
    napi_create_object(env, &result);
    napi_create_array_with_length(env, destroyed_count, &destroyed);
    for (uint32_t i = 0; i < destroyed_count; i++) {
        napi_create_object(env, &item);
        napi_create_uint32(env, destroyed_serials[i], &value);
        napi_set_named_property(env, item, "serial", value);
        napi_get_boolean(env, destroyed_on_creating_thread[i], &value);
        napi_set_named_property(env, item, "onCreatingThread", value);
        napi_set_element(env, destroyed, i, item);
    }
    napi_create_array_with_length(env, warning_count, &warning_list);
    for (uint32_t i = 0; i < warning_count; i++) {
        napi_create_string_utf8(env, warnings[i], NAPI_AUTO_LENGTH, &value);
        napi_set_element(env, warning_list, i, value);
    }
    napi_set_named_property(env, result, "destroyed", destroyed);
    napi_set_named_property(env, result, "warnings", warning_list);
    napi_create_uint32(env, access_begun, &value);
    napi_set_named_property(env, result, "accessBegun", value);
    napi_create_uint32(env, access_ended, &value);
    napi_set_named_property(env, result, "accessEnded", value);
    pthread_mutex_unlock(&records_mutex);
    return result;
}

static napi_value
init(napi_env env, napi_value exports) {
    main_thread = pthread_self();
    napi_property_descriptor desc[] = {
            DECLARE_NAPI_METHOD("createSource", createSource),
            DECLARE_NAPI_METHOD("createFrame", createFrame),
            DECLARE_NAPI_METHOD("retainFrame", retainFrame),
            DECLARE_NAPI_METHOD("releaseNative", releaseNative),
            DECLARE_NAPI_METHOD("liveFrames", liveFrames),
            DECLARE_NAPI_METHOD("records", records),
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
