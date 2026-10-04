/*
 * The GStreamer video encoder (native/encoding) fed from wlroots buffers: the frame is the surface's current wlr_buffer instead of a wl_buffer resource. The buffer stays locked
 * until the encoder is done with it, so the client gets its release only then.
 */
#include <assert.h>
#include <stdlib.h>
#include <drm_fourcc.h>
#include <wlr/types/wlr_buffer.h>
#include "encoder.h"
#include "node_api.h"
#include "wlr_core.h"

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }

/* frame_buffer.user_data belongs to the encoder (its reference count), the locked buffer goes alongside. */
struct locked_frame_buffer {
    struct frame_buffer frame_buffer;
    struct wlr_buffer *buffer;
};

struct node_frame_encoder {
    struct frame_encoder *encoder;
    napi_threadsafe_function js_cb_ref;
};

static napi_threadsafe_function discard_frame_buffer_js_cb_ref;

static napi_value
undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

/* On the main thread: the encoder is done reading the buffer. */
static void
discard_frame_buffer_cb_node(napi_env env, napi_value js_callback, void *context, void *data) {
    struct locked_frame_buffer *locked = data;
    wlr_buffer_unlock(locked->buffer);
    free(locked);
}

/* On a GStreamer thread. */
static void
discard_frame_buffer_cb(const struct frame_buffer *frame_buffer) {
    napi_call_threadsafe_function(discard_frame_buffer_js_cb_ref, (void *) frame_buffer, napi_tsfn_blocking);
}

static void
sample_ready_callback(void *user_data, struct encoded_frame *encoded_frame) {
    struct node_frame_encoder *node_frame_encoder = user_data;
    napi_call_threadsafe_function(node_frame_encoder->js_cb_ref, encoded_frame, napi_tsfn_blocking);
}

static void
finalize_encoded_frame(napi_env env, void *finalize_data, void *finalize_hint) {
    encoded_frame_finalize((struct encoded_frame *) finalize_hint);
}

static void
encoded_frame_to_node_buffer_cb(napi_env env, napi_value js_callback, void *context, void *data) {
    napi_value buffer_value, global, result;
    struct encoded_frame *encoded_frame = data;
    if (encoded_frame == NULL) {
        napi_get_undefined(env, &buffer_value);
    } else {
        napi_create_external_buffer(env, encoded_frame->size, encoded_frame->encoded_data, finalize_encoded_frame,
                                    encoded_frame, &buffer_value);
    }
    napi_get_global(env, &global);
    napi_call_function(env, global, js_callback, 1, &buffer_value, &result);
}

// createFrameEncoder(type: 'x264' | 'nvh264' | 'vaapih264', onFrame) -> encoder
static napi_value
createFrameEncoder(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2], result, name;
    char preferred_encoder[16] = {0};
    size_t length;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_get_value_string_latin1(env, argv[0], preferred_encoder, sizeof(preferred_encoder), &length);

    struct node_frame_encoder *node_frame_encoder = calloc(1, sizeof(*node_frame_encoder));
    // no EGL: shared memory buffers only (the prototype doesn't do dmabufs)
    if (frame_encoder_create(preferred_encoder, sample_ready_callback, node_frame_encoder,
                             &node_frame_encoder->encoder, NULL) == -1) {
        free(node_frame_encoder);
        napi_throw_error(env, NULL, "Can't create frame encoder.");
        return undefined(env);
    }
    napi_create_string_utf8(env, "frame_sample_callback", NAPI_AUTO_LENGTH, &name);
    napi_create_threadsafe_function(env, argv[1], NULL, name, 0, 2, NULL, NULL, node_frame_encoder,
                                    encoded_frame_to_node_buffer_cb, &node_frame_encoder->js_cb_ref);
    napi_unref_threadsafe_function(env, node_frame_encoder->js_cb_ref);
    napi_create_external(env, node_frame_encoder, NULL, NULL, &result);
    return result;
}

