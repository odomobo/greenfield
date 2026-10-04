const DOM_DELTA_PIXEL = 0

/** A mouse wheel click in Chromium's pixel deltas. */
const CLICK_PIXELS = 100
const V120_CLICK = 120

/**
 * The v120 value (120 per click, signed like the delta) of a pixel-mode wheel event if it's a mouse wheel click, else
 * 0: a touchpad scrolls by arbitrary pixel amounts, and a click is a whole multiple of 100 px (Chromium). (A touchpad
 * delta that happens to be exactly 100 is scrolled as a click, which does no harm.) Line-mode events (Firefox) are
 * clicks already: the server knows.
 */
export function wheelClick(deltaMode: number, delta: number): number {
  if (deltaMode !== DOM_DELTA_PIXEL || delta === 0 || Math.abs(delta) % CLICK_PIXELS !== 0) {
    return 0
  }
  return (delta / CLICK_PIXELS) * V120_CLICK
}
