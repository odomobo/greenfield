/*
 * wlroots prototype (ROADMAP.md, Core item 1): the Wayland side of a session on wlroots 0.17 instead of the libwayland
 * fork and the TypeScript protocol implementation.
 *
 * wlroots implements the protocols; this file only wires it up and reports what the window scene needs to JavaScript
 * (src/wlroots/WlrCompositor.ts), which keeps the policy: window positions, stacking, focus, frame pacing and encoding.
 * Nothing is rendered or composited here: the compositor has no renderer (so wlroots doesn't copy shared memory
 * buffers into textures), and each surface's committed client buffer stays locked until the next commit replaces it.
 * It is read directly (patches) or handed to the video encoder.
 *
 * Runs on Node's main thread. wlroots' event loop is driven from JavaScript (dispatch() when its fd is readable), so
 * every wlroots callback, and every event reported to JavaScript, happens inside a call from JavaScript.
 */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <drm_fourcc.h>
#include <wayland-server-core.h>
#include <xkbcommon/xkbcommon.h>
#include <wlr/backend.h>
#include <wlr/backend/headless.h>
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor_shape_v1.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_fractional_scale_v1.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_idle_inhibit_v1.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_presentation_time.h>
#include <wlr/types/wlr_single_pixel_buffer_v1.h>
#include <wlr/types/wlr_viewporter.h>
#include <wlr/types/wlr_xdg_activation_v1.h>
#include <wlr/types/wlr_xdg_output_v1.h>
#include <wlr/types/wlr_primary_selection.h>
#include <wlr/types/wlr_primary_selection_v1.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_shm.h>
#include <wlr/types/wlr_subcompositor.h>
#include <wlr/types/wlr_viewporter.h>
#include <wlr/types/wlr_xdg_output_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/util/log.h>
#include "node_api.h"
#include "wlr_core.h"
#include "wlr_core_internal.h"

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }
#define NAPI_CALL(env, the_call)                                                    \
    if ((the_call) != napi_ok) {                                                    \
        const napi_extended_error_info *error_info;                                 \
        napi_get_last_error_info((env), &error_info);                               \
        bool is_pending;                                                            \
        napi_is_exception_pending((env), &is_pending);                              \
        if (!is_pending) {                                                          \
            napi_throw_error((env), NULL, error_info->error_message ? error_info->error_message : "napi error"); \
        }                                                                           \
    }

/* Our id for a Wayland client, reported to JavaScript with its process (client-new, client-destroy). */
struct client_id {
    struct wl_listener destroy;
    struct core *core;
    uint32_t id;
};

/* The one core of this process (there is one session per process). */
static struct core *the_core = NULL;

static void
client_id_destroy(struct wl_listener *listener, void *data) {
    struct client_id *client_id = wl_container_of(listener, client_id, destroy);
    struct core *core = client_id->core;
    uint32_t id = client_id->id;
    wl_list_remove(&client_id->destroy.link);
    free(client_id);
    napi_value args[] = {u32(core, id)};
    emit(core, "client-destroy", 1, args);
}

static uint32_t
client_id_of(struct core *core, struct wl_client *client) {
    struct wl_listener *listener = wl_client_get_destroy_listener(client, client_id_destroy);
    if (listener) {
        struct client_id *client_id = wl_container_of(listener, client_id, destroy);
        return client_id->id;
    }
    struct client_id *client_id = calloc(1, sizeof(*client_id));
    client_id->core = core;
    client_id->id = ++core->next_client_id;
    client_id->destroy.notify = client_id_destroy;
    wl_client_add_destroy_listener(client, &client_id->destroy);
    return client_id->id;
}

/* A new connection: report its process (from the socket's credentials), so apps started outside the shell (from a
 * terminal in the session) are known too. */
static void
handle_client_created(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, client_created);
    struct wl_client *client = data;
    pid_t pid = 0;
    wl_client_get_credentials(client, &pid, NULL, NULL);
    napi_value args[] = {u32(core, client_id_of(core, client)), i32(core, pid)};
    emit(core, "client-new", 2, args);
}

struct gsurf *
gsurf_from_surface(struct core *core, struct wlr_surface *surface) {
    if (surface == NULL) {
        return NULL;
    }
    struct gsurf *gsurf;
    wl_list_for_each(gsurf, &core->surfaces, link) {
        if (gsurf->surface == surface) {
            return gsurf;
        }
    }
    return NULL;
}

struct gsurf *
gsurf_from_sid(struct core *core, uint32_t sid) {
    struct gsurf *gsurf;
    wl_list_for_each(gsurf, &core->surfaces, link) {
        if (gsurf->sid == sid) {
            return gsurf;
        }
    }
    return NULL;
}

// ---------------------------------------------------------------------------------------------------------------------
// events to JavaScript: onEvent(type, ...args)

void
emit(struct core *core, const char *type, size_t argc, napi_value *argv) {
    napi_env env = core->env;
    napi_value args[12], callback, global, result;
    assert(argc < 11);
    napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &args[0]);
    for (size_t i = 0; i < argc; i++) {
        args[i + 1] = argv[i];
    }
    napi_get_reference_value(env, core->on_event, &callback);
    napi_get_global(env, &global);
    core->emitting++;
    napi_status status = napi_call_function(env, global, callback, argc + 1, args, &result);
    core->emitting--;
    if (status != napi_ok) {
        // an exception in the handler must not stop wlroots' dispatch; report it and carry on
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (pending) {
            napi_value exception;
            napi_get_and_clear_last_exception(env, &exception);
            napi_value message;
            char text[512] = {0};
            if (napi_coerce_to_string(env, exception, &message) == napi_ok) {
                napi_get_value_string_utf8(env, message, text, sizeof(text), NULL);
            }
            fprintf(stderr, "wlr-core: exception in %s handler: %s\n", type, text);
        }
    }
}

napi_value
u32(struct core *core, uint32_t value) {
    napi_value result;
    napi_create_uint32(core->env, value, &result);
    return result;
}

napi_value
i32(struct core *core, int32_t value) {
    napi_value result;
    napi_create_int32(core->env, value, &result);
    return result;
}

napi_value
str(struct core *core, const char *value) {
    napi_value result;
    if (value == NULL) {
        napi_get_null(core->env, &result);
    } else {
        napi_create_string_utf8(core->env, value, NAPI_AUTO_LENGTH, &result);
    }
    return result;
}

napi_value
boolean(struct core *core, bool value) {
    napi_value result;
    napi_get_boolean(core->env, value, &result);
    return result;
}

/* A region as a flat Int32Array of x, y, width, height. */
static napi_value
region_rects(struct core *core, const pixman_region32_t *region) {
    int n = 0;
    const pixman_box32_t *boxes = pixman_region32_rectangles((pixman_region32_t *) region, &n);
    napi_value array_buffer, result;
    int32_t *data;
    napi_create_arraybuffer(core->env, (size_t) n * 4 * sizeof(int32_t), (void **) &data, &array_buffer);
    for (int i = 0; i < n; i++) {
        data[i * 4] = boxes[i].x1;
        data[i * 4 + 1] = boxes[i].y1;
        data[i * 4 + 2] = boxes[i].x2 - boxes[i].x1;
        data[i * 4 + 3] = boxes[i].y2 - boxes[i].y1;
    }
    napi_create_typedarray(core->env, napi_int32_array, (size_t) n * 4, array_buffer, 0, &result);
    return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// surfaces

static void
handle_surface_commit(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, commit);
    struct core *core = gsurf->core;
    struct wlr_surface *surface = gsurf->surface;
    // current.committed accumulates, it doesn't tell what this commit changed. But wlroots drops current.buffer after
    // every commit event, so it is set only if this commit attached a buffer; has_buffer is false after a null attach.
    bool new_buffer = surface->current.buffer != NULL || (!surface->has_buffer && gsurf->buffer != NULL);
    if (new_buffer) {
        if (gsurf->buffer) {
            wlr_buffer_unlock(gsurf->buffer);
        }
        gsurf->buffer = surface->current.buffer ? wlr_buffer_lock(surface->current.buffer) : NULL;
    }
    struct wlr_buffer *buffer = gsurf->buffer;

    // the input region clipped to the surface
    pixman_region32_t input;
    pixman_region32_init(&input);
    pixman_region32_intersect_rect(&input, &surface->input_region, 0, 0, surface->current.width,
                                   surface->current.height);

    napi_value args[] = {
            u32(core, gsurf->sid),
            boolean(core, buffer != NULL),
            boolean(core, new_buffer),
            u32(core, buffer ? (uint32_t) buffer->width : 0),
            u32(core, buffer ? (uint32_t) buffer->height : 0),
            region_rects(core, &surface->buffer_damage),
            u32(core, (uint32_t) surface->current.width),
            u32(core, (uint32_t) surface->current.height),
            region_rects(core, &input),
            boolean(core, !wl_list_empty(&surface->current.frame_callback_list)),
    };
    pixman_region32_fini(&input);
    emit(core, "surface-commit", sizeof(args) / sizeof(args[0]), args);
}

