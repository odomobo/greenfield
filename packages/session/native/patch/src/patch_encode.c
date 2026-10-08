/*
 * nebula-patch-addon: the patch encoder (ROADMAP.md, "Encoding policy": the QOI cascade, and JPEG while bandwidth is
 * short). Called synchronously, from worker threads (the addon is context aware, every worker loads its own instance).
 *
 *   encodePatch(rgba: Uint8Array, width, height, opaque: boolean, jpegQuality = 0) -> { format, channels, data }
 *
 * `rgba` is tightly packed RGBA, 8 bits per channel. The cascade:
 *   1. QOI (3 channels if opaque, else 4). If the result is at least 90% of the raw size, it's noise: raw if the QOI
 *      is bigger than the raw pixels, else the QOI as it is. No LZ4.
 *   2. Else LZ4 over the QOI: if that's smaller than the QOI, QOI + LZ4 (the LZ4 block of the whole QOI stream), else
 *      the plain QOI.
 * Raw is RGB for an opaque patch, RGBA otherwise. The format numbers are the scene protocol's PatchFormat.
 *
 * With a JPEG quality (1-100; 0: lossless only) the patch is also encoded as JPEG (libjpeg-turbo, 4:4:4 so colored text
 * stays readable): one color JPEG if it's opaque, else the color JPEG and a grayscale JPEG of the alpha (JPEG with
 * alpha: u32le length of the color JPEG, the color JPEG, the alpha JPEG). Whichever of the lossless result and the JPEG
 * is smaller is sent: UI content often compresses better losslessly, and then nothing needs refreshing later.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h> /* jpeglib.h needs FILE */
#include <setjmp.h>
#include <jpeglib.h>
#include "node_api.h"

#define QOI_IMPLEMENTATION
#include "qoi.h"
#include "lz4.h"

#define FORMAT_RAW 0
#define FORMAT_QOI 1
#define FORMAT_QOI_LZ4 2
#define FORMAT_JPEG 3
#define FORMAT_JPEG_ALPHA 4

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
    uint8_t *jpeg;
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

struct jpeg_error {
    struct jpeg_error_mgr manager;
    jmp_buf jump;
};

static void
jpeg_error_exit(j_common_ptr cinfo) {
    longjmp(((struct jpeg_error *) cinfo->err)->jump, 1);
}

static void
jpeg_quiet(j_common_ptr cinfo) {
    (void) cinfo;
}

/*
 * The JPEG of width x height pixels (`components` bytes each: RGBA, of which the alpha is left out, or gray) into `out`,
 * which has `capacity` bytes: more than any JPEG of these pixels can take, so libjpeg never has to grow it. Returns its
 * length, 0 on failure.
 */
static size_t
compress_jpeg(const uint8_t *pixels, uint32_t width, uint32_t height, int components, int quality, uint8_t *out,
              size_t capacity) {
    struct jpeg_compress_struct cinfo;
    struct jpeg_error error;
    unsigned char *buffer = out;
    unsigned long length = capacity;
    cinfo.err = jpeg_std_error(&error.manager);
    error.manager.error_exit = jpeg_error_exit;
    error.manager.output_message = jpeg_quiet;
    if (setjmp(error.jump)) {
        jpeg_destroy_compress(&cinfo);
        return 0;
    }
    jpeg_create_compress(&cinfo);
    jpeg_mem_dest(&cinfo, &buffer, &length);
    cinfo.image_width = width;
    cinfo.image_height = height;
    cinfo.input_components = components;
    cinfo.in_color_space = components == 1 ? JCS_GRAYSCALE : JCS_EXT_RGBX;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, quality, TRUE);
    for (int i = 0; i < cinfo.num_components; i++) {
        // 4:4:4, no chroma subsampling
        cinfo.comp_info[i].h_samp_factor = 1;
        cinfo.comp_info[i].v_samp_factor = 1;
    }
    jpeg_start_compress(&cinfo, TRUE);
    while (cinfo.next_scanline < height) {
        JSAMPROW row = (JSAMPROW) (pixels + (size_t) cinfo.next_scanline * width * components);
        jpeg_write_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    if (buffer != out) {
        // (it outgrew the capacity after all: libjpeg allocated its own)
        free(buffer);
        return 0;
    }
    return length;
}

