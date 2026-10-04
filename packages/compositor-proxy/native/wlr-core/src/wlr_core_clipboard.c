/*
 * The clipboard between the remote apps and the browser (wave 3 E).
 *
 * Remote -> browser: when an app sets the seat's selection, a text mime type is read through a pipe (non-blocking,
 * watched on the wl_event_loop, capped in size and time) and reported to JavaScript as a "clipboard-text" event.
 * Browser -> remote: setClipboardText(text) offers the text as a server-side wlr_data_source and makes it the seat's
 * selection; the data source's send writes the text to the receiver's pipe, again without ever blocking.
 * Our own source is recognized by its impl and never read back, so the browser's text isn't echoed to the browser.
 *
 * The primary selection (middle-click paste) stays between the remote apps: browsers have no primary selection.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_seat.h>
#include "node_api.h"
#include "wlr_core_internal.h"

/* the biggest selection sent to the browser, and how long an app may take to write it */
#define MAX_SELECTION_BYTES (4 * 1024 * 1024)
#define READ_TIMEOUT_MS 3000

/* the text mime types, in order of preference (what we read, and what we offer, except STRING and TEXT) */
static const char *const READ_MIME_TYPES[] = {"text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "TEXT",
                                              "STRING"};
static const char *const OFFER_MIME_TYPES[] = {"text/plain;charset=utf-8", "text/plain", "UTF8_STRING"};
#define COUNT(array) (sizeof(array) / sizeof((array)[0]))

static struct core *clip_core = NULL;

// ---------------------------------------------------------------------------------------------------------------------
// remote -> browser

struct reader {
    struct core *core;
    struct wl_event_source *source, *timer;
    int fd;
    bool latin1;
    char *data;
    size_t length, capacity;
};

static struct reader *reader = NULL;

static void
reader_finish(struct reader *r) {
    if (r->source) {
        wl_event_source_remove(r->source);
    }
    if (r->timer) {
        wl_event_source_remove(r->timer);
    }
    close(r->fd);
    free(r->data);
    if (reader == r) {
        reader = NULL;
    }
    free(r);
}

/* STRING selections are ISO 8859-1, JavaScript wants UTF-8 */
static char *
latin1_to_utf8(const char *data, size_t length, size_t *out_length) {
    char *out = malloc(length * 2 + 1);
    size_t n = 0;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char) data[i];
        if (c < 0x80) {
            out[n++] = (char) c;
        } else {
            out[n++] = (char) (0xc0 | (c >> 6));
            out[n++] = (char) (0x80 | (c & 0x3f));
        }
    }
    *out_length = n;
    return out;
}

static void
reader_deliver(struct reader *r) {
    struct core *core = r->core;
    size_t length = r->length;
    char *converted = NULL;
    const char *data = r->data ? r->data : "";
    if (r->latin1) {
        converted = latin1_to_utf8(data, length, &length);
        data = converted;
    }
    napi_value text;
    napi_create_string_utf8(core->env, data, length, &text);
    free(converted);
    // (the reader goes first: the event handler may run JavaScript that changes the selection)
    reader_finish(r);
    napi_value args[] = {text};
    emit(core, "clipboard-text", 1, args);
}

static int
reader_readable(int fd, uint32_t mask, void *data) {
    struct reader *r = data;
    for (;;) {
        if (r->capacity - r->length < 4096) {
            r->capacity = r->capacity ? r->capacity * 2 : 16384;
            r->data = realloc(r->data, r->capacity);
        }
        ssize_t n = read(fd, r->data + r->length, r->capacity - r->length);
        if (n > 0) {
            r->length += (size_t) n;
            if (r->length > MAX_SELECTION_BYTES) {
                fprintf(stderr, "wlr-core: selection over %d bytes, not sent to the browser\n", MAX_SELECTION_BYTES);
                reader_finish(r);
                return 0;
            }
            continue;
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n < 0 && errno == EAGAIN) {
            return 0;
        }
        // end of data (or an error): what we have is the selection
        reader_deliver(r);
        return 0;
    }
}

static int
reader_timeout(void *data) {
    fprintf(stderr, "wlr-core: an app didn't finish writing its selection, not sent to the browser\n");
    reader_finish(data);
    return 0;
}

static const struct wlr_data_source_impl browser_source_impl;

static const char *
pick_mime(const struct wlr_data_source *source) {
    for (size_t i = 0; i < COUNT(READ_MIME_TYPES); i++) {
        char **mime;
        wl_array_for_each(mime, &source->mime_types) {
            if (strcmp(*mime, READ_MIME_TYPES[i]) == 0) {
                return READ_MIME_TYPES[i];
            }
        }
    }
    return NULL;
}

