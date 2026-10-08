# Roadmap

The remaining work. For design documentation see [ARCHITECTURE.md](ARCHITECTURE.md).
For completed work see [HISTORY.md](HISTORY.md).
## Remaining work

### Next

1. **Replace `dbus-next` with an `sd_bus` C addon.** The `dbus-next` npm package (unmaintained since 2021) is the
   session's only runtime npm dependency with a significant transitive tree (17 packages, including `event-stream`).
   Replace it with a small C addon wrapping `sd_bus` (libsystemd), which is already on every target machine. The
   session uses D-Bus only for the notification server (`src/shell/notifications.ts`): connect to the session bus,
   request a name, export an interface, handle method calls, emit signals. A ~200 line addon in the existing
   CMake/Ninja build eliminates the entire tree. The notification server's TypeScript stays largely the same.

2. **System tray (StatusNotifierItem host).** Apps like Discord, Steam, chat clients and network applets put an icon
   in the system tray and keep running when their window closes. The session provides the
   `org.kde.StatusNotifierWatcher` (if none is on the bus) and registers as the host; it forwards the items to the
   viewer over the session WebSocket.
   - The viewer shows each item's icon in the taskbar's tray area (left of the mute toggle), with its tooltip;
     `Status: Passive` items are hidden, `NeedsAttention` uses its attention icon.
   - Clicks: left click `Activate`, middle click `SecondaryActivate`, wheel `Scroll`. Right click (or `ItemIsMenu`)
     shows the item's `com.canonical.dbusmenu` menu as one of our own animated context menus.
   - Legacy XEmbed tray icons (old X11 apps) are not supported.
   - e2e: a small test item registering an icon and a menu; check the icon shows, a click activates, a menu entry is
     delivered, and the icon goes when the item's bus name goes.

### Later

3. **Don't send what can't be seen.** Minimized, fully covered and partially covered windows, all with one algorithm
   computed on the server (it has every window's position, stacking order, minimized state and opaque region). Damage
   in hidden regions accumulates instead of being sent; when a region becomes visible again, the accumulated damage is
   sent. The tricky part: the viewer's layout runs ahead of the server's during drags, resizes and animations, so the
   server must widen its idea of what's visible during those interactions.

4. **Text input methods (IME)** for Chinese, Japanese, Korean and other composed input, and dead keys and compose:
   the browser's composition events mapped to `text-input-v3` (wlroots provides it).

5. Hardware video decoding in the browser.

6. Downloadable/user-written CSS themes.

7. WebTransport, only if the single WebSocket ever becomes a bottleneck.

8. **Browser-drawn window shadows** (nice-to-have). Only for windows whose `wl_surface.set_opaque_region` covers the
   whole surface (a plain opaque rectangle with no shadow margin of its own). Everything else keeps the app's own
   shadow and corners.

9. **Viewer improvements.** Details to come from the user when this item is reached.

### Last

10. **Install script, uninstall script and systemd unit.** Until then, real-PAM setup is manual (see
    `packages/session/README.md`). A `.deb` package possibly later.

11. **Two-factor sign-in via PAM prompts** (lowest priority). Only makes sense once the core is verified sound and
    free of vulnerabilities.

### Needs verification on other hardware

- Real PAM sign-in (needs root).
- GPU (dmabuf) buffers on a machine with a GPU.
- GPU acceleration: `--encoder auto` picking `vaapih264`/`nvh264`, streaming surfaces sent as hardware video.
- Lossy encoding and congestion control on real slow/distant/Wi-Fi links (only the simulated link is tested).
- Congestion control sharing a bottleneck with other traffic.
- A real GPU-rendered game as a streaming surface (only the synthetic busy client was tested).
- Firefox: whether a mouse back button over the desktop is fully blocked.

### Known issues

- Pinning two apps in quick succession once left only one pinned; not reproduced since.
- Input on a Wayland subsurface or popup the app just moved can land off by the move for about a round trip. Not seen
  with a real app. Fix if it shows: send coordinates relative to the window's main surface.
