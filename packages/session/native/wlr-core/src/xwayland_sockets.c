/*
 * Our replacement for wlroots' xwayland/sockets.c (0.17.4): the X11 display's listening sockets. The addon links
 * wlroots statically, and defining all of that file's functions here keeps the linker from pulling in wlroots' own
 * (an archive member is only linked for symbols nothing else defines). Keep the signatures in sync with
 * native/wlroots/xwayland/sockets.h when updating wlroots.
 *
 * Why: wlroots insists on creating /tmp/.X11-unix/X<n>, and fails when it can't. That fails on WSL, where WSLg mounts
 * /tmp/.X11-unix read-only, and on a multi-user server where /tmp/.X11-unix doesn't exist yet wlroots creates it
 * with mode 0755, owned by the first session's user, so no other user's session can create its socket there. Before
 * binding, it also unlinks the path, which removes a live X server's socket if that server has no lock file (WSLg's
 * :0 has none).
 *
 * Here: X11 clients on Linux connect to the abstract socket @/tmp/.X11-unix/X<n> first, so that's the one that
 * matters. The filesystem socket is created when /tmp/.X11-unix lets us, else in a private directory (Xwayland wants
 * two listening sockets; nobody connects to that one). A display is skipped if anything already serves it: a lock
 * file of a live process, a socket file someone listens on, or the abstract socket.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include <wlr/util/log.h>

#define MAX_DISPLAY 32

static const char lock_fmt[] = "/tmp/.X%d-lock";
static const char socket_fmt[] = "/tmp/.X11-unix/X%d";

/* the filesystem socket we created, unlinked when the display goes away */
static char socket_path[108];
/* our display, -1: none */
static int our_display = -1;
/* the process that made it (a forked child that exits mustn't remove them) */
static pid_t owner_pid;

/* hidden: they replace wlroots' own inside the addon, they're not the addon's to export */
#define INTERNAL __attribute__((visibility("hidden")))
INTERNAL bool set_cloexec(int fd, bool cloexec);
INTERNAL void unlink_display_sockets(int display);
INTERNAL int open_display_sockets(int socks[2]);

bool
set_cloexec(int fd, bool cloexec) {
    int flags = fcntl(fd, F_GETFD);
    if (flags == -1) {
        wlr_log_errno(WLR_ERROR, "fcntl failed");
        return false;
    }
    flags = cloexec ? flags | FD_CLOEXEC : flags & ~FD_CLOEXEC;
    if (fcntl(fd, F_SETFD, flags) == -1) {
        wlr_log_errno(WLR_ERROR, "fcntl failed");
        return false;
    }
    return true;
}

/* A listening socket at this address (abstract if path starts with '\0'), -1 with errno set if it can't be. */
static int
listen_at(const char *path, size_t path_length) {
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    if (path_length >= sizeof(addr.sun_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    memcpy(addr.sun_path, path, path_length);
    socklen_t size = (socklen_t) (offsetof(struct sockaddr_un, sun_path) + path_length);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return -1;
    }
    if (bind(fd, (struct sockaddr *) &addr, size) < 0 || listen(fd, 1) < 0) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }
    return fd;
}

/* Someone accepts connections on this socket file. */
static bool
socket_file_live(const char *path) {
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return true; // can't tell: leave it alone
    }
    bool live = connect(fd, (struct sockaddr *) &addr, sizeof(addr)) == 0 || errno != ECONNREFUSED;
    close(fd);
    return live;
}

/* The lock file of this display belongs to a running process (or can't be read). */
static bool
lock_live(const char *lock_name) {
    int fd = open(lock_name, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return errno != ENOENT;
    }
    char pid[12] = {0};
    ssize_t bytes = read(fd, pid, sizeof(pid) - 1);
    close(fd);
    char *end;
    long value = strtol(pid, &end, 10);
    if (bytes <= 0 || value <= 0 || value > INT32_MAX) {
        return true;
    }
    if (kill((pid_t) value, 0) != 0 && errno == ESRCH) {
        // stale: its server is gone
        return unlink(lock_name) != 0;
    }
    return true;
}

