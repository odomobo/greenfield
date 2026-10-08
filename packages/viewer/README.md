# Viewer

Browser viewer and window manager for server-side sessions. The session (compositor + apps) runs on the server
in a per-user session process behind the gateway; the viewer shows each window as an element of its own (a canvas per surface, moved and stretched by CSS transforms, composited and
hit tested by the browser), does interactive move/resize and window placement, and
can disconnect and reattach at any time without the apps noticing.

## Running

The viewer is the gateway's one page (`packages/session`, served at `/`): the sign-in form and the desktop (signing
in attaches to the user's one desktop, starting it if needed), so it never navigates away. It opens one WebSocket,
`/ws` (same origin), signs in on it (the server's prompts answered in-band, see "Sign-in" in
`libs/scene-protocol`) and then uses it for the desktop ([src/connection.ts](src/connection.ts)). There is no token:
when the WebSocket closes (a lost connection, another sign-in taking the desktop over, Log out) the page shows the
sign-in form again, saying why. Build it with `yarn build`; see the gateway README for running everything.

Query parameters:

- `test=1` expose test hooks (`window.__viewerTest`), used by the scripts in `scripts/e2e` (readLuma, surfacePixels, injectFrame, ...)

## Desktop shell

[src/shell](src/shell), drawn in HTML on top of the session's output (which excludes it):

- Taskbar at the top: the Apps button, pinned apps and running windows grouped by app (a short line under running
  apps, a longer accent line under the active one), then the connection indicator and the clock with the
  notification bell. Clicking an app with one window activates it, or minimizes it if it's active; with several
  windows it opens their previews. Hovering a running app shows previews (the windows' last images, also when
  minimized) with minimize, maximize and close buttons. Right-click for New window, Pin/Unpin and window actions.
- Apps menu: you with the session menu (Disconnect closes the connection and goes back to the sign-in form, the
  desktop keeps running; Log out ends the desktop), search, pinned apps and all apps (the pin button on a row pins or
  unpins).
- Notifications: toasts top right, and a history behind the bell. Kept by the session, so they're still there after
  reconnecting.
- Minimize, maximize and restore are animated (300 ms, scaling the window's current image, nothing is resized for
  it): minimize eases in toward the taskbar button, restore eases out from it; maximize eases in, restore down eases
  out. Maximize and restore down ask the app right away and animate while it redraws.

No keyboard shortcuts: everything is reachable with the pointer. Colors and sizes are theme custom properties
(`/static/theme.css`).

Since leaving the page signs out, accidental back navigation is guarded three ways: over the desktop, the mouse's
back/forward buttons and Alt+Left/Right go to the remote app (as BTN_SIDE/BTN_EXTRA and normal keys); after signing
in, a guard history entry absorbs a back navigation (re-armed on the next click or key press); and while signed in,
the browser asks before leaving the page.

Opening a second viewer on the same session takes it over; the first one shows a "taken over" message.

## Protocol

One WebSocket per session, see [src/protocol.ts](src/protocol.ts) for the envelope and all message types.
