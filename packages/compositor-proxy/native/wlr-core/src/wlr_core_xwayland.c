/*
 * X11 apps (ROADMAP.md, Core item 1, wave 2 B): wlroots' XWayland support, an X11 display served by Xwayland (started
 * lazily, when the first X11 app connects) with wlroots' X11 window manager (xwm).
 *
 * Xwayland is an ordinary Wayland client of ours: every X11 window it shows has a wl_surface, which goes through the
 * same surface handling, encoders and frame pacing as any other (wlr_core.c). This file adds what X11 needs on top:
 * - Managed X11 windows are reported like xdg toplevels (toplevel-new with x11 = true, title, app id from WM_CLASS,
 *   parent from WM_TRANSIENT_FOR, move/resize/maximize/fullscreen/minimize requests), by the sid of their surface, so
 *   the window policy in JavaScript is the same for both.
 * - Override-redirect windows (menus, tooltips, dropdowns; X11 apps place them themselves, in root coordinates) are
 *   shown as surfaces of the window they belong to, like xdg popups, at their position relative to it.
 * - X11 apps know where their windows are (X11 has absolute positions, Wayland doesn't): JavaScript tells us with
 *   setPosition, so menus open in the right place and pointer coordinates match.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/util/log.h>
#include <wlr/xcursor.h>
#include <wlr/xwayland.h>
#include <xcb/xcb.h>
#include "wlr_core_internal.h"

struct x11 {
    struct core *core;
    struct wlr_xwayland *xwayland;
    struct wl_list windows; // xwin.link
    /* mapped override-redirect windows, in the order they were mapped (bottom to top) */
    struct wl_list overrides; // xwin.override_link

    struct wl_listener new_surface;
    struct wl_listener ready;
};

/* An X11 window (wlr_xwayland_surface), managed or override-redirect. */
struct xwin {
    struct wl_list link;
    struct wl_list override_link; // in x11.overrides while it's a mapped override-redirect window
    struct x11 *x11;
    struct wlr_xwayland_surface *xsurface;
    /* its surface, while associated */
    struct gsurf *gsurf;
    /* reported to JavaScript as a toplevel (managed window, associated) */
    bool toplevel;
    /* override-redirect: the toplevel it's shown with (NULL: not shown) */
    struct xwin *owner;
    /* the states we gave it */
    bool maximized, fullscreen;
    /* its size before it was maximized */
    uint16_t restore_width, restore_height;

    struct wl_listener destroy;
    struct wl_listener associate;
    struct wl_listener dissociate;
    struct wl_listener request_configure;
    struct wl_listener request_move;
    struct wl_listener request_resize;
    struct wl_listener request_minimize;
    struct wl_listener request_maximize;
    struct wl_listener request_fullscreen;
    struct wl_listener set_title;
    struct wl_listener set_class;
    struct wl_listener set_parent;
    struct wl_listener set_geometry;
    struct wl_listener set_override_redirect;
};

static void
emit_sid(struct xwin *xwin, const char *type) {
    struct core *core = xwin->x11->core;
    napi_value args[] = {u32(core, xwin->gsurf->sid)};
    emit(core, type, 1, args);
}

static void
report_title(struct xwin *xwin) {
    struct core *core = xwin->x11->core;
    napi_value args[] = {u32(core, xwin->gsurf->sid), str(core, xwin->xsurface->title)};
    emit(core, "toplevel-title", 2, args);
}

static void
report_app_id(struct xwin *xwin) {
    struct core *core = xwin->x11->core;
    // WM_CLASS: the class ("XTerm") is what desktop entries match (StartupWMClass); the instance is the fallback
    const char *app_id = xwin->xsurface->class ? xwin->xsurface->class : xwin->xsurface->instance;
    napi_value args[] = {u32(core, xwin->gsurf->sid), str(core, app_id)};
    emit(core, "toplevel-app-id", 2, args);
}

/* The toplevel an X11 window is transient for (its nearest managed ancestor), NULL if none. */
static struct xwin *
transient_for(struct xwin *xwin) {
    for (struct wlr_xwayland_surface *parent = xwin->xsurface->parent; parent; parent = parent->parent) {
        struct xwin *candidate = parent->data;
        if (candidate && candidate->toplevel) {
            return candidate;
        }
        if (candidate && candidate->owner) {
            return candidate->owner;
        }
    }
    return NULL;
}

static void
report_parent(struct xwin *xwin) {
    struct core *core = xwin->x11->core;
    struct xwin *parent = transient_for(xwin);
    napi_value args[] = {u32(core, xwin->gsurf->sid), u32(core, parent ? parent->gsurf->sid : 0)};
    emit(core, "toplevel-parent", 2, args);
}

