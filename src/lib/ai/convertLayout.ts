import type { FloorPlanSchema, Room, Wall, Opening, Point, Confidence } from '@/lib/schema'
import type { CVPipelineResult } from '@/lib/cv/types'

// ---------------------------------------------------------------------------
// Draft types — the shape of what the AI returns before conversion
// ---------------------------------------------------------------------------

export interface ImageBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface AIOpeningDraft {
  id: string
  room_id: string
  wall: 'north' | 'south' | 'east' | 'west'
  position_along_wall: number
  type: 'door' | 'window' | 'archway'
  width: number
  height: number
  swing: string | null
  sill_height: number | null
  confidence: 'high' | 'medium' | 'low'
}

export interface AIRoomDraft {
  id: string
  name: string
  image_bbox: ImageBBox
  /**
   * Room polygon in metre coordinates (y-up, origin bottom-left).
   * Populated by the CV-assisted path from the BFS polygon.
   * When present, used instead of image_bbox for room vertices and wall edges.
   */
  polygon_m?: Point[]
  floor_material: string
  ceiling_height: number
  confidence: 'high' | 'medium' | 'low'
}

export interface AILayoutDraft {
  meta: {
    unit: string
    floor_name: string
    source_image: string
    bounds: { width: number; height: number }
    ai_notes: string | null
    schema_version: string
  }
  rooms: AIRoomDraft[]
  openings: AIOpeningDraft[]
  wallMask?: SourceWallMask
  sourceImage?: SourceImageOverlay
  sourceImageCrop?: ImagePixelCrop
}

interface SourceWallMask {
  mask: Uint8Array
  width: number
  height: number
  sampleRadiusPx: number
  planBoundsPx?: MaskBounds
}

interface MaskBounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface ResolvedSourceWallMask extends SourceWallMask {
  planBoundsPx: MaskBounds
}

interface ImagePixelCrop {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface SourceImageOverlay {
  base64: string
  mimeType: 'image/jpeg' | 'image/png'
  imageWidth: number
  imageHeight: number
  crop: ImagePixelCrop
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const EDGE_EPSILON = 0.3 // metres — tolerance for coincident edge detection
const SNAP_THRESHOLD_FRACTION = 0.06 // 6% of plan dimension — snap room edges this close together

/**
 * Convert image-fraction bbox to 4 metre vertices.
 * Image space: x0=left, x1=right, y0=top (small), y1=bottom (large)
 * Metre space: bottom-left origin, +Y up
 *
 * Returns [bottom-left, bottom-right, top-right, top-left]
 */
export function bboxToVertices(
  bbox: ImageBBox,
  totalW: number,
  totalH: number,
): Point[] {
  const xLeft = bbox.x0 * totalW
  const xRight = bbox.x1 * totalW
  // Flip Y: image bottom (large y) → metre Y=0 (bottom of plan)
  const yBottom = (1 - bbox.y1) * totalH
  const yTop = (1 - bbox.y0) * totalH

  return [
    { x: xLeft, y: yBottom },   // bottom-left
    { x: xRight, y: yBottom },  // bottom-right
    { x: xRight, y: yTop },     // top-right
    { x: xLeft, y: yTop },      // top-left
  ]
}

// ---------------------------------------------------------------------------
// Wall generation from room adjacency
// ---------------------------------------------------------------------------

type Direction = 'north' | 'south' | 'east' | 'west'
type WallAxis = 'horizontal' | 'vertical'

interface RoomEdge {
  roomId: string
  direction: Direction
  /** for horizontal edges (north/south): fixed y, x runs from x0 to x1 */
  /** for vertical edges (east/west):    fixed x, y runs from y0 to y1 */
  fixedCoord: number  // the constant axis value
  start: number       // start of the range on the varying axis
  end: number         // end of the range on the varying axis
  ceilingHeight: number
}

interface MaskWallComponent {
  axis: WallAxis
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Compute room edges for wall generation.
 *
 * When polygon_m is present (CV-assisted path): derive edges from all polygon
 * segments. Supports non-rectangular rooms (L-shaped, T-shaped, etc.).
 *
 * Fallback (LLM-only path): derive four axis-aligned edges from image_bbox.
 *
 * Direction (north/south/east/west) is inferred from each edge's outward normal
 * relative to the polygon winding. The polygon from the CV path is CW in pixel
 * space (y-down). The Y-flip (y_m = totalH - y_px) reverses the winding order,
 * so the polygon is CCW in metre space (y-up). For a CCW polygon in y-up space
 * the outward normal of edge P0→P1 with d=(dx,dy) is (dy, -dx):
 *   - horizontal edge going right (dx>0): normal y = -dx < 0 → south (bottom wall)
 *   - horizontal edge going left  (dx<0): normal y = -dx > 0 → north (top wall)
 *   - vertical edge going up      (dy>0): normal x = dy  > 0 → east  (right wall)
 *   - vertical edge going down    (dy<0): normal x = dy  < 0 → west  (left wall)
 */
function computeRoomEdges(room: AIRoomDraft, totalW: number, totalH: number): RoomEdge[] {
  const h = room.ceiling_height

  if (room.polygon_m && room.polygon_m.length >= 4) {
    const poly = room.polygon_m
    const n = poly.length
    const edges: RoomEdge[] = []

    for (let i = 0; i < n; i++) {
      const p0 = poly[i]
      const p1 = poly[(i + 1) % n]
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y

      const isHoriz = Math.abs(dy) < EDGE_EPSILON
      const isVert  = Math.abs(dx) < EDGE_EPSILON
      if (!isHoriz && !isVert) continue  // skip diagonal edges (shouldn't occur for rectilinear plans)

      let direction: Direction
      if (isHoriz) {
        // Polygon is CW in metre space (y-up). Outward normal of P0→P1 is (-dy, dx).
        // For horizontal edge: normal y = dx → dx>0 means normal points up = north.
        direction = dx > 0 ? 'north' : 'south'
        edges.push({
          roomId: room.id, direction,
          fixedCoord: p0.y,
          start: Math.min(p0.x, p1.x), end: Math.max(p0.x, p1.x),
          ceilingHeight: h,
        })
      } else {
        // For vertical edge: normal x = -dy → dy>0 means normal points left = west.
        direction = dy > 0 ? 'west' : 'east'
        edges.push({
          roomId: room.id, direction,
          fixedCoord: p0.x,
          start: Math.min(p0.y, p1.y), end: Math.max(p0.y, p1.y),
          ceilingHeight: h,
        })
      }
    }
    return edges
  }

  // Fallback: rectangular edges from image_bbox
  const { x0, x1, y0, y1 } = room.image_bbox
  const xLeft   = x0 * totalW
  const xRight  = x1 * totalW
  const yBottom = (1 - y1) * totalH
  const yTop    = (1 - y0) * totalH

  return [
    { roomId: room.id, direction: 'south', fixedCoord: yBottom, start: xLeft,   end: xRight, ceilingHeight: h },
    { roomId: room.id, direction: 'north', fixedCoord: yTop,    start: xLeft,   end: xRight, ceilingHeight: h },
    { roomId: room.id, direction: 'west',  fixedCoord: xLeft,   start: yBottom, end: yTop,   ceilingHeight: h },
    { roomId: room.id, direction: 'east',  fixedCoord: xRight,  start: yBottom, end: yTop,   ceilingHeight: h },
  ]
}

function isHorizontal(dir: Direction): boolean {
  return dir === 'north' || dir === 'south'
}

/** Opposite direction used to match openings across a shared wall */
function oppositeDirection(dir: Direction): Direction {
  const map: Record<Direction, Direction> = { north: 'south', south: 'north', east: 'west', west: 'east' }
  return map[dir]
}

/** Overlapping range [start, end] of two ranges. Returns null if they only touch or don't overlap. */
function rangeOverlap(
  a0: number, a1: number,
  b0: number, b1: number,
): [number, number] | null {
  const lo = Math.max(a0, b0)
  const hi = Math.min(a1, b1)
  // strictly greater than — touching edges don't count as a shared wall
  if (hi - lo > EDGE_EPSILON) return [lo, hi]
  return null
}

/** Build wall vertices from a horizontal edge (fixed y) */
function horizontalWallVertices(fixedY: number, x0: number, x1: number): Point[] {
  return [
    { x: x0, y: fixedY },
    { x: x1, y: fixedY },
  ]
}

/** Build wall vertices from a vertical edge (fixed x) */
function verticalWallVertices(fixedX: number, y0: number, y1: number): Point[] {
  return [
    { x: fixedX, y: y0 },
    { x: fixedX, y: y1 },
  ]
}

type EdgeRange = [number, number]

/**
 * Find openings that belong to this generated wall interval.
 *
 * AI openings are described against the room edge they came from. Wall generation
 * may split that room edge into multiple shared/exterior wall intervals, so the
 * opening's fractional position is remapped from the source room edge to the
 * generated wall segment.
 */
function matchOpenings(
  edgeContexts: RoomEdge[],
  wallStart: number,
  wallEnd: number,
  openings: AIOpeningDraft[],
): Opening[] {
  const wallLength = wallEnd - wallStart
  if (wallLength <= EDGE_EPSILON) return []

  return openings
    .map((opening): Opening | null => {
      const sourceEdge = edgeContexts.find(
        (edge) => edge.roomId === opening.room_id && edge.direction === opening.wall,
      )
      if (!sourceEdge) return null

      const sourceLength = sourceEdge.end - sourceEdge.start
      if (sourceLength <= EDGE_EPSILON) return null

      const center = sourceEdge.start + opening.position_along_wall * sourceLength
      if (center < wallStart - EDGE_EPSILON || center > wallEnd + EDGE_EPSILON) return null

      return {
        id: opening.id,
        type: opening.type,
        position_along_wall: clamp((center - wallStart) / wallLength, 0, 1),
        width: opening.width,
        height: opening.height,
        swing: opening.swing as Opening['swing'],
        sill_height: opening.sill_height,
        confidence: opening.confidence,
      }
    })
    .filter((opening): opening is Opening => opening !== null)
}

let wallCounter = 0

function makeWall(
  roomIds: string[],
  vertices: Point[],
  isExterior: boolean,
  ceilingHeight: number,
  edgeContexts: RoomEdge[],
  wallStart: number,
  wallEnd: number,
  openings: AIOpeningDraft[],
): Wall {
  wallCounter += 1
  const thickness = isExterior ? 0.2 : 0.1
  return {
    id: `wall_${wallCounter}`,
    room_ids: roomIds,
    vertices,
    thickness,
    height: ceilingHeight,
    material: 'plaster',
    is_exterior: isExterior,
    confidence: 'medium',
    openings: matchOpenings(edgeContexts, wallStart, wallEnd, openings),
  }
}

function wallHasSourceSupport(
  vertices: Point[],
  totalW: number,
  totalH: number,
  wallMask: SourceWallMask | undefined,
): boolean {
  if (!wallMask) return true
  const source = resolveSourceWallMask(wallMask)
  const [a, b] = vertices
  const ax = planXToMask(a.x, source, totalW)
  const ay = planYToMask(a.y, source, totalH)
  const bx = planXToMask(b.x, source, totalW)
  const by = planYToMask(b.y, source, totalH)
  const lengthPx = Math.hypot(bx - ax, by - ay)
  if (lengthPx <= 1) return false

  const samples = Math.max(8, Math.ceil(lengthPx / 8))
  let supported = 0

  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const x = ax + (bx - ax) * t
    const y = ay + (by - ay) * t
    if (hasWallPixelNear(wallMask, x, y)) supported++
  }

