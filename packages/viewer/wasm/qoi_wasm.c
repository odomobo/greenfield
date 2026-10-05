/*

Copyright (c) 2021, Dominic Szablewski - https://phoboslab.org
SPDX-License-Identifier: MIT

(QOI-LICENSE has the licence text.) This file is qoi_decode() of qoi.h, adapted: no malloc, no libc. It decodes into a
buffer the caller provides, always as 4 channels (RGBA, alpha 255 for 3-channel files), so that the result is ImageData.

*/

#define QOI_OP_INDEX 0x00
#define QOI_OP_DIFF 0x40
#define QOI_OP_LUMA 0x80
#define QOI_OP_RUN 0xc0
#define QOI_OP_RGB 0xfe
#define QOI_OP_RGBA 0xff
#define QOI_MASK_2 0xc0
#define QOI_COLOR_HASH(C) (C.rgba.r * 3 + C.rgba.g * 5 + C.rgba.b * 7 + C.rgba.a * 11)
#define QOI_MAGIC (((unsigned int) 'q') << 24 | ((unsigned int) 'o') << 16 | ((unsigned int) 'i') << 8 | ((unsigned int) 'f'))
#define QOI_HEADER_SIZE 14
#define QOI_PIXELS_MAX ((unsigned int) 400000000)

typedef union {
    struct {
        unsigned char r, g, b, a;
    } rgba;
    unsigned int v;
} qoi_rgba_t;

static unsigned int qoi_read_32(const unsigned char *bytes, int *p) {
    unsigned int a = bytes[(*p)++];
    unsigned int b = bytes[(*p)++];
    unsigned int c = bytes[(*p)++];
    unsigned int d = bytes[(*p)++];
    return a << 24 | b << 16 | c << 8 | d;
}

/* Decode `size` bytes of QOI at `data` into `pixels` (room for `capacity` bytes). Returns width << 16 | height (both
   below 65536), or 0 if the data is invalid or doesn't fit. */
unsigned int qoi_decode_into(const unsigned char *bytes, int size, unsigned char *pixels, int capacity) {
    qoi_rgba_t index[64];
    qoi_rgba_t px;
    int px_len, chunks_len, px_pos;
    int p = 0, run = 0;

    if (size < QOI_HEADER_SIZE + 8) return 0;
    unsigned int magic = qoi_read_32(bytes, &p);
    unsigned int width = qoi_read_32(bytes, &p);
    unsigned int height = qoi_read_32(bytes, &p);
    int channels = bytes[p++];
    int colorspace = bytes[p++];
    if (width == 0 || height == 0 || channels < 3 || channels > 4 || colorspace > 1 || magic != QOI_MAGIC ||
        height >= QOI_PIXELS_MAX / width || width >= 65536 || height >= 65536)
        return 0;
    px_len = width * height * 4;
    if (px_len > capacity) return 0;

    for (int i = 0; i < 64; i++) index[i].v = 0;
    px.rgba.r = 0;
    px.rgba.g = 0;
    px.rgba.b = 0;
    px.rgba.a = 255;

    chunks_len = size - 8;
    for (px_pos = 0; px_pos < px_len; px_pos += 4) {
        if (run > 0) {
            run--;
        } else if (p < chunks_len) {
            int b1 = bytes[p++];
            if (b1 == QOI_OP_RGB) {
                px.rgba.r = bytes[p++];
                px.rgba.g = bytes[p++];
                px.rgba.b = bytes[p++];
            } else if (b1 == QOI_OP_RGBA) {
                px.rgba.r = bytes[p++];
                px.rgba.g = bytes[p++];
                px.rgba.b = bytes[p++];
                px.rgba.a = bytes[p++];
            } else if ((b1 & QOI_MASK_2) == QOI_OP_INDEX) {
                px = index[b1];
            } else if ((b1 & QOI_MASK_2) == QOI_OP_DIFF) {
                px.rgba.r += ((b1 >> 4) & 0x03) - 2;
                px.rgba.g += ((b1 >> 2) & 0x03) - 2;
                px.rgba.b += (b1 & 0x03) - 2;
            } else if ((b1 & QOI_MASK_2) == QOI_OP_LUMA) {
                int b2 = bytes[p++];
                int vg = (b1 & 0x3f) - 32;
                px.rgba.r += vg - 8 + ((b2 >> 4) & 0x0f);
                px.rgba.g += vg;
                px.rgba.b += vg - 8 + (b2 & 0x0f);
            } else if ((b1 & QOI_MASK_2) == QOI_OP_RUN) {
                run = (b1 & 0x3f);
            }
            index[QOI_COLOR_HASH(px) & (64 - 1)] = px;
        }
        *(unsigned int *) (pixels + px_pos) = px.v; /* little endian: r, g, b, a bytes */
    }
    return width << 16 | height;
}
