// Unix sockets with fd passing, for the gateway (its web process and its sessions talk to the login helpers, which
// hand them connections as fds: see packages/login). Node's own sockets can't send or receive fds, so these work on
// raw fds; the caller waits for readability with startPoll (poll.c) and wraps a received connection in a net.Socket.
// All sockets made here are non-blocking and close-on-exec. Errors are returned as -errno, never thrown.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include "node_api.h"

#define MAX_RECEIVED_FDS 4

static napi_value
int_value(napi_env env, int32_t value) {
    napi_value result;
    napi_create_int32(env, value, &result);
    return result;
}

static int
set_non_blocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        return -errno;
    }
    return 0;
}

// unixConnect(path: string): number. A connected Unix stream socket (non-blocking once connected), or -errno.
napi_value
fd_unix_connect(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    size_t length = 0;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
        napi_get_value_string_utf8(env, argv[0], address.sun_path, sizeof(address.sun_path), &length) != napi_ok) {
        return int_value(env, -EINVAL);
    }
    if (length >= sizeof(address.sun_path) - 1) {
        return int_value(env, -ENAMETOOLONG);
    }
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return int_value(env, -errno);
    }
    // a Unix socket connects at once (or fails); blocking only waits while the listener's backlog is full
    if (connect(fd, (struct sockaddr *) &address, sizeof(address)) < 0) {
        int error = errno;
        close(fd);
        return int_value(env, -error);
    }
    int error = set_non_blocking(fd);
    if (error < 0) {
        close(fd);
        return int_value(env, error);
    }
    return int_value(env, fd);
}

// acceptConnection(listenFd: number): number. The next connection on a listening socket (non-blocking), -EAGAIN if
// there is none, or -errno.
napi_value
fd_accept_connection(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    int32_t listen_fd;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
        napi_get_value_int32(env, argv[0], &listen_fd) != napi_ok) {
        return int_value(env, -EINVAL);
    }
    int fd;
    do {
        fd = accept4(listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    } while (fd < 0 && errno == EINTR);
    return int_value(env, fd < 0 ? -errno : fd);
}

// sendWithFd(fd: number, data: Buffer, passFd: number): number. Sends data (passFd, unless -1, with its first byte),
// without blocking. Returns how many bytes went out, or -errno.
napi_value
fd_send_with_fd(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    int32_t fd, pass_fd;
    void *data;
    size_t length;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
        napi_get_value_int32(env, argv[0], &fd) != napi_ok ||
        napi_get_buffer_info(env, argv[1], &data, &length) != napi_ok ||
        napi_get_value_int32(env, argv[2], &pass_fd) != napi_ok) {
        return int_value(env, -EINVAL);
    }
    struct iovec iov = {.iov_base = data, .iov_len = length};
    union {
        char buffer[CMSG_SPACE(sizeof(int))];
        struct cmsghdr align;
    } control;
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1};
    if (pass_fd >= 0) {
        memset(&control, 0, sizeof(control));
        message.msg_control = control.buffer;
        message.msg_controllen = sizeof(control.buffer);
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = SOL_SOCKET;
        header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(header), &pass_fd, sizeof(int));
    }
    ssize_t sent;
    do {
        sent = sendmsg(fd, &message, MSG_NOSIGNAL | MSG_DONTWAIT);
    } while (sent < 0 && errno == EINTR);
    return int_value(env, sent < 0 ? -errno : (int32_t) sent);
}

// receiveWithFds(fd: number, maxBytes: number): { data: Buffer, fds: number[] } | number. What is there to read (an
// empty buffer: EOF) and any fds that came with it (close-on-exec), without blocking; -EAGAIN if nothing is there, or
// -errno. More than MAX_RECEIVED_FDS fds at once is an error (-EMSGSIZE; the ones that came are closed).
napi_value
fd_receive_with_fds(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2], result, buffer_value, fds_value;
    int32_t fd, max_bytes;
    void *data;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
        napi_get_value_int32(env, argv[0], &fd) != napi_ok ||
        napi_get_value_int32(env, argv[1], &max_bytes) != napi_ok || max_bytes <= 0 || max_bytes > 65536) {
        return int_value(env, -EINVAL);
    }
    char bytes[max_bytes];
    struct iovec iov = {.iov_base = bytes, .iov_len = (size_t) max_bytes};
    union {
        char buffer[CMSG_SPACE(sizeof(int) * MAX_RECEIVED_FDS)];
        struct cmsghdr align;
    } control;
    struct msghdr message = {
            .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.buffer, .msg_controllen = sizeof(control.buffer)};
    ssize_t received;
    do {
        received = recvmsg(fd, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
    } while (received < 0 && errno == EINTR);
    if (received < 0) {
        return int_value(env, -errno);
    }

    int fds[MAX_RECEIVED_FDS * 2];
    size_t fd_count = 0;
    for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header != NULL; header = CMSG_NXTHDR(&message, header)) {
        if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
            size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            for (size_t i = 0; i < count && fd_count < sizeof(fds) / sizeof(fds[0]); i++) {
                memcpy(&fds[fd_count++], CMSG_DATA(header) + i * sizeof(int), sizeof(int));
            }
        }
    }
    if (message.msg_flags & MSG_CTRUNC) {
        for (size_t i = 0; i < fd_count; i++) {
            close(fds[i]);
        }
        return int_value(env, -EMSGSIZE);
    }

    napi_create_object(env, &result);
    napi_create_buffer_copy(env, (size_t) received, bytes, &data, &buffer_value);
    napi_create_array_with_length(env, fd_count, &fds_value);
    for (size_t i = 0; i < fd_count; i++) {
        napi_set_element(env, fds_value, (uint32_t) i, int_value(env, fds[i]));
    }
    napi_set_named_property(env, result, "data", buffer_value);
    napi_set_named_property(env, result, "fds", fds_value);
    return result;
}

// setCloseOnExec(fd: number): number. 0, or -errno. (An inherited fd isn't, and the apps a session starts mustn't
// inherit it.)
napi_value
fd_set_close_on_exec(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    int32_t fd;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
        napi_get_value_int32(env, argv[0], &fd) != napi_ok) {
        return int_value(env, -EINVAL);
    }
    int flags = fcntl(fd, F_GETFD);
    if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0) {
        return int_value(env, -errno);
    }
    return int_value(env, 0);
}

// closeFd(fd: number): number. 0, or -errno.
napi_value
fd_close(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    int32_t fd;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
        napi_get_value_int32(env, argv[0], &fd) != napi_ok) {
        return int_value(env, -EINVAL);
    }
    return int_value(env, close(fd) < 0 ? -errno : 0);
}
