import type { CVPoint, CVRegion } from './types'

// Room seed must be at least this far from any wall/exterior (fraction of short image side).
// Filters noise/thin strips. 0.02 ≈ 23px at 1166px → 0.13m minimum room half-width.
const MIN_SEED_DIST_FRACTION = 0.02

// Non-maximum suppression radius for seed finding (fraction of short image side).
// Seeds closer than this are merged. 0.05 ≈ 58px at 1166px → 0.32m. Ensures one seed
// per room even in large flat rooms, while keeping adjacent small rooms (≥0.64m) distinct.
const SUPPRESSION_RADIUS_FRACTION = 0.05

// Region must cover at least this fraction of total image area to be kept.
// Filters margin noise, text labels, and furniture symbols.
const MIN_AREA_FRACTION = 0.005

// Maximum number of room regions to return.
const MAX_REGIONS = 30

interface RegionStats {
  label: number
  area: number
  x0: number; x1: number; y0: number; y1: number
  sumX: number; sumY: number
}

interface Seed { idx: number; dist: number }

/**
 * Detect room regions in a floor plan binary mask using distance-transform watershed.
 *
 * Previous approach used a border-flood to find exterior background, then excluded
 * those pixels from the DT. That failed because bilinear downsampling blurs wall edges
 * into 1-pixel gaps — the flood leaked through those gaps into the apartment interior,
 * marking most pixels as exterior, leaving only tiny isolated pockets as seeds.
 *
 * This approach avoids pre-classifying exterior pixels entirely:
 *   1. Compute the distance transform from walls only: dt[px] = city-block distance to
 *      nearest wall pixel, capped by distance to the image border.
 *      The border-distance cap keeps exterior open space (which is inherently close to
 *      the image edge) from producing high-DT seeds that would suppress interior ones
 *      during non-maximum suppression.
 *   2. Find local DT maxima (room centres — points farthest from all walls)
 *   3. Apply non-maximum suppression so each room yields exactly one seed
 *   4. Seeded BFS watershed: each seed grows outward until hitting walls or other seeds
 *   5. Post-filter: discard any region whose pixels touch the image border (exterior)
 *
 * Works for open-plan layouts and wide archways: seeds grow from each room centre and
 * meet at the narrowest point of a shared opening, approximating the door/archway boundary.
 * Robust to wall gaps from downsampling because no BFS needs to thread through walls.
 */
export function detectRegions(mask: Uint8Array, width: number, height: number): CVRegion[] {
  const shortSide = Math.min(width, height)

  // Step 1: Distance transform (wall-only barriers, capped by border distance)
  const dt = computeDistanceTransform(mask, width, height)

  // Step 2: Seeds
  const minDist    = Math.round(shortSide * MIN_SEED_DIST_FRACTION)
  const suppRadius = Math.round(shortSide * SUPPRESSION_RADIUS_FRACTION)
  const seeds = findLocalMaxima(dt, width, height, suppRadius, minDist)
  console.log(`[walkaround/cv] DT watershed: ${seeds.length} seeds (minDist=${minDist}px, suppR=${suppRadius}px)`)

  if (seeds.length === 0) return []

  // Step 3: Watershed
  const labels = seededWatershed(mask, seeds, width, height)

  // Step 4: Extract regions + polygons, discarding border-touching (exterior) regions
  return extractWatershedRegions(labels, seeds.length, width, height)
}

// ---------------------------------------------------------------------------
// Distance transform
// ---------------------------------------------------------------------------

/**
 * 2-pass sequential city-block distance transform from walls only.
 * dt[i] = min(distance to nearest wall pixel, distance to image border).
 *
 * Capping by border distance prevents exterior open space from accumulating
 * high dt values: exterior pixels are inherently close to the image edge, so
 * their dt stays low. Interior room centres (bounded by walls on all sides)
 * are unaffected because their wall-distance is smaller than their border-distance.
 * This ensures NMS picks seeds inside rooms, not in exterior open space.
 */
function computeDistanceTransform(
  mask:   Uint8Array,
  width:  number,
  height: number,
): Float32Array {
  const dt = new Float32Array(mask.length).fill(1e6)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) dt[i] = 0
  }

  // Forward pass: top-left → bottom-right
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (dt[i] === 0) continue
      if (y > 0) dt[i] = Math.min(dt[i], dt[i - width] + 1)
      if (x > 0) dt[i] = Math.min(dt[i], dt[i - 1]     + 1)
    }
  }

  // Backward pass: bottom-right → top-left
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (dt[i] === 0) continue
      if (y < height - 1) dt[i] = Math.min(dt[i], dt[i + width] + 1)
      if (x < width - 1)  dt[i] = Math.min(dt[i], dt[i + 1]     + 1)
    }
  }

  // Cap by distance to image border so exterior open space stays low
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (dt[i] === 0) continue
      const borderDist = Math.min(x, width - 1 - x, y, height - 1 - y)
      if (borderDist < dt[i]) dt[i] = borderDist
    }
  }

  return dt
}

