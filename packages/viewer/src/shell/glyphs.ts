/**
 * The shell's own icons: simple outline glyphs on a 24px grid, drawn for this project (no third-party icon set).
 * They use currentColor, so themes color them through `color`.
 */
function glyph(paths: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
}

/**
 * A solid glyph (the taskbar's and the Apps menu header's icons): `fills` are filled shapes, `strokes` bold lines.
 */
function solid(fills: string, strokes: string, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor">${fills}</g><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${strokes}</g></svg>`
}

const SPEAKER =
  '<path d="M2.5 9.6c0-.6.5-1.1 1.1-1.1h3.3l4.6-3.9c.6-.5 1.5-.1 1.5.7v13.4c0 .8-.9 1.2-1.5.7l-4.6-3.9H3.6c-.6 0-1.1-.5-1.1-1.1z"/>'

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
  /** (solid) */
  power: (size = 20) => solid('', '<path d="M12 3v8.5"/><path d="M7 6.2a8 8 0 1 0 10 0"/>', size),
  /** (solid) */
  bell: (size = 20) =>
    solid(
      '<path d="M12 2.6a6 6 0 0 0-6 6v4.5l-1.5 2.6c-.4.7.1 1.6.9 1.6h13.2c.8 0 1.3-.9.9-1.6L18 13.1V8.6a6 6 0 0 0-6-6z"/><path d="M9.4 18.6h5.2a2.6 2.6 0 0 1-5.2 0z"/>',
      '',
      size,
    ),
  pin: () => glyph('<path d="M14.5 3.5 20.5 9.5 17 11l-3.5 3.5.5 4-1.5 1.5-4-4L4 20.5M8.5 16 4.5 12 6 10.5l4 .5L13.5 7.5z"/>'),
  /** a pinned app's pin (filled) */
  pinned: () =>
    glyph(
      '<path fill="currentColor" d="M14.5 3.5 20.5 9.5 17 11l-3.5 3.5.5 4-1.5 1.5-8-8L6 10.5l4 .5L13.5 7.5z"/><path d="M8.5 16 4 20.5"/>',
    ),
  /** three dots in a row: more (the taskbar's overflow) */
  more: (size = 18) =>
    glyph(
      [5, 12, 19].map((x) => `<circle cx="${x}" cy="12" r="2.1" fill="currentColor" stroke="none"/>`).join(''),
      size,
    ),
  check: (size = 16) => glyph('<path d="m5 12.5 4.5 4.5L19 7.5"/>', size),
  chevronRight: (size = 14) => glyph('<path d="m9.5 6 6 6-6 6"/>', size),
  close: (size = 14) => glyph('<path d="m6 6 12 12M18 6 6 18"/>', size),
  minimize: (size = 14) => glyph('<path d="M5 12h14"/>', size),
  maximize: (size = 14) => glyph('<rect x="5" y="5" width="14" height="14" rx="2"/>', size),
  restore: (size = 14) => glyph('<rect x="4.5" y="8.5" width="11" height="11" rx="2"/><path d="M8.5 5.5h8a2 2 0 0 1 2 2v8"/>', size),
  /** speaker with sound waves (solid) */
  speaker: (size = 22) => solid(SPEAKER, '<path d="M16 9a4.2 4.2 0 0 1 0 6M18.8 6.3a8 8 0 0 1 0 11.4"/>', size),
  /** speaker, muted: crossed out (solid) */
  speakerMuted: (size = 22) => solid(SPEAKER, '<path d="m16 9 6 6m0-6-6 6"/>', size),
  /** (solid) */
  user: (size = 16) =>
    solid(
      '<circle cx="12" cy="7.8" r="4.3"/><path d="M3.8 20c.6-4 3.9-6.5 8.2-6.5s7.6 2.5 8.2 6.5c.1.6-.3 1-.9 1H4.7c-.6 0-1-.4-.9-1z"/>',
      '',
      size,
    ),
  /** the fallback for apps without an icon */
  app: (size = 24) =>
    glyph('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 8.5h17"/><path d="M6.5 6.5h.01M9 6.5h.01"/>', size),
}