static void
handle_surface_map(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, map);
    if (gsurf->xwin) {
        x11_surface_mapped(gsurf);
    }
    napi_value args[] = {u32(gsurf->core, gsurf->sid)};
    emit(gsurf->core, "surface-map", 1, args);
}

static void
handle_surface_unmap(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, unmap);
    if (gsurf->xwin) {
        x11_surface_unmapped(gsurf);
    }
    napi_value args[] = {u32(gsurf->core, gsurf->sid)};
    emit(gsurf->core, "surface-unmap", 1, args);
}

static void
gsurf_toplevel_listeners_remove(struct gsurf *gsurf) {
    if (gsurf->toplevel == NULL) {
        return;
    }
    wl_list_remove(&gsurf->xdg_destroy.link);
    wl_list_remove(&gsurf->request_move.link);
    wl_list_remove(&gsurf->request_resize.link);
    wl_list_remove(&gsurf->request_maximize.link);
    wl_list_remove(&gsurf->request_fullscreen.link);
    wl_list_remove(&gsurf->request_minimize.link);
    wl_list_remove(&gsurf->set_title.link);
    wl_list_remove(&gsurf->set_app_id.link);
    wl_list_remove(&gsurf->set_parent.link);
    if (gsurf->decoration) {
        wl_list_remove(&gsurf->decoration_request_mode.link);
        wl_list_remove(&gsurf->decoration_destroy.link);
        gsurf->decoration = NULL;
    }
    gsurf->toplevel = NULL;
}

static void
handle_surface_destroy(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, destroy);
    struct core *core = gsurf->core;
    if (gsurf->xwin) {
        // before XWayland's own listener (it dissociates the X11 window after this): reports toplevel-destroy
        x11_surface_destroyed(gsurf);
    }
    napi_value args[] = {u32(core, gsurf->sid)};
    gsurf_toplevel_listeners_remove(gsurf);
    wl_list_remove(&gsurf->commit.link);
    wl_list_remove(&gsurf->destroy.link);
    wl_list_remove(&gsurf->map.link);
    wl_list_remove(&gsurf->unmap.link);
    wl_list_remove(&gsurf->link);
    if (gsurf->buffer) {
        wlr_buffer_unlock(gsurf->buffer);
    }
    emit(core, "surface-destroy", 1, args);
    free(gsurf);
}

/* Tells a surface the scale it should render at: the integer buffer scale, and the exact one for wp_fractional_scale_v1. */
static void
surface_notify_scale(struct core *core, struct wlr_surface *surface) {
    wlr_surface_set_preferred_buffer_scale(surface, core->output_scale);
    wlr_fractional_scale_v1_notify_scale(surface, core->scale);
}

static void
handle_new_surface(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, new_surface);
    struct wlr_surface *surface = data;
    struct gsurf *gsurf = calloc(1, sizeof(*gsurf));
    gsurf->core = core;
    gsurf->sid = ++core->next_sid;
    gsurf->surface = surface;
    snprintf(gsurf->key, sizeof(gsurf->key), "%u/%u", client_id_of(core, wl_resource_get_client(surface->resource)),
             wl_resource_get_id(surface->resource));
    gsurf->commit.notify = handle_surface_commit;
    wl_signal_add(&surface->events.commit, &gsurf->commit);
    gsurf->destroy.notify = handle_surface_destroy;
    wl_signal_add(&surface->events.destroy, &gsurf->destroy);
    gsurf->map.notify = handle_surface_map;
    wl_signal_add(&surface->events.map, &gsurf->map);
    gsurf->unmap.notify = handle_surface_unmap;
    wl_signal_add(&surface->events.unmap, &gsurf->unmap);
    wl_list_insert(&core->surfaces, &gsurf->link);
    // there is no output layout, so wlroots never enters surfaces into the output: clients need it to learn its scale
    wlr_surface_send_enter(surface, core->output);
    surface_notify_scale(core, surface);

    napi_value args[] = {u32(core, gsurf->sid), str(core, gsurf->key)};
    emit(core, "surface-new", 2, args);
}

// ---------------------------------------------------------------------------------------------------------------------
// xdg toplevels

static void
handle_xdg_destroy(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, xdg_destroy);
    napi_value args[] = {u32(gsurf->core, gsurf->sid)};
    gsurf_toplevel_listeners_remove(gsurf);
    emit(gsurf->core, "toplevel-destroy", 1, args);
}

static void
handle_request_move(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, request_move);
    napi_value args[] = {u32(gsurf->core, gsurf->sid)};
    emit(gsurf->core, "toplevel-request-move", 1, args);
}

static void
handle_request_resize(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, request_resize);
    struct wlr_xdg_toplevel_resize_event *event = data;
    napi_value args[] = {u32(gsurf->core, gsurf->sid), u32(gsurf->core, event->edges)};
    emit(gsurf->core, "toplevel-request-resize", 2, args);
}

static void
handle_request_maximize(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, request_maximize);
    napi_value args[] = {u32(gsurf->core, gsurf->sid), boolean(gsurf->core, gsurf->toplevel->requested.maximized)};
    emit(gsurf->core, "toplevel-request-maximize", 2, args);
}

static void
handle_request_fullscreen(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, request_fullscreen);
    napi_value args[] = {u32(gsurf->core, gsurf->sid), boolean(gsurf->core, gsurf->toplevel->requested.fullscreen)};
    emit(gsurf->core, "toplevel-request-fullscreen", 2, args);
}

static void
handle_request_minimize(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, request_minimize);
    napi_value args[] = {u32(gsurf->core, gsurf->sid)};
    emit(gsurf->core, "toplevel-request-minimize", 1, args);
}

static void
handle_set_title(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, set_title);
    napi_value args[] = {u32(gsurf->core, gsurf->sid), str(gsurf->core, gsurf->toplevel->title)};
    emit(gsurf->core, "toplevel-title", 2, args);
}

static void
handle_set_app_id(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, set_app_id);
    napi_value args[] = {u32(gsurf->core, gsurf->sid), str(gsurf->core, gsurf->toplevel->app_id)};
    emit(gsurf->core, "toplevel-app-id", 2, args);
}

static void
handle_set_parent(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, set_parent);
    struct wlr_xdg_toplevel *parent = gsurf->toplevel->parent;
    struct gsurf *parent_gsurf = parent ? gsurf_from_surface(gsurf->core, parent->base->surface) : NULL;
    napi_value args[] = {u32(gsurf->core, gsurf->sid), u32(gsurf->core, parent_gsurf ? parent_gsurf->sid : 0)};
    emit(gsurf->core, "toplevel-parent", 2, args);
}

/*
 * xdg-decoration: the app's choice is respected. An app that asks for client-side mode (Chrome with its own title bar)
 * draws its frame, like apps without a decoration object (GTK); one that asks for server-side mode or has no preference
 * (foot, Qt) gets ours, drawn by the viewer. "toplevel-decorated" tells JavaScript whether the window has our frame.
 */