static void
handle_set_selection(struct wl_listener *listener, void *data) {
    struct core *core = wl_container_of(listener, core, set_selection);
    if (reader) {
        reader_finish(reader);
    }
    struct wlr_data_source *source = core->seat->selection_source;
    if (source == NULL || source->impl == &browser_source_impl) {
        return;
    }
    const char *mime = pick_mime(source);
    if (mime == NULL) {
        return;
    }
    int fds[2];
    if (pipe2(fds, O_CLOEXEC) != 0) {
        return;
    }
    fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK);
    struct reader *r = calloc(1, sizeof(*r));
    r->core = core;
    r->fd = fds[0];
    r->latin1 = strcmp(mime, "STRING") == 0;
    r->source = wl_event_loop_add_fd(core->loop, fds[0], WL_EVENT_READABLE, reader_readable, r);
    r->timer = wl_event_loop_add_timer(core->loop, reader_timeout, r);
    wl_event_source_timer_update(r->timer, READ_TIMEOUT_MS);
    reader = r;
    // the app gets the write end (over the wire, at the next flush); we only keep the read end
    wlr_data_source_send(source, mime, fds[1]);
    close(fds[1]);
}

// ---------------------------------------------------------------------------------------------------------------------
// browser -> remote

/* The text, shared by the data source and the writes still going on. */
struct text {
    char *data;
    size_t length;
    int refs;
};

static void
text_unref(struct text *text) {
    if (--text->refs == 0) {
        free(text->data);
        free(text);
    }
}

struct writer {
    struct wl_event_source *source;
    struct text *text;
    int fd;
    size_t offset;
};

static void
writer_finish(struct writer *w) {
    if (w->source) {
        wl_event_source_remove(w->source);
    }
    close(w->fd);
    text_unref(w->text);
    free(w);
}

/* true: done (or failed) */
static bool
writer_write(struct writer *w) {
    while (w->offset < w->text->length) {
        ssize_t n = write(w->fd, w->text->data + w->offset, w->text->length - w->offset);
        if (n > 0) {
            w->offset += (size_t) n;
        } else if (n < 0 && errno == EINTR) {
            continue;
        } else if (n < 0 && errno == EAGAIN) {
            return false;
        } else {
            return true;
        }
    }
    return true;
}

static int
writer_writable(int fd, uint32_t mask, void *data) {
    struct writer *w = data;
    if ((mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR)) || writer_write(w)) {
        writer_finish(w);
    }
    return 0;
}

struct browser_source {
    struct wlr_data_source base;
    struct text *text;
};

static void
browser_source_send(struct wlr_data_source *source, const char *mime_type, int32_t fd) {
    struct browser_source *self = wl_container_of(source, self, base);
    bool offered = false;
    for (size_t i = 0; i < COUNT(OFFER_MIME_TYPES); i++) {
        offered = offered || strcmp(mime_type, OFFER_MIME_TYPES[i]) == 0;
    }
    if (!offered) {
        close(fd);
        return;
    }
    // never block on an app that doesn't read: write what fits now, the rest when the pipe has room
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    struct writer *w = calloc(1, sizeof(*w));
    w->fd = fd;
    w->text = self->text;
    self->text->refs++;
    if (writer_write(w)) {
        writer_finish(w);
        return;
    }
    w->source = wl_event_loop_add_fd(clip_core->loop, fd, WL_EVENT_WRITABLE, writer_writable, w);
}

static void
browser_source_destroy(struct wlr_data_source *source) {
    struct browser_source *self = wl_container_of(source, self, base);
    text_unref(self->text);
    free(self);
}

static const struct wlr_data_source_impl browser_source_impl = {
        .send = browser_source_send,
        .destroy = browser_source_destroy,
};

// setClipboardText(text)
static napi_value
set_clipboard_text(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct core *core = core_or_throw(env);
    if (core == NULL || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        return NULL;
    }
    size_t length = 0;
    napi_get_value_string_utf8(env, argv[0], NULL, 0, &length);
    struct text *text = calloc(1, sizeof(*text));
    text->data = malloc(length + 1);
    napi_get_value_string_utf8(env, argv[0], text->data, length + 1, &text->length);
    text->refs = 1;

    struct browser_source *source = calloc(1, sizeof(*source));
    wlr_data_source_init(&source->base, &browser_source_impl);
    source->text = text;
    for (size_t i = 0; i < COUNT(OFFER_MIME_TYPES); i++) {
        char **slot = wl_array_add(&source->base.mime_types, sizeof(char *));
        *slot = strdup(OFFER_MIME_TYPES[i]);
    }
    wlr_seat_set_selection(core->seat, &source->base, wl_display_next_serial(core->display));
    core_flush(core);
    return NULL;
}

void
clipboard_init(struct core *core) {
    clip_core = core;
    core->set_selection.notify = handle_set_selection;
    wl_signal_add(&core->seat->events.set_selection, &core->set_selection);
}

napi_value
wlr_core_clipboard_init(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "setClipboardText", NAPI_AUTO_LENGTH, set_clipboard_text, NULL, &function);
    napi_set_named_property(env, exports, "setClipboardText", function);
    return exports;
}
