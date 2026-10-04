import type { Modifiers } from './protocol'

/** What the browser's events tell about modifiers (KeyboardEvent and MouseEvent both have it). */
type ModifierSource = { getModifierState(key: string): boolean }

/**
 * The browser's modifier state at an input event, sent with every key, pointer, button and axis message: the server
 * makes its keyboard state agree with it (see the scene protocol's Modifiers). Windows reports AltGr as Ctrl+Alt
 * plus AltGraph, so while AltGraph is held, Ctrl and Alt are not reported.
 */
export function modifiersOf(event: ModifierSource): Modifiers {
  const altGr = event.getModifierState('AltGraph')
  return {
    ctrl: !altGr && event.getModifierState('Control'),
    shift: event.getModifierState('Shift'),
    alt: !altGr && event.getModifierState('Alt'),
    meta: event.getModifierState('Meta'),
    altGr,
    capsLock: event.getModifierState('CapsLock'),
    numLock: event.getModifierState('NumLock'),
  }
}