static void
apply_decoration_mode(struct gsurf *gsurf) {
    bool ours = gsurf->decoration->requested_mode != WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE;
    // the answer is a configure that follows set_mode
    wlr_xdg_toplevel_decoration_v1_set_mode(gsurf->decoration, ours ? WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE
                                                                     : WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
    napi_value args[] = {u32(gsurf->core, gsurf->sid), boolean(gsurf->core, ours)};
    emit(gsurf->core, "toplevel-decorated", 2, args);
}

static void
handle_decoration_request_mode(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, decoration_request_mode);
    apply_decoration_mode(gsurf);
}

static void
handle_decoration_destroy(struct wl_listener *listener, void *data) {
    struct gsurf *gsurf = wl_container_of(listener, gsurf, decoration_destroy);
    wl_list_remove(&gsurf->decoration_request_mode.link);
    wl_list_remove(&gsurf->decoration_destroy.link);
    gsurf->decoration = NULL;
    // the window is undecorated again (the app is expected to draw its own frame now)
    napi_value args[] = {u32(gsurf->core, gsurf->sid), boolean(gsurf->core, false)};
    emit(gsurf->core, "toplevel-decorated", 2, args);
}

static void
handle_new_toplevel_decoration(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, new_toplevel_decoration);
    struct wlr_xdg_toplevel_decoration_v1 *decoration = data;
    struct gsurf *gsurf = gsurf_from_surface(core, decoration->toplevel->base->surface);
    if (gsurf == NULL || gsurf->toplevel != decoration->toplevel || gsurf->decoration != NULL) {
        return;
    }
    gsurf->decoration = decoration;
    gsurf->decoration_request_mode.notify = handle_decoration_request_mode;
    wl_signal_add(&decoration->events.request_mode, &gsurf->decoration_request_mode);
    gsurf->decoration_destroy.notify = handle_decoration_destroy;
    wl_signal_add(&decoration->events.destroy, &gsurf->decoration_destroy);
    apply_decoration_mode(gsurf);
}

/*
 * Keep a new popup (menu, tooltip) inside the output: wlroots flips and slides it as its positioner allows. The
 * constraint box is the output in the root toplevel's surface coordinates, so the scene's position of the toplevel
 * (setPosition) is needed; the popup's parent chain leads to it.
 */
static void
unconstrain_popup(struct core *core, struct wlr_xdg_popup *popup) {
    struct wlr_xdg_surface *root = popup->base;
    while (root != NULL && root->role == WLR_XDG_SURFACE_ROLE_POPUP) {
        if (root->popup->parent == NULL) {
            return;
        }
        root = wlr_xdg_surface_try_from_wlr_surface(root->popup->parent);
    }
    struct gsurf *gsurf = root ? gsurf_from_surface(core, root->surface) : NULL;
    if (gsurf == NULL || core->output == NULL) {
        return;
    }
    struct wlr_box box = {.x = -gsurf->pos_x, .y = -gsurf->pos_y, .width = core->output->width,
                          .height = core->output->height};
    wlr_xdg_popup_unconstrain_from_box(popup, &box);
}

// An app asks for its window to be activated (xdg-activation-v1): reported like a click on the window.
static void
handle_request_activate(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, request_activate);
    struct wlr_xdg_activation_v1_request_activate_event *event = data;
    struct wlr_surface *root = wlr_surface_get_root_surface(event->surface);
    struct wlr_xdg_surface *xdg = wlr_xdg_surface_try_from_wlr_surface(root);
    while (xdg != NULL && xdg->role == WLR_XDG_SURFACE_ROLE_POPUP && xdg->popup->parent != NULL) {
        xdg = wlr_xdg_surface_try_from_wlr_surface(xdg->popup->parent);
    }
    struct gsurf *gsurf = gsurf_from_surface(core, xdg ? xdg->surface : root);
    if (gsurf != NULL && (gsurf->toplevel != NULL || gsurf->xwin != NULL)) {
        napi_value args[] = {u32(core, gsurf->sid)};
        emit(core, "toplevel-request-activate", 1, args);
    }
}

static void
handle_new_xdg_surface(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, new_xdg_surface);
    struct wlr_xdg_surface *xdg_surface = data;
    struct gsurf *gsurf = gsurf_from_surface(core, xdg_surface->surface);
    if (gsurf != NULL && xdg_surface->role == WLR_XDG_SURFACE_ROLE_POPUP) {
        unconstrain_popup(core, xdg_surface->popup);
    }
    if (gsurf == NULL || xdg_surface->role != WLR_XDG_SURFACE_ROLE_TOPLEVEL) {
        // popups are part of their toplevel's surface tree (see windowSurfaces)
        return;
    }
    struct wlr_xdg_toplevel *toplevel = xdg_surface->toplevel;
    gsurf->toplevel = toplevel;
    gsurf->xdg_destroy.notify = handle_xdg_destroy;
    wl_signal_add(&xdg_surface->events.destroy, &gsurf->xdg_destroy);
    gsurf->request_move.notify = handle_request_move;
    wl_signal_add(&toplevel->events.request_move, &gsurf->request_move);
    gsurf->request_resize.notify = handle_request_resize;
    wl_signal_add(&toplevel->events.request_resize, &gsurf->request_resize);
    gsurf->request_maximize.notify = handle_request_maximize;
    wl_signal_add(&toplevel->events.request_maximize, &gsurf->request_maximize);
    gsurf->request_fullscreen.notify = handle_request_fullscreen;
    wl_signal_add(&toplevel->events.request_fullscreen, &gsurf->request_fullscreen);
    gsurf->request_minimize.notify = handle_request_minimize;
    wl_signal_add(&toplevel->events.request_minimize, &gsurf->request_minimize);
    gsurf->set_title.notify = handle_set_title;
    wl_signal_add(&toplevel->events.set_title, &gsurf->set_title);
    gsurf->set_app_id.notify = handle_set_app_id;
    wl_signal_add(&toplevel->events.set_app_id, &gsurf->set_app_id);
    gsurf->set_parent.notify = handle_set_parent;
    wl_signal_add(&toplevel->events.set_parent, &gsurf->set_parent);

    napi_value args[] = {u32(core, gsurf->sid)};
    emit(core, "toplevel-new", 1, args);
    // title, app id and parent may have been set before the first commit
    handle_set_title(&gsurf->set_title, NULL);
    handle_set_app_id(&gsurf->set_app_id, NULL);
    if (toplevel->parent) {
        handle_set_parent(&gsurf->set_parent, NULL);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// seat

static void
handle_request_set_cursor(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, request_set_cursor);
    struct wlr_seat_pointer_request_set_cursor_event *event = data;
    if (event->seat_client != core->seat->pointer_state.focused_client) {
        return;
    }
    struct gsurf *gsurf = gsurf_from_surface(core, event->surface);
    napi_value args[] = {u32(core, gsurf ? gsurf->sid : 0), i32(core, event->hotspot_x), i32(core, event->hotspot_y)};
    emit(core, "cursor-surface", 3, args);
}

static void
handle_request_set_shape(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, request_set_shape);
    struct wlr_cursor_shape_manager_v1_request_set_shape_event *event = data;
    if (event->seat_client != core->seat->pointer_state.focused_client) {
        return;
    }
    napi_value args[] = {str(core, wlr_cursor_shape_v1_name(event->shape))};
    emit(core, "cursor-shape", 1, args);
}

static void
handle_request_set_selection(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, request_set_selection);
    struct wlr_seat_request_set_selection_event *event = data;
    wlr_seat_set_selection(core->seat, event->source, event->serial);
}

static void
handle_request_set_primary_selection(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, request_set_primary_selection);
    struct wlr_seat_request_set_primary_selection_event *event = data;
    wlr_seat_set_primary_selection(core->seat, event->source, event->serial);
}

static void
handle_keyboard_key(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, keyboard_key);
    struct wlr_keyboard_key_event *event = data;
    wlr_seat_keyboard_notify_key(core->seat, event->time_msec, event->keycode, event->state);
}

static void
handle_keyboard_modifiers(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, keyboard_modifiers);
    wlr_seat_keyboard_notify_modifiers(core->seat, &core->keyboard.modifiers);
}

static const struct wlr_keyboard_impl keyboard_impl = {
        .name = "greenfield-viewer-keyboard",
};

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript API

