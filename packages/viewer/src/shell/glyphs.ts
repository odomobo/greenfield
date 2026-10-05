/**
 * The shell's own icons: simple outline glyphs on a 24px grid, drawn for this project (no third-party icon set).
 * They use currentColor, so themes color them through `color`.
 */
function glyph(paths: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
}

export const glyphs = {
  apps: (size = 18) =>
    glyph(
      // a 3 x 3 grid of dots
      [5, 12, 19]
        .flatMap((y) => [5, 12, 19].map((x) => `<circle cx="${x}" cy="${y}" r="2.1" fill="currentColor" stroke="none"/>`))
        .join(''),
      size,
    ),
  search: () => glyph('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>'),
  power: () => glyph('<path d="M12 3.5v8"/><path d="M7.2 6.4a7.5 7.5 0 1 0 9.6 0"/>'),
  bell: () =>
    glyph('<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>'),
  pin: () => glyph('<path d="M14.5 3.5 20.5 9.5 17 11l-3.5 3.5.5 4-1.5 1.5-4-4L4 20.5M8.5 16 4.5 12 6 10.5l4 .5L13.5 7.5z"/>'),
  /** a pinned app's pin (filled) */
  pinned: () =>
    glyph(
      '<path fill="currentColor" d="M14.5 3.5 20.5 9.5 17 11l-3.5 3.5.5 4-1.5 1.5-8-8L6 10.5l4 .5L13.5 7.5z"/><path d="M8.5 16 4 20.5"/>',
    ),
  close: (size = 14) => glyph('<path d="m6 6 12 12M18 6 6 18"/>', size),
  minimize: (size = 14) => glyph('<path d="M5 12h14"/>', size),
  maximize: (size = 14) => glyph('<rect x="5" y="5" width="14" height="14" rx="2"/>', size),
  restore: (size = 14) => glyph('<rect x="4.5" y="8.5" width="11" height="11" rx="2"/><path d="M8.5 5.5h8a2 2 0 0 1 2 2v8"/>', size),
  signal: () => glyph('<path d="M4 18.5h1M9 18.5v-4M14 18.5v-8M19 18.5v-12"/>'),
  signalOff: () => glyph('<path d="M4 18.5h1M9 18.5v-4M14 18.5v-2M19 18.5v-2"/><path d="m14 5 5 5m0-5-5 5"/>'),
  /** speaker with sound waves */
  speaker: () => glyph('<path d="M4.5 9.5h3.5l4.5-3.5v12l-4.5-3.5H4.5z"/><path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10"/>'),
  /** speaker, muted: crossed out */
  speakerMuted: () => glyph('<path d="M4.5 9.5h3.5l4.5-3.5v12l-4.5-3.5H4.5z"/><path d="m16 9.5 5 5m0-5-5 5"/>'),
  user: (size = 16) =>
    glyph('<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5"/>', size),
  /** the fallback for apps without an icon */
  app: (size = 24) =>
    glyph('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 8.5h17"/><path d="M6.5 6.5h.01M9 6.5h.01"/>', size),
}
