/*
 * Drag and drop (wave 3 E).
 *
 * Between remote apps: an app's wl_data_device.start_drag becomes a seat pointer drag (wlroots routes the pointer
 * events we send, with the pointer grab, to the surface under the pointer as data device enter/motion/drop). The
 * drag's icon surface is reported like a cursor surface: "drag-start(iconSid)", "drag-icon(iconSid, x, y)" (the icon's
 * offset from the pointer, from the surface offsets of its commits), "drag-end()". The viewer shows it at the pointer.
 *
 * From the user's computer into remote apps: files dragged over the viewer's page become a drag of ours whose data
 * source offers text/uri-list. JavaScript starts it when the files enter a surface (startFileDrag, then the usual
 * pointer motion, so apps highlight their drop targets), drops it (dropFileDrag) when the files are released on an
 * app that accepted them (fileDragAccepted) and cancels it when they leave (cancelFileDrag). What the app receives
 * isn't known until the files are uploaded, which starts at the drop: the app's receive requests wait (their pipes
 * are kept) until provideFiles(list) gives the list of file:// URIs. The pointer button the drag needs is faked
 * under the drag's pointer grab, so no app ever sees a click.
 */
#define _GNU_SOURCE
#include <linux/input-event-codes.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_seat.h>
#include "wlr_core_internal.h"

struct drag_tracker {
    struct core *core;
    struct wlr_drag *drag;
    struct wlr_surface *icon_surface;
    int32_t x, y;
    struct wl_listener destroy;
    struct wl_listener icon_commit;
    struct wl_listener icon_destroy;
};

static void
report_icon(struct drag_tracker *tracker) {
    struct gsurf *gsurf = gsurf_from_surface(tracker->core, tracker->icon_surface);
    napi_value args[] = {u32(tracker->core, gsurf ? gsurf->sid : 0), i32(tracker->core, tracker->x),
                         i32(tracker->core, tracker->y)};
    emit(tracker->core, "drag-icon", 3, args);
}

static void
forget_icon(struct drag_tracker *tracker) {
    if (tracker->icon_surface == NULL) {
        return;
    }
    wl_list_remove(&tracker->icon_commit.link);
    wl_list_remove(&tracker->icon_destroy.link);
    tracker->icon_surface = NULL;
}

static void
handle_icon_commit(struct wl_listener *listener, void *data) {
    struct drag_tracker *tracker = wl_container_of(listener, tracker, icon_commit);
    // the surface's dx and dy are what this commit moved it by (0 if it didn't): the icon's offset adds up
    tracker->x += tracker->icon_surface->current.dx;
    tracker->y += tracker->icon_surface->current.dy;
    report_icon(tracker);
}

static void
handle_icon_destroy(struct wl_listener *listener, void *data) {
    struct drag_tracker *tracker = wl_container_of(listener, tracker, icon_destroy);
    struct core *core = tracker->core;
    forget_icon(tracker);
    napi_value args[] = {u32(core, 0), i32(core, 0), i32(core, 0)};
    emit(core, "drag-icon", 3, args);
}

static void
handle_drag_destroy(struct wl_listener *listener, void *data) {
    struct drag_tracker *tracker = wl_container_of(listener, tracker, destroy);
    struct core *core = tracker->core;
    forget_icon(tracker);
    wl_list_remove(&tracker->destroy.link);
    free(tracker);
    emit(core, "drag-end", 0, NULL);
}

static void
handle_start_drag(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, start_drag);
    struct wlr_drag *drag = data;
    struct drag_tracker *tracker = calloc(1, sizeof(*tracker));
    tracker->core = core;
    tracker->drag = drag;
    tracker->destroy.notify = handle_drag_destroy;
    wl_signal_add(&drag->events.destroy, &tracker->destroy);
    uint32_t sid = 0;
    if (drag->icon) {
        tracker->icon_surface = drag->icon->surface;
        tracker->icon_commit.notify = handle_icon_commit;
        wl_signal_add(&tracker->icon_surface->events.commit, &tracker->icon_commit);
        tracker->icon_destroy.notify = handle_icon_destroy;
        wl_signal_add(&drag->icon->events.destroy, &tracker->icon_destroy);
        struct gsurf *gsurf = gsurf_from_surface(core, tracker->icon_surface);
        sid = gsurf ? gsurf->sid : 0;
    }
    napi_value args[] = {u32(core, sid)};
    emit(core, "drag-start", 1, args);
}

/* An app asked to start a drag: only the press that's going on may start one. */
static void
handle_request_start_drag(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, request_start_drag);
    struct wlr_seat_request_start_drag_event *event = data;
    if (wlr_seat_validate_pointer_grab_serial(core->seat, event->origin, event->serial)) {
        wlr_seat_start_pointer_drag(core->seat, event->drag, event->serial);
    } else {
        wlr_data_source_destroy(event->drag->source);
    }
}

void
dnd_init(struct core *core) {
    core->request_start_drag.notify = handle_request_start_drag;
    wl_signal_add(&core->seat->events.request_start_drag, &core->request_start_drag);
    core->start_drag.notify = handle_start_drag;
    wl_signal_add(&core->seat->events.start_drag, &core->start_drag);
}

// ---------------------------------------------------------------------------------------------------------------------
// files from the user's computer

struct pending_fd {
    struct wl_list link;
    int fd;
};

struct file_source {
    struct wlr_data_source base;
    struct wl_list pending; // pending_fd.link: receivers waiting for the list
    char *list;
};

static const struct wlr_data_source_impl file_source_impl;
/* the source of the file drag that's going on, NULL if none */
static struct file_source *current_file_source = NULL;