  return supported / (samples + 1) >= 0.45
}

function hasWallPixelNear(wallMask: SourceWallMask, x: number, y: number): boolean {
  const cx = Math.round(x)
  const cy = Math.round(y)
  const radius = wallMask.sampleRadiusPx

  for (let dy = -radius; dy <= radius; dy++) {
    const py = cy + dy
    if (py < 0 || py >= wallMask.height) continue
    for (let dx = -radius; dx <= radius; dx++) {
      const px = cx + dx
      if (px < 0 || px >= wallMask.width) continue
      if (wallMask.mask[py * wallMask.width + px] === 0) return true
    }
  }

  return false
}

function mergeRanges(ranges: EdgeRange[], min: number, max: number): EdgeRange[] {
  const sorted = ranges
    .map(([start, end]): EdgeRange => [clamp(start, min, max), clamp(end, min, max)])
    .filter(([start, end]) => end - start > EDGE_EPSILON)
    .sort(([a], [b]) => a - b)

  const merged: EdgeRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || range[0] > previous[1] + EDGE_EPSILON) {
      merged.push([...range])
    } else {
      previous[1] = Math.max(previous[1], range[1])
    }
  }

  return merged
}

function subtractRanges(fullStart: number, fullEnd: number, ranges: EdgeRange[]): EdgeRange[] {
  const uncovered: EdgeRange[] = []
  let cursor = fullStart

  for (const [start, end] of mergeRanges(ranges, fullStart, fullEnd)) {
    if (start - cursor > EDGE_EPSILON) uncovered.push([cursor, start])
    cursor = Math.max(cursor, end)
  }

  if (fullEnd - cursor > EDGE_EPSILON) uncovered.push([cursor, fullEnd])
  return uncovered
}

/**
 * Build a snap map: for each raw value, return the cluster centroid it belongs to.
 * Values within `threshold` of each other are collapsed to their average.
 * Uses string keys to avoid float Map lookup issues.
 */
function buildSnapMap(rawValues: number[], threshold: number): Map<string, number> {
  const unique = [...new Set(rawValues)].sort((a, b) => a - b)
  const result = new Map<string, number>()

  let i = 0
  while (i < unique.length) {
    let j = i + 1
    while (j < unique.length && unique[j] - unique[i] <= threshold) j++
    const cluster = unique.slice(i, j)
    const centroid = cluster.reduce((s, v) => s + v, 0) / cluster.length
    for (const v of cluster) result.set(v.toString(), centroid)
    i = j
  }
  return result
}

/**
 * Snap room bounding box edges so that rooms that are approximately adjacent
 * share exact coordinates. This allows the wall adjacency detector to reliably
 * find shared edges even when the AI outputs slightly inconsistent fractions.
 */
function snapRoomEdges(rooms: AIRoomDraft[], totalW: number, totalH: number): AIRoomDraft[] {
  const xs = rooms.flatMap((r) => [r.image_bbox.x0 * totalW, r.image_bbox.x1 * totalW])
  const ys = rooms.flatMap((r) => [r.image_bbox.y0 * totalH, r.image_bbox.y1 * totalH])

  const threshX = totalW * SNAP_THRESHOLD_FRACTION
  const threshY = totalH * SNAP_THRESHOLD_FRACTION
  const snapX = buildSnapMap(xs, threshX)
  const snapY = buildSnapMap(ys, threshY)

  return rooms.map((r) => ({
    ...r,
    image_bbox: {
      x0: (snapX.get((r.image_bbox.x0 * totalW).toString()) ?? r.image_bbox.x0 * totalW) / totalW,
      y0: (snapY.get((r.image_bbox.y0 * totalH).toString()) ?? r.image_bbox.y0 * totalH) / totalH,
      x1: (snapX.get((r.image_bbox.x1 * totalW).toString()) ?? r.image_bbox.x1 * totalW) / totalW,
      y1: (snapY.get((r.image_bbox.y1 * totalH).toString()) ?? r.image_bbox.y1 * totalH) / totalH,
    },
  }))
}

