import type { FloorPlanSchema, Issue, Opening, Point, Wall } from '@/lib/schema'

export interface AutoFix {
  type: string
  description: string
  affected_ids: string[]
}

export interface ValidationResult {
  schema: FloorPlanSchema
  autoFixLog: AutoFix[]
}

const CONNECT_EPSILON = 0.05
const NEAR_MISS_EPSILON = 0.02
const BOUNDS_TOLERANCE = 1

export function runValidation(input: FloorPlanSchema): ValidationResult {
  const schema = structuredClone(input)
  const issues: Issue[] = []
  const autoFixLog: AutoFix[] = []

  const pushIssue = (
    severity: Issue['severity'],
    code: string,
    message: string,
    elementIds: string[],
  ) => {
    issues.push({
      id: `issue_${issues.length + 1}`,
      severity,
      code,
      message,
      element_ids: elementIds,
    })
  }

  if (schema.meta.bounds.width <= 0 || schema.meta.bounds.height <= 0) {
    pushIssue('error', 'invalid_bounds', 'Floor plan bounds must be positive numbers.', [])
  }

  if (schema.meta.bounds.width * schema.meta.bounds.height > 1000) {
    pushIssue(
      'error',
      'implausibly_large_floorplan',
      'Floor plan bounds exceed 1000m2; this is likely a scale or unit-conversion error.',
      [],
    )
  }

  validateRooms(schema, pushIssue)

  const roomIds = new Set(schema.rooms.map((room) => room.id))
  schema.walls.forEach((wall) => {
    validateWallBasics(wall, roomIds, pushIssue)
    validateWallOpenings(wall, pushIssue, autoFixLog)
  })

  validateOpeningOverlaps(schema.walls, pushIssue)
  validateRoomWallLinks(schema, pushIssue)
  validateWallTopology(schema.walls, pushIssue)
  validateRoomBounds(schema, pushIssue)
  validateWallBounds(schema, pushIssue, autoFixLog)

  if (schema.rooms.length > 0 && schema.walls.length === 0) {
    pushIssue('error', 'missing_walls', 'Floor plan includes rooms but has no walls.', schema.rooms.map((room) => room.id))
  }

  if (schema.rooms.length === 1) {
    pushIssue('info', 'single_room_floor_plan', 'Floor plan contains a single room; verify that segmentation did not miss adjacent rooms.', [schema.rooms[0].id])
  }

  schema.issues = issues
  return { schema, autoFixLog }
}

function validateRooms(
  schema: FloorPlanSchema,
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
): void {
  schema.rooms.forEach((room) => {
    if (room.vertices.length < 3) {
      pushIssue('error', 'invalid_room_vertices', `Room ${room.id} needs at least 3 vertices.`, [room.id])
    }

    room.vertices.forEach((point, idx) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        pushIssue(
          'error',
          'non_finite_room_vertex',
          `Room ${room.id} has a non-finite vertex at index ${idx}.`,
          [room.id],
        )
      }
    })

    const area = Math.abs(polygonArea(room.vertices))
    if (area > 0 && area < 1) {
      pushIssue('warning', 'implausibly_small_room', `Room ${room.id} area is below 1m2.`, [room.id])
    }

    if (room.ceiling_height < 2 || room.ceiling_height > 5) {
      pushIssue(
        'warning',
        'ceiling_height_out_of_range',
        `Room ${room.id} ceiling height is outside the expected 2.0m-5.0m range.`,
        [room.id],
      )
    }
  })

  for (let i = 0; i < schema.rooms.length; i++) {
    if (schema.rooms[i].vertices.length < 3) continue
    for (let j = i + 1; j < schema.rooms.length; j++) {
      if (schema.rooms[j].vertices.length < 3) continue
      const overlapRatio = roomBboxOverlapRatio(schema.rooms[i].vertices, schema.rooms[j].vertices)
      if (overlapRatio > 0.8) {
        pushIssue(
          'error',
          'overlapping_rooms',
          `Rooms ${schema.rooms[i].id} and ${schema.rooms[j].id} substantially overlap.`,
          [schema.rooms[i].id, schema.rooms[j].id],
        )
      }
    }
  }
}

