// Socket tuning for the viewer connection (see src/socket-options.ts): how much unsent data the kernel may buffer, so
// data items wait in the transport's own queue, where control messages and audio can overtake them.
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include "node_api.h"

#define DECLARE_NAPI_METHOD(name, func) { name, 0, func, 0, 0, 0, napi_default, 0 }

// Reads the (fd, bytes) arguments; false (with a JS exception pending) if they aren't two numbers.
static int
get_fd_and_bytes(napi_env env, napi_callback_info info, int32_t *fd, int32_t *bytes) {
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 ||
        napi_get_value_int32(env, argv[0], fd) != napi_ok || napi_get_value_int32(env, argv[1], bytes) != napi_ok) {
        napi_throw_type_error(env, NULL, "Expected (fd: number, bytes: number).");
        return 0;
    }
    return 1;
}

static napi_value
int_value(napi_env env, int value) {
    napi_value result;
    napi_create_int32(env, value, &result);
    return result;
}

// Limits how much unsent data a TCP socket buffers in the kernel (TCP_NOTSENT_LOWAT), so frames wait in our priority
// queue instead of piling data up in the socket. Returns 0 on success, errno otherwise.
static napi_value
set_tcp_not_sent_lowat(napi_env env, napi_callback_info info) {
    int32_t fd, bytes;
    if (!get_fd_and_bytes(env, info, &fd, &bytes)) {
        return NULL;
    }
    int result = 0;
#ifdef TCP_NOTSENT_LOWAT
    if (setsockopt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, &bytes, sizeof(bytes)) < 0) {
        result = errno;
    }
#else
    result = ENOTSUP;
#endif
    return int_value(env, result);
}

// Limits how much a socket buffers in the kernel (SO_SNDBUF). For the Unix socket between a session and the gateway
// this keeps unsent frames in the session's own priority queue instead of the kernel. Returns 0 on success, errno
// otherwise.
static napi_value
set_socket_send_buffer(napi_env env, napi_callback_info info) {
    int32_t fd, bytes;
    if (!get_fd_and_bytes(env, info, &fd, &bytes)) {
        return NULL;
    }
    int result = 0;
    if (setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &bytes, sizeof(bytes)) < 0) {
        result = errno;
    }
    return int_value(env, result);
}

static napi_value
init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
            DECLARE_NAPI_METHOD("setTcpNotSentLowat", set_tcp_not_sent_lowat),
            DECLARE_NAPI_METHOD("setSocketSendBuffer", set_socket_send_buffer),
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
