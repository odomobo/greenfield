# Visual design

The look and feel of nebula's pages and desktop shell: what was decided and why. `ARCHITECTURE.md` covers the design
and the order of work; this file covers how things look and move. Values live in `packages/session/static/theme.css`
(colors, sizes, curves) and `packages/viewer/src/style.css` (layout, animations).

## Theme

- **Dark only.** No light theme, no `prefers-color-scheme` switch. The page declares `color-scheme: dark`, so the
  browser's own scrollbars and form controls match.
- **One background picture behind every page**: sign-in and desktop both sit on the Carina nebula
  (`packages/session/static/background.jpg`, a 3840 px wide copy of the original, ~1.2 MB), covering the viewport.
- **Two glass surfaces** for everything drawn on the picture:
  - **Passive**: `blur(24px)` and black at 60%. The taskbar, the Apps menu, the notification panel and toasts, context
    menus, the sign-in card and the title bars of inactive windows.
  - **Active**: the same blur, tinted nebula blue (`rgba(24, 56, 128, 0.65)`). Only the active window's title bar.
  - No extra saturation on the blur: it made the surfaces pop too much.
  - The active tint is 65% (not lower) so the title stays readable over a bright window behind it.
- **Controls on glass** (buttons, inputs, list rows, notification cards) are faint white overlays, not solid greys.
- **Accent**: a light blue (`#6cb4ff`) for primary buttons, focus underlines and the active taskbar indicator.
- **Logo**: the nebula "N" (from `~/nebula-icon`) is the favicon (16 and 32 px PNGs) and replaces the person icon on
  the sign-in card. PNGs, not the SVG: the SVG embeds the picture and weighs 1 MB.

## Sign-in card

- Username and password up front (password managers fill them); any further PAM prompt (a one-time code, the current
  and new password when it has expired) replaces the fields with one labelled field of its own and a Continue button.
- PAM's messages show above the field: errors in the error box, info texts as grey centered lines, several one per
  line. They belong to the prompt they came before, so answering it clears them.

## Apps follow the theme (defaults only)

nebula tells apps it's dark and gives them an accent color, the standard ways, **as defaults only**: whatever the
user set themselves always wins, and nothing is written over their settings (even where KDE itself would). Other
desktops of the same user never see any of it. All of it comes from `packages/session/src/nebula-settings.ts`.