function validateWallBasics(
  wall: Wall,
  roomIds: Set<string>,
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
): void {
  if (wall.vertices.length < 2) {
    pushIssue('error', 'invalid_wall_vertices', `Wall ${wall.id} needs at least 2 vertices.`, [wall.id])
  }

  wall.vertices.forEach((point, idx) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      pushIssue(
        'error',
        'non_finite_wall_vertex',
        `Wall ${wall.id} has a non-finite vertex at index ${idx}.`,
        [wall.id],
      )
    }
  })

  if (polylineLength(wall.vertices) <= CONNECT_EPSILON) {
    pushIssue('error', 'zero_length_wall', `Wall ${wall.id} has zero or near-zero length.`, [wall.id])
  }

  if (wall.thickness <= 0) {
    pushIssue('error', 'invalid_wall_thickness', `Wall ${wall.id} has non-positive thickness.`, [wall.id])
  }

  if (wall.height <= 0) {
    pushIssue('error', 'invalid_wall_height', `Wall ${wall.id} has non-positive height.`, [wall.id])
  }

  if (wall.room_ids.length === 0) {
    pushIssue('warning', 'wall_without_room', `Wall ${wall.id} is not linked to any room.`, [wall.id])
  }

  wall.room_ids.forEach((roomId) => {
    if (!roomIds.has(roomId)) {
      pushIssue(
        'error',
        'wall_references_missing_room',
        `Wall ${wall.id} references missing room ${roomId}.`,
        [wall.id, roomId],
      )
    }
  })
}

function validateWallOpenings(
  wall: Wall,
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
  autoFixLog: AutoFix[],
): void {
  const length = polylineLength(wall.vertices)

  wall.openings.forEach((opening) => {
    if (opening.width <= 0 || opening.height <= 0) {
      pushIssue(
        'error',
        'invalid_opening_dimensions',
        `Opening ${opening.id} has non-positive dimensions.`,
        [wall.id, opening.id],
      )
      return
    }

    if (opening.width > length) {
      pushIssue(
        'error',
        'opening_wider_than_wall',
        `Opening ${opening.id} is wider than parent wall ${wall.id}.`,
        [wall.id, opening.id],
      )
    }

    if (opening.height > wall.height) {
      pushIssue(
        'error',
        'opening_taller_than_wall',
        `Opening ${opening.id} is taller than parent wall ${wall.id}.`,
        [wall.id, opening.id],
      )
    }

    const sillHeight = opening.type === 'window' ? opening.sill_height ?? 0.9 : 0
    if (sillHeight + opening.height > wall.height) {
      pushIssue(
        'warning',
        'opening_exceeds_wall_height',
        `Opening ${opening.id} extends above parent wall ${wall.id}.`,
        [wall.id, opening.id],
      )
    }

    if (opening.position_along_wall < 0 || opening.position_along_wall > 1) {
      const clamped = clamp(opening.position_along_wall, 0, 1)
      autoFixLog.push({
        type: 'clamp_opening_position',
        description: `Clamped ${opening.id} position_along_wall from ${opening.position_along_wall.toFixed(3)} to ${clamped.toFixed(3)}.`,
        affected_ids: [wall.id, opening.id],
      })
      opening.position_along_wall = clamped
    }

    if (opening.width <= length && length > 0) {
      const half = opening.width / (2 * length)
      const clamped = clamp(opening.position_along_wall, half, 1 - half)
      if (Math.abs(clamped - opening.position_along_wall) > 1e-6) {
        autoFixLog.push({
          type: 'clamp_opening_position',
          description: `Clamped ${opening.id} so its full width stays inside wall ${wall.id}.`,
          affected_ids: [wall.id, opening.id],
        })
        pushIssue(
          'warning',
          'opening_out_of_bounds',
          `Opening ${opening.id} on ${wall.id} was clamped to fit inside the wall.`,
          [wall.id, opening.id],
        )
        opening.position_along_wall = clamped
      }
    }
  })
}

