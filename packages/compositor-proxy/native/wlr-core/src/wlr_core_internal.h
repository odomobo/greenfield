/*
 * What the core's source files share (wlr_core.c and wlr_core_xwayland.c). Not part of the addon's interface.
 */
#ifndef GFLD_WLR_CORE_INTERNAL_H
#define GFLD_WLR_CORE_INTERNAL_H

#include <stdbool.h>
#include <stdint.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/util/box.h>
#include "node_api.h"

/* not exported from the addon */
#define WLR_CORE_INTERNAL __attribute__((visibility("hidden")))

struct x11;
struct xwin;

struct core {
    napi_env env;
    napi_ref on_event;

    struct wl_display *display;
    struct wl_event_loop *loop;
    struct wlr_backend *backend;
    struct wlr_output *output;
    /* the output's logical size (CSS pixels), the viewer's scale and its ceiling (wl_output.scale) */
    int32_t output_width, output_height;
    double scale;
    int output_scale;
    struct wlr_compositor *compositor;
    struct wlr_xdg_shell *xdg_shell;
    struct wlr_seat *seat;
    struct wlr_keyboard keyboard;
    /* the xkb masks of the viewer's modifiers (see sync_modifiers), for this keymap */
    struct xkb_keymap *mods_keymap;
    uint32_t mod_ctrl, mod_shift, mod_alt, mod_meta, mod_altgr, mod_caps, mod_num;
    struct wlr_cursor_shape_manager_v1 *cursor_shape_manager;
    struct wlr_presentation *presentation;
    uint64_t presentation_seq;
    struct wlr_xdg_activation_v1 *xdg_activation;
    struct wl_listener request_activate;
    const char *socket;
    /* XWayland, NULL if it's disabled or couldn't be set up */
    struct x11 *x11;

    struct wl_list surfaces; // gsurf.link
    /* > 0 while JavaScript handles an event (and may call back in) */
    int emitting;
    uint32_t next_sid;
    uint32_t next_client_id;

    struct wl_listener new_surface;
    struct wl_listener new_xdg_surface;
    struct wl_listener request_set_cursor;
    struct wl_listener request_set_selection;
    struct wl_listener request_set_primary_selection;
    struct wl_listener set_selection;
    struct wl_listener request_start_drag;
    struct wl_listener start_drag;
    struct wl_listener request_set_shape;
    struct wl_listener keyboard_key;
    struct wl_listener keyboard_modifiers;
    struct wl_listener client_created;
};

/* A wl_surface, of any role. Toplevels are reported by the sid of their surface. */
struct gsurf {
    struct wl_list link;
    struct core *core;
    uint32_t sid;
    struct wlr_surface *surface;
    char key[32];
    /*
     * The last committed buffer, locked until the next commit replaces it (wlroots itself unlocks it right after the
     * commit event): patches read it later, when there is room to send them.
     */
    struct wlr_buffer *buffer;

    struct wl_listener commit;
    struct wl_listener destroy;
    struct wl_listener map;
    struct wl_listener unmap;

    struct wlr_xdg_toplevel *toplevel;
    struct wl_listener xdg_destroy;
    struct wl_listener request_move;
    struct wl_listener request_resize;
    struct wl_listener request_maximize;
    struct wl_listener request_fullscreen;
    struct wl_listener request_minimize;
    struct wl_listener set_title;
    struct wl_listener set_app_id;
    struct wl_listener set_parent;

    /* the X11 window this is the surface of (XWayland), NULL if none */
    struct xwin *xwin;

    /* where the scene shows a toplevel's surface on the output (setPosition); popups are kept inside the output */
    int32_t pos_x, pos_y;
};

/* A configure from JavaScript: a size (negative: unchanged) and states (-1: unchanged, 0, 1). */
struct configure_request {
    int32_t width, height;
    int maximized, fullscreen, activated, resizing;
};

struct toplevel_state {
    struct wlr_box geometry;
    int32_t configured_width, configured_height;
    bool maximized, fullscreen;
};

WLR_CORE_INTERNAL void emit(struct core *core, const char *type, size_t argc, napi_value *argv);
WLR_CORE_INTERNAL napi_value u32(struct core *core, uint32_t value);
WLR_CORE_INTERNAL napi_value i32(struct core *core, int32_t value);
WLR_CORE_INTERNAL napi_value str(struct core *core, const char *value);
WLR_CORE_INTERNAL napi_value boolean(struct core *core, bool value);
WLR_CORE_INTERNAL struct gsurf *gsurf_from_surface(struct core *core, struct wlr_surface *surface);
WLR_CORE_INTERNAL struct gsurf *gsurf_from_sid(struct core *core, uint32_t sid);
/* the core of this process; throws a JavaScript error and returns NULL if there is none */
WLR_CORE_INTERNAL struct core *core_or_throw(napi_env env);
/* what every call from JavaScript ends with (does nothing while JavaScript handles an event) */
WLR_CORE_INTERNAL void core_flush(struct core *core);

/* The clipboard (wlr_core_clipboard.c): remote selections to JavaScript ("clipboard-text" events), setClipboardText. */
WLR_CORE_INTERNAL void clipboard_init(struct core *core);

/* Write text to a pipe the receiver of a data source gave us, without blocking (closes fd when done). */
WLR_CORE_INTERNAL void core_write_text_async(const char *data, size_t length, int fd);

/* Drag and drop (wlr_core_dnd.c): drags of remote apps ("drag-start", "drag-icon", "drag-end" events). */
WLR_CORE_INTERNAL void dnd_init(struct core *core);

/*
 * XWayland (wlr_core_xwayland.c). X11 windows are reported like xdg toplevels (toplevel-* events, by the sid of
 * their surface), override-redirect windows (menus, tooltips) as surfaces of the window they belong to.
 */

/* Start XWayland's X11 display (Xwayland itself starts when the first X11 app connects). Its name, NULL if none. */
WLR_CORE_INTERNAL const char *x11_create(struct core *core);
/* gsurf->xwin is set: hooks from the surface's own listeners */
WLR_CORE_INTERNAL void x11_surface_mapped(struct gsurf *gsurf);
WLR_CORE_INTERNAL void x11_surface_unmapped(struct gsurf *gsurf);
WLR_CORE_INTERNAL void x11_surface_destroyed(struct gsurf *gsurf);
/* false if the surface isn't an X11 toplevel */
WLR_CORE_INTERNAL bool x11_configure(struct gsurf *gsurf, const struct configure_request *request);
WLR_CORE_INTERNAL bool x11_close(struct gsurf *gsurf);
WLR_CORE_INTERNAL bool x11_toplevel_state(struct gsurf *gsurf, struct toplevel_state *state);
WLR_CORE_INTERNAL bool x11_window_surfaces(struct gsurf *gsurf, wlr_surface_iterator_func_t iterator, void *data);
WLR_CORE_INTERNAL void x11_set_position(struct gsurf *gsurf, int32_t x, int32_t y);

#endif //GFLD_WLR_CORE_INTERNAL_H
