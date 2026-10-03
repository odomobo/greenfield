/**
 * Rectangle region helpers for damage tracking. A region is a list of rectangles; the functions that return regions
 * return disjoint rectangles. Pure, no Node or native dependencies.
 */

export type Rect = { x: number; y: number; width: number; height: number }

export function isEmpty(rect: Rect): boolean {
  return rect.width <= 0 || rect.height <= 0
}

export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.width, b.x + b.width)
  const y1 = Math.min(a.y + a.height, b.y + b.height)
  if (x1 <= x0 || y1 <= y0) {
    return undefined
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** The parts of `rect` not covered by `cut`, as up to four disjoint rectangles. */
export function subtractRect(rect: Rect, cut: Rect): Rect[] {
  const overlap = intersect(rect, cut)
  if (overlap === undefined) {
    return [rect]
  }
  const result: Rect[] = []
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  const overlapRight = overlap.x + overlap.width
  const overlapBottom = overlap.y + overlap.height
  // full width bands above and below the overlap, then the parts left and right of it
  if (overlap.y > rect.y) {
    result.push({ x: rect.x, y: rect.y, width: rect.width, height: overlap.y - rect.y })
  }
  if (overlapBottom < bottom) {
    result.push({ x: rect.x, y: overlapBottom, width: rect.width, height: bottom - overlapBottom })
  }
  if (overlap.x > rect.x) {
    result.push({ x: rect.x, y: overlap.y, width: overlap.x - rect.x, height: overlap.height })
  }
  if (overlapRight < right) {
    result.push({ x: overlapRight, y: overlap.y, width: right - overlapRight, height: overlap.height })
  }
  return result
}

/** The parts of `region` not covered by any of `cuts`. */
export function subtract(region: Rect[], cuts: Rect[]): Rect[] {
  let result = region.filter((rect) => !isEmpty(rect))
  for (const cut of cuts) {
    if (isEmpty(cut)) {
      continue
    }
    result = result.flatMap((rect) => subtractRect(rect, cut))
  }
  return result
}

/** Turn possibly overlapping rectangles into disjoint ones covering the same area. */
export function disjoint(region: Rect[]): Rect[] {
  const result: Rect[] = []
  for (const rect of region) {
    if (!isEmpty(rect)) {
      result.push(...subtract([rect], result))
    }
  }
  return result
}

/** Area of the union of possibly overlapping rectangles. */
export function area(region: Rect[]): number {
  return disjoint(region).reduce((sum, rect) => sum + rect.width * rect.height, 0)
}

export function boundingBox(region: Rect[]): Rect | undefined {
  const rects = region.filter((rect) => !isEmpty(rect))
  if (rects.length === 0) {
    return undefined
  }
  const x0 = Math.min(...rects.map((rect) => rect.x))
  const y0 = Math.min(...rects.map((rect) => rect.y))
  const x1 = Math.max(...rects.map((rect) => rect.x + rect.width))
  const y1 = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Clip rectangles to `bounds`, dropping what falls outside. */
export function clip(region: Rect[], bounds: Rect): Rect[] {
  const result: Rect[] = []
  for (const rect of region) {
    const clipped = intersect(rect, bounds)
    if (clipped) {
      result.push(clipped)
    }
  }
  return result
}

/**
 * Split a rectangle into pieces of at most `maxPixels` each: full width bands (rows compress well in PNG), and for
 * absurdly wide rectangles also columns.
 */
export function splitRect(rect: Rect, maxPixels: number): Rect[] {
  if (isEmpty(rect)) {
    return []
  }
  if (rect.width * rect.height <= maxPixels) {
    return [rect]
  }
  const columns: Rect[] = []
  for (let x = rect.x; x < rect.x + rect.width; x += maxPixels) {
    columns.push({ x, y: rect.y, width: Math.min(maxPixels, rect.x + rect.width - x), height: rect.height })
  }
  const result: Rect[] = []
  for (const column of columns) {
    const bandHeight = Math.max(1, Math.floor(maxPixels / column.width))
    for (let y = column.y; y < column.y + column.height; y += bandHeight) {
      result.push({ x: column.x, y, width: column.width, height: Math.min(bandHeight, column.y + column.height - y) })
    }
  }
  return result
}