function validateOpeningOverlaps(
  walls: Wall[],
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
): void {
  walls.forEach((wall) => {
    const length = polylineLength(wall.vertices)
    const intervals = wall.openings
      .map((opening) => ({ opening, ...openingInterval(opening, length) }))
      .sort((a, b) => a.start - b.start)

    for (let i = 1; i < intervals.length; i++) {
      const previous = intervals[i - 1]
      const current = intervals[i]
      if (current.start < previous.end - CONNECT_EPSILON) {
        pushIssue(
          'error',
          'overlapping_openings',
          `Openings ${previous.opening.id} and ${current.opening.id} overlap on ${wall.id}.`,
          [wall.id, previous.opening.id, current.opening.id],
        )
      }
    }
  })
}

function validateRoomWallLinks(
  schema: FloorPlanSchema,
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
): void {
  schema.rooms.forEach((room) => {
    const adjacentWalls = schema.walls.filter((wall) => wall.room_ids.includes(room.id))
    if (adjacentWalls.length === 0) {
      pushIssue('error', 'room_no_adjacent_walls', `Room ${room.id} has no associated walls.`, [room.id])
    }

    const hasDoorOrArch = adjacentWalls.some((wall) =>
      wall.openings.some((opening) => opening.type === 'door' || opening.type === 'archway'),
    )
    if (!hasDoorOrArch && schema.rooms.length > 1) {
      pushIssue('warning', 'sealed_room', `Room ${room.id} has no door or archway opening.`, [room.id])
    }
  })
}

function validateWallTopology(
  walls: Wall[],
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
): void {
  const endpoints = walls.flatMap((wall) => [
    ...(wall.vertices.length >= 2
      ? [
          { wall, point: wall.vertices[0] },
          { wall, point: wall.vertices[wall.vertices.length - 1] },
        ]
      : []),
  ])

  endpoints.forEach(({ wall, point }) => {
    const connected = walls.some((other) => {
      if (other.id === wall.id) return false
      return wallSegments(other).some((segment) =>
        pointToSegmentDistance(point, segment.a, segment.b) <= CONNECT_EPSILON,
      )
    })
    if (!connected && walls.length > 1) {
      pushIssue('error', 'disconnected_wall_endpoint', `Wall ${wall.id} has an endpoint not connected to another wall.`, [wall.id])
    }
  })

  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const a = endpoints[i]
      const b = endpoints[j]
      if (a.wall.id === b.wall.id) continue
      const distance = pointDistance(a.point, b.point)
      if (distance > 1e-6 && distance <= NEAR_MISS_EPSILON) {
        pushIssue('warning', 'near_miss_vertices', `Walls ${a.wall.id} and ${b.wall.id} have endpoints within 2cm but not snapped.`, [a.wall.id, b.wall.id])
      }
    }
  }

  const segments = walls.flatMap((wall) =>
    wallSegments(wall).map((segment) => ({ wall, ...segment })),
  )
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i]
      const b = segments[j]
      if (a.wall.id === b.wall.id) continue
      if (properSegmentIntersection(a.a, a.b, b.a, b.b)) {
        pushIssue('warning', 'intersecting_walls_no_vertex', `Walls ${a.wall.id} and ${b.wall.id} cross without a shared vertex.`, [a.wall.id, b.wall.id])
      }
    }
  }
}