static napi_value
undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

/*
 * Send what wlroots queued: idle configures and client buffers. Not while JavaScript handles an event: flushing can
 * destroy a client, and that must not happen in the middle of wlroots' own dispatch (or of another client's
 * destruction). The call that emitted the event flushes when it's done.
 */
static void
flush(struct core *core) {
    if (core->emitting > 0) {
        return;
    }
    wl_event_loop_dispatch_idle(core->loop);
    wl_display_flush_clients(core->display);
}

void
core_flush(struct core *core) {
    flush(core);
}

/*
 * The output's logical size is the viewer's size in CSS pixels. Its mode is that size times the integer scale (what
 * wl_output tells legacy clients: the mode in pixels and the scale, so mode / scale is the logical size). The
 * fractional scale (core->scale) is only told through wp_fractional_scale_v1.
 */
static bool
set_output_size(struct core *core, int32_t width, int32_t height) {
    core->output_width = width;
    core->output_height = height;
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, true);
    wlr_output_state_set_scale(&state, (float) core->output_scale);
    wlr_output_state_set_custom_mode(&state, width * core->output_scale, height * core->output_scale, 0);
    bool ok = wlr_output_commit_state(core->output, &state);
    wlr_output_state_finish(&state);
    return ok;
}

static char *
string_property(napi_env env, napi_value object, const char *name) {
    napi_value value;
    size_t length = 0;
    if (napi_get_named_property(env, object, name, &value) != napi_ok ||
        napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0) {
        return NULL;
    }
    char *string = calloc(length + 1, 1);
    napi_get_value_string_utf8(env, value, string, length + 1, &length);
    return string;
}

/*
 * The keymap of the viewer's keyboard: the names JavaScript read from the system's keyboard configuration (a missing
 * one is xkbcommon's default, which honors XKB_DEFAULT_*), or the default if they don't compile (a layout this
 * machine doesn't have).
 */
static struct xkb_keymap *
keymap_from_config(struct xkb_context *context, napi_value config, napi_env env) {
    struct xkb_keymap *keymap = NULL;
    if (config != NULL) {
        napi_valuetype type;
        if (napi_typeof(env, config, &type) == napi_ok && type == napi_object) {
            char *model = string_property(env, config, "model");
            char *layout = string_property(env, config, "layout");
            char *variant = string_property(env, config, "variant");
            char *options = string_property(env, config, "options");
            struct xkb_rule_names names = {.model = model, .layout = layout, .variant = variant, .options = options};
            keymap = xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
            free(model);
            free(layout);
            free(variant);
            free(options);
        }
    }
    return keymap ? keymap : xkb_keymap_new_from_names(context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
}


static void
set_output_scale(struct core *core, double scale) {
    int integer = (int) ceil(scale);
    if (scale == core->scale && integer == core->output_scale) {
        return;
    }
    core->scale = scale;
    core->output_scale = integer;
    set_output_size(core, core->output_width, core->output_height);
    struct gsurf *gsurf;
    wl_list_for_each(gsurf, &core->surfaces, link) {
        surface_notify_scale(core, gsurf->surface);
    }
}

// create(onEvent, width, height, keyboard?: { model, layout, variant, options }) -> { socket, fd }
static napi_value
create(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4], result, value;
    int32_t width, height;
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))
    NAPI_CALL(env, napi_get_value_int32(env, argv[1], &width))
    NAPI_CALL(env, napi_get_value_int32(env, argv[2], &height))
    if (the_core) {
        napi_throw_error(env, NULL, "Only one wlroots core per process.");
        return undefined(env);
    }

    wlr_log_init(getenv("GFLD_WLR_DEBUG") ? WLR_DEBUG : WLR_ERROR, NULL);

    struct core *core = calloc(1, sizeof(*core));
    core->env = env;
    napi_create_reference(env, argv[0], 1, &core->on_event);
    wl_list_init(&core->surfaces);

    core->display = wl_display_create();
    core->loop = wl_display_get_event_loop(core->display);
    core->client_created.notify = handle_client_created;
    wl_display_add_client_created_listener(core->display, &core->client_created);
    core->backend = wlr_headless_backend_create(core->display);
    if (core->backend == NULL) {
        napi_throw_error(env, NULL, "Can't create the wlroots headless backend.");
        return undefined(env);
    }

    // No renderer: nothing is composited here, and without one wlroots doesn't copy committed shared memory buffers
    // into textures. We keep each surface's buffer locked instead (see gsurf.buffer); that is what the encoders read.
    static const uint32_t shm_formats[] = {DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888, DRM_FORMAT_ABGR8888,
                                           DRM_FORMAT_XBGR8888};
    wlr_shm_create(core->display, 1, shm_formats, sizeof(shm_formats) / sizeof(shm_formats[0]));
    core->compositor = wlr_compositor_create(core->display, 5, NULL);
    wlr_subcompositor_create(core->display);
    // HiDPI: apps render at the viewer's scale. Fractional scaling needs wp_viewporter (the buffer size and the logical
    // size differ), created with the cheap globals below.
    wlr_fractional_scale_manager_v1_create(core->display, 1);
    wlr_data_device_manager_create(core->display);
    wlr_primary_selection_v1_device_manager_create(core->display);
    // cheap globals (wave 3 D); none of them needs a renderer
    wlr_viewporter_create(core->display);
    wlr_single_pixel_buffer_manager_v1_create(core->display);
    wlr_idle_inhibit_v1_create(core->display);
    core->presentation = wlr_presentation_create(core->display, core->backend);
    core->xdg_activation = wlr_xdg_activation_v1_create(core->display);
    core->request_activate.notify = handle_request_activate;
    wl_signal_add(&core->xdg_activation->events.request_activate, &core->request_activate);
    core->decoration_manager = wlr_xdg_decoration_manager_v1_create(core->display);
    core->new_toplevel_decoration.notify = handle_new_toplevel_decoration;
    wl_signal_add(&core->decoration_manager->events.new_toplevel_decoration, &core->new_toplevel_decoration);

    core->scale = 1;
    core->output_scale = 1;
    core->output_width = width;
    core->output_height = height;
    core->output = wlr_headless_add_output(core->backend, (unsigned int) width, (unsigned int) height);
    wlr_output_create_global(core->output);
    // xdg-output tells clients the output's logical size (its mode divided by the scale), the size that matters on a
    // HiDPI output: Xwayland sizes the X11 screen by it, GTK and Qt use it too.
    struct wlr_output_layout *layout = wlr_output_layout_create();
    wlr_output_layout_add(layout, core->output, 0, 0);
    wlr_xdg_output_manager_v1_create(core->display, layout);

    core->xdg_shell = wlr_xdg_shell_create(core->display, 3);
    core->new_xdg_surface.notify = handle_new_xdg_surface;
    wl_signal_add(&core->xdg_shell->events.new_surface, &core->new_xdg_surface);
    core->new_surface.notify = handle_new_surface;
    wl_signal_add(&core->compositor->events.new_surface, &core->new_surface);

    core->seat = wlr_seat_create(core->display, "seat0");
    wlr_seat_set_capabilities(core->seat, WL_SEAT_CAPABILITY_POINTER | WL_SEAT_CAPABILITY_KEYBOARD |
                                                    WL_SEAT_CAPABILITY_TOUCH);
    input_create(core);
    core->request_set_cursor.notify = handle_request_set_cursor;
    wl_signal_add(&core->seat->events.request_set_cursor, &core->request_set_cursor);
    core->request_set_selection.notify = handle_request_set_selection;
    wl_signal_add(&core->seat->events.request_set_selection, &core->request_set_selection);
    core->request_set_primary_selection.notify = handle_request_set_primary_selection;
    wl_signal_add(&core->seat->events.request_set_primary_selection, &core->request_set_primary_selection);

    clipboard_init(core);
    dnd_init(core);

    core->cursor_shape_manager = wlr_cursor_shape_manager_v1_create(core->display, 1);
    core->request_set_shape.notify = handle_request_set_shape;
    wl_signal_add(&core->cursor_shape_manager->events.request_set_shape, &core->request_set_shape);

    // The viewer's keys come in as evdev codes; the keymap is ours (default rules, XKB_DEFAULT_* override).
    wlr_keyboard_init(&core->keyboard, &keyboard_impl, "greenfield-viewer-keyboard");
    struct xkb_context *xkb_context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_keymap *keymap = keymap_from_config(xkb_context, argc > 3 ? argv[3] : NULL, env);
    wlr_keyboard_set_keymap(&core->keyboard, keymap);
    // clients repeat keys themselves (the viewer drops the browser's repeats)
    wlr_keyboard_set_repeat_info(&core->keyboard, 25, 600);
    xkb_keymap_unref(keymap);
    xkb_context_unref(xkb_context);
    core->keyboard_key.notify = handle_keyboard_key;
    wl_signal_add(&core->keyboard.events.key, &core->keyboard_key);
    core->keyboard_modifiers.notify = handle_keyboard_modifiers;
    wl_signal_add(&core->keyboard.events.modifiers, &core->keyboard_modifiers);
    wlr_seat_set_keyboard(core->seat, &core->keyboard);

    core->socket = wl_display_add_socket_auto(core->display);
    if (core->socket == NULL || !wlr_backend_start(core->backend) || !set_output_size(core, width, height)) {
        napi_throw_error(env, NULL, "Can't start the wlroots core.");
        return undefined(env);
    }
    the_core = core;
    // GFLD_XWAYLAND=0: no X11 apps
    const char *x11_display = NULL;
    const char *xwayland_setting = getenv("GFLD_XWAYLAND");
    if (xwayland_setting == NULL || strcmp(xwayland_setting, "0") != 0) {
        x11_display = x11_create(core);
    }

    NAPI_CALL(env, napi_create_object(env, &result))
    NAPI_CALL(env, napi_create_string_utf8(env, core->socket, NAPI_AUTO_LENGTH, &value))
    NAPI_CALL(env, napi_set_named_property(env, result, "socket", value))
    NAPI_CALL(env, napi_create_int32(env, wl_event_loop_get_fd(core->loop), &value))
    NAPI_CALL(env, napi_set_named_property(env, result, "fd", value))
    if (x11_display) {
        NAPI_CALL(env, napi_create_string_utf8(env, x11_display, NAPI_AUTO_LENGTH, &value))
        NAPI_CALL(env, napi_set_named_property(env, result, "x11Display", value))
    }
    return result;
}

