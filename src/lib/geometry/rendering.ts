import * as THREE from 'three'
import type { Opening, Point, Room, Wall } from '@/lib/schema'

export interface WallRenderBox {
  id: string
  position: [number, number, number]
  rotationY: number
  size: [number, number, number]
  wallId: string
  isExterior: boolean
}

export interface WallAabb {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

interface WallSegment {
  p0: Point
  p1: Point
  length: number
  startDistance: number
  unitX: number
  unitY: number
  rotationY: number
}

interface OpeningSpan {
  opening: Opening
  start: number
  end: number
}

const MIN_RENDER_LENGTH = 0.01
const DOOR_COLLISION_HEIGHT = 1.5

export function buildRoomFloorGeometry(room: Room): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const first = room.vertices[0]
  shape.moveTo(first.x, first.y)

  for (const point of room.vertices.slice(1)) {
    shape.lineTo(point.x, point.y)
  }
  shape.closePath()

  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(Math.PI / 2)
  geometry.computeVertexNormals()
  return geometry
}

export function buildWallRenderBoxes(walls: Wall[]): WallRenderBox[] {
  return walls.flatMap((wall) => {
    const segments = buildWallSegments(wall)
    const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0)
    if (totalLength <= 0) return []

    return segments.flatMap((segment, segmentIndex) => {
      const spans = spansForSegment(wall.openings, segment, totalLength)
      return boxesForSegment(wall, segment, segmentIndex, spans)
    })
  })
}

export function buildWallCollisionAabbs(walls: Wall[]): WallAabb[] {
  return walls.flatMap((wall) => {
    const segments = buildWallSegments(wall)
    const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0)
    if (totalLength <= 0) return []

    return segments.flatMap((segment) => {
      const passableSpans = spansForSegment(wall.openings, segment, totalLength)
        .filter(({ opening }) => isPassableOpening(opening))
      const solidIntervals = subtractSpans(segment.length, passableSpans)

      return solidIntervals.map(([start, end]) =>
        aabbForWallInterval(segment, start, end, wall.thickness),
      )
    })
  })
}

function buildWallSegments(wall: Wall): WallSegment[] {
  const segments: WallSegment[] = []
  let startDistance = 0

  for (let i = 0; i < wall.vertices.length - 1; i++) {
    const p0 = wall.vertices[i]
    const p1 = wall.vertices[i + 1]
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const length = Math.hypot(dx, dy)
    if (length <= MIN_RENDER_LENGTH) continue

    segments.push({
      p0,
      p1,
      length,
      startDistance,
      unitX: dx / length,
      unitY: dy / length,
      rotationY: -Math.atan2(dy, dx),
    })
    startDistance += length
  }

  return segments
}

function spansForSegment(
  openings: Opening[],
  segment: WallSegment,
  totalLength: number,
): OpeningSpan[] {
  return openings
    .map((opening) => {
      const center = opening.position_along_wall * totalLength
      const start = center - opening.width / 2
      const end = center + opening.width / 2
      const segmentStart = segment.startDistance
      const segmentEnd = segment.startDistance + segment.length
      const clippedStart = Math.max(0, start - segmentStart)
      const clippedEnd = Math.min(segment.length, end - segmentStart)

      if (end <= segmentStart || start >= segmentEnd || clippedEnd - clippedStart <= MIN_RENDER_LENGTH) {
        return null
      }

      return {
        opening,
        start: clippedStart,
        end: clippedEnd,
      }
    })
    .filter((span): span is OpeningSpan => span !== null)
    .sort((a, b) => a.start - b.start)
}

