#ifndef APP_ENDPOINT_ENCODING_PIXELS_H
#define APP_ENDPOINT_ENCODING_PIXELS_H

#include <stdint.h>
#include <stdbool.h>

struct wl_resource;
struct westfield_egl;

/**
 * A rectangle of a buffer as tightly packed RGBA rows, top to bottom. NULL if the rectangle is out of bounds or the
 * buffer can't be read (unsupported format, external-only dmabuf, ...). The caller frees the result.
 */
uint8_t *
read_buffer_pixels(struct wl_resource *buffer_resource, struct westfield_egl *westfield_egl,
                   int32_t x, int32_t y, int32_t width, int32_t height);

bool
get_buffer_size(struct wl_resource *buffer_resource, uint32_t *width, uint32_t *height);

#endif //APP_ENDPOINT_ENCODING_PIXELS_H