export function generateWalls(
  rooms: AIRoomDraft[],
  openings: AIOpeningDraft[],
  totalW: number,
  totalH: number,
  wallMask?: SourceWallMask,
): Wall[] {
  wallCounter = 0
  const walls: Wall[] = []

  // Snap nearby room edges to shared coordinates so adjacency detection is reliable
  const snappedRooms = snapRoomEdges(rooms, totalW, totalH)

  // Compute all edges for all rooms
  const allEdges = snappedRooms.flatMap((r) => computeRoomEdges(r, totalW, totalH))

  const coveredRanges: EdgeRange[][] = allEdges.map(() => [])

  // Find shared (interior) edges
  for (let i = 0; i < allEdges.length; i++) {
    const edgeA = allEdges[i]

    for (let j = i + 1; j < allEdges.length; j++) {
      const edgeB = allEdges[j]

      // Different rooms only
      if (edgeA.roomId === edgeB.roomId) continue

      // Both must be same axis (both horizontal or both vertical)
      const aHoriz = isHorizontal(edgeA.direction)
      const bHoriz = isHorizontal(edgeB.direction)
      if (aHoriz !== bHoriz) continue

      // Directions must be opposite (north-south or east-west pair)
      if (edgeA.direction !== oppositeDirection(edgeB.direction)) continue

      // Fixed coordinates must be coincident
      if (Math.abs(edgeA.fixedCoord - edgeB.fixedCoord) >= EDGE_EPSILON) continue

      // Ranges must overlap
      const overlap = rangeOverlap(edgeA.start, edgeA.end, edgeB.start, edgeB.end)
      if (!overlap) continue

      // Create interior wall at the overlapping segment
      const avgFixed = (edgeA.fixedCoord + edgeB.fixedCoord) / 2
      const [lo, hi] = overlap
      const vertices = aHoriz
        ? horizontalWallVertices(avgFixed, lo, hi)
        : verticalWallVertices(avgFixed, lo, hi)

      const avgHeight = (edgeA.ceilingHeight + edgeB.ceilingHeight) / 2
      if (wallHasSourceSupport(vertices, totalW, totalH, wallMask)) {
        walls.push(
          makeWall(
            [edgeA.roomId, edgeB.roomId],
            vertices,
            false,
            avgHeight,
            [edgeA, edgeB],
            lo,
            hi,
            openings,
          ),
        )
      }

      coveredRanges[i].push(overlap)
      coveredRanges[j].push(overlap)
    }
  }

  // Uncovered edge intervals → exterior walls. An edge can have multiple
  // interior overlaps, so this must split instead of treating the whole edge as paired.
  for (let i = 0; i < allEdges.length; i++) {
    const edge = allEdges[i]
    const horiz = isHorizontal(edge.direction)

    for (const [start, end] of subtractRanges(edge.start, edge.end, coveredRanges[i])) {
      const vertices = horiz
        ? horizontalWallVertices(edge.fixedCoord, start, end)
        : verticalWallVertices(edge.fixedCoord, start, end)

      if (wallHasSourceSupport(vertices, totalW, totalH, wallMask)) {
        walls.push(
          makeWall(
            [edge.roomId],
            vertices,
            true,
            edge.ceilingHeight,
            [edge],
            start,
            end,
            openings,
          ),
        )
      }
    }
  }

  return walls
}

function generateWallsFromMask(
  wallMask: SourceWallMask,
  rooms: AIRoomDraft[],
  totalW: number,
  totalH: number,
): Wall[] {
  wallCounter = 0
  const source = resolveSourceWallMask(wallMask)
  const candidates = extractWallComponents(source)
  const components = candidates
    .filter((component) => maskComponentHasStructuralSupport(component, rooms, source))
  const walls = components
    .map((component) => maskComponentToWall(component, rooms, source, totalW, totalH))
    .filter((wall): wall is Wall => wall !== null)

  console.log(
    `[walkaround/cv] Generated ${walls.length} source-mask wall segments ` +
    `(${components.length}/${candidates.length} candidates after structural-support filter)`,
  )
  return walls
}

function renumberWalls(walls: Wall[]): Wall[] {
  return walls.map((wall, index) => ({
    ...wall,
    id: `wall_${index + 1}`,
  }))
}

function extractWallComponents(wallMask: ResolvedSourceWallMask): MaskWallComponent[] {
  const { mask, width, height } = wallMask
  const cropW = wallMask.planBoundsPx.x1 - wallMask.planBoundsPx.x0
  const cropH = wallMask.planBoundsPx.y1 - wallMask.planBoundsPx.y0
  const shortSide = Math.min(cropW, cropH)
  const minRunLength = Math.max(36, Math.round(shortSide * 0.03))
  const minThickness = Math.max(6, Math.round(shortSide * 0.0055))
  const maxThickness = Math.max(28, Math.round(shortSide * 0.035))

  const horizontalCandidates = markAxisRuns(mask, width, height, 'horizontal', minRunLength)
  const verticalCandidates = markAxisRuns(mask, width, height, 'vertical', minRunLength)

  return [
    ...candidateComponents(horizontalCandidates, width, height, 'horizontal', minRunLength, minThickness, maxThickness),
    ...candidateComponents(verticalCandidates, width, height, 'vertical', minRunLength, minThickness, maxThickness),
  ]
}

function markAxisRuns(
  mask: Uint8Array,
  width: number,
  height: number,
  axis: WallAxis,
  minRunLength: number,
): Uint8Array {
  const candidates = new Uint8Array(mask.length)

  if (axis === 'horizontal') {
    for (let y = 0; y < height; y++) {
      let x = 0
      while (x < width) {
        while (x < width && mask[y * width + x] !== 0) x++
        const start = x
        while (x < width && mask[y * width + x] === 0) x++
        if (x - start >= minRunLength) {
          for (let px = start; px < x; px++) candidates[y * width + px] = 1
        }
      }
    }
    return candidates
  }

  for (let x = 0; x < width; x++) {
    let y = 0
    while (y < height) {
      while (y < height && mask[y * width + x] !== 0) y++
      const start = y
      while (y < height && mask[y * width + x] === 0) y++
      if (y - start >= minRunLength) {
        for (let py = start; py < y; py++) candidates[py * width + x] = 1
      }
    }
  }

  return candidates
}

function candidateComponents(
  candidates: Uint8Array,
  width: number,
  height: number,
  axis: WallAxis,
  minRunLength: number,
  minThickness: number,
  maxThickness: number,
): MaskWallComponent[] {
  const visited = new Uint8Array(candidates.length)
  const queue = new Int32Array(candidates.length)
  const components: MaskWallComponent[] = []

  for (let i = 0; i < candidates.length; i++) {
    if (visited[i] || candidates[i] === 0) continue

    let head = 0
    let tail = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let area = 0

    visited[i] = 1
    queue[tail++] = i

    while (head < tail) {
      const idx = queue[head++]
      const x = idx % width
      const y = (idx - x) / width
      area++
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)

      const neighbours = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ]
      for (const next of neighbours) {
        if (next < 0 || visited[next] || candidates[next] === 0) continue
        visited[next] = 1
        queue[tail++] = next
      }
    }

    const componentWidth = maxX - minX + 1
    const componentHeight = maxY - minY + 1
    const longSide = axis === 'horizontal' ? componentWidth : componentHeight
    const shortSide = axis === 'horizontal' ? componentHeight : componentWidth
    const fill = area / (componentWidth * componentHeight)

    if (
      longSide >= minRunLength &&
      shortSide >= minThickness &&
      shortSide <= maxThickness &&
      longSide / shortSide >= 3 &&
      fill >= 0.35
    ) {
      components.push({ axis, x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 })
    }
  }

  return mergeMaskWallComponents(components)
}