// ---------------------------------------------------------------------------------------------------------------------
// toplevels and override-redirect windows

/* A managed window got its surface: report it as a toplevel. */
static void
toplevel_start(struct xwin *xwin) {
    struct core *core = xwin->x11->core;
    xwin->toplevel = true;
    napi_value args[] = {u32(core, xwin->gsurf->sid), boolean(core, true)};
    emit(core, "toplevel-new", 2, args);
    report_title(xwin);
    report_app_id(xwin);
    if (transient_for(xwin)) {
        report_parent(xwin);
    }
}

static void
toplevel_end(struct xwin *xwin) {
    if (!xwin->toplevel) {
        return;
    }
    xwin->toplevel = false;
    // its menus and tooltips go with it
    struct xwin *other;
    wl_list_for_each(other, &xwin->x11->windows, link) {
        if (other->owner == xwin) {
            other->owner = NULL;
        }
    }
    emit_sid(xwin, "toplevel-destroy");
}

/* The X11 toplevel a surface belongs to (an override-redirect's owner), NULL if none. */
static struct xwin *
toplevel_of_surface(struct x11 *x11, struct wlr_surface *surface) {
    struct gsurf *gsurf = surface ? gsurf_from_surface(x11->core, surface) : NULL;
    if (gsurf == NULL || gsurf->xwin == NULL) {
        return NULL;
    }
    return gsurf->xwin->toplevel ? gsurf->xwin : gsurf->xwin->owner;
}

/*
 * Which window an override-redirect window (menu, tooltip) is shown with. X11 doesn't say; in order: the window it's
 * transient for (some toolkits set it), the X11 window under the pointer (tooltips, menus opened by a click), the one
 * with the keyboard focus (menus opened with the keyboard), the app's own topmost window.
 */
static struct xwin *
override_owner(struct xwin *xwin) {
    struct x11 *x11 = xwin->x11;
    struct xwin *owner = transient_for(xwin);
    if (owner == NULL) {
        owner = toplevel_of_surface(x11, x11->core->seat->pointer_state.focused_surface);
    }
    if (owner == NULL) {
        owner = toplevel_of_surface(x11, x11->core->seat->keyboard_state.focused_surface);
    }
    if (owner == NULL) {
        struct xwin *candidate;
        wl_list_for_each(candidate, &x11->windows, link) {
            if (candidate->toplevel && candidate->gsurf->surface->mapped &&
                candidate->xsurface->pid == xwin->xsurface->pid) {
                owner = candidate;
            }
        }
    }
    return owner;
}

void
x11_surface_mapped(struct gsurf *gsurf) {
    struct xwin *xwin = gsurf->xwin;
    if (xwin->xsurface->override_redirect) {
        xwin->owner = override_owner(xwin);
        wl_list_remove(&xwin->override_link);
        wl_list_insert(xwin->x11->overrides.prev, &xwin->override_link);
    }
}

void
x11_surface_unmapped(struct gsurf *gsurf) {
    struct xwin *xwin = gsurf->xwin;
    wl_list_remove(&xwin->override_link);
    wl_list_init(&xwin->override_link);
    xwin->owner = NULL;
}

/* The surface goes away (before XWayland dissociates the window from it). */
void
x11_surface_destroyed(struct gsurf *gsurf) {
    struct xwin *xwin = gsurf->xwin;
    toplevel_end(xwin);
    x11_surface_unmapped(gsurf);
    xwin->gsurf = NULL;
    gsurf->xwin = NULL;
}

static void
handle_associate(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, associate);
    struct gsurf *gsurf = gsurf_from_surface(xwin->x11->core, xwin->xsurface->surface);
    if (gsurf == NULL) {
        return;
    }
    xwin->gsurf = gsurf;
    gsurf->xwin = xwin;
    if (!xwin->xsurface->override_redirect) {
        toplevel_start(xwin);
    }
}

static void
handle_dissociate(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, dissociate);
    if (xwin->gsurf) {
        x11_surface_destroyed(xwin->gsurf);
    }
}

/* An X11 window can become (or stop being) override-redirect while it exists. */
static void
handle_set_override_redirect(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, set_override_redirect);
    if (xwin->gsurf == NULL) {
        return;
    }
    if (xwin->xsurface->override_redirect) {
        toplevel_end(xwin);
    } else if (!xwin->toplevel) {
        wl_list_remove(&xwin->override_link);
        wl_list_init(&xwin->override_link);
        xwin->owner = NULL;
        toplevel_start(xwin);
    }
}

