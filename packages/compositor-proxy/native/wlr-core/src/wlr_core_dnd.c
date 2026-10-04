/*
 * Drag and drop (wave 3 E).
 *
 * Between remote apps: an app's wl_data_device.start_drag becomes a seat pointer drag (wlroots routes the pointer
 * events we send, with the pointer grab, to the surface under the pointer as data device enter/motion/drop). The
 * drag's icon surface is reported like a cursor surface: "drag-start(iconSid)", "drag-icon(iconSid, x, y)" (the icon's
 * offset from the pointer, from the surface offsets of its commits), "drag-end()". The viewer shows it at the pointer.
 */
#define _GNU_SOURCE
#include <stdlib.h>
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