function mergeMaskWallComponents(components: MaskWallComponent[]): MaskWallComponent[] {
  const byAxis = new Map<WallAxis, MaskWallComponent[]>()
  components.forEach((component) => {
    byAxis.set(component.axis, [...(byAxis.get(component.axis) ?? []), component])
  })

  const merged: MaskWallComponent[] = []
  byAxis.forEach((axisComponents, axis) => {
    const sorted = axisComponents.sort((a, b) =>
      axis === 'horizontal' ? a.y0 - b.y0 || a.x0 - b.x0 : a.x0 - b.x0 || a.y0 - b.y0,
    )

    for (const component of sorted) {
      const previous = merged.find((candidate) =>
        candidate.axis === axis && maskComponentsCanMerge(candidate, component),
      )
      if (previous) {
        previous.x0 = Math.min(previous.x0, component.x0)
        previous.y0 = Math.min(previous.y0, component.y0)
        previous.x1 = Math.max(previous.x1, component.x1)
        previous.y1 = Math.max(previous.y1, component.y1)
      } else {
        merged.push({ ...component })
      }
    }
  })

  return merged
}

function maskComponentsCanMerge(a: MaskWallComponent, b: MaskWallComponent): boolean {
  const sameAxisTolerance = 4
  const gapTolerance = 4

  if (a.axis === 'horizontal') {
    const centerA = (a.y0 + a.y1) / 2
    const centerB = (b.y0 + b.y1) / 2
    if (Math.abs(centerA - centerB) > sameAxisTolerance) return false
    return rangesTouchOrOverlap(a.x0, a.x1, b.x0, b.x1, gapTolerance)
  }

  const centerA = (a.x0 + a.x1) / 2
  const centerB = (b.x0 + b.x1) / 2
  if (Math.abs(centerA - centerB) > sameAxisTolerance) return false
  return rangesTouchOrOverlap(a.y0, a.y1, b.y0, b.y1, gapTolerance)
}

function rangesTouchOrOverlap(a0: number, a1: number, b0: number, b1: number, tolerance: number): boolean {
  return Math.max(a0, b0) <= Math.min(a1, b1) + tolerance
}

function maskComponentToWall(
  component: MaskWallComponent,
  rooms: AIRoomDraft[],
  wallMask: ResolvedSourceWallMask,
  totalW: number,
  totalH: number,
): Wall | null {
  wallCounter += 1
  const bounds = wallMask.planBoundsPx
  const cropW = bounds.x1 - bounds.x0
  const cropH = bounds.y1 - bounds.y0
  const roomIds = roomIdsNearMaskWall(component, rooms, wallMask)

  const thickness = component.axis === 'horizontal'
    ? clamp(((component.y1 - component.y0) / cropH) * totalH, 0.08, 0.35)
    : clamp(((component.x1 - component.x0) / cropW) * totalW, 0.08, 0.35)

  const vertices = component.axis === 'horizontal'
    ? [
        {
          x: maskXToPlan(component.x0, wallMask, totalW),
          y: maskYToPlan((component.y0 + component.y1) / 2, wallMask, totalH),
        },
        {
          x: maskXToPlan(component.x1, wallMask, totalW),
          y: maskYToPlan((component.y0 + component.y1) / 2, wallMask, totalH),
        },
      ]
    : [
        {
          x: maskXToPlan((component.x0 + component.x1) / 2, wallMask, totalW),
          y: maskYToPlan(component.y1, wallMask, totalH),
        },
        {
          x: maskXToPlan((component.x0 + component.x1) / 2, wallMask, totalW),
          y: maskYToPlan(component.y0, wallMask, totalH),
        },
      ]

  if (pointDistance(vertices[0], vertices[1]) < 0.2) return null

  return {
    id: `wall_${wallCounter}`,
    room_ids: roomIds,
    vertices,
    thickness,
    height: 2.7,
    material: 'plaster',
    is_exterior: isLikelyExteriorMaskWall(component, rooms, wallMask),
    confidence: 'medium',
    openings: [],
  }
}

function roomIdsNearMaskWall(
  component: MaskWallComponent,
  rooms: AIRoomDraft[],
  wallMask: ResolvedSourceWallMask,
): string[] {
  const bounds = wallMask.planBoundsPx
  const cropW = bounds.x1 - bounds.x0
  const cropH = bounds.y1 - bounds.y0
  const tolerancePx = Math.max(14, Math.round(Math.min(cropW, cropH) * 0.012))
  const ids = rooms
    .filter((room) => {
      const bbox = room.image_bbox
      const rx0 = bounds.x0 + bbox.x0 * cropW
      const rx1 = bounds.x0 + bbox.x1 * cropW
      const ry0 = bounds.y0 + bbox.y0 * cropH
      const ry1 = bounds.y0 + bbox.y1 * cropH

      if (component.axis === 'horizontal') {
        const y = (component.y0 + component.y1) / 2
        const overlapsX = Math.min(component.x1, rx1) - Math.max(component.x0, rx0) > tolerancePx
        return overlapsX && (Math.abs(y - ry0) <= tolerancePx || Math.abs(y - ry1) <= tolerancePx)
      }

      const x = (component.x0 + component.x1) / 2
      const overlapsY = Math.min(component.y1, ry1) - Math.max(component.y0, ry0) > tolerancePx
      return overlapsY && (Math.abs(x - rx0) <= tolerancePx || Math.abs(x - rx1) <= tolerancePx)
    })
    .map((room) => room.id)

  return [...new Set(ids)].slice(0, 2)
}

function maskComponentHasStructuralSupport(
  component: MaskWallComponent,
  rooms: AIRoomDraft[],
  wallMask: ResolvedSourceWallMask,
): boolean {
  if (rooms.length === 0) return true
  if (maskComponentTouchesPlanEdge(component, wallMask)) return true
  return roomIdsNearMaskWall(component, rooms, wallMask).length > 0
}

function maskComponentTouchesPlanEdge(
  component: MaskWallComponent,
  wallMask: ResolvedSourceWallMask,
): boolean {
  const bounds = wallMask.planBoundsPx
  const cropW = bounds.x1 - bounds.x0
  const cropH = bounds.y1 - bounds.y0
  const tolerancePx = Math.max(10, Math.round(Math.min(cropW, cropH) * 0.012))

  if (component.axis === 'horizontal') {
    const y = (component.y0 + component.y1) / 2
    return Math.abs(y - bounds.y0) <= tolerancePx || Math.abs(y - bounds.y1) <= tolerancePx
  }

  const x = (component.x0 + component.x1) / 2
  return Math.abs(x - bounds.x0) <= tolerancePx || Math.abs(x - bounds.x1) <= tolerancePx
}

function isLikelyExteriorMaskWall(
  component: MaskWallComponent,
  rooms: AIRoomDraft[],
  wallMask: ResolvedSourceWallMask,
): boolean {
  if (rooms.length === 0) return true
  const bounds = wallMask.planBoundsPx
  const cropW = bounds.x1 - bounds.x0
  const cropH = bounds.y1 - bounds.y0
  const minX = Math.min(...rooms.map((room) => bounds.x0 + room.image_bbox.x0 * cropW))
  const maxX = Math.max(...rooms.map((room) => bounds.x0 + room.image_bbox.x1 * cropW))
  const minY = Math.min(...rooms.map((room) => bounds.y0 + room.image_bbox.y0 * cropH))
  const maxY = Math.max(...rooms.map((room) => bounds.y0 + room.image_bbox.y1 * cropH))
  const tolerance = Math.max(18, Math.round(Math.min(cropW, cropH) * 0.015))

  if (component.axis === 'horizontal') {
    const y = (component.y0 + component.y1) / 2
    return Math.abs(y - minY) <= tolerance || Math.abs(y - maxY) <= tolerance
  }

  const x = (component.x0 + component.x1) / 2
  return Math.abs(x - minX) <= tolerance || Math.abs(x - maxX) <= tolerance
}