/* The second listening socket: in /tmp/.X11-unix if we may, else in a directory of our own. */
static int
open_file_socket(int display) {
    char path[sizeof(socket_path)];
    snprintf(path, sizeof(path), socket_fmt, display);
    struct stat st;
    if (lstat(path, &st) == 0) {
        if (socket_file_live(path)) {
            errno = EADDRINUSE;
            return -1;
        }
        unlink(path); // stale, if we may
    }
    int fd = listen_at(path, strlen(path));
    if (fd < 0 && errno != EADDRINUSE) {
        wlr_log(WLR_INFO, "Can't create %s (%s); X11 apps connect to the abstract socket", path, strerror(errno));
        const char *runtime_dir = getenv("XDG_RUNTIME_DIR");
        char dir[40];
        int length = runtime_dir ? snprintf(path, sizeof(path), "%s/greenfield-X%d", runtime_dir, display) : -1;
        if (length < 0 || length >= (int) sizeof(path)) {
            snprintf(dir, sizeof(dir), "/tmp/greenfield-x11-%u", (unsigned) getuid());
            if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
                return -1;
            }
            snprintf(path, sizeof(path), "%s/X%d", dir, display);
        }
        unlink(path);
        fd = listen_at(path, strlen(path));
    }
    if (fd >= 0) {
        snprintf(socket_path, sizeof(socket_path), "%s", path);
    }
    return fd;
}

void
unlink_display_sockets(int display) {
    if (socket_path[0]) {
        unlink(socket_path);
        socket_path[0] = '\0';
    }
    char lock_name[64];
    snprintf(lock_name, sizeof(lock_name), lock_fmt, display);
    unlink(lock_name);
    if (display == our_display) {
        our_display = -1;
    }
}

/* The session process exits without tearing down wlroots: don't leave the lock file and socket behind. */
static void
unlink_at_exit(void) {
    if (our_display >= 0 && getpid() == owner_pid) {
        unlink_display_sockets(our_display);
    }
}

int
open_display_sockets(int socks[2]) {
    for (int display = 0; display <= MAX_DISPLAY; display++) {
        char lock_name[64];
        snprintf(lock_name, sizeof(lock_name), lock_fmt, display);
        int lock_fd = open(lock_name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0444);
        if (lock_fd < 0) {
            if (errno == EEXIST && !lock_live(lock_name)) {
                display--; // the stale lock is gone: try this display again
            }
            continue;
        }

        // the abstract socket: what clients use; taken means the display is served by someone else
        char abstract[sizeof(socket_path)];
        abstract[0] = '\0';
        int length = snprintf(abstract + 1, sizeof(abstract) - 1, socket_fmt, display);
        socks[0] = listen_at(abstract, (size_t) length + 1);
        socks[1] = socks[0] < 0 ? -1 : open_file_socket(display);
        char pid[12];
        snprintf(pid, sizeof(pid), "%10d\n", getpid()); // what X servers write
        if (socks[1] < 0 || write(lock_fd, pid, sizeof(pid) - 1) != sizeof(pid) - 1) {
            if (socks[0] >= 0) {
                close(socks[0]);
            }
            if (socks[1] >= 0) {
                close(socks[1]);
                unlink(socket_path);
                socket_path[0] = '\0';
            }
            socks[0] = socks[1] = -1;
            close(lock_fd);
            unlink(lock_name);
            continue;
        }
        close(lock_fd);
        static bool registered = false;
        if (!registered) {
            registered = atexit(unlink_at_exit) == 0;
        }
        our_display = display;
        owner_pid = getpid();
        return display;
    }
    wlr_log(WLR_ERROR, "No X11 display available in the first %d", MAX_DISPLAY + 1);
    return -1;
}
