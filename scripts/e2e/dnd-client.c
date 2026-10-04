/*
 * A tiny Wayland client for the drag and drop end-to-end test (scripts/e2e/dnd.sh), built by the script with
 * wayland-scanner and gcc: two windows, "dnd-source" (red) and "dnd-target" (blue), and a drag icon (green, 32x32).
 *
 * Pressing the left button over the source window starts a drag with the text "dragged text" (and the icon); the
 * target window accepts the text and, on the drop, reads it and writes it to the file given as the first argument.
 * It logs what happens on stdout: "drag started", "target entered", "dropped <text>", "drag finished".
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <linux/input-event-codes.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#define MIME "text/plain;charset=utf-8"
#define TEXT "dragged text"
#define SIZE 200

struct window {
    const char *title;
    uint32_t color;
    int size;
    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;
    bool configured;
};

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_seat *seat;
static struct wl_data_device_manager *data_manager;
static struct wl_data_device *data_device;
static struct wl_pointer *pointer;
static struct window source_window = {.title = "dnd-source", .color = 0xffcc2222, .size = SIZE};
static struct window target_window = {.title = "dnd-target", .color = 0xff2222cc, .size = SIZE};
static struct wl_surface *pointer_surface;
static struct wl_data_offer *offer;
static const char *output_file;
static int receive_fd = -1;
static char received[256];
static size_t received_length;
static bool dropped;

static struct wl_buffer *
make_buffer(int size, uint32_t color) {
    int fd = memfd_create("dnd-buffer", 0);
    ftruncate(fd, size * size * 4);
    uint32_t *pixels = mmap(NULL, size * size * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int i = 0; i < size * size; i++) {
        pixels[i] = color;
    }
    munmap(pixels, size * size * 4);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size * size * 4);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, size, size, size * 4, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buffer;
}

static void
paint(struct window *window) {
    wl_surface_attach(window->surface, make_buffer(window->size, window->color), 0, 0);
    wl_surface_commit(window->surface);
}

static void
wm_base_ping(void *data, struct xdg_wm_base *base, uint32_t serial) {
    xdg_wm_base_pong(base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = {wm_base_ping};

static void
xdg_surface_configure(void *data, struct xdg_surface *xdg_surface, uint32_t serial) {
    struct window *window = data;
    xdg_surface_ack_configure(xdg_surface, serial);
    if (!window->configured) {
        window->configured = true;
        paint(window);
    }
}
static const struct xdg_surface_listener xdg_surface_listener = {xdg_surface_configure};

static void
toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {}
static void
toplevel_close(void *data, struct xdg_toplevel *t) {
    exit(0);
}
static const struct xdg_toplevel_listener toplevel_listener = {toplevel_configure, toplevel_close};

static void
create_window(struct window *window) {
    window->surface = wl_compositor_create_surface(compositor);
    window->xdg_surface = xdg_wm_base_get_xdg_surface(wm_base, window->surface);
    xdg_surface_add_listener(window->xdg_surface, &xdg_surface_listener, window);
    window->toplevel = xdg_surface_get_toplevel(window->xdg_surface);
    xdg_toplevel_add_listener(window->toplevel, &toplevel_listener, window);
    xdg_toplevel_set_title(window->toplevel, window->title);
    xdg_toplevel_set_app_id(window->toplevel, "test-dnd");
    wl_surface_commit(window->surface);
}

// --- the drag source

static void
source_target(void *data, struct wl_data_source *s, const char *mime) {}
static void
source_send(void *data, struct wl_data_source *s, const char *mime, int32_t fd) {
    write(fd, TEXT, strlen(TEXT));
    close(fd);
}
static void
source_cancelled(void *data, struct wl_data_source *s) {
    printf("drag cancelled\n");
    fflush(stdout);
    wl_data_source_destroy(s);
}
static void
source_drop_performed(void *data, struct wl_data_source *s) {}
static void
source_finished(void *data, struct wl_data_source *s) {
    printf("drag finished\n");
    fflush(stdout);
    wl_data_source_destroy(s);
}
static void
source_action(void *data, struct wl_data_source *s, uint32_t action) {}
static const struct wl_data_source_listener source_listener = {source_target, source_send, source_cancelled,
                                                               source_drop_performed, source_finished, source_action};

static void
start_drag(uint32_t serial) {
    struct wl_data_source *source = wl_data_device_manager_create_data_source(data_manager);
    wl_data_source_add_listener(source, &source_listener, NULL);
    wl_data_source_offer(source, MIME);
    wl_data_source_set_actions(source, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY);
    struct wl_surface *icon = wl_compositor_create_surface(compositor);
    wl_surface_attach(icon, make_buffer(32, 0xff22cc22), 0, 0);
    wl_surface_commit(icon);
    wl_data_device_start_drag(data_device, source, source_window.surface, icon, serial);
    printf("drag started\n");
    fflush(stdout);
}

// --- the pointer

static void
pointer_enter(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *surface, wl_fixed_t x,
              wl_fixed_t y) {
    pointer_surface = surface;
}
static void
pointer_leave(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *surface) {
    pointer_surface = NULL;
}
static void
pointer_motion(void *data, struct wl_pointer *p, uint32_t time, wl_fixed_t x, wl_fixed_t y) {}
static void
pointer_button(void *data, struct wl_pointer *p, uint32_t serial, uint32_t time, uint32_t button, uint32_t state) {
    if (button == BTN_LEFT && state == WL_POINTER_BUTTON_STATE_PRESSED && pointer_surface == source_window.surface) {
        start_drag(serial);
    }
}
static void
pointer_axis(void *data, struct wl_pointer *p, uint32_t time, uint32_t axis, wl_fixed_t value) {}
static void
pointer_frame(void *data, struct wl_pointer *p) {}
static void
pointer_axis_source(void *data, struct wl_pointer *p, uint32_t source) {}
static void
pointer_axis_stop(void *data, struct wl_pointer *p, uint32_t time, uint32_t axis) {}
static void
pointer_axis_discrete(void *data, struct wl_pointer *p, uint32_t axis, int32_t discrete) {}
static const struct wl_pointer_listener pointer_listener = {pointer_enter,      pointer_leave,       pointer_motion,
                                                            pointer_button,     pointer_axis,        pointer_frame,
                                                            pointer_axis_source, pointer_axis_stop, pointer_axis_discrete};

static void
seat_capabilities(void *data, struct wl_seat *s, uint32_t capabilities) {
    if ((capabilities & WL_SEAT_CAPABILITY_POINTER) && pointer == NULL) {
        pointer = wl_seat_get_pointer(s);
        wl_pointer_add_listener(pointer, &pointer_listener, NULL);
    }
}
static void
seat_name(void *data, struct wl_seat *s, const char *name) {}
static const struct wl_seat_listener seat_listener = {seat_capabilities, seat_name};

// --- the drop target

static void
offer_offer(void *data, struct wl_data_offer *o, const char *mime) {}
static void
offer_source_actions(void *data, struct wl_data_offer *o, uint32_t actions) {}
static void
offer_action(void *data, struct wl_data_offer *o, uint32_t action) {}
static const struct wl_data_offer_listener offer_listener = {offer_offer, offer_source_actions, offer_action};

static void
device_data_offer(void *data, struct wl_data_device *d, struct wl_data_offer *o) {
    wl_data_offer_add_listener(o, &offer_listener, NULL);
}
static void
device_enter(void *data, struct wl_data_device *d, uint32_t serial, struct wl_surface *surface, wl_fixed_t x,
             wl_fixed_t y, struct wl_data_offer *o) {
    offer = o;
    if (surface == target_window.surface && o) {
        wl_data_offer_accept(o, serial, MIME);
        wl_data_offer_set_actions(o, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY);
        printf("target entered\n");
        fflush(stdout);
    } else if (o) {
        wl_data_offer_accept(o, serial, NULL);
    }
}
static void
device_leave(void *data, struct wl_data_device *d) {}
static void
device_motion(void *data, struct wl_data_device *d, uint32_t time, wl_fixed_t x, wl_fixed_t y) {}
static void
device_drop(void *data, struct wl_data_device *d) {
    if (offer == NULL) {
        return;
    }
    int fds[2];
    pipe(fds);
    wl_data_offer_receive(offer, MIME, fds[1]);
    close(fds[1]);
    receive_fd = fds[0];
    dropped = true;
}
static void
device_selection(void *data, struct wl_data_device *d, struct wl_data_offer *o) {}
static const struct wl_data_device_listener device_listener = {device_data_offer, device_enter, device_leave,
                                                               device_motion,     device_drop,  device_selection};

static void
registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    if (strcmp(interface, "wl_compositor") == 0) {
        compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    } else if (strcmp(interface, "wl_shm") == 0) {
        shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    } else if (strcmp(interface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    } else if (strcmp(interface, "wl_seat") == 0) {
        seat = wl_registry_bind(registry, name, &wl_seat_interface, 5);
        wl_seat_add_listener(seat, &seat_listener, NULL);
    } else if (strcmp(interface, "wl_data_device_manager") == 0) {
        data_manager = wl_registry_bind(registry, name, &wl_data_device_manager_interface, 3);
    }
}
static void
registry_remove(void *data, struct wl_registry *registry, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {registry_global, registry_remove};

int
main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: dnd-client <file the dropped text goes to>\n");
        return 2;
    }
    output_file = argv[1];
    display = wl_display_connect(NULL);
    if (display == NULL) {
        fprintf(stderr, "can't connect to the Wayland display\n");
        return 1;
    }
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);
    if (!compositor || !shm || !wm_base || !seat || !data_manager) {
        fprintf(stderr, "missing globals\n");
        return 1;
    }
    data_device = wl_data_device_manager_get_data_device(data_manager, seat);
    wl_data_device_add_listener(data_device, &device_listener, NULL);
    create_window(&source_window);
    create_window(&target_window);

    for (;;) {
        // (the standard dispatch loop with a second fd: the dropped text arrives through a pipe)
        while (wl_display_prepare_read(display) != 0) {
            wl_display_dispatch_pending(display);
        }
        wl_display_flush(display);
        struct pollfd fds[2] = {{wl_display_get_fd(display), POLLIN, 0}, {receive_fd, POLLIN, 0}};
        poll(fds, receive_fd >= 0 ? 2 : 1, -1);
        if (fds[0].revents & POLLIN) {
            wl_display_read_events(display);
        } else {
            wl_display_cancel_read(display);
        }
        wl_display_dispatch_pending(display);
        if (receive_fd >= 0 && (fds[1].revents & (POLLIN | POLLHUP))) {
            ssize_t n = read(receive_fd, received + received_length, sizeof(received) - 1 - received_length);
            if (n > 0) {
                received_length += (size_t) n;
            } else {
                close(receive_fd);
                receive_fd = -1;
                received[received_length] = 0;
                FILE *file = fopen(output_file, "w");
                fprintf(file, "%s", received);
                fclose(file);
                printf("dropped %s\n", received);
                fflush(stdout);
                if (offer && dropped) {
                    wl_data_offer_finish(offer);
                    wl_data_offer_destroy(offer);
                    offer = NULL;
                }
            }
        }
    }
}