static void
file_source_send(struct wlr_data_source *source, const char *mime_type, int32_t fd) {
    struct file_source *self = wl_container_of(source, self, base);
    if (strcmp(mime_type, "text/uri-list") != 0) {
        close(fd);
    } else if (self->list) {
        core_write_text_async(self->list, strlen(self->list), fd);
    } else {
        struct pending_fd *pending = calloc(1, sizeof(*pending));
        pending->fd = fd;
        wl_list_insert(&self->pending, &pending->link);
    }
}

static void
file_source_destroy(struct wlr_data_source *source) {
    struct file_source *self = wl_container_of(source, self, base);
    struct pending_fd *pending, *tmp;
    wl_list_for_each_safe(pending, tmp, &self->pending, link) {
        close(pending->fd);
        free(pending);
    }
    if (current_file_source == self) {
        current_file_source = NULL;
    }
    free(self->list);
    free(self);
}

static const struct wlr_data_source_impl file_source_impl = {
        .send = file_source_send,
        .destroy = file_source_destroy,
};

/* true while the file drag is going on (until its drop or cancelling) */
static bool
file_drag_going(struct core *core) {
    return current_file_source && core->seat->drag && core->seat->drag->source == &current_file_source->base;
}

static bool
arg_string(napi_env env, napi_value value, char **out) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
        return false;
    }
    *out = malloc(length + 1);
    napi_get_value_string_utf8(env, value, *out, length + 1, &length);
    return true;
}

static napi_value
boolean_result(napi_env env, bool value) {
    napi_value result;
    napi_get_boolean(env, value, &result);
    return result;
}

// startFileDrag(sid) -> started: a drag of files over this surface's client begins
static napi_value
start_file_drag(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    uint32_t sid = 0;
    if (core == NULL || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        return boolean_result(env, false);
    }
    napi_get_value_uint32(env, argv[0], &sid);
    struct gsurf *gsurf = gsurf_from_sid(core, sid);
    if (gsurf == NULL || core->seat->drag != NULL) {
        return boolean_result(env, false);
    }
    struct wlr_seat_client *seat_client =
            wlr_seat_client_for_wl_client(core->seat, wl_resource_get_client(gsurf->surface->resource));
    if (seat_client == NULL) {
        return boolean_result(env, false);
    }
    struct file_source *source = calloc(1, sizeof(*source));
    wlr_data_source_init(&source->base, &file_source_impl);
    wl_list_init(&source->pending);
    char **slot = wl_array_add(&source->base.mime_types, sizeof(char *));
    *slot = strdup("text/uri-list");
    struct wlr_drag *drag = wlr_drag_create(seat_client, &source->base, NULL);
    if (drag == NULL) {
        wlr_data_source_destroy(&source->base);
        return boolean_result(env, false);
    }
    current_file_source = source;
    wlr_seat_start_pointer_drag(core->seat, drag, wl_display_next_serial(core->display));
    // the press the drag needs (see the top of the file): the drag's grab takes it, no app gets it
    wlr_seat_pointer_notify_button(core->seat, 0, BTN_LEFT, WLR_BUTTON_PRESSED);
    core_flush(core);
    return boolean_result(env, true);
}

// fileDragAccepted() -> bool: the app under the pointer takes the files
static napi_value
file_drag_accepted(napi_env env, napi_callback_info info) {
    struct core *core = core_or_throw(env);
    struct file_source *source = current_file_source;
    return boolean_result(env, core && file_drag_going(core) && source->base.accepted &&
                                       source->base.current_dnd_action);
}

// dropFileDrag(timeMs): the files are released where the pointer is (the app takes them if it accepted)
static napi_value
drop_file_drag(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    uint32_t time = 0;
    if (core && file_drag_going(core) && napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 1) {
        napi_get_value_uint32(env, argv[0], &time);
        struct file_source *source = current_file_source;
        bool accepted = source->base.accepted && source->base.current_dnd_action;
        wlr_seat_pointer_notify_button(core->seat, time, BTN_LEFT, WLR_BUTTON_RELEASED);
        if (!accepted) {
            wlr_data_source_destroy(&source->base);
        }
        core_flush(core);
    }
    return NULL;
}

// cancelFileDrag()
static napi_value
cancel_file_drag(napi_env env, napi_callback_info info) {
    struct core *core = core_or_throw(env);
    if (core && file_drag_going(core)) {
        wlr_data_source_destroy(&current_file_source->base);
        core_flush(core);
    }
    return NULL;
}

// provideFiles(list): the text/uri-list of the dropped files, for the receivers waiting and the ones to come
static napi_value
provide_files(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    char *list = NULL;
    if (core == NULL || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
        !arg_string(env, argv[0], &list)) {
        return NULL;
    }
    // (the source is kept alive by the seat as its drag source until the next drag, also after the drop)
    struct wlr_data_source *seat_source = core->seat->drag_source;
    if (seat_source && seat_source->impl == &file_source_impl) {
        struct file_source *source = wl_container_of(seat_source, source, base);
        free(source->list);
        source->list = list;
        struct pending_fd *pending, *tmp;
        wl_list_for_each_safe(pending, tmp, &source->pending, link) {
            core_write_text_async(list, strlen(list), pending->fd);
            wl_list_remove(&pending->link);
            free(pending);
        }
    } else {
        free(list);
    }
    core_flush(core);
    return NULL;
}

napi_value
wlr_core_dnd_init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
            {"startFileDrag", 0, start_file_drag, 0, 0, 0, napi_default, 0},
            {"fileDragAccepted", 0, file_drag_accepted, 0, 0, 0, napi_default, 0},
            {"dropFileDrag", 0, drop_file_drag, 0, 0, 0, napi_default, 0},
            {"cancelFileDrag", 0, cancel_file_drag, 0, 0, 0, napi_default, 0},
            {"provideFiles", 0, provide_files, 0, 0, 0, napi_default, 0},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
