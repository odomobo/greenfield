import { Rect } from './gl/renderer'

export type Easing = (t: number) => number

/** A cubic Bézier timing function, like CSS cubic-bezier(x1, y1, x2, y2). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const sample = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (x: number) => {
    if (x <= 0) {
      return 0
    }
    if (x >= 1) {
      return 1
    }
    // solve x(t) = x by bisection, then evaluate y(t)
    let low = 0
    let high = 1
    let t = x
    for (let i = 0; i < 24; i++) {
      const value = sample(x1, x2, t)
      if (Math.abs(value - x) < 1e-5) {
        break
      }
      if (value < x) {
        low = t
      } else {
        high = t
      }
      t = (low + high) / 2
    }
    return sample(y1, y2, t)
  }
}

/** Starts slow and accelerates out (minimize, maximize). Subtle, like CSS ease-in. */
export const EASE_IN = cubicBezier(0.7, 0, 1, 1)
/** Starts fast and eases out (restore). Subtle, like CSS ease-out. */
export const EASE_OUT = cubicBezier(0, 0, 0.3, 1)

/** Eased progress (0..1) of something that started now and lasts `duration` ms. */
export class Animation {
  private readonly start = performance.now()

  constructor(
    private readonly duration: number,
    private readonly easing: Easing,
  ) {}

  progress(now = performance.now()): number {
    return this.easing(Math.min(1, (now - this.start) / this.duration))
  }

  done(now = performance.now()): boolean {
    return now - this.start >= this.duration
  }
}

export function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    width: from.width + (to.width - from.width) * t,
    height: from.height + (to.height - from.height) * t,
  }
}
