// The session's D-Bus connection (src/shell/dbus.ts): sd_bus (libsystemd), driven from libuv, with a converter between
// JS values and D-Bus messages driven by the signature. The value mapping (documented in dbus.ts):
//   - y n q i u x t d are numbers (64-bit integers lose precision past 2^53), b a boolean, s o g strings, h an fd;
//   - ay is a Buffer (any Uint8Array or array of numbers when sending);
//   - other arrays are arrays, structs are arrays of their fields;
//   - a{..} dictionaries are plain objects keyed by the key (numbers become property names, and back);
//   - v is a Variant (the class given to setVariantClass: `new Variant(signature, value)`; anything with `signature`
//     and `value` when sending).
//
// Every message received (except replies to our calls) goes to one JS function, which says whether it handled it; a
// method call it doesn't handle is left to sd_bus (which answers UnknownObject or UnknownMethod).
#define _GNU_SOURCE
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <fcntl.h>
#include <poll.h>
#include <systemd/sd-bus.h>
#include "node_api.h"
// avoid depending on libuv
#include "uv.h"

#define DECLARE_NAPI_METHOD(name, func) \
  { name, 0, func, 0, 0, 0, napi_default, 0 }

// Leaves the function with `ret` if a N-API call fails (the error is thrown unless one is pending already).
#define CHECK(env, the_call, ret)                                                 \
  do {                                                                            \
    if ((the_call) != napi_ok) {                                                  \
      throw_last_error(env);                                                      \
      return ret;                                                                 \
    }                                                                             \
  } while (0)

static napi_ref variant_class;

struct bus {
  sd_bus *bus;
  napi_env env;
  napi_async_context async_context;
  napi_ref on_message;
  napi_ref on_close;
  sd_bus_slot *filter;
  uv_poll_t poll;
  uv_timer_t timer;
  int handles_open;
  // inside sd_bus_process: closing waits until it returns
  bool processing;
  bool close_requested;
  bool closed;
};

struct pending_call {
  // may be gone by the time the slot is destroyed (when the last message referencing the sd_bus is collected)
  struct bus *bus;
  napi_env env;
  napi_ref callback;
};