struct core *
core_or_throw(napi_env env) {
    if (the_core == NULL) {
        napi_throw_error(env, NULL, "wlroots core not created.");
    }
    return the_core;
}

static napi_value
dispatch(napi_env env, napi_callback_info info) {
    struct core *core = core_or_throw(env);
    if (core) {
        wl_event_loop_dispatch(core->loop, 0);
        flush(core);
    }
    return undefined(env);
}

static bool
get_args(napi_env env, napi_callback_info info, size_t expected, napi_value *argv) {
    size_t argc = expected;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < expected) {
        napi_throw_error(env, NULL, "Missing arguments.");
        return false;
    }
    return true;
}

static uint32_t
arg_u32(napi_env env, napi_value value) {
    uint32_t result = 0;
    napi_get_value_uint32(env, value, &result);
    return result;
}

static int32_t
arg_i32(napi_env env, napi_value value) {
    int32_t result = 0;
    napi_get_value_int32(env, value, &result);
    return result;
}

static double
arg_double(napi_env env, napi_value value) {
    double result = 0;
    napi_get_value_double(env, value, &result);
    return result;
}

static bool
arg_bool(napi_env env, napi_value value) {
    bool result = false;
    napi_get_value_bool(env, value, &result);
    return result;
}

struct core *
wlr_core_get(napi_env env) {
    return core_or_throw(env);
}

void
wlr_core_flush(struct core *core) {
    flush(core);
}

// setOutputSize(width, height)
static napi_value
setOutputSize(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 2, argv)) {
        set_output_size(core, arg_i32(env, argv[0]), arg_i32(env, argv[1]));
        flush(core);
    }
    return undefined(env);
}

// setOutputScale(scale): the viewer's scale (devicePixelRatio); apps are told to render at it
static napi_value
setOutputScale(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 1, argv)) {
        double scale = arg_double(env, argv[0]);
        if (scale >= 1 && scale <= 16) {
            set_output_scale(core, scale);
        }
        flush(core);
    }
    return undefined(env);
}

// pointerMotion(sid (0: none), sx, sy, timeMs)
static napi_value
pointerMotion(napi_env env, napi_callback_info info) {
    napi_value argv[4];
    struct core *core = core_or_throw(env);
    if (core == NULL || !get_args(env, info, 4, argv)) {
        return undefined(env);
    }
    struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
    double sx = arg_double(env, argv[1]), sy = arg_double(env, argv[2]);
    uint32_t time = arg_u32(env, argv[3]);
    if (gsurf == NULL) {
        wlr_seat_pointer_notify_clear_focus(core->seat);
        input_pointer_focus_changed(core);
    } else {
        if (core->seat->pointer_state.focused_surface != gsurf->surface) {
            wlr_seat_pointer_notify_enter(core->seat, gsurf->surface, sx, sy);
            input_pointer_focus_changed(core);
        }
        input_clamp_pointer(core, gsurf->surface, &sx, &sy);
        wlr_seat_pointer_notify_motion(core->seat, time, sx, sy);
    }
    wlr_seat_pointer_notify_frame(core->seat);
    flush(core);
    return undefined(env);
}

// pointerButton(linuxButton, pressed, timeMs)
static napi_value
pointerButton(napi_env env, napi_callback_info info) {
    napi_value argv[3];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 3, argv)) {
        wlr_seat_pointer_notify_button(core->seat, arg_u32(env, argv[2]), arg_u32(env, argv[0]),
                                       arg_bool(env, argv[1]) ? WLR_BUTTON_PRESSED : WLR_BUTTON_RELEASED);
        wlr_seat_pointer_notify_frame(core->seat);
        flush(core);
    }
    return undefined(env);
}

// pointerAxis(horizontal, value, discrete (v120 units, 0: smooth), timeMs, finger? (touchpad: source finger))
static napi_value
pointerAxis(napi_env env, napi_callback_info info) {
    napi_value argv[5];
    struct core *core = core_or_throw(env);
    size_t argc = 5;
    if (core && napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 4) {
        bool finger = argc > 4 && arg_bool(env, argv[4]);
        wlr_seat_pointer_notify_axis(core->seat, arg_u32(env, argv[3]),
                                     arg_bool(env, argv[0]) ? WLR_AXIS_ORIENTATION_HORIZONTAL
                                                            : WLR_AXIS_ORIENTATION_VERTICAL,
                                     arg_double(env, argv[1]), arg_i32(env, argv[2]),
                                     finger ? WLR_AXIS_SOURCE_FINGER : WLR_AXIS_SOURCE_WHEEL);
        wlr_seat_pointer_notify_frame(core->seat);
        flush(core);
    }
    return undefined(env);
}

/*
 * The keyboard. The viewer's browser knows the real modifier state (getModifierState() on every event); the server
 * only sees the key events that reach the viewer's page: a key released while the page didn't have focus never comes.
 * So the viewer sends its modifier state with every input event, and before the event the server's xkb state is made
 * to agree with it (sync_modifiers): modifier keys the viewer doesn't hold anymore are released for real (the app sees
 * a key release, and the modifiers change with it); modifiers the viewer holds without a key we saw pressed are set
 * in the modifier mask only (no key press is made up). Nothing changes when they already agree, which is the normal
 * case: Ctrl+A, Ctrl+B, Ctrl+C stays one Ctrl press. Keys that aren't modifiers are released when the viewer's page
 * loses focus or the viewer goes (releaseAllKeys): the browser can't tell which of them are still held.
 */