function resolveSourceWallMask(wallMask: SourceWallMask): ResolvedSourceWallMask {
  return {
    ...wallMask,
    planBoundsPx: wallMask.planBoundsPx ?? computeWallMaskBounds(wallMask.mask, wallMask.width, wallMask.height),
  }
}

function computeWallMaskBounds(mask: Uint8Array, width: number, height: number): MaskBounds {
  const shortSide = Math.min(width, height)
  const cropRunLength = Math.max(32, Math.round(shortSide * 0.04))
  const cropMinThickness = Math.max(4, Math.round(shortSide * 0.003))
  const cropMaxThickness = Math.max(28, Math.round(shortSide * 0.035))
  const components = [
    ...candidateComponents(
      markAxisRuns(mask, width, height, 'horizontal', cropRunLength),
      width,
      height,
      'horizontal',
      cropRunLength,
      cropMinThickness,
      cropMaxThickness,
    ),
    ...candidateComponents(
      markAxisRuns(mask, width, height, 'vertical', cropRunLength),
      width,
      height,
      'vertical',
      cropRunLength,
      cropMinThickness,
      cropMaxThickness,
    ),
  ]

  if (components.length > 0) {
    const minX = Math.min(...components.map((component) => component.x0))
    const minY = Math.min(...components.map((component) => component.y0))
    const maxX = Math.max(...components.map((component) => component.x1))
    const maxY = Math.max(...components.map((component) => component.y1))
    const padding = Math.max(2, Math.round(shortSide * 0.003))
    return {
      x0: clamp(minX - padding, 0, width - 1),
      y0: clamp(minY - padding, 0, height - 1),
      x1: clamp(maxX + padding, 1, width),
      y1: clamp(maxY + padding, 1, height),
    }
  }

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 0) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x0: 0, y0: 0, x1: width, y1: height }
  }

  const padding = Math.max(2, Math.round(shortSide * 0.003))
  return {
    x0: clamp(minX - padding, 0, width - 1),
    y0: clamp(minY - padding, 0, height - 1),
    x1: clamp(maxX + 1 + padding, 1, width),
    y1: clamp(maxY + 1 + padding, 1, height),
  }
}

function maskXToPlan(x: number, wallMask: ResolvedSourceWallMask, totalW: number): number {
  const bounds = wallMask.planBoundsPx
  const cropW = Math.max(1, bounds.x1 - bounds.x0)
  return clamp((x - bounds.x0) / cropW, 0, 1) * totalW
}

function maskYToPlan(y: number, wallMask: ResolvedSourceWallMask, totalH: number): number {
  const bounds = wallMask.planBoundsPx
  const cropH = Math.max(1, bounds.y1 - bounds.y0)
  return (1 - clamp((y - bounds.y0) / cropH, 0, 1)) * totalH
}

function planXToMask(x: number, wallMask: ResolvedSourceWallMask, totalW: number): number {
  const bounds = wallMask.planBoundsPx
  const cropW = Math.max(1, bounds.x1 - bounds.x0)
  return bounds.x0 + clamp(x / totalW, 0, 1) * cropW
}

function planYToMask(y: number, wallMask: ResolvedSourceWallMask, totalH: number): number {
  const bounds = wallMask.planBoundsPx
  const cropH = Math.max(1, bounds.y1 - bounds.y0)
  return bounds.y0 + (1 - clamp(y / totalH, 0, 1)) * cropH
}

// ---------------------------------------------------------------------------
// Main conversion: AILayoutDraft → FloorPlanSchema
// ---------------------------------------------------------------------------

export function convertDraftToSchema(draft: AILayoutDraft): FloorPlanSchema {
  const { width: totalW, height: totalH } = draft.meta.bounds

  const rooms: Room[] = draft.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    // CV-assisted path: use actual polygon vertices for non-rectangular room support.
    // LLM-only fallback: derive 4 rectangle corners from image_bbox.
    vertices: r.polygon_m ?? bboxToVertices(r.image_bbox, totalW, totalH),
    floor_material: r.floor_material,
    ceiling_height: r.ceiling_height,
    confidence: r.confidence,
  }))

  const maskWalls = draft.wallMask
    ? generateWallsFromMask(draft.wallMask, draft.rooms, totalW, totalH)
    : []
  const edgeWalls = maskWalls.length > 0
    ? []
    : generateWalls(draft.rooms, draft.openings, totalW, totalH, draft.wallMask)
  if (maskWalls.length > 0) {
    console.log('[walkaround/cv] Using source-mask walls only; skipped room-edge wall additions')
  }
  const walls = renumberWalls(maskWalls.length > 0 ? maskWalls : edgeWalls)
  const annotations: unknown[] = draft.sourceImage
    ? [
        {
          type: 'source_image_overlay',
          data: draft.sourceImage.base64,
          mimeType: draft.sourceImage.mimeType,
          imageWidth: draft.sourceImage.imageWidth,
          imageHeight: draft.sourceImage.imageHeight,
          crop: draft.sourceImage.crop,
        },
      ]
    : []

  return {
    meta: {
      unit: 'meters',
      floor_name: draft.meta.floor_name,
      source_image: draft.meta.source_image,
      bounds: { width: totalW, height: totalH },
      ai_notes: draft.meta.ai_notes,
      schema_version: draft.meta.schema_version || '1.0',
    },
    rooms,
    walls,
    structural: [],
    furniture: [],
    annotations,
    issues: [],
  }
}

// ---------------------------------------------------------------------------
// JSON parsing helpers (duplicated from parseResponse to avoid circular deps)
// ---------------------------------------------------------------------------

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'JSON.parse failed' }
  }
}

function repairMalformedJson(text: string): string {
  let repaired = text
  repaired = repaired.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  repaired = repaired.replace(/,\s*([}\]])/g, '$1')
  repaired = repaired.replace(/}\s*{/g, '},{').replace(/]\s*\[/g, '],[').replace(/}\s*"/g, '},"').replace(/]\s*"/g, '],"')
  return repaired
}

function parseJsonCandidate(cleaned: string): unknown {
  const direct = tryParseJson(cleaned)
  if (direct.ok) return direct.value

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in model output')
  }

  const sliced = cleaned.slice(firstBrace, lastBrace + 1)
  const slicedParse = tryParseJson(sliced)
  if (slicedParse.ok) return slicedParse.value

  const repaired = repairMalformedJson(sliced)
  const repairedParse = tryParseJson(repaired)
  if (repairedParse.ok) return repairedParse.value

  throw new Error(slicedParse.error ?? repairedParse.error ?? 'JSON.parse failed')
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function coerceNumber(value: unknown): number {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NaN
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function coerceString(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : fallback
  }
  if (value === null || value === undefined) return fallback
  const s = String(value).trim()
  return s.length > 0 ? s : fallback
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  if (typeof value !== 'string') return 'medium'
  const n = value.trim().toLowerCase()
  if (n === 'high' || n === 'medium' || n === 'low') return n
  return 'medium'
}

function normalizeBBox(raw: unknown, roomIndex: number): ImageBBox {
  if (!isRecord(raw)) {
    // Fallback: spread rooms evenly — caller will clamp
    return { x0: 0, y0: 0, x1: 1, y1: 1 }
  }
  const x0 = clamp(coerceNumber(raw['x0']), 0, 1)
  const y0 = clamp(coerceNumber(raw['y0']), 0, 1)
  const x1 = clamp(coerceNumber(raw['x1']), 0, 1)
  const y1 = clamp(coerceNumber(raw['y1']), 0, 1)

  // Ensure x0 < x1 and y0 < y1 — if degenerate, spread slightly
  const safeX1 = x1 > x0 ? x1 : Math.min(x0 + 0.1, 1)
  const safeY1 = y1 > y0 ? y1 : Math.min(y0 + 0.1, 1)

  void roomIndex // used implicitly for fallback error context
  return { x0, y0, x1: safeX1, y1: safeY1 }
}

