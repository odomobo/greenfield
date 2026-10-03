#ifndef GFLD_WLR_CORE_H
#define GFLD_WLR_CORE_H

#include <stdint.h>

struct wlr_buffer;

/** The current (last committed) buffer of a surface, NULL if it has none. */
struct wlr_buffer *wlr_core_surface_buffer(uint32_t sid);

#endif //GFLD_WLR_CORE_H
