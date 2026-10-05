/*
 * Input beyond plain pointer and keyboard (ROADMAP.md, Core item 1, wave 3 H): pointer constraints (pointer lock and
 * confinement, for games and 3D apps) with relative pointer motion, and touch.
 *
 * pointer-constraints-v1: an app asks to lock or confine the pointer to a surface. wlroots only tracks the request; the
 * compositor decides when it's active. Here it's active while the surface has the pointer focus: the core then tells
 * JavaScript (`pointer-constraint(sid, active, confined)`), which tells the viewer, which locks the browser's pointer
 * (Pointer Lock API) and sends relative motion (`pointerRelative`) instead of positions. Confinement is best effort: the
 * browser can't confine the pointer to a region of a window, so motion over the surface is clamped to the region.
 * The viewer ends a lock by itself (Escape, the page lost focus): `pointerConstraintRelease` deactivates the constraint
 * and doesn't activate it again until the pointer has left the surface and come back, or the app made a new one.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <wlr/types/wlr_pointer_constraints_v1.h>
#include <wlr/types/wlr_relative_pointer_v1.h>
#include <wlr/types/wlr_seat.h>
#include "wlr_core_internal.h"

struct input {
    struct core *core;
    struct wlr_pointer_constraints_v1 *constraints;
    struct wlr_relative_pointer_manager_v1 *relative;
    struct wl_listener new_constraint;
    /* the constraint that's active (told to the viewer), NULL if none */
    struct wlr_pointer_constraint_v1 *active;
    /* ended by the viewer: not activated again until the pointer leaves its surface */
    struct wlr_pointer_constraint_v1 *released;
};

struct constraint_ref {
    struct input *input;
    struct wlr_pointer_constraint_v1 *constraint;
    struct wl_listener destroy;
};

static void
report(struct input *input, struct wlr_pointer_constraint_v1 *constraint, bool active) {
    struct core *core = input->core;
    struct gsurf *gsurf = gsurf_from_surface(core, constraint->surface);
    if (gsurf == NULL) {
        return;
    }
    napi_value args[] = {u32(core, gsurf->sid), boolean(core, active),
                         boolean(core, constraint->type == WLR_POINTER_CONSTRAINT_V1_CONFINED)};
    emit(core, "pointer-constraint", 3, args);
}

static void
activate(struct input *input, struct wlr_pointer_constraint_v1 *constraint) {
    input->active = constraint;
    wlr_pointer_constraint_v1_send_activated(constraint);
    report(input, constraint, true);
}

static void
deactivate(struct input *input) {
    struct wlr_pointer_constraint_v1 *constraint = input->active;
    if (constraint == NULL) {
        return;
    }
    input->active = NULL;
    wlr_pointer_constraint_v1_send_deactivated(constraint);
    report(input, constraint, false);
}

static void
handle_constraint_destroy(struct wl_listener *listener, void *data) {
    struct constraint_ref *ref = wl_container_of(listener, ref, destroy);
    struct input *input = ref->input;
    if (input->active == ref->constraint) {
        // the app destroyed it (or the surface went away): no deactivated event to send
        input->active = NULL;
        report(input, ref->constraint, false);
    }
    if (input->released == ref->constraint) {
        input->released = NULL;
    }
    wl_list_remove(&ref->destroy.link);
    free(ref);
}

/* The surface the constraint applies to has the pointer focus, and the constraint isn't the one the viewer ended. */
static void
activate_if_focused(struct input *input, struct wlr_pointer_constraint_v1 *constraint) {
    struct core *core = input->core;
    if (constraint == NULL || constraint == input->active || constraint == input->released ||
        core->seat->pointer_state.focused_surface != constraint->surface) {
        return;
    }
    deactivate(input);
    activate(input, constraint);
}

static void
handle_new_constraint(struct wl_listener *listener, void *data) {
    struct input *input = wl_container_of(listener, input, new_constraint);
    struct wlr_pointer_constraint_v1 *constraint = data;
    struct constraint_ref *ref = calloc(1, sizeof(*ref));
    ref->input = input;
    ref->constraint = constraint;
    ref->destroy.notify = handle_constraint_destroy;
    wl_signal_add(&constraint->events.destroy, &ref->destroy);
    activate_if_focused(input, constraint);
}

void
input_create(struct core *core) {
    struct input *input = calloc(1, sizeof(*input));
    input->core = core;
    input->constraints = wlr_pointer_constraints_v1_create(core->display);
    input->relative = wlr_relative_pointer_manager_v1_create(core->display);
    input->new_constraint.notify = handle_new_constraint;
    wl_signal_add(&input->constraints->events.new_constraint, &input->new_constraint);
    core->input = input;
}

void
input_pointer_focus_changed(struct core *core) {
    struct input *input = core->input;
    struct wlr_surface *focused = core->seat->pointer_state.focused_surface;
    if (input->active && input->active->surface != focused) {
        deactivate(input);
    }
    if (input->released && input->released->surface != focused) {
        input->released = NULL;
    }
    if (focused) {
        activate_if_focused(
                input, wlr_pointer_constraints_v1_constraint_for_surface(input->constraints, focused, core->seat));
    }
}