/**
 * If the AI accidentally outputs `vertices` (metre coordinates) instead of `image_bbox`,
 * attempt to derive an approximate image_bbox from the vertices.
 */
function approximateBBoxFromVertices(
  vertices: unknown[],
  totalW: number,
  totalH: number,
): ImageBBox | null {
  if (vertices.length < 3) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const v of vertices) {
    if (!isRecord(v)) continue
    const x = coerceNumber(v['x'])
    const y = coerceNumber(v['y'])
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (!isFiniteNumber(minX)) return null

  // Metre→fraction, then flip Y for image space
  const x0 = clamp(minX / totalW, 0, 1)
  const x1 = clamp(maxX / totalW, 0, 1)
  // y in metre space is bottom-left origin; image y is top-left origin
  const y0 = clamp(1 - maxY / totalH, 0, 1)
  const y1 = clamp(1 - minY / totalH, 0, 1)
  return { x0, y0, x1, y1 }
}

function normalizeRoom(raw: unknown, index: number, totalW: number, totalH: number): AIRoomDraft | null {
  if (!isRecord(raw)) return null

  const id = coerceString(raw['id'], `room_${index + 1}`)
  const name = coerceString(raw['name'], `Room ${index + 1}`)
  const floor_material = coerceString(raw['floor_material'], 'unknown')

  let ceiling_height = coerceNumber(raw['ceiling_height'])
  if (!isFiniteNumber(ceiling_height) || ceiling_height <= 0) ceiling_height = 2.7

  const confidence = normalizeConfidence(raw['confidence'])

  let image_bbox: ImageBBox

  if (isRecord(raw['image_bbox'])) {
    image_bbox = normalizeBBox(raw['image_bbox'], index)
  } else if (Array.isArray(raw['vertices']) && raw['vertices'].length >= 3) {
    // AI output metre vertices — check if they look like fractions or metres
    const firstVertex = raw['vertices'][0]
    const sampleX = isRecord(firstVertex) ? coerceNumber(firstVertex['x']) : NaN
    if (isFiniteNumber(sampleX) && sampleX > 1.5) {
      // Values > 1 → metre coordinates; convert to image fractions
      const approx = approximateBBoxFromVertices(raw['vertices'] as unknown[], totalW, totalH)
      if (approx) {
        image_bbox = approx
      } else {
        return null // can't recover
      }
    } else {
      // Values in [0,1] — treat as fractions directly
      const approx = approximateBBoxFromVertices(raw['vertices'] as unknown[], 1, 1)
      image_bbox = approx ?? { x0: 0, y0: 0, x1: 1, y1: 1 }
    }
  } else {
    return null // no usable position data
  }

  return { id, name, image_bbox, floor_material, ceiling_height, confidence }
}

function normalizeOpening(raw: unknown, index: number): AIOpeningDraft | null {
  if (!isRecord(raw)) return null

  const id = coerceString(raw['id'], `opening_${index + 1}`)
  const room_id = coerceString(raw['room_id'], '')
  if (!room_id) return null

  const wallRaw = coerceString(raw['wall'], '').toLowerCase()
  if (wallRaw !== 'north' && wallRaw !== 'south' && wallRaw !== 'east' && wallRaw !== 'west') return null
  const wall = wallRaw as 'north' | 'south' | 'east' | 'west'

  let position_along_wall = coerceNumber(raw['position_along_wall'])
  if (!isFiniteNumber(position_along_wall)) position_along_wall = 0.5
  position_along_wall = clamp(position_along_wall, 0, 1)

  const typeRaw = coerceString(raw['type'], 'door').toLowerCase()
  const type: 'door' | 'window' | 'archway' =
    typeRaw === 'window' ? 'window' : typeRaw === 'archway' ? 'archway' : 'door'

  let width = coerceNumber(raw['width'])
  if (!isFiniteNumber(width) || width <= 0) width = 0.9

  let height = coerceNumber(raw['height'])
  if (!isFiniteNumber(height) || height <= 0) height = 2.1

  const swingRaw = typeof raw['swing'] === 'string' ? raw['swing'].trim().toLowerCase() : null
  const swing =
    swingRaw === 'inward_left' || swingRaw === 'inward_right' ||
    swingRaw === 'outward_left' || swingRaw === 'outward_right'
      ? swingRaw
      : null

  const sillRaw = coerceNumber(raw['sill_height'])
  const sill_height = isFiniteNumber(sillRaw) ? sillRaw : null

  const confidence = normalizeConfidence(raw['confidence'])

  return { id, room_id, wall, position_along_wall, type, width, height, swing, sill_height, confidence }
}

// ---------------------------------------------------------------------------
// Public parser entrypoint
// ---------------------------------------------------------------------------