static void
handle_request_configure(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, request_configure);
    struct wlr_xwayland_surface_configure_event *event = data;
    struct wlr_xwayland_surface *xsurface = xwin->xsurface;
    if (xwin->gsurf == NULL || !xwin->gsurf->surface->mapped) {
        // not shown yet: as it likes (where it's shown is up to the viewer)
        wlr_xwayland_surface_configure(xsurface, event->x, event->y, event->width, event->height);
    } else if (xwin->maximized || xwin->fullscreen) {
        // keeps its size; X11 wants an answer
        wlr_xwayland_surface_configure(xsurface, xsurface->x, xsurface->y, xsurface->width, xsurface->height);
    } else {
        // its size, not its position: windows are moved by the user
        wlr_xwayland_surface_configure(xsurface, xsurface->x, xsurface->y, event->width, event->height);
    }
}

static void
handle_request_move(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, request_move);
    if (xwin->toplevel) {
        emit_sid(xwin, "toplevel-request-move");
    }
}

static void
handle_request_resize(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, request_resize);
    struct wlr_xwayland_resize_event *event = data;
    if (xwin->toplevel) {
        // WLR_EDGE_* bits are the same as xdg_toplevel's resize edges
        struct core *core = xwin->x11->core;
        napi_value args[] = {u32(core, xwin->gsurf->sid), u32(core, event->edges)};
        emit(core, "toplevel-request-resize", 2, args);
    }
}

static void
handle_request_minimize(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, request_minimize);
    struct wlr_xwayland_minimize_event *event = data;
    if (xwin->toplevel && event->minimize) {
        emit_sid(xwin, "toplevel-request-minimize");
    }
}

static void
handle_request_maximize(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, request_maximize);
    if (xwin->toplevel) {
        // xwm already took the requested state from _NET_WM_STATE
        struct core *core = xwin->x11->core;
        bool maximized = xwin->xsurface->maximized_horz && xwin->xsurface->maximized_vert;
        napi_value args[] = {u32(core, xwin->gsurf->sid), boolean(core, maximized)};
        emit(core, "toplevel-request-maximize", 2, args);
    }
}

static void
handle_request_fullscreen(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, request_fullscreen);
    if (xwin->toplevel) {
        struct core *core = xwin->x11->core;
        napi_value args[] = {u32(core, xwin->gsurf->sid), boolean(core, xwin->xsurface->fullscreen)};
        emit(core, "toplevel-request-fullscreen", 2, args);
    }
}

static void
handle_set_title(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, set_title);
    if (xwin->toplevel) {
        report_title(xwin);
    }
}

static void
handle_set_class(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, set_class);
    if (xwin->toplevel) {
        report_app_id(xwin);
    }
}

static void
handle_set_parent(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, set_parent);
    if (xwin->toplevel) {
        report_parent(xwin);
    }
}

/* An override-redirect window moved itself (a tooltip following the pointer): the scene changes. */
static void
handle_set_geometry(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, set_geometry);
    if (xwin->gsurf && xwin->owner) {
        emit_sid(xwin, "x11-geometry");
    }
}

static void
handle_xwin_destroy(struct wl_listener *listener, void *data) {
    struct xwin *xwin = wl_container_of(listener, xwin, destroy);
    if (xwin->gsurf) {
        x11_surface_destroyed(xwin->gsurf);
    }
    struct xwin *other;
    wl_list_for_each(other, &xwin->x11->windows, link) {
        if (other->owner == xwin) {
            other->owner = NULL;
        }
    }
    wl_list_remove(&xwin->link);
    wl_list_remove(&xwin->override_link);
    wl_list_remove(&xwin->destroy.link);
    wl_list_remove(&xwin->associate.link);
    wl_list_remove(&xwin->dissociate.link);
    wl_list_remove(&xwin->request_configure.link);
    wl_list_remove(&xwin->request_move.link);
    wl_list_remove(&xwin->request_resize.link);
    wl_list_remove(&xwin->request_minimize.link);
    wl_list_remove(&xwin->request_maximize.link);
    wl_list_remove(&xwin->request_fullscreen.link);
    wl_list_remove(&xwin->set_title.link);
    wl_list_remove(&xwin->set_class.link);
    wl_list_remove(&xwin->set_parent.link);
    wl_list_remove(&xwin->set_geometry.link);
    wl_list_remove(&xwin->set_override_redirect.link);
    xwin->xsurface->data = NULL;
    free(xwin);
}