/* The viewer's modifier bits (the scene protocol's Modifiers, as WlrCompositor packs them). */
enum {
    VIEWER_CTRL = 1 << 0,
    VIEWER_SHIFT = 1 << 1,
    VIEWER_ALT = 1 << 2,
    VIEWER_META = 1 << 3,
    VIEWER_ALTGR = 1 << 4,
    VIEWER_CAPS = 1 << 5,
    VIEWER_NUM = 1 << 6,
};
#define VIEWER_HELD (VIEWER_CTRL | VIEWER_SHIFT | VIEWER_ALT | VIEWER_META | VIEWER_ALTGR)

/* The keys that are those modifiers, by evdev code (where the key is, whatever the server's keymap does with it). */
static const struct {
    uint32_t code;
    uint32_t viewer;
} modifier_keys[] = {
        {29, VIEWER_CTRL},                // KEY_LEFTCTRL
        {97, VIEWER_CTRL},                // KEY_RIGHTCTRL
        {42, VIEWER_SHIFT},               // KEY_LEFTSHIFT
        {54, VIEWER_SHIFT},               // KEY_RIGHTSHIFT
        {56, VIEWER_ALT},                 // KEY_LEFTALT
        {100, VIEWER_ALT | VIEWER_ALTGR}, // KEY_RIGHTALT: Alt or AltGr, depending on the viewer's layout
        {125, VIEWER_META},               // KEY_LEFTMETA
        {126, VIEWER_META},               // KEY_RIGHTMETA
        {58, VIEWER_CAPS},                // KEY_CAPSLOCK
        {69, VIEWER_NUM},                 // KEY_NUMLOCK
};

static uint32_t
viewer_modifier_of_key(uint32_t code) {
    for (size_t i = 0; i < sizeof(modifier_keys) / sizeof(modifier_keys[0]); i++) {
        if (modifier_keys[i].code == code) {
            return modifier_keys[i].viewer;
        }
    }
    return 0;
}

static uint32_t
now_msec(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint32_t) (now.tv_sec * 1000 + now.tv_nsec / 1000000);
}

static uint32_t
mod_mask(struct xkb_keymap *keymap, const char *name) {
    xkb_mod_index_t index = xkb_keymap_mod_get_index(keymap, name);
    return index == XKB_MOD_INVALID ? 0 : 1u << index;
}

/* The modifiers these keys (evdev codes) set when held together, in this keymap. */
static uint32_t
mods_of_keys(struct xkb_keymap *keymap, const uint32_t *codes, size_t count) {
    if (count == 0) {
        return 0;
    }
    struct xkb_state *state = xkb_state_new(keymap);
    if (state == NULL) {
        return 0;
    }
    for (size_t i = 0; i < count; i++) {
        xkb_state_update_key(state, codes[i] + 8, XKB_KEY_DOWN);
    }
    uint32_t mods = xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED);
    xkb_state_unref(state);
    return mods;
}

static void
update_mod_masks(struct core *core) {
    struct xkb_keymap *keymap = core->keyboard.keymap;
    if (core->mods_keymap == keymap) {
        return;
    }
    core->mods_keymap = keymap;
    core->mod_ctrl = mod_mask(keymap, XKB_MOD_NAME_CTRL);
    core->mod_shift = mod_mask(keymap, XKB_MOD_NAME_SHIFT);
    core->mod_alt = mod_mask(keymap, XKB_MOD_NAME_ALT);
    core->mod_meta = mod_mask(keymap, XKB_MOD_NAME_LOGO);
    core->mod_caps = mod_mask(keymap, XKB_MOD_NAME_CAPS);
    core->mod_num = mod_mask(keymap, XKB_MOD_NAME_NUM);
    // AltGr: whatever the keymap's ISO_Level3_Shift sets (Mod5 in the usual keymaps)
    core->mod_altgr = 0;
    for (xkb_keycode_t keycode = xkb_keymap_min_keycode(keymap);
         keycode <= xkb_keymap_max_keycode(keymap) && core->mod_altgr == 0; keycode++) {
        const xkb_keysym_t *syms;
        int count = xkb_keymap_key_get_syms_by_level(keymap, keycode, 0, 0, &syms);
        for (int i = 0; i < count; i++) {
            if (syms[i] == XKB_KEY_ISO_Level3_Shift) {
                uint32_t code = keycode - 8;
                core->mod_altgr = mods_of_keys(keymap, &code, 1);
                break;
            }
        }
    }
    if (core->mod_altgr == 0) {
        core->mod_altgr = mod_mask(keymap, "Mod5");
    }
}

static uint32_t
xkb_mods_of_viewer(struct core *core, uint32_t viewer) {
    return (viewer & VIEWER_CTRL ? core->mod_ctrl : 0) | (viewer & VIEWER_SHIFT ? core->mod_shift : 0) |
           (viewer & VIEWER_ALT ? core->mod_alt : 0) | (viewer & VIEWER_META ? core->mod_meta : 0) |
           (viewer & VIEWER_ALTGR ? core->mod_altgr : 0);
}

static bool
key_pressed(struct wlr_keyboard *keyboard, uint32_t code) {
    for (size_t i = 0; i < keyboard->num_keycodes; i++) {
        if (keyboard->keycodes[i] == code) {
            return true;
        }
    }
    return false;
}

static void
notify_key(struct core *core, uint32_t code, bool pressed, uint32_t time) {
    struct wlr_keyboard_key_event event = {
            .time_msec = time,
            .keycode = code,
            .update_state = true,
            .state = pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED,
    };
    wlr_keyboard_notify_key(&core->keyboard, &event);
}

/*
 * Make the server's modifiers agree with the viewer's (VIEWER_* bits), before an input event. event_code: the evdev
 * code of the key event that follows (0: not a key event); that key isn't corrected, its own event does that.
 */
static void
sync_modifiers(struct core *core, uint32_t viewer, uint32_t event_code, uint32_t time) {
    struct wlr_keyboard *keyboard = &core->keyboard;
    if (keyboard->keymap == NULL) {
        return;
    }
    update_mod_masks(core);

    // modifier keys the viewer doesn't hold anymore (released while the page didn't have focus)
    uint32_t pressed[WLR_KEYBOARD_KEYS_CAP];
    size_t num_pressed = keyboard->num_keycodes;
    memcpy(pressed, keyboard->keycodes, num_pressed * sizeof(pressed[0]));
    for (size_t i = 0; i < num_pressed; i++) {
        uint32_t modifier = viewer_modifier_of_key(pressed[i]) & VIEWER_HELD;
        if (modifier != 0 && pressed[i] != event_code && (viewer & modifier) == 0) {
            notify_key(core, pressed[i], false, time);
        }
    }

    // modifiers the viewer holds that no pressed key (nor the key of this event) accounts for
    uint32_t event_modifier = viewer_modifier_of_key(event_code);
    uint32_t covered = event_modifier;
    for (size_t i = 0; i < keyboard->num_keycodes; i++) {
        covered |= viewer_modifier_of_key(keyboard->keycodes[i]);
    }
    uint32_t depressed = mods_of_keys(keyboard->keymap, keyboard->keycodes, keyboard->num_keycodes) |
                         xkb_mods_of_viewer(core, viewer & VIEWER_HELD & ~covered);

    // Caps Lock and Num Lock, unless this event is that key (it toggles the lock itself)
    uint32_t locked = keyboard->modifiers.locked;
    if (!(event_modifier & VIEWER_CAPS)) {
        locked = (locked & ~core->mod_caps) | (viewer & VIEWER_CAPS ? core->mod_caps : 0);
    }
    if (!(event_modifier & VIEWER_NUM)) {
        locked = (locked & ~core->mod_num) | (viewer & VIEWER_NUM ? core->mod_num : 0);
    }

    if (depressed != keyboard->modifiers.depressed || keyboard->modifiers.latched != 0 ||
        locked != keyboard->modifiers.locked) {
        // wlroots tells the focused client only if this changes its modifiers
        wlr_keyboard_notify_modifiers(keyboard, depressed, 0, locked, keyboard->modifiers.group);
    }
}