static napi_value
destroyFrameEncoder(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct node_frame_encoder *node_frame_encoder;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_get_value_external(env, argv[0], (void **) &node_frame_encoder);
    frame_encoder_destroy(&node_frame_encoder->encoder);
    return undefined(env);
}

static napi_value
requestKeyUnit(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct node_frame_encoder *node_frame_encoder;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_get_value_external(env, argv[0], (void **) &node_frame_encoder);
    frame_encoder_request_key_unit(&node_frame_encoder->encoder);
    return undefined(env);
}

/* The encoder takes wl_shm formats, which equal the DRM ones except for these two. */
static uint32_t
wl_shm_format_from_drm(uint32_t drm_format) {
    switch (drm_format) {
        case DRM_FORMAT_ARGB8888:
            return WL_SHM_FORMAT_ARGB8888;
        case DRM_FORMAT_XRGB8888:
            return WL_SHM_FORMAT_XRGB8888;
        default:
            return drm_format;
    }
}

// encodeFrame(encoder, sid, contentSerial, creationSerial): encodes the surface's current buffer
static napi_value
encodeFrame(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4];
    struct node_frame_encoder *node_frame_encoder;
    uint32_t sid, content_serial, creation_serial;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_get_value_external(env, argv[0], (void **) &node_frame_encoder);
    napi_get_value_uint32(env, argv[1], &sid);
    napi_get_value_uint32(env, argv[2], &content_serial);
    napi_get_value_uint32(env, argv[3], &creation_serial);

    struct wlr_buffer *buffer = wlr_core_surface_buffer(sid);
    void *data;
    uint32_t format;
    size_t stride;
    if (buffer == NULL ||
        !wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride)) {
        napi_throw_error(env, NULL, "Can't encode frame buffer, no readable buffer.");
        return undefined(env);
    }
    // The mapping stays valid while the buffer is locked (wlr_shm keeps it until the last buffer of the pool is gone).
    // The encoder thread reads it without SIGBUS protection.
    wlr_buffer_end_data_ptr_access(buffer);

    struct locked_frame_buffer *locked = calloc(1, sizeof(*locked));
    locked->buffer = wlr_buffer_lock(buffer);
    struct frame_buffer *frame_buffer = &locked->frame_buffer;
    frame_buffer->type = SHM;
    frame_buffer->buffer_id = sid;
    frame_buffer->width = (uint32_t) buffer->width;
    frame_buffer->height = (uint32_t) buffer->height;
    frame_buffer->discard_cb = discard_frame_buffer_cb;
    frame_buffer->impl.shm.buffer_format = wl_shm_format_from_drm(format);
    frame_buffer->impl.shm.buffer_data = data;
    frame_buffer->impl.shm.buffer_stride = (uint32_t) stride;
    frame_buffer->impl.shm.pool = NULL;

    if (frame_encoder_encode(&node_frame_encoder->encoder, frame_buffer, content_serial, creation_serial) == -1) {
        napi_throw_error(env, NULL, "Can't encode frame buffer.");
    }
    return undefined(env);
}

napi_value
wlr_core_encoder_init(napi_env env, napi_value exports) {
    napi_value name;
    napi_create_string_utf8(env, "discard_frame_buffer_callback", NAPI_AUTO_LENGTH, &name);
    napi_create_threadsafe_function(env, NULL, NULL, name, 0, 3, NULL, NULL, NULL, discard_frame_buffer_cb_node,
                                    &discard_frame_buffer_js_cb_ref);
    napi_unref_threadsafe_function(env, discard_frame_buffer_js_cb_ref);
    napi_property_descriptor desc[] = {
            DECLARE_NAPI_METHOD("createFrameEncoder", createFrameEncoder),
            DECLARE_NAPI_METHOD("destroyFrameEncoder", destroyFrameEncoder),
            DECLARE_NAPI_METHOD("requestKeyUnit", requestKeyUnit),
            DECLARE_NAPI_METHOD("encodeFrame", encodeFrame),
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