function boxesForSegment(
  wall: Wall,
  segment: WallSegment,
  segmentIndex: number,
  spans: OpeningSpan[],
): WallRenderBox[] {
  const boxes: WallRenderBox[] = []
  const solidIntervals = subtractSpans(segment.length, spans)

  solidIntervals.forEach(([start, end], intervalIndex) => {
    boxes.push(
      makeWallBox(
        `${wall.id}-seg-${segmentIndex}-solid-${intervalIndex}`,
        wall,
        segment,
        start,
        end,
        0,
        wall.height,
      ),
    )
  })

  spans.forEach((span, spanIndex) => {
    const bottom = openingBottom(span.opening)
    const top = Math.min(wall.height, bottom + span.opening.height)

    if (bottom > MIN_RENDER_LENGTH) {
      boxes.push(
        makeWallBox(
          `${wall.id}-seg-${segmentIndex}-opening-${spanIndex}-below`,
          wall,
          segment,
          span.start,
          span.end,
          0,
          bottom,
        ),
      )
    }

    if (top < wall.height - MIN_RENDER_LENGTH) {
      boxes.push(
        makeWallBox(
          `${wall.id}-seg-${segmentIndex}-opening-${spanIndex}-above`,
          wall,
          segment,
          span.start,
          span.end,
          top,
          wall.height,
        ),
      )
    }
  })

  return boxes
}

function subtractSpans(length: number, spans: Array<{ start: number; end: number }>): Array<[number, number]> {
  const intervals: Array<[number, number]> = []
  let cursor = 0

  for (const span of mergeSpans(spans, length)) {
    if (span.start - cursor > MIN_RENDER_LENGTH) {
      intervals.push([cursor, span.start])
    }
    cursor = Math.max(cursor, span.end)
  }

  if (length - cursor > MIN_RENDER_LENGTH) {
    intervals.push([cursor, length])
  }

  return intervals
}

function mergeSpans(spans: Array<{ start: number; end: number }>, length: number): Array<{ start: number; end: number }> {
  const sorted = spans
    .map((span) => ({
      start: clamp(span.start, 0, length),
      end: clamp(span.end, 0, length),
    }))
    .filter((span) => span.end - span.start > MIN_RENDER_LENGTH)
    .sort((a, b) => a.start - b.start)

  const merged: Array<{ start: number; end: number }> = []
  for (const span of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || span.start > previous.end) {
      merged.push({ ...span })
    } else {
      previous.end = Math.max(previous.end, span.end)
    }
  }
  return merged
}

function makeWallBox(
  id: string,
  wall: Wall,
  segment: WallSegment,
  start: number,
  end: number,
  bottom: number,
  top: number,
): WallRenderBox {
  const length = end - start
  const centerAlongSegment = (start + end) / 2
  const centerX = segment.p0.x + segment.unitX * centerAlongSegment
  const centerZ = segment.p0.y + segment.unitY * centerAlongSegment
  const height = top - bottom

  return {
    id,
    wallId: wall.id,
    isExterior: wall.is_exterior,
    position: [centerX, bottom + height / 2, centerZ],
    rotationY: segment.rotationY,
    size: [length, height, wall.thickness],
  }
}

function aabbForWallInterval(
  segment: WallSegment,
  start: number,
  end: number,
  thickness: number,
): WallAabb {
  const nx = -segment.unitY
  const nz = segment.unitX
  const halfThickness = thickness / 2
  const startX = segment.p0.x + segment.unitX * start
  const startZ = segment.p0.y + segment.unitY * start
  const endX = segment.p0.x + segment.unitX * end
  const endZ = segment.p0.y + segment.unitY * end

  const corners = [
    [startX + nx * halfThickness, startZ + nz * halfThickness],
    [startX - nx * halfThickness, startZ - nz * halfThickness],
    [endX + nx * halfThickness, endZ + nz * halfThickness],
    [endX - nx * halfThickness, endZ - nz * halfThickness],
  ]

  return {
    minX: Math.min(...corners.map(([x]) => x)),
    maxX: Math.max(...corners.map(([x]) => x)),
    minZ: Math.min(...corners.map(([, z]) => z)),
    maxZ: Math.max(...corners.map(([, z]) => z)),
  }
}

function openingBottom(opening: Opening): number {
  if (opening.type === 'window') {
    return opening.sill_height ?? 0.9
  }
  return 0
}

function isPassableOpening(opening: Opening): boolean {
  return (
    opening.type !== 'window' &&
    openingBottom(opening) <= 0.1 &&
    opening.height >= DOOR_COLLISION_HEIGHT
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
