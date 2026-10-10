# Roadmap

The remaining work. For design documentation see [ARCHITECTURE.md](ARCHITECTURE.md).
For completed work see [HISTORY.md](HISTORY.md).
## Remaining work

### Next

Nothing queued; the user picks the next item from Later.

### Later

2. **Don't send what can't be seen.** Minimized, fully covered and partially covered windows, all with one algorithm
   computed on the server (it has every window's position, stacking order, minimized state and opaque region). Damage
   in hidden regions accumulates instead of being sent; when a region becomes visible again, the accumulated damage is
   sent. The tricky part: the viewer's layout runs ahead of the server's during drags, resizes and animations, so the
   server must widen its idea of what's visible during those interactions.

3. **Text input methods (IME)** for Chinese, Japanese, Korean and other composed input, and dead keys and compose:
   the browser's composition events mapped to `text-input-v3` (wlroots provides it).

4. Hardware video decoding in the browser.

5. Downloadable/user-written CSS themes.

6. WebTransport, only if the single WebSocket ever becomes a bottleneck.

7. **Browser-drawn window shadows** (nice-to-have). Only for windows whose `wl_surface.set_opaque_region` covers the
   whole surface (a plain opaque rectangle with no shadow margin of its own). Everything else keeps the app's own
   shadow and corners.

8. **Viewer improvements.** Details to come from the user when this item is reached.

### Last

9. **Install script, uninstall script and systemd unit.** Until then, real-PAM setup is manual (see
    `packages/session/README.md`). A `.deb` package possibly later.

10. **Two-factor sign-in via PAM prompts** (lowest priority). Only makes sense once the core is verified sound and
    free of vulnerabilities.

### Needs verification on other hardware

- Real PAM sign-in (needs root).
- GPU (dmabuf) buffers on a machine with a GPU.
- The video codec's own GPU context (`gpu_context_for_device` in `packages/video-codec/native/src/gst_frame_encoder.c`,
  opened on a frame's `device`) and its import of dmabuf frames, on a GPU machine. Also, once capture receives dmabufs,
  that it sets the frame's `device` (0 today).
- GPU acceleration: `--encoder auto` picking `vaapih264`/`nvh264`, streaming surfaces sent as hardware video.
- Lossy encoding and congestion control on real slow/distant/Wi-Fi links (only the simulated link is tested).
- Congestion control sharing a bottleneck with other traffic.
- A real GPU-rendered game as a streaming surface (only the synthetic busy client was tested).
- Firefox: whether a mouse back button over the desktop is fully blocked.

### Known issues

- Pinning two apps in quick succession once left only one pinned; not reproduced since.
- Input on a Wayland subsurface or popup the app just moved can land off by the move for about a round trip. Not seen
  with a real app. Fix if it shows: send coordinates relative to the window's main surface.
- Snap apps (Firefox on Ubuntu, any snap on the GNOME runtime) play into the user's audio, not the session's: the
  snap's `desktop-launch` (gnome-46-2404, lines 390-397) overwrites `PULSE_SERVER` with
  `$XDG_RUNTIME_DIR/../pulse/native`, i.e. `/run/user/<uid>/pulse/native`, whenever that socket exists (on WSL, WSLg's
  server: the sound comes out of Windows). Practical fix: launch `/snap/bin/*` programs through
  `snap run --shell <app> -c 'export PULSE_SERVER=<ours>; exec <app command from meta/snap.yaml> "$@"'`. With AppArmor
  enforcing (not on WSL) that alone gives no sound rather than the user's: the snap's audio-playback policy only allows
  the standard socket paths, so the session's socket would also have to be somewhere a snap can reach (a socket in
  `~`, or TCP on localhost with authentication; both unverified). Cleaner but out of our hands: snapcraft's desktop
  extension keeping a `PULSE_SERVER` that is already set.
- Audio isolation only holds for processes the session starts. Not covered (unverified, by how they work): an app
  that hands off to an instance already running elsewhere (Firefox, Chrome, VS Code); D-Bus-activated apps and
  services, which get the user's bus environment (`DBusActivatable=true` apps, gnome-terminal's server,
  speech-dispatcher); systemd user services; a tmux/screen server started outside the session. A thorough fix needs a
  session bus and systemd instance of the session's own, or one desktop per user. Also to check: clients with a
  libpipewire older than 1.0.5 may ignore `PIPEWIRE_RUNTIME_DIR` and reach the user's PipeWire (`PIPEWIRE_REMOTE` with
  an absolute path may be more robust); Flatpak is expected to honour `PULSE_SERVER` but wasn't tested.
