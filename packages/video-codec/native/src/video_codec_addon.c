/*
 * The video codec's addon (src/H264Encoder.ts): the GStreamer encoder (gst_frame_encoder.c) fed with frames
 * (packages/frames). encode() takes a reference to the frame of a JavaScript frame handle; the encoder releases it when
 * GStreamer is done reading the buffer, on a GStreamer thread, and the frame library takes that release back to the
 * frame's creating thread (capture's: wlroots buffers are unlocked there). The codec knows nothing about capture.
 */
#include <stdlib.h>
#include "encoder.h"
#include "nebula_frame.h"
#include "node_api.h"

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }

struct node_frame_encoder {
    struct frame_encoder *encoder;
    napi_threadsafe_function js_cb_ref;
};

static napi_value
undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

/* On a GStreamer thread. */
static void
sample_ready_callback(void *user_data, struct encoded_frame *encoded_frame) {
    struct node_frame_encoder *node_frame_encoder = user_data;
    napi_call_threadsafe_function(node_frame_encoder->js_cb_ref, encoded_frame, napi_tsfn_blocking);
}

static void
finalize_encoded_frame(napi_env env, void *finalize_data, void *finalize_hint) {
    (void) env, (void) finalize_data;
    encoded_frame_finalize((struct encoded_frame *) finalize_hint);
}

static void
encoded_frame_to_node_buffer_cb(napi_env env, napi_value js_callback, void *context, void *data) {
    (void) context;
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

static struct node_frame_encoder *
encoder_arg(napi_env env, napi_callback_info info, size_t argc, napi_value *argv) {
    struct node_frame_encoder *node_frame_encoder = NULL;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_get_value_external(env, argv[0], (void **) &node_frame_encoder);
    return node_frame_encoder;
}

// createEncoder(type: 'nvh264' | 'vaapih264' | 'x264', onFrame) -> encoder
static napi_value
createEncoder(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2], result, name;
    char preferred_encoder[16] = {0};
    size_t length;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_get_value_string_latin1(env, argv[0], preferred_encoder, sizeof(preferred_encoder), &length);

    struct node_frame_encoder *node_frame_encoder = calloc(1, sizeof(*node_frame_encoder));
    if (frame_encoder_create(preferred_encoder, sample_ready_callback, node_frame_encoder,
                             &node_frame_encoder->encoder) == -1) {
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
destroyEncoder(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    struct node_frame_encoder *node_frame_encoder = encoder_arg(env, info, 1, argv);
    frame_encoder_destroy(&node_frame_encoder->encoder);
    return undefined(env);
}

static napi_value
requestKeyUnit(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    struct node_frame_encoder *node_frame_encoder = encoder_arg(env, info, 1, argv);
    frame_encoder_request_key_unit(&node_frame_encoder->encoder);
    return undefined(env);
}

// setQuality(encoder, high): the quality of the frames from the next one on
static napi_value
setQuality(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    bool high;
    struct node_frame_encoder *node_frame_encoder = encoder_arg(env, info, 2, argv);
    napi_get_value_bool(env, argv[1], &high);
    frame_encoder_set_quality(&node_frame_encoder->encoder, high);
    return undefined(env);
}

// encode(encoder, frame): encodes the frame; the encoder holds its own reference to it until GStreamer is done
static napi_value
encode(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    struct node_frame_encoder *node_frame_encoder = encoder_arg(env, info, 2, argv);
    struct nebula_frame *frame = nebula_frame_from_js(env, argv[1]);
    if (frame == NULL) {
        napi_throw_type_error(env, NULL, "Can't encode: not a frame, or a released one.");
        return undefined(env);
    }
    // the encoder takes over this reference
    if (frame_encoder_encode(&node_frame_encoder->encoder, frame) == -1) {
        napi_throw_error(env, NULL, "Can't encode frame buffer.");
    }
    return undefined(env);
}

static napi_value
init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
            DECLARE_NAPI_METHOD("createEncoder", createEncoder),
            DECLARE_NAPI_METHOD("destroyEncoder", destroyEncoder),
            DECLARE_NAPI_METHOD("requestKeyUnit", requestKeyUnit),
            DECLARE_NAPI_METHOD("setQuality", setQuality),
            DECLARE_NAPI_METHOD("encode", encode),
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