function validateRoomBounds(
  schema: FloorPlanSchema,
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
): void {
  const { width, height } = schema.meta.bounds
  schema.rooms.forEach((room) => {
    const centroid = polygonCentroid(room.vertices)
    if (centroid.x < -BOUNDS_TOLERANCE || centroid.x > width + BOUNDS_TOLERANCE || centroid.y < -BOUNDS_TOLERANCE || centroid.y > height + BOUNDS_TOLERANCE) {
      pushIssue(
        'error',
        'room_out_of_bounds',
        `Room ${room.id} centroid is outside floor plan bounds.`,
        [room.id],
      )
    }
  })
}

function validateWallBounds(
  schema: FloorPlanSchema,
  pushIssue: (severity: Issue['severity'], code: string, message: string, elementIds: string[]) => void,
  autoFixLog: AutoFix[],
): void {
  const { width, height } = schema.meta.bounds

  schema.walls.forEach((wall) => {
    wall.vertices.forEach((point, idx) => {
      const outsideX = point.x < 0 ? -point.x : point.x > width ? point.x - width : 0
      const outsideY = point.y < 0 ? -point.y : point.y > height ? point.y - height : 0

      if (outsideX > BOUNDS_TOLERANCE || outsideY > BOUNDS_TOLERANCE) {
        pushIssue(
          'error',
          'wall_vertex_out_of_bounds',
          `Wall ${wall.id} vertex[${idx}] (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) is far outside bounds (${width.toFixed(1)}x${height.toFixed(1)}).`,
          [wall.id],
        )
      } else if (outsideX > 0 || outsideY > 0) {
        const clamped = { x: clamp(point.x, 0, width), y: clamp(point.y, 0, height) }
        autoFixLog.push({
          type: 'clamp_wall_vertex',
          description: `Clamped wall ${wall.id} vertex[${idx}] from (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) to (${clamped.x.toFixed(2)}, ${clamped.y.toFixed(2)}).`,
          affected_ids: [wall.id],
        })
        point.x = clamped.x
        point.y = clamped.y
      }
    })
  })
}

function polylineLength(points: Point[]): number {
  let length = 0
  for (let i = 0; i < points.length - 1; i++) {
    length += pointDistance(points[i], points[i + 1])
  }
  return length
}

function polygonArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function polygonCentroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

function roomBboxOverlapRatio(a: Point[], b: Point[]): number {
  const bboxA = bbox(a)
  const bboxB = bbox(b)
  const overlapW = Math.max(0, Math.min(bboxA.maxX, bboxB.maxX) - Math.max(bboxA.minX, bboxB.minX))
  const overlapH = Math.max(0, Math.min(bboxA.maxY, bboxB.maxY) - Math.max(bboxA.minY, bboxB.minY))
  const overlapArea = overlapW * overlapH
  const smallerArea = Math.min((bboxA.maxX - bboxA.minX) * (bboxA.maxY - bboxA.minY), (bboxB.maxX - bboxB.minX) * (bboxB.maxY - bboxB.minY))
  return smallerArea > 0 ? overlapArea / smallerArea : 0
}

function bbox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

function openingInterval(opening: Opening, wallLength: number): { start: number; end: number } {
  const center = opening.position_along_wall * wallLength
  return {
    start: center - opening.width / 2,
    end: center + opening.width / 2,
  }
}

function wallSegments(wall: Wall): Array<{ a: Point; b: Point }> {
  const segments: Array<{ a: Point; b: Point }> = []
  for (let i = 0; i < wall.vertices.length - 1; i++) {
    segments.push({ a: wall.vertices[i], b: wall.vertices[i + 1] })
  }
  return segments
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointToSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return pointDistance(point, a)
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq, 0, 1)
  return pointDistance(point, { x: a.x + dx * t, y: a.y + dy * t })
}

function properSegmentIntersection(a: Point, b: Point, c: Point, d: Point): boolean {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(denominator) < 1e-9) return false

  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator
  return t > CONNECT_EPSILON && t < 1 - CONNECT_EPSILON && u > CONNECT_EPSILON && u < 1 - CONNECT_EPSILON
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
