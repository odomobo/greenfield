/*
 * The frame's JavaScript handle (the `Frame` interface of @nebula/session-contracts): a plain object with width,
 * height, contentSerial, readPixels(rect) and release(). The object wraps the frame pointer (napi_wrap) and holds one
 * reference to it; release() removes the wrap and drops the reference, so a released handle no longer has a frame. If
 * the handle is collected without release(), its finalizer drops the reference (the held-too-long warning will
 * usually have reported it by then).
 *
 * Handles are type-tagged (napi_type_tag_object): a native consumer accepts only objects with the frame tag. Every copy
 * of the library uses the same tag, so a frame created by capture's copy is accepted by a consumer's copy.
 */
#include <stdlib.h>
#include "nebula_frame.h"

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }

static const napi_type_tag frame_tag = {0x6e6562756c612d66ULL, 0x72616d652d763031ULL};

static napi_value
undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static napi_value
u32(napi_env env, uint32_t value) {
    napi_value result;
    napi_create_uint32(env, value, &result);
    return result;
}

/* The handle was collected without release(). */
static void
handle_finalize(napi_env env, void *data, void *hint) {
    (void) env, (void) hint;
    nebula_frame_release(data);
}

/* The frame wrapped by `this`, NULL if it was released (no reference added). */
static struct nebula_frame *
this_frame(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv, napi_value *this_value) {
    void *frame = NULL;
    if (napi_get_cb_info(env, info, argc, argv, this_value, NULL) != napi_ok ||
        napi_unwrap(env, *this_value, &frame) != napi_ok) {
        return NULL;
    }
    return frame;
}

static int32_t
rect_field(napi_env env, napi_value rect, const char *name) {
    napi_value value;
    int32_t result = 0;
    if (napi_get_named_property(env, rect, name, &value) == napi_ok) {
        napi_get_value_int32(env, value, &result);
    }
    return result;
}

/*
 * readPixels(rect) -> { pixels: Uint8Array RGBA, opaque: boolean } | undefined
 * A copy in a plain ArrayBuffer, so it can be transferred to an encoder worker. undefined if the frame was released or
 * can't be read this way (not shared memory, an unsupported format, a rectangle outside the buffer).
 */
static napi_value
handle_read_pixels(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1], this_value, array_buffer, pixels_array, opaque_value, result;
    struct nebula_frame *frame = this_frame(env, info, &argc, argv, &this_value);
    if (frame == NULL || argc < 1) {
        return undefined(env);
    }
    int32_t x = rect_field(env, argv[0], "x"), y = rect_field(env, argv[0], "y");
    int32_t width = rect_field(env, argv[0], "width"), height = rect_field(env, argv[0], "height");
    if (width <= 0 || height <= 0 || (int64_t) width * height > INT32_MAX / 4) {
        return undefined(env);
    }
    size_t length = (size_t) width * height * 4;
    uint8_t *pixels;
    bool opaque;
    if (napi_create_arraybuffer(env, length, (void **) &pixels, &array_buffer) != napi_ok ||
        !nebula_frame_read_rgba(frame, x, y, width, height, pixels, &opaque)) {
        return undefined(env);
    }
    if (napi_create_typedarray(env, napi_uint8_array, length, array_buffer, 0, &pixels_array) != napi_ok ||
        napi_get_boolean(env, opaque, &opaque_value) != napi_ok || napi_create_object(env, &result) != napi_ok ||
        napi_set_named_property(env, result, "pixels", pixels_array) != napi_ok ||
        napi_set_named_property(env, result, "opaque", opaque_value) != napi_ok) {
        return undefined(env);
    }
    return result;
}

/* release(): drops the handle's reference; later calls do nothing. */
static napi_value
handle_release(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value this_value;
    void *frame = NULL;
    if (this_frame(env, info, &argc, NULL, &this_value) != NULL &&
        napi_remove_wrap(env, this_value, &frame) == napi_ok && frame != NULL) {
        nebula_frame_release(frame);
    }
    return undefined(env);
}

napi_value
nebula_frame_to_js(napi_env env, struct nebula_frame *frame) {
    napi_value object;
    if (napi_create_object(env, &object) != napi_ok || napi_type_tag_object(env, object, &frame_tag) != napi_ok ||
        napi_wrap(env, object, frame, handle_finalize, NULL, NULL) != napi_ok) {
        nebula_frame_release(frame);
        return undefined(env);
    }
    napi_property_descriptor properties[] = {
            {"width", 0, 0, 0, 0, u32(env, frame->width), napi_enumerable, 0},
            {"height", 0, 0, 0, 0, u32(env, frame->height), napi_enumerable, 0},
            {"contentSerial", 0, 0, 0, 0, u32(env, frame->content_serial), napi_enumerable, 0},
            DECLARE_NAPI_METHOD("readPixels", handle_read_pixels),
            DECLARE_NAPI_METHOD("release", handle_release),
    };
    napi_define_properties(env, object, sizeof(properties) / sizeof(properties[0]), properties);
    return object;
}

struct nebula_frame *
nebula_frame_from_js(napi_env env, napi_value value) {
    napi_valuetype type;
    bool tagged = false;
    void *frame = NULL;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_object ||
        napi_check_object_type_tag(env, value, &frame_tag, &tagged) != napi_ok || !tagged ||
        napi_unwrap(env, value, &frame) != napi_ok || !nebula_frame_is_valid(frame)) {
        return NULL;
    }
    nebula_frame_retain(frame);
    return frame;
}
