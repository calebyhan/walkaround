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

/**
 * Find openings that belong to this wall.
 * An opening matches if its room_id is one of the wall's room_ids AND its wall direction
 * matches either the edge direction or its opposite (for interior shared walls).
 */
function matchOpenings(
  wallRoomIds: string[],
  edgeDirections: Direction[],
  openings: AIOpeningDraft[],
): Opening[] {
  return openings
    .filter(
      (o) =>
        wallRoomIds.includes(o.room_id) &&
        edgeDirections.some(
          (dir) => o.wall === dir || o.wall === oppositeDirection(dir),
        ),
    )
    .map((o): Opening => ({
      id: o.id,
      type: o.type,
      position_along_wall: o.position_along_wall,
      width: o.width,
      height: o.height,
      swing: o.swing as Opening['swing'],
      sill_height: o.sill_height,
      confidence: o.confidence,
    }))
}

let wallCounter = 0

function makeWall(
  roomIds: string[],
  vertices: Point[],
  isExterior: boolean,
  ceilingHeight: number,
  edgeDirections: Direction[],
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
    openings: matchOpenings(roomIds, edgeDirections, openings),
  }
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
): Wall[] {
  wallCounter = 0
  const walls: Wall[] = []

  // Snap nearby room edges to shared coordinates so adjacency detection is reliable
  const snappedRooms = snapRoomEdges(rooms, totalW, totalH)

  // Compute all edges for all rooms
  const allEdges = snappedRooms.flatMap((r) => computeRoomEdges(r, totalW, totalH))

  // Track which edges have been paired (index into allEdges)
  const paired = new Set<number>()

  // Find shared (interior) edges
  for (let i = 0; i < allEdges.length; i++) {
    if (paired.has(i)) continue
    const edgeA = allEdges[i]

    for (let j = i + 1; j < allEdges.length; j++) {
      if (paired.has(j)) continue
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
      walls.push(
        makeWall(
          [edgeA.roomId, edgeB.roomId],
          vertices,
          false,
          avgHeight,
          [edgeA.direction, edgeB.direction],
          openings,
        ),
      )

      paired.add(i)
      paired.add(j)
      break
    }
  }

  // Remaining unpaired edges → exterior walls
  for (let i = 0; i < allEdges.length; i++) {
    if (paired.has(i)) continue
    const edge = allEdges[i]
    const horiz = isHorizontal(edge.direction)
    const vertices = horiz
      ? horizontalWallVertices(edge.fixedCoord, edge.start, edge.end)
      : verticalWallVertices(edge.fixedCoord, edge.start, edge.end)

    walls.push(
      makeWall(
        [edge.roomId],
        vertices,
        true,
        edge.ceilingHeight,
        [edge.direction],
        openings,
      ),
    )
  }

  return walls
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

  const walls = generateWalls(draft.rooms, draft.openings, totalW, totalH)

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
    annotations: [],
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
  const plan_width_m = Number.isFinite(rawPW) && rawPW > 0 ? rawPW : null
  const plan_height_m = Number.isFinite(rawPH) && rawPH > 0 ? rawPH : null

  return { floor_name, plan_width_m, plan_height_m, rooms, openings }
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

export function mergeWithLLMLabels(
  cv: CVPipelineResult,
  llm: LLMSemanticOutput,
): AILayoutDraft {
  const { imageWidth: W, imageHeight: H, regions } = cv

  // Build a lookup: region_id → LLMRoomLabel
  const labelMap = new Map<number, LLMRoomLabel>(llm.rooms.map((r) => [r.region_id, r]))

  // Compute pixel→meter scale from rooms that have usable labeled dimensions.
  // X (horizontal) and Y (vertical) scales are tracked separately to detect
  // anisotropic scans; a single global scale is only used if they agree.
  const xScales: number[] = []
  const yScales: number[] = []
  for (const region of regions) {
    const label = labelMap.get(region.id)
    if (!label) continue
    if (label.width_m > 0 && region.originalBBox.w > 0) {
      xScales.push(label.width_m / region.originalBBox.w)
    }
    if (label.depth_m > 0 && region.originalBBox.h > 0) {
      yScales.push(label.depth_m / region.originalBBox.h)
    }
  }

  const xScale = xScales.length > 0 ? median(xScales) : null
  const yScale = yScales.length > 0 ? median(yScales) : null

  if (xScale !== null && yScale !== null) {
    const ratio = Math.max(xScale, yScale) / Math.min(xScale, yScale)
    if (ratio > 1.1) {
      console.log(
        `[walkaround/cv] Per-room X/Y scale differ by ${((ratio - 1) * 100).toFixed(0)}% ` +
        `— using plan_width_m/plan_height_m for correct anisotropic bounds`,
      )
    }
  }

  // Prefer plan-level dimensions (single reliable measurement) over per-room aggregation.
  // Per-room scale is noisy when grid cells partially overlap rooms.
  let globalScale: number
  if (llm.plan_width_m !== null) {
    globalScale = llm.plan_width_m / W
    console.log(
      `[walkaround/cv] Scale from plan_width_m=${llm.plan_width_m}m: ${globalScale.toFixed(4)} m/px`,
    )
  } else if (xScales.length > 0) {
    globalScale = xScale!
    console.log(
      `[walkaround/cv] Scale from x-samples (no plan_width_m): ${globalScale.toFixed(4)} m/px ` +
      `(${xScales.length} samples)`,
    )
  } else {
    const allScales = [...xScales, ...yScales]
    globalScale = allScales.length > 0 ? median(allScales) : 0.01
    console.log(
      `[walkaround/cv] Scale from per-room fallback: ${globalScale.toFixed(4)} m/px ` +
      `(${xScales.length} x-samples, ${yScales.length} y-samples)`,
    )
  }

  // Use plan-level dimensions directly when available for accurate anisotropic scaling.
  // Y-scale may differ from X-scale when the image has non-square pixel-per-meter density.
  const totalW = llm.plan_width_m ?? W * globalScale
  const totalH = llm.plan_height_m ?? H * globalScale
  console.log(
    `[walkaround/cv] Plan bounds: ${totalW.toFixed(2)}m × ${totalH.toFixed(2)}m ` +
    `(${llm.plan_width_m !== null ? 'LLM' : 'CV'} width, ${llm.plan_height_m !== null ? 'LLM' : 'CV'} height)`,
  )

  // Build AIRoomDraft for each detected region
  const rooms: AIRoomDraft[] = regions.map((region, i) => {
    const label = labelMap.get(region.id)
    const { x, y, w, h } = region.originalBBox

    const image_bbox: ImageBBox = {
      x0: x / W,
      y0: y / H,
      x1: (x + w) / W,
      y1: (y + h) / H,
    }

    // Convert the CV polygon from original pixel coordinates to metre coordinates.
    // Pixel origin: top-left, y downward.  Metre origin: bottom-left, y upward.
    //   x_m = (x_px / imageWidth)  * totalW
    //   y_m = (1 - y_px / imageHeight) * totalH
    const polygon_m: Point[] | undefined = region.originalPolygon.length >= 4
      ? region.originalPolygon.map((pt) => ({
          x: (pt.x / W) * totalW,
          y: (1 - pt.y / H) * totalH,
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
  }
}
