/**
 * Reconciles the viewer's optimistic window state with the server's, which is the source of truth (see the scene
 * protocol): every window change the viewer sends is numbered per window, the server echoes the last number it applied
 * in each scene window. A window's local state (where the viewer shows it while a move is on its way, the minimized
 * state it asked for) is kept while the server is behind the last number sent, or while the window is being dragged,
 * and dropped once the server caught up: from then on the server's state is shown as is, corrections included.
 *
 * Pure (no DOM), so it can be unit tested in Node.
 */
import type { SceneWindow } from './protocol'

export type Point = { x: number; y: number }

type WindowState = {
  /** last sequence number sent for this window */
  sent: number
  /** last sequence number the server applied */
  confirmed: number
  /** shown instead of the server's position */
  position?: Point
  /** shown instead of the server's minimized state */
  minimized?: boolean
}

export class WindowSync {
  private readonly states = new Map<string, WindowState>()

  private stateOf(id: string): WindowState {
    let state = this.states.get(id)
    if (state === undefined) {
      state = { sent: 0, confirmed: 0 }
      this.states.set(id, state)
    }
    return state
  }

  /**
   * The sequence number for a change to a window that's about to be sent. Continues from what the server applied, so a
   * new viewer (after a reconnect or a takeover) numbers after the previous one.
   */
  nextSeq(id: string): number {
    const state = this.stateOf(id)
    state.sent = Math.max(state.sent, state.confirmed) + 1
    return state.sent
  }

  /** Whether the server hasn't applied every change sent for this window yet. */
  pending(id: string): boolean {
    const state = this.states.get(id)
    return state !== undefined && state.sent > state.confirmed
  }

  /** Show the window here until the server caught up (and the window isn't held anymore). */
  setPosition(id: string, position: Point): void {
    this.stateOf(id).position = position
  }

  position(id: string): Point | undefined {
    return this.states.get(id)?.position
  }

  setMinimized(id: string, minimized: boolean): void {
    this.stateOf(id).minimized = minimized
  }

  minimized(id: string): boolean | undefined {
    return this.states.get(id)?.minimized
  }

  /**
   * A scene arrived: record what the server applied, and drop the local state of windows it caught up with, unless
   * `held` (being dragged: the pointer decides where it is until the drag ends). Windows that are gone are forgotten.
   */
  sceneReceived(windows: SceneWindow[], held: (id: string) => boolean): void {
    const present = new Set<string>()
    for (const window of windows) {
      present.add(window.id)
      const state = this.states.get(window.id)
      if (state === undefined) {
        if (window.seq > 0) {
          this.states.set(window.id, { sent: 0, confirmed: window.seq })
        }
        continue
      }
      state.confirmed = Math.max(state.confirmed, window.seq)
      if (state.sent <= state.confirmed) {
        if (!held(window.id)) {
          state.position = undefined
        }
        state.minimized = undefined
      }
    }
    for (const id of [...this.states.keys()]) {
      if (!present.has(id)) {
        this.states.delete(id)
      }
    }
  }


  clear(): void {
    this.states.clear()
  }
}