static void
handle_new_xsurface(struct wl_listener *listener, void *data) {
    struct x11 *x11 = wl_container_of(listener, x11, new_surface);
    struct wlr_xwayland_surface *xsurface = data;
    struct xwin *xwin = calloc(1, sizeof(*xwin));
    xwin->x11 = x11;
    xwin->xsurface = xsurface;
    xsurface->data = xwin;
    wl_list_insert(x11->windows.prev, &xwin->link);
    wl_list_init(&xwin->override_link);

#define LISTEN(signal, field, handler) xwin->field.notify = handler; wl_signal_add(&xsurface->events.signal, &xwin->field)
    LISTEN(destroy, destroy, handle_xwin_destroy);
    LISTEN(associate, associate, handle_associate);
    LISTEN(dissociate, dissociate, handle_dissociate);
    LISTEN(request_configure, request_configure, handle_request_configure);
    LISTEN(request_move, request_move, handle_request_move);
    LISTEN(request_resize, request_resize, handle_request_resize);
    LISTEN(request_minimize, request_minimize, handle_request_minimize);
    LISTEN(request_maximize, request_maximize, handle_request_maximize);
    LISTEN(request_fullscreen, request_fullscreen, handle_request_fullscreen);
    LISTEN(set_title, set_title, handle_set_title);
    LISTEN(set_class, set_class, handle_set_class);
    LISTEN(set_parent, set_parent, handle_set_parent);
    LISTEN(set_geometry, set_geometry, handle_set_geometry);
    LISTEN(set_override_redirect, set_override_redirect, handle_set_override_redirect);
#undef LISTEN
}

/* Xwayland is up: give the root window a cursor (X11 apps that don't set their own show it). */
static void
handle_ready(struct wl_listener *listener, void *data) {
    struct x11 *x11 = wl_container_of(listener, x11, ready);
    wlr_log(WLR_INFO, "Xwayland is ready on %s", x11->xwayland->display_name);
    struct wlr_xcursor_manager *cursors = wlr_xcursor_manager_create(NULL, 24);
    if (cursors == NULL || !wlr_xcursor_manager_load(cursors, 1)) {
        wlr_xcursor_manager_destroy(cursors);
        return;
    }
    struct wlr_xcursor *cursor = wlr_xcursor_manager_get_xcursor(cursors, "default", 1);
    if (cursor == NULL) {
        cursor = wlr_xcursor_manager_get_xcursor(cursors, "left_ptr", 1);
    }
    if (cursor && cursor->image_count > 0) {
        struct wlr_xcursor_image *image = cursor->images[0];
        wlr_xwayland_set_cursor(x11->xwayland, image->buffer, image->width * 4, image->width, image->height,
                                (int32_t) image->hotspot_x, (int32_t) image->hotspot_y);
    }
    wlr_xcursor_manager_destroy(cursors);
}

const char *
x11_create(struct core *core) {
    struct x11 *x11 = calloc(1, sizeof(*x11));
    x11->core = core;
    wl_list_init(&x11->windows);
    wl_list_init(&x11->overrides);
    // lazy: Xwayland runs only once an X11 app connects
    x11->xwayland = wlr_xwayland_create(core->display, core->compositor, true);
    if (x11->xwayland == NULL) {
        wlr_log(WLR_ERROR, "XWayland is not available: X11 apps won't run.");
        free(x11);
        return NULL;
    }
    x11->new_surface.notify = handle_new_xsurface;
    wl_signal_add(&x11->xwayland->events.new_surface, &x11->new_surface);
    x11->ready.notify = handle_ready;
    wl_signal_add(&x11->xwayland->events.ready, &x11->ready);
    // clipboard and primary selection between X11 and Wayland apps
    wlr_xwayland_set_seat(x11->xwayland, core->seat);
    core->x11 = x11;
    return x11->xwayland->display_name;
}

// ---------------------------------------------------------------------------------------------------------------------
// calls from JavaScript

