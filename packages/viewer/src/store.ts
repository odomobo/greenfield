import { useSyncExternalStore } from 'react'

/**
 * The bridge between the imperative core (connection, desktop, the shell's services) and the React views: a tiny
 * subscribe/notify store. The imperative side publishes immutable state snapshots into it, components subscribe with
 * `useStore` (a thin wrapper around React's useSyncExternalStore). High-frequency updates (frames, drags) never pass
 * through here - they go straight to the renderer/DOM (see desktop.ts).
 *
 * State is always replaced as a whole object, so `get` returns a stable reference between updates and selectors can
 * safely return parts of it.
 */
export type Store<T extends object> = {
  get(): T
  /** merge a partial state into the current one and notify the subscribers */
  update(patch: Partial<T>): void
  subscribe(listener: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    update(patch) {
      state = { ...state, ...patch }
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Subscribe a component to the whole state of a store. */
export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.get())
}

/**
 * Subscribe a component to a part of a store's state. The selector must return a value that is stable between
 * updates (a primitive or a reference held by the state), or the component renders in a loop.
 */
export function useStorePart<T extends object, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()))
}