// key(evdevCode, pressed, timeMs)
static napi_value
key(napi_env env, napi_callback_info info) {
    napi_value argv[3];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 3, argv)) {
        uint32_t code = arg_u32(env, argv[0]);
        bool pressed = arg_bool(env, argv[1]);
        // a key goes down and up once: a release already made (sync_modifiers, releaseAllKeys) isn't sent again,
        // nor a press of a key that's down
        if (key_pressed(&core->keyboard, code) != pressed) {
            notify_key(core, code, pressed, arg_u32(env, argv[2]));
        }
        flush(core);
    }
    return undefined(env);
}

// syncModifiers(viewerModifiers (VIEWER_* bits), eventEvdevCode (0: not a key event), timeMs)
static napi_value
syncModifiers(napi_env env, napi_callback_info info) {
    napi_value argv[3];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 3, argv)) {
        sync_modifiers(core, arg_u32(env, argv[0]), arg_u32(env, argv[1]), arg_u32(env, argv[2]));
        flush(core);
    }
    return undefined(env);
}

// releaseAllKeys(): every key still held is released (the viewer's page lost focus, or the viewer went)
static napi_value
releaseAllKeys(napi_env env, napi_callback_info info) {
    struct core *core = core_or_throw(env);
    if (core) {
        struct wlr_keyboard *keyboard = &core->keyboard;
        uint32_t time = now_msec();
        uint32_t pressed[WLR_KEYBOARD_KEYS_CAP];
        size_t num_pressed = keyboard->num_keycodes;
        memcpy(pressed, keyboard->keycodes, num_pressed * sizeof(pressed[0]));
        for (size_t i = 0; i < num_pressed; i++) {
            notify_key(core, pressed[i], false, time);
        }
        // and modifiers held without a key (sync_modifiers); the locks stay
        if (keyboard->keymap != NULL && (keyboard->modifiers.depressed != 0 || keyboard->modifiers.latched != 0)) {
            wlr_keyboard_notify_modifiers(keyboard, 0, 0, keyboard->modifiers.locked, keyboard->modifiers.group);
        }
        flush(core);
    }
    return undefined(env);
}

// keyboardFocus(sid (0: none))
static napi_value
keyboardFocus(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    if (core == NULL || !get_args(env, info, 1, argv)) {
        return undefined(env);
    }
    struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
    if (gsurf == NULL) {
        wlr_seat_keyboard_notify_clear_focus(core->seat);
    } else if (core->seat->keyboard_state.focused_surface != gsurf->surface) {
        wlr_seat_keyboard_notify_enter(core->seat, gsurf->surface, core->keyboard.keycodes,
                                       core->keyboard.num_keycodes, &core->keyboard.modifiers);
    }
    flush(core);
    return undefined(env);
}

/* A state in configure()'s state object: -1 if it's not there. */
static int
state_flag(napi_env env, napi_value state, const char *name) {
    napi_value value;
    bool flag;
    if (napi_get_named_property(env, state, name, &value) == napi_ok &&
        napi_get_value_bool(env, value, &flag) == napi_ok) {
        return flag;
    }
    return -1;
}

// configure(sid, width, height (negative: unchanged), { maximized, fullscreen, activated, resizing })
static napi_value
configure(napi_env env, napi_callback_info info) {
    napi_value argv[4];
    struct core *core = core_or_throw(env);
    if (core == NULL || !get_args(env, info, 4, argv)) {
        return undefined(env);
    }
    struct configure_request request = {
            .width = arg_i32(env, argv[1]),
            .height = arg_i32(env, argv[2]),
            .maximized = state_flag(env, argv[3], "maximized"),
            .fullscreen = state_flag(env, argv[3], "fullscreen"),
            .activated = state_flag(env, argv[3], "activated"),
            .resizing = state_flag(env, argv[3], "resizing"),
    };
    struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
    if (gsurf && x11_configure(gsurf, &request)) {
        flush(core);
        return undefined(env);
    }
    struct wlr_xdg_toplevel *toplevel = gsurf ? gsurf->toplevel : NULL;
    if (toplevel == NULL || !toplevel->base->initialized) {
        return undefined(env);
    }
    if (request.width >= 0 && request.height >= 0) {
        wlr_xdg_toplevel_set_size(toplevel, request.width, request.height);
    }
    if (request.maximized >= 0) {
        wlr_xdg_toplevel_set_maximized(toplevel, request.maximized);
    }
    if (request.fullscreen >= 0) {
        wlr_xdg_toplevel_set_fullscreen(toplevel, request.fullscreen);
    }
    if (request.activated >= 0) {
        wlr_xdg_toplevel_set_activated(toplevel, request.activated);
    }
    if (request.resizing >= 0) {
        wlr_xdg_toplevel_set_resizing(toplevel, request.resizing);
    }
    flush(core);
    return undefined(env);
}

// close(sid)
static napi_value
closeToplevel(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 1, argv)) {
        struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
        if (gsurf && x11_close(gsurf)) {
            flush(core);
        } else if (gsurf && gsurf->toplevel) {
            wlr_xdg_toplevel_send_close(gsurf->toplevel);
            flush(core);
        }
    }
    return undefined(env);
}

// toplevelState(sid) -> { geometry: [x, y, w, h], configured: [w, h], limits: [minW, minH, maxW, maxH], maximized, fullscreen } | undefined
static napi_value
toplevelState(napi_env env, napi_callback_info info) {
    napi_value argv[1], result, array, value;
    struct core *core = core_or_throw(env);
    if (core == NULL || !get_args(env, info, 1, argv)) {
        return undefined(env);
    }
    struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
    struct toplevel_state state = {0};
    if (gsurf == NULL) {
        return undefined(env);
    } else if (!x11_toplevel_state(gsurf, &state)) {
        struct wlr_xdg_toplevel *toplevel = gsurf->toplevel;
        if (toplevel == NULL) {
            return undefined(env);
        }
        wlr_xdg_surface_get_geometry(toplevel->base, &state.geometry);
        state.configured_width = toplevel->current.width;
        state.configured_height = toplevel->current.height;
        state.min_width = toplevel->current.min_width;
        state.min_height = toplevel->current.min_height;
        state.max_width = toplevel->current.max_width;
        state.max_height = toplevel->current.max_height;
        state.maximized = toplevel->current.maximized;
        state.fullscreen = toplevel->current.fullscreen;
    }
    napi_create_object(env, &result);
    napi_create_array_with_length(env, 4, &array);
    int32_t g[] = {state.geometry.x, state.geometry.y, state.geometry.width, state.geometry.height};
    for (uint32_t i = 0; i < 4; i++) {
        napi_create_int32(env, g[i], &value);
        napi_set_element(env, array, i, value);
    }
    napi_set_named_property(env, result, "geometry", array);
    napi_create_array_with_length(env, 2, &array);
    napi_create_int32(env, state.configured_width, &value);
    napi_set_element(env, array, 0, value);
    napi_create_int32(env, state.configured_height, &value);
    napi_set_element(env, array, 1, value);
    napi_set_named_property(env, result, "configured", array);
    napi_create_array_with_length(env, 4, &array);
    int32_t limits[] = {state.min_width, state.min_height, state.max_width, state.max_height};
    for (uint32_t i = 0; i < 4; i++) {
        napi_create_int32(env, limits[i], &value);
        napi_set_element(env, array, i, value);
    }
    napi_set_named_property(env, result, "limits", array);
    napi_get_boolean(env, state.maximized, &value);
    napi_set_named_property(env, result, "maximized", value);
    napi_get_boolean(env, state.fullscreen, &value);
    napi_set_named_property(env, result, "fullscreen", value);
    return result;
}

struct surfaces_iterator {
    struct core *core;
    napi_env env;
    napi_value array;
    uint32_t length;
};

static void
add_window_surface(struct surfaces_iterator *iterator, struct wlr_surface *surface, int sx, int sy, bool popup) {
    struct gsurf *gsurf = gsurf_from_surface(iterator->core, surface);
    if (gsurf == NULL || !surface->mapped) {
        return;
    }
    napi_value entry, value;
    napi_create_array_with_length(iterator->env, 4, &entry);
    napi_create_uint32(iterator->env, gsurf->sid, &value);
    napi_set_element(iterator->env, entry, 0, value);
    napi_create_int32(iterator->env, sx, &value);
    napi_set_element(iterator->env, entry, 1, value);
    napi_create_int32(iterator->env, sy, &value);
    napi_set_element(iterator->env, entry, 2, value);
    napi_get_boolean(iterator->env, popup, &value);
    napi_set_element(iterator->env, entry, 3, value);
    napi_set_element(iterator->env, iterator->array, iterator->length++, entry);
}

