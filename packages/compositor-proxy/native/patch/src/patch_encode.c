/*
 * nebula-patch-addon: the lossless patch encoder (ROADMAP.md, "Encoding policy": the QOI cascade). Called
 * synchronously, from worker threads (the addon is context aware, every worker loads its own instance).
 *
 *   encodePatch(rgba: Uint8Array, width, height, opaque: boolean) -> { format, channels, data: Uint8Array }
 *
 * `rgba` is tightly packed RGBA, 8 bits per channel. The cascade:
 *   1. QOI (3 channels if opaque, else 4). If the result is at least 90% of the raw size, it's noise: raw if the QOI
 *      is bigger than the raw pixels, else the QOI as it is. No LZ4.
 *   2. Else LZ4 over the QOI: if that's smaller than the QOI, QOI + LZ4 (the LZ4 block of the whole QOI stream), else
 *      the plain QOI.
 * Raw is RGB for an opaque patch, RGBA otherwise. The format numbers are the scene protocol's PatchFormat.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "node_api.h"

#define QOI_IMPLEMENTATION
#include "qoi.h"
#include "lz4.h"

#define FORMAT_RAW 0
#define FORMAT_QOI 1
#define FORMAT_QOI_LZ4 2

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }

struct encoded_patch {
    uint8_t format;
    uint8_t channels;
    const uint8_t *data;
    size_t length;
    /* owned memory to free (data may point into one of them, or into the caller's pixels) */
    uint8_t *packed;
    uint8_t *qoi;
    uint8_t *lz4;
};

/* 0 on success, -1 on failure (bad size, out of memory) */
static int
encode_patch(const uint8_t *rgba, uint32_t width, uint32_t height, bool opaque, struct encoded_patch *out) {
    memset(out, 0, sizeof(*out));
    size_t count = (size_t) width * height;
    unsigned channels = opaque ? 3 : 4;
    const uint8_t *pixels = rgba;
    if (opaque) {
        out->packed = malloc(count * 3);
        if (out->packed == NULL) {
            return -1;
        }
        uint8_t *to = out->packed;
        for (const uint8_t *from = rgba, *end = rgba + count * 4; from < end; from += 4, to += 3) {
            to[0] = from[0];
            to[1] = from[1];
            to[2] = from[2];
        }
        pixels = out->packed;
    }
    size_t raw = count * channels;
    qoi_desc desc = {.width = width, .height = height, .channels = (uint8_t) channels, .colorspace = QOI_SRGB};
    int qoi_length;
    out->qoi = qoi_encode(pixels, &desc, &qoi_length);
    if (out->qoi == NULL) {
        return -1;
    }
    out->channels = (uint8_t) channels;
    size_t qoi = (size_t) qoi_length;
    if (qoi * 10 >= raw * 9) {
        if (qoi > raw) {
            out->format = FORMAT_RAW;
            out->data = pixels;
            out->length = raw;
        } else {
            out->format = FORMAT_QOI;
            out->data = out->qoi;
            out->length = qoi;
        }
        return 0;
    }
    // a destination one byte short of the QOI: LZ4 fails (returns 0) unless its result is smaller
    out->lz4 = malloc(qoi);
    int lz4_length = out->lz4 == NULL ? 0
                                      : LZ4_compress_default((const char *) out->qoi, (char *) out->lz4, qoi_length,
                                                             qoi_length - 1);
    if (lz4_length > 0 && (size_t) lz4_length < qoi) {
        out->format = FORMAT_QOI_LZ4;
        out->data = out->lz4;
        out->length = (size_t) lz4_length;
    } else {
        out->format = FORMAT_QOI;
        out->data = out->qoi;
        out->length = qoi;
    }
    return 0;
}

static void
release(struct encoded_patch *patch) {
    free(patch->packed);
    free(patch->qoi);
    free(patch->lz4);
}

static napi_value
throw_error(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}

/* encodePatch(rgba, width, height, opaque) */
static napi_value
encode_patch_js(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4) {
        return throw_error(env, "encodePatch(rgba, width, height, opaque)");
    }
    bool is_typedarray = false;
    napi_is_typedarray(env, argv[0], &is_typedarray);
    if (!is_typedarray) {
        return throw_error(env, "encodePatch: rgba must be a Uint8Array");
    }
    napi_typedarray_type type;
    size_t array_length, byte_offset;
    void *data;
    napi_value array_buffer;
    if (napi_get_typedarray_info(env, argv[0], &type, &array_length, &data, &array_buffer, &byte_offset) != napi_ok ||
        type != napi_uint8_array) {
        return throw_error(env, "encodePatch: rgba must be a Uint8Array");
    }
    uint32_t width, height;
    bool opaque;
    if (napi_get_value_uint32(env, argv[1], &width) != napi_ok || napi_get_value_uint32(env, argv[2], &height) != napi_ok ||
        napi_get_value_bool(env, argv[3], &opaque) != napi_ok) {
        return throw_error(env, "encodePatch: bad width, height or opaque");
    }
    if (width == 0 || height == 0 || width >= 65536 || height >= 65536 || array_length != (size_t) width * height * 4) {
        return throw_error(env, "encodePatch: the pixels don't match width x height x 4");
    }
    struct encoded_patch patch;
    if (encode_patch(data, width, height, opaque, &patch) != 0) {
        release(&patch);
        return throw_error(env, "encodePatch: encoding failed");
    }
    napi_value result, buffer, bytes, format, channels;
    void *copy;
    napi_status status = napi_create_arraybuffer(env, patch.length, &copy, &buffer);
    if (status == napi_ok) {
        memcpy(copy, patch.data, patch.length);
        status = napi_create_typedarray(env, napi_uint8_array, patch.length, buffer, 0, &bytes);
    }
    uint8_t patch_format = patch.format, patch_channels = patch.channels;
    release(&patch);
    if (status != napi_ok) {
        return throw_error(env, "encodePatch: out of memory");
    }
    napi_create_object(env, &result);
    napi_create_uint32(env, patch_format, &format);
    napi_create_uint32(env, patch_channels, &channels);
    napi_set_named_property(env, result, "format", format);
    napi_set_named_property(env, result, "channels", channels);
    napi_set_named_property(env, result, "data", bytes);
    return result;
}

static napi_value
init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {DECLARE_NAPI_METHOD("encodePatch", encode_patch_js)};
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