static void
throw_last_error(napi_env env) {
  const napi_extended_error_info *info;
  bool pending;
  napi_get_last_error_info(env, &info);
  napi_is_exception_pending(env, &pending);
  if (!pending) {
    napi_throw_error(env, NULL, info->error_message ? info->error_message : "N-API call failed");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// signatures

// The length of the complete type at the start of `s`, 0 if there's none.
static size_t
complete_type_length(const char *s) {
  switch (*s) {
    case 'a': {
      size_t n = complete_type_length(s + 1);
      return n ? n + 1 : 0;
    }
    case '(':
    case '{': {
      char close = *s == '(' ? ')' : '}';
      size_t i = 1;
      while (s[i] && s[i] != close) {
        size_t n = complete_type_length(s + i);
        if (n == 0) {
          return 0;
        }
        i += n;
      }
      return s[i] && i > 1 ? i + 1 : 0;
    }
    case 0:
      return 0;
    default:
      return strchr("ybnqiuxtdsoghv", *s) ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// JS -> message

// Conversion errors: a message for the TypeError thrown (or the error reply), set by the first failure.
static char conversion_error[256];

static int
conversion_failed(const char *format, const char *detail) {
  snprintf(conversion_error, sizeof(conversion_error), format, detail);
  return -EINVAL;
}

static int append_value(napi_env env, sd_bus_message *m, const char *type, size_t type_length, napi_value value);

static int
append_string(napi_env env, sd_bus_message *m, char type, napi_value value) {
  napi_valuetype value_type;
  size_t length;
  if (napi_typeof(env, value, &value_type) != napi_ok || value_type != napi_string) {
    char t[2] = {type, 0};
    return conversion_failed("expected a string for '%s'", t);
  }
  napi_get_value_string_utf8(env, value, NULL, 0, &length);
  char *text = malloc(length + 1);
  napi_get_value_string_utf8(env, value, text, length + 1, &length);
  int r = strlen(text) == length ? sd_bus_message_append_basic(m, type, text) : conversion_failed("%s", "a string contains NUL");
  free(text);
  return r;
}

static int
append_basic(napi_env env, sd_bus_message *m, char type, napi_value value) {
  if (type == 's' || type == 'o' || type == 'g') {
    return append_string(env, m, type, value);
  }
  if (type == 'b') {
    bool b;
    napi_value coerced;
    napi_coerce_to_bool(env, value, &coerced);
    napi_get_value_bool(env, coerced, &b);
    int i = b;
    return sd_bus_message_append_basic(m, type, &i);
  }
  double d;
  napi_valuetype value_type;
  napi_typeof(env, value, &value_type);
  if (value_type == napi_bigint) {
    bool lossless;
    int64_t i;
    napi_get_value_bigint_int64(env, value, &i, &lossless);
    d = (double) i;
  } else if (value_type == napi_number) {
    napi_get_value_double(env, value, &d);
  } else {
    char t[2] = {type, 0};
    return conversion_failed("expected a number for '%s'", t);
  }
  switch (type) {
    case 'y': {
      uint8_t v = (uint8_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 'n': {
      int16_t v = (int16_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 'q': {
      uint16_t v = (uint16_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 'i':
    case 'h': {
      int32_t v = (int32_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 'u': {
      // like JS's >>> 0 for negative numbers
      uint32_t v = d < 0 ? (uint32_t) (int32_t) d : (uint32_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 'x': {
      int64_t v = (int64_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 't': {
      uint64_t v = (uint64_t) d;
      return sd_bus_message_append_basic(m, type, &v);
    }
    case 'd':
      return sd_bus_message_append_basic(m, type, &d);
  }
  char t[2] = {type, 0};
  return conversion_failed("unknown type '%s'", t);
}

static int
get_array(napi_env env, napi_value value, uint32_t *length) {
  bool is_array;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    return conversion_failed("%s", "expected an array");
  }
  napi_get_array_length(env, value, length);
  return 0;
}

static int
append_array(napi_env env, sd_bus_message *m, const char *element, size_t element_length, napi_value value) {
  char *contents = strndup(element, element_length);
  int r = 0;
  bool is_typed_array = false;
  if (element_length == 1 && element[0] == 'y') {
    napi_is_typedarray(env, value, &is_typed_array);
  }
  if (is_typed_array) {
    napi_typedarray_type typed_type;
    size_t length;
    void *data;
    napi_get_typedarray_info(env, value, &typed_type, &length, &data, NULL, NULL);
    r = typed_type == napi_uint8_array || typed_type == napi_int8_array || typed_type == napi_uint8_clamped_array
          ? sd_bus_message_append_array(m, 'y', data, length)
          : conversion_failed("%s", "expected a Uint8Array for 'ay'");
  } else if (element[0] == '{') {
    // a dictionary: a plain object
    napi_valuetype value_type;
    napi_value keys;
    uint32_t count;
    if (napi_typeof(env, value, &value_type) != napi_ok || value_type != napi_object ||
        napi_get_all_property_names(env, value, napi_key_own_only, napi_key_enumerable | napi_key_skip_symbols,
                                    napi_key_numbers_to_strings, &keys) != napi_ok) {
      free(contents);
      return conversion_failed("expected an object for 'a%s'", "{..}");
    }
    napi_get_array_length(env, keys, &count);
    const char *key_type = element + 1;
    size_t key_length = complete_type_length(key_type);
    const char *value_type_sig = key_type + key_length;
    size_t value_length = complete_type_length(value_type_sig);
    char *entry = strndup(element + 1, element_length - 2);
    r = sd_bus_message_open_container(m, 'a', contents);
    for (uint32_t i = 0; r >= 0 && i < count; i++) {
      napi_value key, entry_value;
      napi_get_element(env, keys, i, &key);
      napi_get_property(env, value, key, &entry_value);
      if (!strchr("sog", key_type[0])) {
        napi_coerce_to_number(env, key, &key);
      }
      r = sd_bus_message_open_container(m, 'e', entry);
      if (r >= 0) {
        r = append_value(env, m, key_type, key_length, key);
      }
      if (r >= 0) {
        r = append_value(env, m, value_type_sig, value_length, entry_value);
      }
      if (r >= 0) {
        r = sd_bus_message_close_container(m);
      }
    }
    if (r >= 0) {
      r = sd_bus_message_close_container(m);
    }
    free(entry);
  } else {
    uint32_t length;
    r = get_array(env, value, &length);
    if (r >= 0) {
      r = sd_bus_message_open_container(m, 'a', contents);
    }
    for (uint32_t i = 0; r >= 0 && i < length; i++) {
      napi_value item;
      napi_get_element(env, value, i, &item);
      r = append_value(env, m, element, element_length, item);
    }
    if (r >= 0) {
      r = sd_bus_message_close_container(m);
    }
  }
  free(contents);
  return r;
}

static int
append_struct(napi_env env, sd_bus_message *m, const char *type, size_t type_length, napi_value value) {
  uint32_t length;
  int r = get_array(env, value, &length);
  if (r < 0) {
    return r;
  }
  char *contents = strndup(type + 1, type_length - 2);
  r = sd_bus_message_open_container(m, 'r', contents);
  const char *field = contents;
  for (uint32_t i = 0; r >= 0 && *field; i++) {
    size_t field_length = complete_type_length(field);
    if (i >= length) {
      r = conversion_failed("too few fields for '(%.200s)'", contents);
      break;
    }
    napi_value item;
    napi_get_element(env, value, i, &item);
    r = append_value(env, m, field, field_length, item);
    field += field_length;
  }
  if (r >= 0) {
    r = sd_bus_message_close_container(m);
  }
  free(contents);
  return r;
}

static int
append_variant(napi_env env, sd_bus_message *m, napi_value value) {
  napi_valuetype value_type;
  napi_value signature_value, inner;
  if (napi_typeof(env, value, &value_type) != napi_ok || value_type != napi_object ||
      napi_get_named_property(env, value, "signature", &signature_value) != napi_ok ||
      napi_get_named_property(env, value, "value", &inner) != napi_ok ||
      napi_typeof(env, signature_value, &value_type) != napi_ok || value_type != napi_string) {
    return conversion_failed("%s", "expected a Variant for 'v'");
  }
  char signature[256];
  size_t length;
  napi_get_value_string_utf8(env, signature_value, signature, sizeof(signature), &length);
  if (length == 0 || complete_type_length(signature) != length) {
    return conversion_failed("bad variant signature '%.200s'", signature);
  }
  int r = sd_bus_message_open_container(m, 'v', signature);
  if (r >= 0) {
    r = append_value(env, m, signature, length, inner);
  }
  if (r >= 0) {
    r = sd_bus_message_close_container(m);
  }
  return r;
}

static int
append_value(napi_env env, sd_bus_message *m, const char *type, size_t type_length, napi_value value) {
  switch (type[0]) {
    case 'a':
      return append_array(env, m, type + 1, type_length - 1, value);
    case '(':
      return append_struct(env, m, type, type_length, value);
    case 'v':
      return append_variant(env, m, value);
    default:
      return append_basic(env, m, type[0], value);
  }
}

// Appends `body` (an array) as the message's arguments of `signature`.
static int
append_body(napi_env env, sd_bus_message *m, const char *signature, napi_value body) {
  uint32_t length;
  int r = get_array(env, body, &length);
  uint32_t i = 0;
  for (const char *type = signature; r >= 0 && *type; i++) {
    size_t type_length = complete_type_length(type);
    if (type_length == 0) {
      return conversion_failed("bad signature '%.200s'", signature);
    }
    if (i >= length) {
      return conversion_failed("too few arguments for '%.200s'", signature);
    }
    napi_value item;
    napi_get_element(env, body, i, &item);
    r = append_value(env, m, type, type_length, item);
    type += type_length;
  }
  if (r >= 0 && i < length) {
    return conversion_failed("too many arguments for '%.200s'", signature);
  }
  if (r < 0 && conversion_error[0] == 0) {
    snprintf(conversion_error, sizeof(conversion_error), "can't append to '%.120s': %.100s", signature, strerror(-r));
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// message -> JS

static int read_value(napi_env env, sd_bus_message *m, napi_value *out);

static int
read_basic(napi_env env, sd_bus_message *m, char type, napi_value *out) {
  union {
    uint8_t y;
    int16_t n;
    uint16_t q;
    int32_t i;
    uint32_t u;
    int64_t x;
    uint64_t t;
    double d;
    int b;
    const char *s;
  } v;
  int r = sd_bus_message_read_basic(m, type, &v);
  if (r < 0) {
    return r;
  }
  switch (type) {
    case 'y':
      napi_create_uint32(env, v.y, out);
      break;
    case 'n':
      napi_create_int32(env, v.n, out);
      break;
    case 'q':
      napi_create_uint32(env, v.q, out);
      break;
    case 'i':
      napi_create_int32(env, v.i, out);
      break;
    case 'u':
      napi_create_uint32(env, v.u, out);
      break;
    case 'x':
      napi_create_int64(env, v.x, out);
      break;
    case 't':
      napi_create_double(env, (double) v.t, out);
      break;
    case 'd':
      napi_create_double(env, v.d, out);
      break;
    case 'b':
      napi_get_boolean(env, v.b != 0, out);
      break;
    case 'h':
      // the message owns the fd; ours is a copy (or -1)
      napi_create_int32(env, v.i >= 0 ? fcntl(v.i, F_DUPFD_CLOEXEC, 3) : -1, out);
      break;
    case 's':
    case 'o':
    case 'g':
      napi_create_string_utf8(env, v.s, NAPI_AUTO_LENGTH, out);
      break;
    default:
      return -EINVAL;
  }
  return 0;
}

static int
read_container(napi_env env, sd_bus_message *m, char type, const char *contents, napi_value *out) {
  int r;
  if (type == 'a' && contents[0] == 'y' && contents[1] == 0) {
    const void *data;
    size_t size;
    void *copy;
    r = sd_bus_message_read_array(m, 'y', &data, &size);
    if (r >= 0) {
      napi_create_buffer_copy(env, size, data, &copy, out);
    }
    return r;
  }
  r = sd_bus_message_enter_container(m, type, contents);
  if (r < 0) {
    return r;
  }
  if (type == 'v') {
    napi_value args[2], constructor;
    napi_create_string_utf8(env, contents, NAPI_AUTO_LENGTH, &args[0]);
    r = read_value(env, m, &args[1]);
    if (r >= 0 && (napi_get_reference_value(env, variant_class, &constructor) != napi_ok ||
                   napi_new_instance(env, constructor, 2, args, out) != napi_ok)) {
      r = -EINVAL;
    }
  } else if (type == 'a' && contents[0] == '{') {
    napi_create_object(env, out);
    // (entering with no contents at the end fails instead of answering 0)
    while (r >= 0 && (r = sd_bus_message_peek_type(m, NULL, NULL)) > 0) {
      napi_value key, value;
      r = sd_bus_message_enter_container(m, 'e', NULL);
      if (r >= 0) {
        r = read_value(env, m, &key);
      }
      if (r >= 0) {
        r = read_value(env, m, &value);
      }
      if (r >= 0) {
        napi_set_property(env, *out, key, value);
        r = sd_bus_message_exit_container(m);
      }
    }
  } else {
    // arrays and structs
    napi_create_array(env, out);
    uint32_t i = 0;
    char element_type;
    while (r >= 0 && (r = sd_bus_message_peek_type(m, &element_type, NULL)) > 0) {
      napi_value value;
      r = read_value(env, m, &value);
      if (r >= 0) {
        napi_set_element(env, *out, i++, value);
      }
    }
  }
  if (r >= 0) {
    r = sd_bus_message_exit_container(m);
  }
  return r;
}

static int
read_value(napi_env env, sd_bus_message *m, napi_value *out) {
  char type;
  const char *contents;
  int r = sd_bus_message_peek_type(m, &type, &contents);
  if (r <= 0) {
    return r < 0 ? r : -ENXIO;
  }
  if (type == 'a' || type == 'r' || type == 'v' || type == 'e') {
    return read_container(env, m, type, contents, out);
  }
  return read_basic(env, m, type, out);
}

// The message's arguments as an array.
static int
read_body(napi_env env, sd_bus_message *m, napi_value *out) {
  napi_create_array(env, out);
  uint32_t i = 0;
  int r;
  char type;
  while ((r = sd_bus_message_peek_type(m, &type, NULL)) > 0) {
    napi_value value;
    r = read_value(env, m, &value);
    if (r < 0) {
      break;
    }
    napi_set_element(env, *out, i++, value);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// the event loop

static void rearm(struct bus *bus);
static void teardown(struct bus *bus, const char *error);

// Calls a JS function from the event loop (so its promises settle before we return). An exception becomes uncaught.
static void
make_callback(struct bus *bus, napi_ref function_ref, size_t argc, napi_value *argv, napi_value *result) {
  napi_env env = bus->env;
  napi_value function, resource, ignored;
  napi_get_reference_value(env, function_ref, &function);
  napi_create_object(env, &resource);
  if (napi_make_callback(env, bus->async_context, resource, function, argc, argv, result ? result : &ignored) !=
      napi_ok) {
    bool pending;
    napi_is_exception_pending(env, &pending);
    if (pending) {
      napi_value error;
      napi_get_and_clear_last_exception(env, &error);
      napi_fatal_exception(env, error);
    }
    if (result) {
      *result = NULL;
    }
  }
}

static void
process(struct bus *bus) {
  napi_handle_scope scope;
  napi_open_handle_scope(bus->env, &scope);
  bus->processing = true;
  int r = 0;
  while (!bus->close_requested && (r = sd_bus_process(bus->bus, NULL)) > 0) {
  }
  bus->processing = false;
  if (bus->close_requested) {
    teardown(bus, NULL);
  } else if (r < 0 || sd_bus_is_open(bus->bus) <= 0) {
    teardown(bus, r < 0 ? strerror(-r) : "disconnected");
  } else {
    rearm(bus);
  }
  napi_close_handle_scope(bus->env, scope);
}

static void
on_poll(uv_poll_t *handle, int status, int events) {
  (void) status;
  (void) events;
  process(handle->data);
}

static void
on_timer(uv_timer_t *handle) {
  process(handle->data);
}

// Waits for what sd_bus waits for next (the fd readable or writable, a timeout).
static void
rearm(struct bus *bus) {
  int events = sd_bus_get_events(bus->bus);
  if (events < 0) {
    teardown(bus, strerror(-events));
    return;
  }
  uv_poll_start(&bus->poll, (events & POLLIN ? UV_READABLE : 0) | (events & POLLOUT ? UV_WRITABLE : 0), on_poll);
  uint64_t deadline;
  if (sd_bus_get_timeout(bus->bus, &deadline) >= 0 && deadline != UINT64_MAX) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint64_t now_us = (uint64_t) now.tv_sec * 1000000 + (uint64_t) now.tv_nsec / 1000;
    uv_timer_start(&bus->timer, on_timer, deadline > now_us ? (deadline - now_us + 999) / 1000 : 0, 0);
  } else {
    uv_timer_stop(&bus->timer);
  }
}

static void
handle_closed(uv_handle_t *handle) {
  struct bus *bus = handle->data;
  if (--bus->handles_open == 0) {
    free(bus);
  }
}

// Closes the connection (sending what's queued first) and, on `error`, tells JS.
static void
teardown(struct bus *bus, const char *error) {
  if (bus->closed) {
    return;
  }
  bus->closed = true;
  napi_env env = bus->env;
  sd_bus_slot_unref(bus->filter);
  sd_bus_flush_close_unref(bus->bus);
  bus->bus = NULL;
  uv_poll_stop(&bus->poll);
  uv_timer_stop(&bus->timer);
  if (error) {
    napi_value argv[1];
    napi_create_string_utf8(env, error, NAPI_AUTO_LENGTH, &argv[0]);
    make_callback(bus, bus->on_close, 1, argv, NULL);
  }
  napi_delete_reference(env, bus->on_message);
  napi_delete_reference(env, bus->on_close);
  napi_async_destroy(env, bus->async_context);
  uv_close((uv_handle_t *) &bus->poll, handle_closed);
  uv_close((uv_handle_t *) &bus->timer, handle_closed);
}

// ---------------------------------------------------------------------------------------------------------------------
// messages received

static void
release_message(napi_env env, void *data, void *hint) {
  (void) env;
  (void) hint;
  sd_bus_message_unref(data);
}

static napi_value
string_or_empty(napi_env env, const char *s) {
  napi_value value;
  napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &value);
  return value;
}

static int
filter(sd_bus_message *m, void *userdata, sd_bus_error *ret_error) {
  (void) ret_error;
  struct bus *bus = userdata;
  napi_env env = bus->env;
  uint8_t type;
  sd_bus_message_get_type(m, &type);
  bool is_call = type == SD_BUS_MESSAGE_METHOD_CALL;
  if ((!is_call && type != SD_BUS_MESSAGE_SIGNAL) || bus->close_requested ||
      (sd_bus_message_get_path(m) && strcmp(sd_bus_message_get_path(m), "/org/freedesktop/DBus/Local") == 0)) {
    return 0;
  }
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);
  napi_value body;
  conversion_error[0] = 0;
  int r = read_body(env, m, &body);
  // for sd_bus's own dispatch, if we leave it the message
  sd_bus_message_rewind(m, true);
  int handled = 0;
  if (r < 0) {
    if (is_call) {
      sd_bus_reply_method_errorf(m, SD_BUS_ERROR_INVALID_ARGS, "Couldn't read the arguments: %s", strerror(-r));
      handled = 1;
    }
  } else {
    napi_value argv[8], result;
    napi_get_boolean(env, is_call, &argv[0]);
    argv[1] = string_or_empty(env, sd_bus_message_get_sender(m));
    argv[2] = string_or_empty(env, sd_bus_message_get_path(m));
    argv[3] = string_or_empty(env, sd_bus_message_get_interface(m));
    argv[4] = string_or_empty(env, sd_bus_message_get_member(m));
    argv[5] = string_or_empty(env, sd_bus_message_get_signature(m, true));
    argv[6] = body;
    if (is_call) {
      napi_create_external(env, sd_bus_message_ref(m), release_message, NULL, &argv[7]);
    } else {
      napi_get_undefined(env, &argv[7]);
    }
    make_callback(bus, bus->on_message, 8, argv, &result);
    bool b = false;
    if (result) {
      napi_get_value_bool(env, result, &b);
    }
    handled = is_call && b;
  }
  napi_close_handle_scope(env, scope);
  return handled;
}

// ---------------------------------------------------------------------------------------------------------------------
// the JS functions

static struct bus *
get_bus(napi_env env, napi_value value) {
  struct bus *bus;
  if (napi_get_value_external(env, value, (void **) &bus) != napi_ok) {
    napi_throw_type_error(env, NULL, "not a bus");
    return NULL;
  }
  if (bus->closed || bus->close_requested) {
    napi_throw_error(env, NULL, "the D-Bus connection is closed");
    return NULL;
  }
  return bus;
}

static char *
get_string(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a string");
    return NULL;
  }
  char *text = malloc(length + 1);
  napi_get_value_string_utf8(env, value, text, length + 1, &length);
  return text;
}

static napi_value
throw_errno(napi_env env, const char *what, int r) {
  char message[512];
  snprintf(message, sizeof(message), "%s: %s", what, conversion_error[0] ? conversion_error : strerror(-r));
  napi_throw_error(env, NULL, message);
  return NULL;
}

// setVariantClass(constructor)
static napi_value
set_variant_class(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  if (variant_class) {
    napi_delete_reference(env, variant_class);
  }
  CHECK(env, napi_create_reference(env, argv[0], 1, &variant_class), NULL);
  return NULL;
}

// openSessionBus(onMessage, onClose): bus
static napi_value
open_session_bus(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result, name;
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  sd_bus *sd;
  int r = sd_bus_open_user(&sd);
  if (r < 0) {
    return throw_errno(env, "Couldn't connect to the session bus", r);
  }
  struct bus *bus = calloc(1, sizeof(*bus));
  bus->bus = sd;
  bus->env = env;
  napi_create_string_utf8(env, "nebula:dbus", NAPI_AUTO_LENGTH, &name);
  napi_async_init(env, NULL, name, &bus->async_context);
  napi_create_reference(env, argv[0], 1, &bus->on_message);
  napi_create_reference(env, argv[1], 1, &bus->on_close);
  sd_bus_add_filter(sd, &bus->filter, filter, bus);
  uv_loop_t *loop;
  napi_get_uv_event_loop(env, &loop);
  uv_poll_init(loop, &bus->poll, sd_bus_get_fd(sd));
  uv_timer_init(loop, &bus->timer);
  bus->poll.data = bus;
  bus->timer.data = bus;
  bus->handles_open = 2;
  rearm(bus);
  CHECK(env, napi_create_external(env, bus, NULL, NULL, &result), NULL);
  return result;
}

// uniqueName(bus): string (only once a reply came: the bus has said hello)
static napi_value
unique_name(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  struct bus *bus = get_bus(env, argv[0]);
  if (!bus) {
    return NULL;
  }
  const char *name;
  int r = sd_bus_get_unique_name(bus->bus, &name);
  if (r < 0) {
    return throw_errno(env, "No unique name", r);
  }
  return string_or_empty(env, name);
}

static int
call_replied(sd_bus_message *m, void *userdata, sd_bus_error *ret_error) {
  (void) ret_error;
  struct pending_call *call = userdata;
  struct bus *bus = call->bus;
  if (bus->closed) {
    return 0;
  }
  napi_env env = bus->env;
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);
  napi_value argv[3];
  napi_get_null(env, &argv[0]);
  napi_get_null(env, &argv[1]);
  napi_get_null(env, &argv[2]);
  const sd_bus_error *error = sd_bus_message_get_error(m);
  if (error) {
    argv[0] = string_or_empty(env, error->name);
    argv[1] = string_or_empty(env, error->message);
  } else {
    conversion_error[0] = 0;
    int r = read_body(env, m, &argv[2]);
    if (r < 0) {
      argv[0] = string_or_empty(env, SD_BUS_ERROR_INVALID_ARGS);
      char text[300];
      snprintf(text, sizeof(text), "Couldn't read the reply: %s", strerror(-r));
      argv[1] = string_or_empty(env, text);
    }
  }
  make_callback(bus, call->callback, 3, argv, NULL);
  napi_close_handle_scope(env, scope);
  return 1;
}

static void
call_destroyed(void *userdata) {
  struct pending_call *call = userdata;
  napi_delete_reference(call->env, call->callback);
  free(call);
}

// Sends a message built by the caller and rearms the event loop (sd_bus queues what it can't write at once).
static napi_value
send_message(napi_env env, struct bus *bus, sd_bus_message *m, const char *signature, napi_value body) {
  conversion_error[0] = 0;
  int r = append_body(env, m, signature, body);
  if (r >= 0) {
    r = sd_bus_send(bus->bus, m, NULL);
  }
  sd_bus_message_unref(m);
  if (r < 0) {
    return throw_errno(env, "Couldn't send a D-Bus message", r);
  }
  rearm(bus);
  return NULL;
}

// call(bus, destination, path, interface, member, signature, body, timeoutMs, callback(errorName, errorMessage, body))
static napi_value
call_method(napi_env env, napi_callback_info info) {
  size_t argc = 9;
  napi_value argv[9];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  struct bus *bus = get_bus(env, argv[0]);
  if (!bus) {
    return NULL;
  }
  // destination, path, interface, member, signature
  char *strings[5] = {0};
  sd_bus_message *m = NULL;
  double timeout_ms;
  for (int i = 0; i < 5; i++) {
    if (!(strings[i] = get_string(env, argv[1 + i]))) {
      goto done;
    }
  }
  if (napi_get_value_double(env, argv[7], &timeout_ms) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a timeout");
    goto done;
  }
  conversion_error[0] = 0;
  int r = sd_bus_message_new_method_call(bus->bus, &m, strings[0], strings[1], strings[2][0] ? strings[2] : NULL,
                                         strings[3]);
  if (r >= 0) {
    r = append_body(env, m, strings[4], argv[6]);
  }
  if (r < 0) {
    throw_errno(env, "Couldn't make a D-Bus call", r);
    goto done;
  }
  struct pending_call *call = calloc(1, sizeof(*call));
  call->bus = bus;
  call->env = env;
  napi_create_reference(env, argv[8], 1, &call->callback);
  sd_bus_slot *slot;
  r = sd_bus_call_async(bus->bus, &slot, m, call_replied, call, (uint64_t) (timeout_ms * 1000));
  if (r < 0) {
    napi_delete_reference(env, call->callback);
    free(call);
    throw_errno(env, "Couldn't make a D-Bus call", r);
    goto done;
  }
  // the slot belongs to the bus now, and frees the call with itself
  sd_bus_slot_set_destroy_callback(slot, call_destroyed);
  sd_bus_slot_set_floating(slot, 1);
  sd_bus_slot_unref(slot);
  rearm(bus);
done:
  for (int i = 0; i < 5; i++) {
    free(strings[i]);
  }
  sd_bus_message_unref(m);
  return NULL;
}

// emitSignal(bus, path, interface, member, signature, body)
static napi_value
emit_signal(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  struct bus *bus = get_bus(env, argv[0]);
  if (!bus) {
    return NULL;
  }
  // path, interface, member, signature
  char *strings[4] = {0};
  napi_value result = NULL;
  for (int i = 0; i < 4; i++) {
    if (!(strings[i] = get_string(env, argv[1 + i]))) {
      goto done;
    }
  }
  sd_bus_message *m;
  int r = sd_bus_message_new_signal(bus->bus, &m, strings[0], strings[1], strings[2]);
  if (r < 0) {
    throw_errno(env, "Couldn't make a D-Bus signal", r);
    goto done;
  }
  result = send_message(env, bus, m, strings[3], argv[5]);
done:
  for (int i = 0; i < 4; i++) {
    free(strings[i]);
  }
  return result;
}

// reply(bus, call, signature, body)
static napi_value
reply(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  struct bus *bus = get_bus(env, argv[0]);
  sd_bus_message *call;
  if (!bus) {
    return NULL;
  }
  CHECK(env, napi_get_value_external(env, argv[1], (void **) &call), NULL);
  if (sd_bus_message_get_expect_reply(call) == 0) {
    return NULL;
  }
  char *signature = get_string(env, argv[2]);
  if (!signature) {
    return NULL;
  }
  sd_bus_message *m;
  napi_value result = NULL;
  int r = sd_bus_message_new_method_return(call, &m);
  if (r < 0) {
    throw_errno(env, "Couldn't make a D-Bus reply", r);
  } else {
    result = send_message(env, bus, m, signature, argv[3]);
  }
  free(signature);
  return result;
}

// replyError(bus, call, name, message)
static napi_value
reply_error(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  struct bus *bus = get_bus(env, argv[0]);
  sd_bus_message *call;
  if (!bus) {
    return NULL;
  }
  CHECK(env, napi_get_value_external(env, argv[1], (void **) &call), NULL);
  char *name = get_string(env, argv[2]);
  char *message = name ? get_string(env, argv[3]) : NULL;
  if (message) {
    int r = sd_bus_reply_method_errorf(call, name, "%s", message);
    if (r < 0) {
      throw_errno(env, "Couldn't send a D-Bus error", r);
    } else {
      rearm(bus);
    }
  }
  free(name);
  free(message);
  return NULL;
}

// close(bus): sends what's queued, then closes (onClose isn't called).
static napi_value
close_bus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), NULL);
  struct bus *bus;
  CHECK(env, napi_get_value_external(env, argv[0], (void **) &bus), NULL);
  if (bus->processing) {
    bus->close_requested = true;
  } else {
    teardown(bus, NULL);
  }
  return NULL;
}

static napi_value
module_init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    DECLARE_NAPI_METHOD("setVariantClass", set_variant_class),
    DECLARE_NAPI_METHOD("openSessionBus", open_session_bus),
    DECLARE_NAPI_METHOD("uniqueName", unique_name),
    DECLARE_NAPI_METHOD("call", call_method),
    DECLARE_NAPI_METHOD("emitSignal", emit_signal),
    DECLARE_NAPI_METHOD("reply", reply),
    DECLARE_NAPI_METHOD("replyError", reply_error),
    DECLARE_NAPI_METHOD("close", close_bus),
  };
  CHECK(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties), NULL);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, module_init)
