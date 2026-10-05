import { useEffect, useRef, useState } from 'react'

/**
 * A list whose removed items stay a little longer, marked leaving, so they can animate out: `items` with the ones that
 * went in the last `ms` milliseconds back at the place they had. Keys identify items across renders.
 */
export function usePresence<T>(items: T[], key: (item: T) => string, ms: number): { item: T; leaving: boolean }[] {
  const [, rerender] = useState(0)
  const previous = useRef<T[]>([])
  // the leaving items, and the index each had in the list it left
  const leaving = useRef(new Map<string, { item: T; index: number; timer: ReturnType<typeof setTimeout> }>())

  const keys = new Set(items.map(key))
  previous.current.forEach((item, index) => {
    const k = key(item)
    if (!keys.has(k) && !leaving.current.has(k)) {
      const timer = setTimeout(() => {
        leaving.current.delete(k)
        rerender((n) => n + 1)
      }, ms)
      leaving.current.set(k, { item, index, timer })
    }
  })
  // an item that came back isn't leaving
  for (const [k, entry] of [...leaving.current]) {
    if (keys.has(k)) {
      clearTimeout(entry.timer)
      leaving.current.delete(k)
    }
  }
  previous.current = items

  useEffect(() => {
    const entries = leaving.current
    return () => entries.forEach((entry) => clearTimeout(entry.timer))
  }, [])

  const shown = items.map((item) => ({ item, leaving: false }))
  for (const { item, index } of [...leaving.current.values()].sort((a, b) => a.index - b.index)) {
    shown.splice(Math.min(index, shown.length), 0, { item, leaving: true })
  }
  return shown
}