export function parseLayoutDraftFromRaw(rawText: string): AILayoutDraft {
  const cleaned = stripMarkdownFences(rawText)

  let parsed: unknown
  try {
    parsed = parseJsonCandidate(cleaned)
  } catch (e) {
    throw new Error(
      `AI output is not parseable JSON: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (!isRecord(parsed)) {
    throw new Error('AI output top-level value is not an object')
  }

  // --- meta ---
  const rawMeta = isRecord(parsed['meta']) ? parsed['meta'] : {}

  const unit = coerceString(rawMeta['unit'], 'meters')
  const floor_name = coerceString(rawMeta['floor_name'], 'Ground Floor')
  const source_image = coerceString(rawMeta['source_image'], '')
  const schema_version = coerceString(rawMeta['schema_version'], '1.0')
  const ai_notes =
    rawMeta['ai_notes'] === null || rawMeta['ai_notes'] === undefined
      ? null
      : typeof rawMeta['ai_notes'] === 'string'
        ? rawMeta['ai_notes']
        : String(rawMeta['ai_notes'])

  const rawBounds = isRecord(rawMeta['bounds']) ? rawMeta['bounds'] : {}
  let boundsWidth = coerceNumber(rawBounds['width'])
  let boundsHeight = coerceNumber(rawBounds['height'])
  if (!isFiniteNumber(boundsWidth) || boundsWidth <= 0) boundsWidth = 10
  if (!isFiniteNumber(boundsHeight) || boundsHeight <= 0) boundsHeight = 10

  const meta: AILayoutDraft['meta'] = {
    unit,
    floor_name,
    source_image,
    bounds: { width: boundsWidth, height: boundsHeight },
    ai_notes,
    schema_version,
  }

  // --- rooms ---
  const rawRooms = Array.isArray(parsed['rooms']) ? parsed['rooms'] : []
  const rooms: AIRoomDraft[] = rawRooms
    .map((r, i) => normalizeRoom(r, i, boundsWidth, boundsHeight))
    .filter((r): r is AIRoomDraft => r !== null)

  if (rooms.length === 0) {
    throw new Error('AI output contains no usable rooms')
  }

  // --- openings ---
  const rawOpenings = Array.isArray(parsed['openings']) ? parsed['openings'] : []
  const openings: AIOpeningDraft[] = rawOpenings
    .map((o, i) => normalizeOpening(o, i))
    .filter((o): o is AIOpeningDraft => o !== null)

  // Filter openings whose room_id doesn't match any known room
  const roomIds = new Set(rooms.map((r) => r.id))
  const filteredOpenings = openings.filter((o) => roomIds.has(o.room_id))

  return { meta, rooms, openings: filteredOpenings }
}

// ---------------------------------------------------------------------------
// CV + LLM merge types
// ---------------------------------------------------------------------------

export interface LLMRoomLabel {
  region_id: number
  name: string
  width_m: number
  depth_m: number
  confidence: Confidence
}

export interface LLMOpeningLabel {
  region_id: number
  type: 'door' | 'window' | 'archway'
  wall: 'north' | 'south' | 'east' | 'west'
  position_along_wall: number
  width_m: number
  height_m: number
  swing: string | null
  sill_height_m: number | null
  confidence: Confidence
}

export interface LLMSemanticOutput {
  floor_name: string
  plan_width_m: number | null
  plan_height_m: number | null
  total_area_m2: number | null
  rooms: LLMRoomLabel[]
  openings: LLMOpeningLabel[]
}

// ---------------------------------------------------------------------------
// LLM semantic output parser
// ---------------------------------------------------------------------------

export function parseLLMSemanticOutput(rawText: string): LLMSemanticOutput {
  const cleaned = stripMarkdownFences(rawText)
  let parsed: unknown
  try {
    parsed = parseJsonCandidate(cleaned)
  } catch (e) {
    throw new Error(
      `LLM semantic output is not parseable JSON: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (!isRecord(parsed)) throw new Error('LLM semantic output top-level value is not an object')

  const floor_name = coerceString(parsed['floor_name'], 'Floor 1')

  const rawRooms = Array.isArray(parsed['rooms']) ? parsed['rooms'] : []
  const rooms: LLMRoomLabel[] = rawRooms
    .map((r): LLMRoomLabel | null => {
      if (!isRecord(r)) return null
      const region_id = Math.round(coerceNumber(r['region_id']))
      if (!Number.isFinite(region_id) || region_id < 1) return null
      const name = coerceString(r['name'], `Room ${region_id}`)
      let width_m = coerceNumber(r['width_m'])
      let depth_m = coerceNumber(r['depth_m'])
      if (!Number.isFinite(width_m) || width_m <= 0) width_m = 0
      if (!Number.isFinite(depth_m) || depth_m <= 0) depth_m = 0
      return { region_id, name, width_m, depth_m, confidence: normalizeConfidence(r['confidence']) }
    })
    .filter((r): r is LLMRoomLabel => r !== null)

  const rawOpenings = Array.isArray(parsed['openings']) ? parsed['openings'] : []
  const openings: LLMOpeningLabel[] = rawOpenings
    .map((o): LLMOpeningLabel | null => {
      if (!isRecord(o)) return null
      const region_id = Math.round(coerceNumber(o['region_id']))
      if (!Number.isFinite(region_id) || region_id < 1) return null

      const wallRaw = coerceString(o['wall'], '').toLowerCase()
      if (!['north', 'south', 'east', 'west'].includes(wallRaw)) return null
      const wall = wallRaw as LLMOpeningLabel['wall']

      const typeRaw = coerceString(o['type'], 'door').toLowerCase()
      const type: LLMOpeningLabel['type'] =
        typeRaw === 'window' ? 'window' : typeRaw === 'archway' ? 'archway' : 'door'

      let position_along_wall = coerceNumber(o['position_along_wall'])
      if (!Number.isFinite(position_along_wall)) position_along_wall = 0.5
      position_along_wall = clamp(position_along_wall, 0, 1)

      let width_m = coerceNumber(o['width_m'])
      if (!Number.isFinite(width_m) || width_m <= 0) width_m = 0.9
      let height_m = coerceNumber(o['height_m'])
      if (!Number.isFinite(height_m) || height_m <= 0) height_m = 2.1

      const swingRaw = typeof o['swing'] === 'string' ? o['swing'].trim().toLowerCase() : null
      const swing =
        swingRaw === 'inward_left' || swingRaw === 'inward_right' ||
        swingRaw === 'outward_left' || swingRaw === 'outward_right'
          ? swingRaw
          : null

      const sillRaw = coerceNumber(o['sill_height_m'])
      const sill_height_m = Number.isFinite(sillRaw) ? sillRaw : null

      return {
        region_id, type, wall, position_along_wall, width_m, height_m, swing, sill_height_m,
        confidence: normalizeConfidence(o['confidence']),
      }
    })
    .filter((o): o is LLMOpeningLabel => o !== null)

  const rawPW = coerceNumber(parsed['plan_width_m'])
  const rawPH = coerceNumber(parsed['plan_height_m'])
  const rawAreaM2 = coerceNumber(parsed['total_area_m2'])
  const rawAreaSqft = coerceNumber(parsed['total_area_sqft'])
  const plan_width_m = Number.isFinite(rawPW) && rawPW > 0 ? rawPW : null
  const plan_height_m = Number.isFinite(rawPH) && rawPH > 0 ? rawPH : null
  const total_area_m2 =
    Number.isFinite(rawAreaM2) && rawAreaM2 > 0
      ? rawAreaM2
      : Number.isFinite(rawAreaSqft) && rawAreaSqft > 0
        ? rawAreaSqft * 0.09290304
        : null

  return { floor_name, plan_width_m, plan_height_m, total_area_m2, rooms, openings }
}

// ---------------------------------------------------------------------------
// Merge CV regions with LLM semantic labels → AILayoutDraft
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function robustScaleEstimate(samples: Array<{ scale: number; confidence: Confidence }>): {
  scale: number | null
  kept: number
  total: number
} {
  const finite = samples.filter((sample) => Number.isFinite(sample.scale) && sample.scale > 0)
  if (finite.length === 0) return { scale: null, kept: 0, total: 0 }

  const highConfidence = finite.filter((sample) => sample.confidence === 'high')
  const preferred = highConfidence.length >= 2 ? highConfidence : finite.filter((sample) => sample.confidence !== 'low')
  const usable = preferred.length > 0 ? preferred : finite
  const center = median(usable.map((sample) => sample.scale))
  const filtered = usable.filter((sample) => {
    const ratio = Math.max(sample.scale, center) / Math.min(sample.scale, center)
    return ratio <= 1.35
  })
  const finalSamples = filtered.length >= 2 ? filtered : usable

  return {
    scale: median(finalSamples.map((sample) => sample.scale)),
    kept: finalSamples.length,
    total: finite.length,
  }
}

function chooseAxisExtent(
  axis: 'width' | 'height',
  pixelExtent: number,
  sampleScale: number | null,
  llmExtent: number | null,
  fallbackScale: number,
): { extent: number; source: string } {
  const sampleExtent = sampleScale !== null ? pixelExtent * sampleScale : null

  if (sampleExtent !== null) {
    if (llmExtent !== null) {
      const ratio = Math.max(sampleExtent, llmExtent) / Math.min(sampleExtent, llmExtent)
      if (ratio > 1.15) {
        console.log(
          `[walkaround/cv] Ignoring LLM plan_${axis}_m=${llmExtent.toFixed(3)}m; ` +
          `room dimension samples imply ${sampleExtent.toFixed(3)}m`,
        )
      }
    }
    return { extent: sampleExtent, source: 'room dimensions' }
  }

  if (llmExtent !== null) return { extent: llmExtent, source: 'LLM plan extent fallback' }
  return { extent: pixelExtent * fallbackScale, source: 'pixel fallback' }
}

function chooseCVPlanScale(
  cv: CVPipelineResult,
  llm: LLMSemanticOutput,
  planImageW: number,
  planImageH: number,
  xScale: number | null,
  yScale: number | null,
): {
  totalW: number
  totalH: number
  widthSource: string
  heightSource: string
} {
  const interiorAreaPx = cv.regions.reduce((sum, region) => sum + region.pixelArea, 0) * cv.downsampleScale ** 2
  const cropAreaPx = planImageW * planImageH
  const fillRatio = cropAreaPx > 0 ? interiorAreaPx / cropAreaPx : 0
  const areaScale =
    llm.total_area_m2 !== null && interiorAreaPx > 0
      ? Math.sqrt(llm.total_area_m2 / interiorAreaPx)
      : null

  if (areaScale !== null) {
    console.log(
      `[walkaround/cv] Scale from total_area_m2=${llm.total_area_m2!.toFixed(2)}m²: ` +
      `${areaScale.toFixed(4)} m/px (CV floor fill=${(fillRatio * 100).toFixed(0)}%)`,
    )

    if (xScale !== null && yScale !== null && llm.total_area_m2 !== null) {
      const sampledArea = xScale * yScale * interiorAreaPx
      console.log(
        `[walkaround/cv] Using printed area instead of room dimension scale: ` +
        `sampled floor area would be ${sampledArea.toFixed(1)}m² vs printed ${llm.total_area_m2.toFixed(1)}m²`,
      )
    }

    return {
      totalW: planImageW * areaScale,
      totalH: planImageH * areaScale,
      widthSource: 'printed area + CV floor mask',
      heightSource: 'printed area + CV floor mask',
    }
  }

  const fallbackScale = xScale ?? yScale ?? areaScale ?? 0.01
  const widthChoice = chooseAxisExtent('width', planImageW, xScale, llm.plan_width_m, fallbackScale)
  const heightChoice = chooseAxisExtent('height', planImageH, yScale, llm.plan_height_m, fallbackScale)

  return {
    totalW: widthChoice.extent,
    totalH: heightChoice.extent,
    widthSource: widthChoice.source,
    heightSource: heightChoice.source,
  }
}

export function mergeWithLLMLabels(
  cv: CVPipelineResult,
  llm: LLMSemanticOutput,
): AILayoutDraft {
  const { imageWidth: W, imageHeight: H, regions } = cv
  const sourceWallMask = resolveSourceWallMask({
    mask: cv.wallMask,
    width: cv.wallMaskWidth,
    height: cv.wallMaskHeight,
    sampleRadiusPx: cv.wallSampleRadiusPx,
  })
  const maskBounds = sourceWallMask.planBoundsPx
  const planImageBounds = {
    x0: (maskBounds.x0 / cv.wallMaskWidth) * W,
    y0: (maskBounds.y0 / cv.wallMaskHeight) * H,
    x1: (maskBounds.x1 / cv.wallMaskWidth) * W,
    y1: (maskBounds.y1 / cv.wallMaskHeight) * H,
  }
  const planImageW = Math.max(1, planImageBounds.x1 - planImageBounds.x0)
  const planImageH = Math.max(1, planImageBounds.y1 - planImageBounds.y0)
  console.log(
    `[walkaround/cv] Plan crop from wall mask: ` +
    `${Math.round(planImageBounds.x0)},${Math.round(planImageBounds.y0)} ` +
    `${Math.round(planImageW)}×${Math.round(planImageH)}px`,
  )

  // Build a lookup: region_id → LLMRoomLabel
  const labelMap = new Map<number, LLMRoomLabel>(llm.rooms.map((r) => [r.region_id, r]))

  // Compute pixel→meter scale from rooms that have usable labeled dimensions.
  // X (horizontal) and Y (vertical) scales are tracked separately to detect
  // anisotropic scans; a single global scale is only used if they agree.
  const xSamples: Array<{ scale: number; confidence: Confidence }> = []
  const ySamples: Array<{ scale: number; confidence: Confidence }> = []
  for (const region of regions) {
    const label = labelMap.get(region.id)
    if (!label) continue
    if (label.width_m > 0 && region.originalBBox.w > 0) {
      xSamples.push({ scale: label.width_m / region.originalBBox.w, confidence: label.confidence })
    }
    if (label.depth_m > 0 && region.originalBBox.h > 0) {
      ySamples.push({ scale: label.depth_m / region.originalBBox.h, confidence: label.confidence })
    }
  }

  const xEstimate = robustScaleEstimate(xSamples)
  const yEstimate = robustScaleEstimate(ySamples)
  const xScale = xEstimate.scale
  const yScale = yEstimate.scale
  console.log(
    `[walkaround/cv] Scale from room dimension samples: ` +
    `x=${xScale?.toFixed(4) ?? 'n/a'} m/px (${xEstimate.kept}/${xEstimate.total}), ` +
    `y=${yScale?.toFixed(4) ?? 'n/a'} m/px (${yEstimate.kept}/${yEstimate.total})`,
  )

  if (xScale !== null && yScale !== null) {
    const ratio = Math.max(xScale, yScale) / Math.min(xScale, yScale)
    if (ratio > 1.1) {
      console.log(
        `[walkaround/cv] Per-room X/Y scale differ by ${((ratio - 1) * 100).toFixed(0)}% ` +
        `— treating room-derived scale as diagnostic unless no better scale anchor exists`,
      )
    }
  }

  const scaleChoice = chooseCVPlanScale(cv, llm, planImageW, planImageH, xScale, yScale)
  const totalW = scaleChoice.totalW
  const totalH = scaleChoice.totalH
  console.log(
    `[walkaround/cv] Plan bounds: ${totalW.toFixed(2)}m × ${totalH.toFixed(2)}m ` +
    `(${scaleChoice.widthSource} width, ${scaleChoice.heightSource} height)`,
  )

  // Build AIRoomDraft for each detected region
  const rooms: AIRoomDraft[] = regions.map((region, i) => {
    const label = labelMap.get(region.id)
    const { x, y, w, h } = region.originalBBox

    const image_bbox: ImageBBox = {
      x0: clamp((x - planImageBounds.x0) / planImageW, 0, 1),
      y0: clamp((y - planImageBounds.y0) / planImageH, 0, 1),
      x1: clamp((x + w - planImageBounds.x0) / planImageW, 0, 1),
      y1: clamp((y + h - planImageBounds.y0) / planImageH, 0, 1),
    }

    // Convert the CV polygon from original pixel coordinates to metre coordinates.
    // Pixel origin: top-left, y downward.  Metre origin: bottom-left, y upward.
    // Coordinates are normalized through the detected structural-wall crop, not
    // the full image canvas, so margins and marketing text do not distort geometry.
    const polygon_m: Point[] | undefined = region.originalPolygon.length >= 4
      ? region.originalPolygon.map((pt) => ({
          x: clamp((pt.x - planImageBounds.x0) / planImageW, 0, 1) * totalW,
          y: (1 - clamp((pt.y - planImageBounds.y0) / planImageH, 0, 1)) * totalH,
        }))
      : undefined

    return {
      id: `room_${region.id}`,
      name: label?.name ?? `Room ${i + 1}`,
      image_bbox,
      polygon_m,
      floor_material: 'unknown',
      ceiling_height: 2.7,
      confidence: label?.confidence ?? 'low',
    }
  })

  // Build AIOpeningDraft for each LLM opening, referencing room_id by region_id
  const roomIds = new Set(rooms.map((r) => r.id))
  const openings: AIOpeningDraft[] = llm.openings
    .map((o, i): AIOpeningDraft | null => {
      const room_id = `room_${o.region_id}`
      if (!roomIds.has(room_id)) return null
      return {
        id: `opening_${i + 1}`,
        room_id,
        wall: o.wall,
        position_along_wall: o.position_along_wall,
        type: o.type,
        width: o.width_m,
        height: o.height_m,
        swing: o.swing,
        sill_height: o.sill_height_m,
        confidence: o.confidence,
      }
    })
    .filter((o): o is AIOpeningDraft => o !== null)

  return {
    meta: {
      unit: 'meters',
      floor_name: llm.floor_name,
      source_image: '',
      bounds: { width: totalW, height: totalH },
      ai_notes: null,
      schema_version: '1.0',
    },
    rooms,
    openings,
    wallMask: sourceWallMask,
    sourceImageCrop: planImageBounds,
  }
}