- **GSettings** (GTK, Chrome): `color-scheme 'prefer-dark'` (GTK4, Chrome) and `gtk-theme 'Adwaita-dark'` (GTK3,
  whose theme ignores the color scheme), in the dconf defaults below the user's own database. A user whose
  `gtk-theme` is set (KDE's GTK sync sets it to Breeze) keeps their theme: GTK3 apps stay light for them.
- **KDE apps**: a `kdeglobals` with a dark color scheme and nebula's accent (`NEBULA_ACCENT`, a deeper nebula blue
  than the shell's own highlight), in a config directory below the user's `~/.config` for our sessions' apps only
  (not for services the shared D-Bus starts). The user's own `kdeglobals` keys win. Sessions set
  `QT_QPA_PLATFORMTHEME=kde` (unless the user chose one), since Qt loads KDE's integration by itself only on KDE.
- **Later**: the nebula Settings backend for `xdg-desktop-portal` (`org.freedesktop.appearance` color scheme and
  accent), for libadwaita, Flatpak and newer GTK/Qt apps. Needs an install-script step, so it waits for that.

## Window frames (title bars drawn by the viewer)

- **Height**: 48 px, the same as the taskbar (`FRAME_TITLE_HEIGHT` in the scene protocol, shared with the server, so
  changing it is a protocol change).
- **Rounded top corners** (8 px, `--radius-frame`); square when maximized. The border and shadow follow the corners.
- **Border**: opaque dark grey (`#2a2a2a`), the same look as the flyouts' edge. Not the flyouts' translucent white:
  a window's border has no dark glass under it, so translucent white lit up the picture behind it into a glowing
  outline.
- **Shadows**, like other Linux desktops: a shallow one under inactive windows, a taller one under the active window,
  the two fairly close together. None when maximized.
- **Layout**: the app icon (26 px) centered in a square at the left; the title (16 px) centered on the whole bar; the
  minimize, maximize and close buttons on the right as 48 × 48 squares with square hover highlights. Minimize is an
  underscore at the bottom of its glyph.
  - The sides of the bar share the leftover space equally (so the title is truly centered) but never shrink below the
    icon's square and the buttons: in a narrow window the title moves off center, then shrinks with an ellipsis,
    instead of covering the buttons or vanishing.

## Taskbar and Apps menu

- **Taskbar**: 48 px high, at the top. The Apps button is a 3 × 3 grid of dots.
- **Tray**: the apps' tray icons, the mute toggle, then the notification bell with the clock.
  - Icons are simple solid shapes: a solid speaker with bold sound waves (a bold ✕ when muted, still white; grey
    only when audio is unavailable), a solid bell, a solid user silhouette, a bold power symbol.
  - **No connection indicator.** It only showed connected/not connected, and a dropped connection shows the sign-in
    form (saying why) anyway. Showing link saturation was considered and rejected: by the time the server could
    report it, it's too late to be useful.
  - **Apps' tray icons** (system tray): 20 px, all shown inline in the order they came (no overflow flyout for now);
    they grow in and shrink away like taskbar buttons. Menus open under the icon; a second click closes them.
- **Context menus** may have a column of check marks / radio dots and one of icons (only when an entry has one), and
  submenus: a chevron, opened by pointing at the entry for 150 ms or clicking it, beside the menu (on its left if
  there's no room on the right).
- **Apps menu header**: a three-column grid. The user (avatar and name) on the left, the session name centered on the
  menu, the power button on the right, all on one center line.
  - The session name's field is exactly as wide as its text (a hidden copy of the text sizes it), so it stays
    centered while it's edited, and the hover outline and editing box hug the name. Capped at 300 px, then ellipsized.
- **Session names** default to "Nebula N" (the lowest free N).

## Motion

Everything that appears or disappears animates, snappily: about 100–160 ms. Things coming in start fast and ease out
(`--ease-out`, `cubic-bezier(0, 0, 0.3, 1)`); things going away accelerate out (`--ease-in`,
`cubic-bezier(0.7, 0, 1, 1)`). Going away is a little quicker than coming in. The sign-in page
is not animated (for now). `prefers-reduced-motion` turns the animations off.

| What | In | Out |
|---|---|---|
| Apps menu, notification panel | drops 8 px into place and fades in, 150 ms | fades and lifts out, 100 ms |
| Context menus (window menu, taskbar menus, session menu) | drops in from where it opens and fades in, 120 ms | fades out, 100 ms |
| The window menu's Move/Resize hint ("Click to start moving", by the pointer) | fades in, 120 ms | gone at once (the click starts it) |
| Toasts | slide in from the right, 160 ms | slide out to the right, 140 ms |
| A dismissed notification in the panel | | slides out to the right, 140 ms |
| Taskbar buttons | grow in from no width, 160 ms (neighbours slide over) | shrink away to no width, 160 ms |
| Windows | grow from 92% and fade in, 150 ms | shrink to 92% and fade out, 130 ms |
| Minimize / restore / maximize (earlier) | ~150 ms, ease-in for minimize and maximize, ease-out for the restores | |

How they're built, and the rules that keep them from breaking things:

- **State changes at once; only what's shown lags.** A closed popup is closed for the shell and the tests
  immediately (`hidden` flips, the popup leaves the stack); the animation is presentation only.
  - The Apps menu and notification panel transition `display` with `allow-discrete` and `@starting-style`.
  - Menus, toasts, notification cards and taskbar buttons that go away stay briefly as **leaving copies**
    (`usePresence` in `shell/presence.ts`): no input, and stripped of their ids and data attributes, so nothing
    mistakes them for the real thing.
- **Taskbar buttons grow in with a Web Animation** started when the button mounts (not a CSS animation: the
  button's classes change while it runs). Buttons that arrive within a second of connecting are the session as it
  was (pinned apps, open windows) and don't animate.
- **New windows wait until they're ready**: transparent and not clickable until the app's first picture has arrived
  and the window is placed (or 500 ms, whichever comes first), then they grow in. This avoids animating an empty
  frame. Windows that are already open when the session is attached or reattached don't animate.
- **Closed windows fade out as a copy**: the server has already dropped the window, so the viewer copies the window's
  element and its canvases' pixels into a ghost layer above the windows, animates that, and removes it.
- **A second click on a menu's button closes it** (the power button's session menu; the Apps button already did).
- **Maximize or restore down from a menu gives the keyboard back to the session**, as activating a window does.
