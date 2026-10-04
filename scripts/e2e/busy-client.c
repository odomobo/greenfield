/*
 * A tiny Wayland client for the encoding end-to-end test (scripts/e2e/busy.sh) and for measuring by hand, built with
 * wayland-scanner and gcc: one window that behaves like a vsync game. On every frame callback it renders a new frame
 * of its whole surface (a moving pattern with some noise) and commits it with full damage, and asks for the next
 * callback, forever. It writes the number of frames it has committed to the file given as the first argument, about
 * twice a second.
 *
 * Usage: busy-client <frames file> [width height]
 */
#define _GNU_SOURCE
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_surface *surface;
static int width = 640;
static int height = 480;
static const char *frames_file;
static bool configured;
static unsigned long frames;
static unsigned long noise = 12345;

struct buffer {
    struct wl_buffer *buffer;
    uint32_t *pixels;
    bool busy;
};
static struct buffer buffers[2];

static double
now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static void
buffer_release(void *data, struct wl_buffer *wl_buffer) {
    ((struct buffer *) data)->busy = false;
}
static const struct wl_buffer_listener buffer_listener = {buffer_release};

static void
create_buffer(struct buffer *b) {
    size_t size = (size_t) width * height * 4;
    int fd = memfd_create("busy-buffer", 0);
    if (ftruncate(fd, size) < 0) {
        exit(1);
    }
    b->pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    b->buffer = wl_shm_pool_create_buffer(pool, 0, width, height, width * 4, WL_SHM_FORMAT_ARGB8888);
    wl_buffer_add_listener(b->buffer, &buffer_listener, b);
    wl_shm_pool_destroy(pool);
    close(fd);
}

static void frame_done(void *data, struct wl_callback *callback, uint32_t time);
static const struct wl_callback_listener frame_listener = {frame_done};

static void
paint(void) {
    struct buffer *b = !buffers[0].busy ? &buffers[0] : &buffers[1];
    unsigned long t = frames;
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            noise = noise * 1103515245 + 12345;
            uint32_t v = (uint32_t) (x * 3 + y * 2 + t * 7) + ((noise >> 16) & 7);
            b->pixels[y * width + x] = 0xff000000 | ((v & 0xff) << 16) | (((v * 3) & 0xff) << 8) | ((v * 5) & 0xff);
        }
    }
    b->busy = true;
    struct wl_callback *callback = wl_surface_frame(surface);
    wl_callback_add_listener(callback, &frame_listener, NULL);
    wl_surface_attach(surface, b->buffer, 0, 0);
    wl_surface_damage_buffer(surface, 0, 0, width, height);
    wl_surface_commit(surface);
    frames++;
}

static void
frame_done(void *data, struct wl_callback *callback, uint32_t time) {
    wl_callback_destroy(callback);
    paint();
}

static void
wm_base_ping(void *data, struct xdg_wm_base *base, uint32_t serial) {
    xdg_wm_base_pong(base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = {wm_base_ping};

static void
xdg_surface_configure(void *data, struct xdg_surface *xdg_surface, uint32_t serial) {
    xdg_surface_ack_configure(xdg_surface, serial);
    if (!configured) {
        configured = true;
        paint();
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
registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    if (strcmp(interface, "wl_compositor") == 0) {
        compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    } else if (strcmp(interface, "wl_shm") == 0) {
        shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    } else if (strcmp(interface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    }
}
static void
registry_remove(void *data, struct wl_registry *registry, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {registry_global, registry_remove};

static void
write_frames(void) {
    FILE *file = fopen(frames_file, "w");
    if (file) {
        fprintf(file, "%lu\n", frames);
        fclose(file);
    }
}

int
main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: busy-client <frames file> [width height]\n");
        return 2;
    }
    frames_file = argv[1];
    if (argc >= 4) {
        width = atoi(argv[2]);
        height = atoi(argv[3]);
    }
    display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "no Wayland display\n");
        return 1;
    }
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);
    if (!compositor || !shm || !wm_base) {
        fprintf(stderr, "missing globals\n");
        return 1;
    }
    create_buffer(&buffers[0]);
    create_buffer(&buffers[1]);
    surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xdg_surface = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xdg_surface, &xdg_surface_listener, NULL);
    struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(xdg_surface);
    xdg_toplevel_add_listener(toplevel, &toplevel_listener, NULL);
    xdg_toplevel_set_title(toplevel, "busy-client");
    xdg_toplevel_set_app_id(toplevel, "test-busy");
    wl_surface_commit(surface);

    double last_write = 0;
    while (wl_display_dispatch(display) != -1) {
        double now = now_ms();
        if (now - last_write > 500) {
            last_write = now;
            write_frames();
        }
    }
    return 0;
}