bool
x11_configure(struct gsurf *gsurf, const struct configure_request *request) {
    struct xwin *xwin = gsurf->xwin;
    if (xwin == NULL || !xwin->toplevel) {
        return false;
    }
    struct wlr_xwayland_surface *xsurface = xwin->xsurface;
    if (!gsurf->surface->mapped) {
        // going away (unmapped, maybe destroyed already in X11): nothing to tell it
        return true;
    }
    if (request->maximized >= 0 && request->maximized != xwin->maximized) {
        if (request->maximized && !xwin->fullscreen) {
            xwin->restore_width = xsurface->width;
            xwin->restore_height = xsurface->height;
        }
        xwin->maximized = request->maximized;
    }
    if (request->fullscreen >= 0 && request->fullscreen != xwin->fullscreen) {
        if (request->fullscreen && !xwin->maximized) {
            xwin->restore_width = xsurface->width;
            xwin->restore_height = xsurface->height;
        }
        xwin->fullscreen = request->fullscreen;
    }
    // _NET_WM_STATE is ours to set. A configure without any change answers a request: the app wrote the state it
    // wanted into xwm's copy, so this also puts back what it has when we didn't grant it.
    bool answer = request->width < 0 && request->height < 0 && request->activated < 0 && request->resizing < 0;
    if (answer || request->maximized >= 0 || request->fullscreen >= 0) {
        wlr_xwayland_surface_set_maximized(xsurface, xwin->maximized);
        wlr_xwayland_surface_set_fullscreen(xsurface, xwin->fullscreen);
    }

    int32_t width = request->width, height = request->height;
    if (width == 0 && height == 0) {
        // xdg's "you choose": back to the size it had
        width = xwin->restore_width ? xwin->restore_width : xsurface->width;
        height = xwin->restore_height ? xwin->restore_height : xsurface->height;
    }
    if (width > 0 && height > 0 && (width != xsurface->width || height != xsurface->height)) {
        wlr_xwayland_surface_configure(xsurface, xsurface->x, xsurface->y, (uint16_t) width, (uint16_t) height);
    }
    if (request->activated == 1) {
        wlr_xwayland_surface_activate(xsurface, true);
        wlr_xwayland_surface_restack(xsurface, NULL, XCB_STACK_MODE_ABOVE);
    } else if (request->activated == 0) {
        wlr_xwayland_surface_activate(xsurface, false);
    }
    return true;
}

bool
x11_close(struct gsurf *gsurf) {
    if (gsurf->xwin == NULL || !gsurf->xwin->toplevel) {
        return false;
    }
    wlr_xwayland_surface_close(gsurf->xwin->xsurface);
    return true;
}

bool
x11_toplevel_state(struct gsurf *gsurf, struct toplevel_state *state) {
    struct xwin *xwin = gsurf->xwin;
    if (xwin == NULL || !xwin->toplevel) {
        return false;
    }
    // no client-side shadows in X11: the window is all of its surface
    state->geometry = (struct wlr_box){
            .x = 0,
            .y = 0,
            .width = gsurf->surface->current.width,
            .height = gsurf->surface->current.height,
    };
    state->configured_width = xwin->xsurface->width;
    state->configured_height = xwin->xsurface->height;
    state->maximized = xwin->maximized;
    state->fullscreen = xwin->fullscreen;
    return true;
}

struct offset_iterator {
    wlr_surface_iterator_func_t iterator;
    void *data;
    int dx, dy;
};

static void
iterate_with_offset(struct wlr_surface *surface, int sx, int sy, void *data) {
    struct offset_iterator *offset = data;
    offset->iterator(surface, sx + offset->dx, sy + offset->dy, offset->data);
}

bool
x11_window_surfaces(struct gsurf *gsurf, wlr_surface_iterator_func_t iterator, void *data) {
    struct xwin *xwin = gsurf->xwin;
    if (xwin == NULL || !xwin->toplevel) {
        return false;
    }
    wlr_surface_for_each_surface(gsurf->surface, iterator, data);
    // its menus and tooltips, above it, where the app put them (in root coordinates, as the window's position is)
    struct xwin *override;
    wl_list_for_each(override, &xwin->x11->overrides, override_link) {
        if (override->owner == xwin && override->gsurf) {
            struct offset_iterator offset = {
                    .iterator = iterator,
                    .data = data,
                    .dx = override->xsurface->x - xwin->xsurface->x,
                    .dy = override->xsurface->y - xwin->xsurface->y,
            };
            wlr_surface_for_each_surface(override->gsurf->surface, iterate_with_offset, &offset);
        }
    }
    return true;
}

void
x11_set_position(struct gsurf *gsurf, int32_t x, int32_t y) {
    struct xwin *xwin = gsurf->xwin;
    if (xwin == NULL || !xwin->toplevel) {
        return;
    }
    struct wlr_xwayland_surface *xsurface = xwin->xsurface;
    if (xsurface->x != x || xsurface->y != y) {
        wlr_xwayland_surface_configure(xsurface, (int16_t) x, (int16_t) y, xsurface->width, xsurface->height);
    }
}