// ---------------------------------------------------------------------------
// Local maxima / room seeds
// ---------------------------------------------------------------------------

/**
 * Find local maxima of the distance transform and apply non-maximum suppression.
 * Each surviving maximum is placed at the most central point of one room —
 * the point maximally far from all surrounding walls.
 */
function findLocalMaxima(
  dt:          Float32Array,
  width:       number,
  height:      number,
  suppRadius:  number,
  minDist:     number,
): Seed[] {
  const candidates: Seed[] = []

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const d = dt[i]
      if (d < minDist) continue

      // Local maximum in 3×3 neighbourhood
      let isMax = true
      outer: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          if (dt[(y + dy) * width + (x + dx)] > d) { isMax = false; break outer }
        }
      }
      if (isMax) candidates.push({ idx: i, dist: d })
    }
  }

  // Strongest (most central) seed first
  candidates.sort((a, b) => b.dist - a.dist)

  // Greedy NMS with adaptive suppression radius.
  //
  // Each accepted seed suppresses all candidates within max(suppRadius, seed.dist).
  // Using seed.dist (the DT value = distance to nearest wall ≈ room half-width) as
  // the radius has a geometric guarantee: for two seeds in the *same* room, the more
  // central seed (higher DT) will suppress the peripheral one, because the peripheral
  // seed's distance to center < room half-width ≤ the suppression radius. For seeds
  // in *adjacent* rooms separated by a wall, their distance > dA + dB > dA, so they
  // are never suppressed. This works correctly regardless of room size.
  const suppressed = new Uint8Array(dt.length)
  const selected: Seed[] = []

  for (const c of candidates) {
    if (suppressed[c.idx]) continue
    selected.push(c)
    if (selected.length >= MAX_REGIONS) break

    const cy = (c.idx - c.idx % width) / width
    const cx = c.idx % width
    const r = Math.max(suppRadius, Math.round(c.dist))
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const ny = cy + dy, nx = cx + dx
        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
          suppressed[ny * width + nx] = 1
        }
      }
    }
  }
  return selected
}

// ---------------------------------------------------------------------------
// Seeded BFS watershed
// ---------------------------------------------------------------------------

/**
 * Grow each seed outward via 4-connectivity BFS.
 * Each pixel is claimed by whichever seed reaches it first.
 * Wall pixels (mask=0) are never claimed (-1). Exterior pixels are claimed by
 * whichever seed reaches them and later post-filtered by border-touch detection.
 *
 * For rooms separated by actual walls, BFS fronts stop at the wall → correct boundary.
 * For open archways, fronts meet at the narrowest point → approximate boundary.
 */
function seededWatershed(
  mask:  Uint8Array,
  seeds: Seed[],
  width: number,
  height: number,
): Int32Array {
  const labels = new Int32Array(mask.length)  // 0 = unclaimed, -1 = wall, N = seed label
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) labels[i] = -1
  }

  const queue = new Int32Array(mask.length)
  let head = 0, tail = 0

  for (let s = 0; s < seeds.length; s++) {
    const idx = seeds[s].idx
    if (labels[idx] === 0) { labels[idx] = s + 1; queue[tail++] = idx }
  }

  while (head < tail) {
    const idx   = queue[head++]
    const label = labels[idx]
    const px    = idx % width
    const py    = (idx - px) / width

    if (px > 0          && labels[idx - 1]     === 0) { labels[idx - 1]     = label; queue[tail++] = idx - 1     }
    if (px < width - 1  && labels[idx + 1]     === 0) { labels[idx + 1]     = label; queue[tail++] = idx + 1     }
    if (py > 0          && labels[idx - width]  === 0) { labels[idx - width] = label; queue[tail++] = idx - width }
    if (py < height - 1 && labels[idx + width]  === 0) { labels[idx + width] = label; queue[tail++] = idx + width }
  }
  return labels
}

// ---------------------------------------------------------------------------
// Region extraction
// ---------------------------------------------------------------------------

interface RegionStatsExt extends RegionStats {
  touchesBorder: boolean
}