/* Replaces `out`'s result with the JPEG (with alpha) if that is smaller. 0 on success (either way), -1 on failure. */
static int
encode_jpeg_if_smaller(const uint8_t *rgba, uint32_t width, uint32_t height, bool opaque, int quality,
                       struct encoded_patch *out) {
    size_t count = (size_t) width * height;
    // a JPEG of 4:4:4 data is far smaller than this at any quality but 100 (blocks rounded up, headers)
    size_t padded = (size_t) ((width + 7) & ~7u) * ((height + 7) & ~7u);
    size_t color_capacity = padded * 3 * 2 + 4096;
    size_t alpha_capacity = opaque ? 0 : padded * 2 + 4096;
    uint8_t *jpeg = malloc(4 + color_capacity + alpha_capacity);
    if (jpeg == NULL) {
        return -1;
    }
    size_t color = compress_jpeg(rgba, width, height, 4, quality, jpeg + 4, color_capacity);
    if (color == 0) {
        free(jpeg);
        return -1;
    }
    size_t length;
    if (opaque) {
        memmove(jpeg, jpeg + 4, color);
        length = color;
    } else {
        uint8_t *gray = malloc(count);
        if (gray == NULL) {
            free(jpeg);
            return -1;
        }
        for (size_t i = 0; i < count; i++) {
            gray[i] = rgba[i * 4 + 3];
        }
        size_t alpha = compress_jpeg(gray, width, height, 1, quality, jpeg + 4 + color, alpha_capacity);
        free(gray);
        if (alpha == 0) {
            free(jpeg);
            return -1;
        }
        jpeg[0] = (uint8_t) color;
        jpeg[1] = (uint8_t) (color >> 8);
        jpeg[2] = (uint8_t) (color >> 16);
        jpeg[3] = (uint8_t) (color >> 24);
        length = 4 + color + alpha;
    }
    if (length < out->length) {
        out->format = opaque ? FORMAT_JPEG : FORMAT_JPEG_ALPHA;
        out->channels = opaque ? 3 : 4;
        out->data = jpeg;
        out->length = length;
        out->jpeg = jpeg;
    } else {
        free(jpeg);
    }
    return 0;
}

static void
release(struct encoded_patch *patch) {
    free(patch->packed);
    free(patch->qoi);
    free(patch->lz4);
    free(patch->jpeg);
}

static napi_value
throw_error(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}

/* encodePatch(rgba, width, height, opaque, jpegQuality = 0) */
static napi_value
encode_patch_js(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value argv[5];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4) {
        return throw_error(env, "encodePatch(rgba, width, height, opaque, jpegQuality)");
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
    uint32_t jpeg_quality = 0;
    if (argc >= 5 && napi_get_value_uint32(env, argv[4], &jpeg_quality) != napi_ok) {
        return throw_error(env, "encodePatch: bad jpegQuality");
    }
    if (jpeg_quality > 100) {
        return throw_error(env, "encodePatch: jpegQuality is 0 (lossless) or 1-100");
    }
    if (width == 0 || height == 0 || width >= 65536 || height >= 65536 || array_length != (size_t) width * height * 4) {
        return throw_error(env, "encodePatch: the pixels don't match width x height x 4");
    }
    struct encoded_patch patch;
    if (encode_patch(data, width, height, opaque, &patch) != 0 ||
        (jpeg_quality > 0 && encode_jpeg_if_smaller(data, width, height, opaque, (int) jpeg_quality, &patch) != 0)) {
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
