/*
 * A small X11 app that moves its own window (XMoveWindow), for scripts/e2e/x11-move.sh:
 *
 *   x11-move-client drag            a borderless 200x200 square (_MOTIF_WM_HINTS: no decorations) that follows the
 *                                   pointer while button 1 is held, moving itself on every motion
 *   x11-move-client wander <flag>   a decorated, resizable 300x200 window that moves itself 40 px right and back every
 *                                   40 ms while the file <flag> exists
 *
 * Prints "moved" (line buffered) for each move it asks for.
 */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    int drag = argc >= 2 && strcmp(argv[1], "drag") == 0;
    const char *flag = argc >= 3 ? argv[2] : NULL;
    if (!drag && flag == NULL) {
        fprintf(stderr, "usage: %s drag | wander <flag file>\n", argv[0]);
        return 2;
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    Display *dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "cannot open display\n");
        return 1;
    }
    int screen = DefaultScreen(dpy);
    XSetWindowAttributes attrs = {
        .background_pixel = drag ? 0x2050d0 : 0x20a050,
        .event_mask = ButtonPressMask | Button1MotionMask | StructureNotifyMask,
    };
    int width = drag ? 200 : 300, height = 200;
    Window win = XCreateWindow(dpy, RootWindow(dpy, screen), 0, 0, width, height, 0, CopyFromParent, InputOutput,
                               CopyFromParent, CWBackPixel | CWEventMask, &attrs);
    XStoreName(dpy, win, drag ? "Self Drag" : "Self Wander");
    if (drag) {
        XSizeHints size = {.flags = PMinSize | PMaxSize, .min_width = 200, .min_height = 200, .max_width = 200,
                           .max_height = 200};
        XSetWMNormalHints(dpy, win, &size);
        struct { unsigned long flags, functions, decorations; long input_mode; unsigned long status; } mwm = {
            .flags = 2 /* MWM_HINTS_DECORATIONS */, .decorations = 0};
        Atom mwm_atom = XInternAtom(dpy, "_MOTIF_WM_HINTS", False);
        XChangeProperty(dpy, win, mwm_atom, mwm_atom, 32, PropModeReplace, (unsigned char *)&mwm, 5);
    }
    Atom wm_delete = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(dpy, win, &wm_delete, 1);
    XMapWindow(dpy, win);
    XFlush(dpy);

    int grab_x = 0, grab_y = 0;
    /* where the window is (the last ConfigureNotify), where a wander started, and which way it goes next */
    int x = 0, y = 0, base_x = 0, base_y = 0, wandering = 0, right = 1;
    long long last_move = 0;
    for (;;) {
        while (XPending(dpy)) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            switch (ev.type) {
            case ButtonPress:
                if (ev.xbutton.button == Button1) {
                    grab_x = ev.xbutton.x;
                    grab_y = ev.xbutton.y;
                }
                break;
            case MotionNotify:
                if (drag) {
                    while (XCheckTypedWindowEvent(dpy, win, MotionNotify, &ev))
                        ;
                    XMoveWindow(dpy, win, ev.xmotion.x_root - grab_x, ev.xmotion.y_root - grab_y);
                    printf("moved\n");
                }
                break;
            case ConfigureNotify:
                x = ev.xconfigure.x;
                y = ev.xconfigure.y;
                break;
            case ClientMessage:
                if ((Atom)ev.xclient.data.l[0] == wm_delete) {
                    XCloseDisplay(dpy);
                    return 0;
                }
                break;
            }
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long long now_ms = now.tv_sec * 1000LL + now.tv_nsec / 1000000;
        if (!drag && now_ms - last_move >= 40) {
            last_move = now_ms;
            if (access(flag, F_OK) == 0) {
                if (!wandering) {
                    wandering = 1;
                    base_x = x;
                    base_y = y;
                }
                XMoveWindow(dpy, win, base_x + (right ? 40 : 0), base_y);
                right = !right;
                printf("moved\n");
            } else {
                wandering = 0;
            }
        }
        XFlush(dpy);
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(ConnectionNumber(dpy), &fds);
        struct timeval timeout = {.tv_sec = 0, .tv_usec = 40000};
        select(ConnectionNumber(dpy) + 1, &fds, NULL, NULL, drag ? NULL : &timeout);
    }
}