void
input_clamp_pointer(struct core *core, struct wlr_surface *surface, double *sx, double *sy) {
    struct wlr_pointer_constraint_v1 *constraint = core->input->active;
    if (constraint == NULL || constraint->surface != surface ||
        constraint->type != WLR_POINTER_CONSTRAINT_V1_CONFINED || !pixman_region32_not_empty(&constraint->region)) {
        return;
    }
    pixman_box32_t *box = pixman_region32_extents(&constraint->region);
    *sx = *sx < box->x1 ? box->x1 : *sx > box->x2 - 1 ? box->x2 - 1 : *sx;
    *sy = *sy < box->y1 ? box->y1 : *sy > box->y2 - 1 ? box->y2 - 1 : *sy;
}

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript API

static napi_value
undefined_value(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

/* Reads the call's arguments as doubles (touch ids and times fit exactly). */
static bool
number_args(napi_env env, napi_callback_info info, size_t expected, double *values) {
    napi_value argv[8];
    size_t argc = expected;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < expected) {
        napi_throw_error(env, NULL, "Missing arguments.");
        return false;
    }
    for (size_t i = 0; i < expected; i++) {
        values[i] = 0;
        napi_get_value_double(env, argv[i], &values[i]);
    }
    return true;
}

// pointerRelative(dx, dy, timeMs): relative motion while the pointer is locked
static napi_value
pointerRelative(napi_env env, napi_callback_info info) {
    double v[3];
    struct core *core = wlr_core_get(env);
    if (core && number_args(env, info, 3, v)) {
        wlr_relative_pointer_manager_v1_send_relative_motion(core->input->relative, core->seat,
                                                             (uint64_t) v[2] * 1000, v[0], v[1], v[0], v[1]);
        wlr_seat_pointer_notify_frame(core->seat);
        wlr_core_flush(core);
    }
    return undefined_value(env);
}

// pointerConstraintRelease(): the viewer's lock ended (Escape, focus lost): deactivate the constraint
static napi_value
pointerConstraintRelease(napi_env env, napi_callback_info info) {
    struct core *core = wlr_core_get(env);
    if (core && core->input->active) {
        core->input->released = core->input->active;
        deactivate(core->input);
        wlr_core_flush(core);
    }
    return undefined_value(env);
}

/* Surface coordinates for a point (x, y in output coordinates) on an X11 surface, by where X11 has its window (see
 * pointerMotion in wlr_core.c); a Wayland surface's are the viewer's (sx, sy). */
static void
surface_point(struct gsurf *gsurf, double x, double y, double *sx, double *sy) {
    int32_t rx, ry;
    if (gsurf && x11_root_position(gsurf, &rx, &ry)) {
        *sx = x - rx;
        *sy = y - ry;
    }
}

// touch(kind (0 down, 1 motion, 2 up, 3 cancel), sid, id, sx, sy, x, y, timeMs): surface and output coordinates
static napi_value
touch(napi_env env, napi_callback_info info) {
    double v[8];
    struct core *core = wlr_core_get(env);
    if (core == NULL || !number_args(env, info, 8, v)) {
        return undefined_value(env);
    }
    int kind = (int) v[0];
    uint32_t time = (uint32_t) v[7];
    int32_t id = (int32_t) v[2];
    double sx = v[3], sy = v[4];
    if (kind == 0) {
        struct gsurf *gsurf = gsurf_from_sid(core, (uint32_t) v[1]);
        if (gsurf) {
            surface_point(gsurf, v[5], v[6], &sx, &sy);
            wlr_seat_touch_notify_down(core->seat, gsurf->surface, time, id, sx, sy);
        }
    } else if (kind == 1) {
        struct wlr_touch_point *point = wlr_seat_touch_get_point(core->seat, id);
        if (point) {
            if (point->surface) {
                surface_point(gsurf_from_surface(core, point->surface), v[5], v[6], &sx, &sy);
            }
            wlr_seat_touch_notify_motion(core->seat, time, id, sx, sy);
        }
    } else if (kind == 2) {
        if (wlr_seat_touch_get_point(core->seat, id)) {
            wlr_seat_touch_notify_up(core->seat, time, id);
        }
    } else if (!wl_list_empty(&core->seat->touch_state.touch_points)) {
        struct wlr_touch_point *point = wl_container_of(core->seat->touch_state.touch_points.next, point, link);
        if (point->surface) {
            wlr_seat_touch_notify_cancel(core->seat, point->surface);
        }
    }
    wlr_seat_touch_notify_frame(core->seat);
    wlr_core_flush(core);
    return undefined_value(env);
}

napi_value
wlr_core_input_init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
            {"pointerRelative", 0, pointerRelative, 0, 0, 0, napi_default, 0},
            {"pointerConstraintRelease", 0, pointerConstraintRelease, 0, 0, 0, napi_default, 0},
            {"touch", 0, touch, 0, 0, 0, napi_default, 0},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