function extractWatershedRegions(
  labels:   Int32Array,
  numSeeds: number,
  width:    number,
  height:   number,
): CVRegion[] {
  const stats: RegionStatsExt[] = Array.from({ length: numSeeds }, (_, i) => ({
    label: i + 1, area: 0,
    x0: width, x1: 0, y0: height, y1: 0,
    sumX: 0, sumY: 0,
    touchesBorder: false,
  }))

  for (let idx = 0; idx < labels.length; idx++) {
    const label = labels[idx]
    if (label <= 0 || label > numSeeds) continue
    const s  = stats[label - 1]
    const px = idx % width
    const py = (idx - px) / width
    s.area++
    s.sumX += px; s.sumY += py
    if (px < s.x0) s.x0 = px
    if (px > s.x1) s.x1 = px
    if (py < s.y0) s.y0 = py
    if (py > s.y1) s.y1 = py
    // Mark as exterior if any owned pixel sits on the image border
    if (!s.touchesBorder && (px === 0 || px === width - 1 || py === 0 || py === height - 1)) {
      s.touchesBorder = true
    }
  }

  const minArea = width * height * MIN_AREA_FRACTION
  const borderCount = stats.filter(s => s.touchesBorder).length
  const valid = stats
    .filter(s => !s.touchesBorder && s.area >= minArea && s.x1 >= s.x0)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_REGIONS)
  console.log(`[walkaround/cv] regions: ${stats.length} total, ${borderCount} border-filtered, ${valid.length} interior pass area filter`)

  return valid.map((s, i): CVRegion => {
    const id       = i + 1
    const polygon  = extractRectilinearPolygon(labels, s.label, width, s.x0, s.y0, s.x1, s.y1)
    const pixelBBox = { x: s.x0, y: s.y0, w: s.x1 - s.x0 + 1, h: s.y1 - s.y0 + 1 }
    const centroid  = { x: s.sumX / s.area, y: s.sumY / s.area }
    return { id, pixelBBox, originalBBox: pixelBBox, pixelArea: s.area, centroid, polygon, originalPolygon: polygon }
  })
}

// ---------------------------------------------------------------------------
// Polygon extraction
// ---------------------------------------------------------------------------

/**
 * Extract a rectilinear polygon that outlines a watershed region.
 *
 * Algorithm:
 *   1. Scanline: for each row in the bounding box, find x_min and x_max of
 *      pixels belonging to this region → a list of spans.
 *   2. Build the polygon by tracing the right boundary top→bottom (adding step
 *      vertices when x_max changes) then the left boundary bottom→top (adding
 *      step vertices when x_min changes).
 *   3. Remove collinear points (simplify).
 */
function extractRectilinearPolygon(
  labels: Int32Array,
  label:  number,
  width:  number,
  bx0: number, by0: number, bx1: number, by1: number,
): CVPoint[] {
  const spans: Array<{ y: number; x0: number; x1: number }> = []
  for (let y = by0; y <= by1; y++) {
    let rowX0 = -1, rowX1 = -1
    for (let x = bx0; x <= bx1; x++) {
      if (labels[y * width + x] === label) {
        if (rowX0 === -1) rowX0 = x
        rowX1 = x
      }
    }
    if (rowX0 !== -1) spans.push({ y, x0: rowX0, x1: rowX1 })
  }
  if (spans.length === 0) return []
  return buildPolygonFromSpans(spans)
}

/**
 * Build a rectilinear polygon from horizontal scanline spans.
 *
 * Traces: top-left → top-right → right side down (stepping when x1 changes) →
 * bottom-right → bottom-left → left side up (stepping when x0 changes) → close.
 *
 * Example — L-shaped room:
 *   spans: y0 x0=0 x1=9, y1 x0=0 x1=9, y2 x0=5 x1=9, y3 x0=5 x1=9
 *   polygon: (0,0)→(10,0)→(10,4)→(5,4)→(5,2)→(0,2) ✓
 */
function buildPolygonFromSpans(spans: Array<{ y: number; x0: number; x1: number }>): CVPoint[] {
  const v: CVPoint[] = []

  v.push({ x: spans[0].x0,     y: spans[0].y })
  v.push({ x: spans[0].x1 + 1, y: spans[0].y })

  for (let i = 1; i < spans.length; i++) {
    const prevX1 = spans[i - 1].x1
    const currX1 = spans[i].x1
    if (currX1 !== prevX1) {
      v.push({ x: prevX1 + 1, y: spans[i].y })
      v.push({ x: currX1 + 1, y: spans[i].y })
    }
  }

  const last = spans[spans.length - 1]
  v.push({ x: last.x1 + 1, y: last.y + 1 })
  v.push({ x: last.x0,     y: last.y + 1 })

  for (let i = spans.length - 2; i >= 0; i--) {
    const nextX0 = spans[i + 1].x0
    const currX0 = spans[i].x0
    if (currX0 !== nextX0) {
      v.push({ x: nextX0, y: spans[i].y + 1 })
      v.push({ x: currX0, y: spans[i].y + 1 })
    }
  }

  return removeCollinear(v)
}

/**
 * Remove collinear intermediate points from a polygon.
 */
function removeCollinear(pts: CVPoint[]): CVPoint[] {
  if (pts.length < 3) return pts
  const result: CVPoint[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]
    const curr = pts[i]
    const next = pts[(i + 1) % n]
    const collinear =
      (prev.x === curr.x && curr.x === next.x) ||
      (prev.y === curr.y && curr.y === next.y)
    if (!collinear) result.push(curr)
  }
  return result
}