static void
add_surface(struct wlr_surface *surface, int sx, int sy, void *data) {
    add_window_surface(data, surface, sx, sy, false);
}

static void
add_popup_surface(struct wlr_surface *surface, int sx, int sy, void *data) {
    add_window_surface(data, surface, sx, sy, true);
}

// windowSurfaces(sid) -> [sid, x, y, popup][] bottom to top, relative to the toplevel's surface: the window's own
// (its surface and subsurfaces), then its popups (xdg popups, X11 override-redirect menus and tooltips) with theirs
static napi_value
windowSurfaces(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    if (core == NULL || !get_args(env, info, 1, argv)) {
        return undefined(env);
    }
    struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
    struct surfaces_iterator iterator = {.core = core, .env = env};
    napi_create_array(env, &iterator.array);
    if (gsurf && !x11_window_surfaces(gsurf, add_surface, add_popup_surface, &iterator) && gsurf->toplevel) {
        wlr_surface_for_each_surface(gsurf->toplevel->base->surface, add_surface, &iterator);
        wlr_xdg_surface_for_each_popup_surface(gsurf->toplevel->base, add_popup_surface, &iterator);
    }
    return iterator.array;
}

// setPosition(sid, x, y): where the window's surface is on the output (X11 apps are told, Wayland apps can't know; the
// core keeps popups inside the output with it)
static napi_value
setPosition(napi_env env, napi_callback_info info) {
    napi_value argv[3];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 3, argv)) {
        struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
        if (gsurf) {
            gsurf->pos_x = arg_i32(env, argv[1]);
            gsurf->pos_y = arg_i32(env, argv[2]);
        }
        if (gsurf && gsurf->xwin) {
            x11_set_position(gsurf, gsurf->pos_x, gsurf->pos_y);
            flush(core);
        }
    }
    return undefined(env);
}

// sendFrameDone(sid, timeMs)
static napi_value
sendFrameDone(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    struct core *core = core_or_throw(env);
    if (core && get_args(env, info, 2, argv)) {
        struct gsurf *gsurf = gsurf_from_sid(core, arg_u32(env, argv[0]));
        if (gsurf) {
            uint32_t ms = arg_u32(env, argv[1]);
            struct timespec when = {.tv_sec = ms / 1000, .tv_nsec = (long) (ms % 1000) * 1000000};
            wlr_surface_send_frame_done(gsurf->surface, &when);
            // presentation-time: the frame counts as shown now (NULL: the client asked for no feedback)
            struct wlr_presentation_feedback *feedback = wlr_presentation_surface_sampled(core->presentation, gsurf->surface);
            if (feedback) {
                struct timespec now;
                clock_gettime(CLOCK_MONOTONIC, &now);
                struct wlr_presentation_event event = {.output = core->output, .tv_sec = (uint64_t) now.tv_sec,
                                                       .tv_nsec = (uint32_t) now.tv_nsec, .refresh = 16666667,
                                                       .seq = ++core->presentation_seq, .flags = 0};
                wlr_presentation_feedback_send_presented(feedback, &event);
                wlr_presentation_feedback_destroy(feedback);
            }
            flush(core);
        }
    }
    return undefined(env);
}

struct wlr_buffer *
wlr_core_surface_buffer(uint32_t sid) {
    if (the_core == NULL) {
        return NULL;
    }
    struct gsurf *gsurf = gsurf_from_sid(the_core, sid);
    return gsurf ? gsurf->buffer : NULL;
}

static void
finalize_pixels(napi_env env, void *finalize_data, void *finalize_hint) {
    free(finalize_data);
}

// readPixels(sid, x, y, width, height) -> RGBA Buffer | undefined (a copy, the buffer may be released right after)
static napi_value
readPixels(napi_env env, napi_callback_info info) {
    napi_value argv[5], result;
    if (!get_args(env, info, 5, argv)) {
        return undefined(env);
    }
    struct wlr_buffer *buffer = wlr_core_surface_buffer(arg_u32(env, argv[0]));
    int32_t x = arg_i32(env, argv[1]), y = arg_i32(env, argv[2]);
    int32_t width = arg_i32(env, argv[3]), height = arg_i32(env, argv[4]);
    if (buffer == NULL || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > buffer->width ||
        y + height > buffer->height) {
        return undefined(env);
    }
    void *data;
    uint32_t format;
    size_t stride;
    if (!wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride)) {
        // e.g. a dmabuf: would need a GPU readback, not part of the prototype
        return undefined(env);
    }
    // byte offsets of R, G, B, A in a little endian pixel, -1: no alpha
    int r, g, b, a;
    switch (format) {
        case DRM_FORMAT_ARGB8888:
            r = 2, g = 1, b = 0, a = 3;
            break;
        case DRM_FORMAT_XRGB8888:
            r = 2, g = 1, b = 0, a = -1;
            break;
        case DRM_FORMAT_ABGR8888:
            r = 0, g = 1, b = 2, a = 3;
            break;
        case DRM_FORMAT_XBGR8888:
            r = 0, g = 1, b = 2, a = -1;
            break;
        default:
            wlr_buffer_end_data_ptr_access(buffer);
            return undefined(env);
    }
    uint8_t *pixels = malloc((size_t) width * height * 4);
    uint8_t *out = pixels;
    for (int32_t row = y; row < y + height; row++) {
        const uint8_t *in = (const uint8_t *) data + (size_t) row * stride + (size_t) x * 4;
        for (int32_t column = 0; column < width; column++, in += 4, out += 4) {
            out[0] = in[r];
            out[1] = in[g];
            out[2] = in[b];
            out[3] = a < 0 ? 0xff : in[a];
        }
    }
    wlr_buffer_end_data_ptr_access(buffer);
    NAPI_CALL(env, napi_create_external_buffer(env, (size_t) width * height * 4, pixels, finalize_pixels, NULL,
                                               &result))
    return result;
}

napi_value wlr_core_encoder_init(napi_env env, napi_value exports);
napi_value wlr_core_clipboard_init(napi_env env, napi_value exports);
napi_value wlr_core_dnd_init(napi_env env, napi_value exports);

static napi_value
init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
            DECLARE_NAPI_METHOD("create", create),
            DECLARE_NAPI_METHOD("dispatch", dispatch),
            DECLARE_NAPI_METHOD("setOutputSize", setOutputSize),
            DECLARE_NAPI_METHOD("setOutputScale", setOutputScale),
            DECLARE_NAPI_METHOD("pointerMotion", pointerMotion),
            DECLARE_NAPI_METHOD("pointerButton", pointerButton),
            DECLARE_NAPI_METHOD("pointerAxis", pointerAxis),
            DECLARE_NAPI_METHOD("key", key),
            DECLARE_NAPI_METHOD("syncModifiers", syncModifiers),
            DECLARE_NAPI_METHOD("releaseAllKeys", releaseAllKeys),
            DECLARE_NAPI_METHOD("keyboardFocus", keyboardFocus),
            DECLARE_NAPI_METHOD("configure", configure),
            DECLARE_NAPI_METHOD("close", closeToplevel),
            DECLARE_NAPI_METHOD("toplevelState", toplevelState),
            DECLARE_NAPI_METHOD("windowSurfaces", windowSurfaces),
            DECLARE_NAPI_METHOD("setPosition", setPosition),
            DECLARE_NAPI_METHOD("sendFrameDone", sendFrameDone),
            DECLARE_NAPI_METHOD("readPixels", readPixels),
    };
    NAPI_CALL(env, napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc))
    wlr_core_clipboard_init(env, exports);
    wlr_core_dnd_init(env, exports);
    wlr_core_input_init(env, exports);
    return wlr_core_encoder_init(env, exports);
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
