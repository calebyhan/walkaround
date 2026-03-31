import type { FloorPlanSchema } from '@/lib/schema'

export type ParseError = {
  type: 'malformed_json' | 'schema_mismatch'
  raw: string
  detail: string
}

export class GeminiParseError extends Error {
  readonly parseError: ParseError

  constructor(parseError: ParseError) {
    super(parseError.detail)
    this.name = 'GeminiParseError'
    this.parseError = parseError
  }
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) {
    throw new Error(detail)
  }
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

function tryParseJson(text: string):
  | { ok: true; value: unknown }
  | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'JSON.parse failed',
    }
  }
}

function repairMalformedJson(text: string): string {
  let repaired = text

  // Normalize typographic quotes that occasionally appear in model output.
  repaired = repaired
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')

  // Remove trailing commas before object/array closes.
  repaired = repaired.replace(/,\s*([}\]])/g, '$1')

  // Add likely-missing commas between adjacent JSON structures.
  repaired = repaired
    .replace(/}\s*{/g, '},{')
    .replace(/]\s*\[/g, '],[')
    .replace(/}\s*"/g, '},"')
    .replace(/]\s*"/g, '],"')

  return repaired
}

function validatePoint(value: unknown, path: string): void {
  assert(isRecord(value), `${path} must be an object`)
  assert(isFiniteNumber(value['x']), `${path}.x must be a finite number`)
  assert(isFiniteNumber(value['y']), `${path}.y must be a finite number`)
}

function validateConfidence(value: unknown, path: string): void {
  assert(
    value === 'high' || value === 'medium' || value === 'low',
    `${path} must be "high", "medium", or "low"`,
  )
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  if (typeof value !== 'string') return 'medium'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized
  }
  return 'medium'
}

function coerceString(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : fallback
  }
  if (value === null || value === undefined) return fallback
  const stringified = String(value).trim()
  return stringified.length > 0 ? stringified : fallback
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function normalizePointArrayInPlace(value: unknown): void {
  if (!Array.isArray(value)) return
  value.forEach((point, index) => {
    if (!isRecord(point)) {
      value[index] = { x: 0, y: 0 }
      return
    }
    point['x'] = coerceNumber(point['x'])
    point['y'] = coerceNumber(point['y'])
  })
}

function normalizeRoomsInPlace(obj: Record<string, unknown>): void {
  if (!Array.isArray(obj['rooms'])) {
    obj['rooms'] = []
    return
  }

  obj['rooms'].forEach((room, index) => {
    if (!isRecord(room)) {
      obj['rooms'][index] = {
        id: `room_${index + 1}`,
        name: `Room ${index + 1}`,
        vertices: [],
        floor_material: 'unknown',
        ceiling_height: 2.4,
        confidence: 'medium',
      }
      return
    }

    room['id'] = coerceString(room['id'], `room_${index + 1}`)
    room['name'] = coerceString(room['name'], `Room ${index + 1}`)
    room['floor_material'] = coerceString(room['floor_material'], 'unknown')
    room['ceiling_height'] = coerceNumber(room['ceiling_height'])
    if (!Number.isFinite(room['ceiling_height']) || room['ceiling_height'] <= 0) {
      room['ceiling_height'] = 2.4
    }
    room['confidence'] = normalizeConfidence(room['confidence'])

    if (!Array.isArray(room['vertices'])) {
      room['vertices'] = []
    }
    normalizePointArrayInPlace(room['vertices'])
  })
}

function normalizeOpeningsInPlace(wall: Record<string, unknown>): void {
  if (!Array.isArray(wall['openings'])) {
    wall['openings'] = []
    return
  }

  wall['openings'].forEach((opening, index) => {
    if (!isRecord(opening)) {
      wall['openings'][index] = {
        id: `opening_${index + 1}`,
        type: 'door',
        position_along_wall: 0.5,
        width: 0.9,
        height: 2.1,
        swing: null,
        sill_height: null,
        confidence: 'medium',
      }
      return
    }

    opening['id'] = coerceString(opening['id'], `opening_${index + 1}`)

    const openingType = coerceString(opening['type'], 'door').toLowerCase()
    if (openingType === 'door' || openingType === 'window' || openingType === 'archway') {
      opening['type'] = openingType
    } else {
      opening['type'] = 'door'
    }

    opening['position_along_wall'] = coerceNumber(opening['position_along_wall'])
    if (!Number.isFinite(opening['position_along_wall'])) opening['position_along_wall'] = 0.5

    opening['width'] = coerceNumber(opening['width'])
    if (!Number.isFinite(opening['width']) || opening['width'] <= 0) opening['width'] = 0.9

    opening['height'] = coerceNumber(opening['height'])
    if (!Number.isFinite(opening['height']) || opening['height'] <= 0) opening['height'] = 2.1

    const swing = typeof opening['swing'] === 'string' ? opening['swing'].trim().toLowerCase() : opening['swing']
    if (
      swing === 'inward_left' ||
      swing === 'inward_right' ||
      swing === 'outward_left' ||
      swing === 'outward_right'
    ) {
      opening['swing'] = swing
    } else {
      opening['swing'] = null
    }

    const sillHeight = coerceNumber(opening['sill_height'])
    opening['sill_height'] = Number.isFinite(sillHeight) ? sillHeight : null
    opening['confidence'] = normalizeConfidence(opening['confidence'])
  })
}

function normalizeWallsInPlace(obj: Record<string, unknown>): void {
  if (!Array.isArray(obj['walls'])) {
    obj['walls'] = []
    return
  }

  obj['walls'].forEach((wall, index) => {
    if (!isRecord(wall)) {
      obj['walls'][index] = {
        id: `wall_${index + 1}`,
        room_ids: [],
        vertices: [],
        thickness: 0.15,
        height: 2.4,
        material: 'plaster',
        is_exterior: false,
        confidence: 'medium',
        openings: [],
      }
      return
    }

    wall['id'] = coerceString(wall['id'], `wall_${index + 1}`)
    if (!Array.isArray(wall['room_ids'])) {
      wall['room_ids'] = []
    } else {
      wall['room_ids'] = wall['room_ids'].map((id, roomIdx) => coerceString(id, `room_${roomIdx + 1}`))
    }

    if (!Array.isArray(wall['vertices'])) {
      wall['vertices'] = []
    }
    normalizePointArrayInPlace(wall['vertices'])

    wall['thickness'] = coerceNumber(wall['thickness'])
    if (!Number.isFinite(wall['thickness']) || wall['thickness'] <= 0) wall['thickness'] = 0.15

    wall['height'] = coerceNumber(wall['height'])
    if (!Number.isFinite(wall['height']) || wall['height'] <= 0) wall['height'] = 2.4

    wall['material'] = coerceString(wall['material'], 'plaster')
    wall['is_exterior'] = coerceBoolean(wall['is_exterior'], false)
    wall['confidence'] = normalizeConfidence(wall['confidence'])
    normalizeOpeningsInPlace(wall)
  })
}

function normalizeFurnitureInPlace(obj: Record<string, unknown>): void {
  if (!Array.isArray(obj['furniture'])) {
    obj['furniture'] = []
    return
  }

  obj['furniture'].forEach((item, index) => {
    if (!isRecord(item)) {
      obj['furniture'][index] = {
        id: `furn_${index + 1}`,
        model_id: 'unknown',
        x: 0,
        y: 0,
        rotation_y: 0,
        room_id: '',
        label: 'Item',
      }
      return
    }

    item['id'] = coerceString(item['id'], `furn_${index + 1}`)
    item['model_id'] = coerceString(item['model_id'] ?? item['type'], 'unknown')

    if (!Number.isFinite(coerceNumber(item['x'])) || !Number.isFinite(coerceNumber(item['y']))) {
      if (Array.isArray(item['vertices'])) {
        normalizePointArrayInPlace(item['vertices'])
        const points = item['vertices'].filter(isRecord)
        if (points.length > 0) {
          const sumX = points.reduce((acc, point) => acc + coerceNumber(point['x']), 0)
          const sumY = points.reduce((acc, point) => acc + coerceNumber(point['y']), 0)
          item['x'] = sumX / points.length
          item['y'] = sumY / points.length
        }
      }
    }

    item['x'] = coerceNumber(item['x'])
    if (!Number.isFinite(item['x'])) item['x'] = 0
    item['y'] = coerceNumber(item['y'])
    if (!Number.isFinite(item['y'])) item['y'] = 0

    item['rotation_y'] = coerceNumber(item['rotation_y'])
    if (!Number.isFinite(item['rotation_y'])) item['rotation_y'] = 0

    item['room_id'] = coerceString(item['room_id'], '')
    item['label'] = coerceString(item['label'] ?? item['type'] ?? item['model_id'], 'Item')
  })
}

function normalizeCollectionsInPlace(obj: Record<string, unknown>): void {
  normalizeRoomsInPlace(obj)
  normalizeWallsInPlace(obj)
  normalizeFurnitureInPlace(obj)

  if (!Array.isArray(obj['structural'])) obj['structural'] = []
  if (!Array.isArray(obj['annotations'])) obj['annotations'] = []
  if (!Array.isArray(obj['issues'])) obj['issues'] = []
}

function validateFloorPlanSchema(obj: unknown): obj is FloorPlanSchema {
  assert(isRecord(obj), 'Top-level response must be an object')

  const meta = obj['meta']
  assert(isRecord(meta), 'meta must be an object')
  assert(meta['unit'] === 'meters', 'meta.unit must be "meters"')
  assert(typeof meta['floor_name'] === 'string', 'meta.floor_name must be a string')
  assert(typeof meta['source_image'] === 'string', 'meta.source_image must be a string')
  assert(isRecord(meta['bounds']), 'meta.bounds must be an object')
  assert(isFiniteNumber(meta['bounds']['width']), 'meta.bounds.width must be a finite number')
  assert(isFiniteNumber(meta['bounds']['height']), 'meta.bounds.height must be a finite number')
  assert(meta['bounds']['width'] > 0, 'meta.bounds.width must be > 0')
  assert(meta['bounds']['height'] > 0, 'meta.bounds.height must be > 0')
  assert(
    meta['ai_notes'] === null || typeof meta['ai_notes'] === 'string',
    'meta.ai_notes must be a string or null',
  )
  assert(typeof meta['schema_version'] === 'string', 'meta.schema_version must be a string')

  const rooms = obj['rooms']
  assert(Array.isArray(rooms), 'rooms must be an array')
  rooms.forEach((room, i) => {
    const path = `rooms[${i}]`
    assert(isRecord(room), `${path} must be an object`)
    assert(typeof room['id'] === 'string', `${path}.id must be a string`)
    assert(typeof room['name'] === 'string', `${path}.name must be a string`)
    assert(Array.isArray(room['vertices']), `${path}.vertices must be an array`)
    assert(room['vertices'].length >= 3, `${path}.vertices must have at least 3 points`)
    room['vertices'].forEach((p, j) => validatePoint(p, `${path}.vertices[${j}]`))
    assert(typeof room['floor_material'] === 'string', `${path}.floor_material must be a string`)
    assert(isFiniteNumber(room['ceiling_height']), `${path}.ceiling_height must be a finite number`)
    assert(room['ceiling_height'] > 0, `${path}.ceiling_height must be > 0`)
    validateConfidence(room['confidence'], `${path}.confidence`)
  })

  const walls = obj['walls']
  assert(Array.isArray(walls), 'walls must be an array')
  walls.forEach((wall, i) => {
    const path = `walls[${i}]`
    assert(isRecord(wall), `${path} must be an object`)
    assert(typeof wall['id'] === 'string', `${path}.id must be a string`)
    assert(Array.isArray(wall['room_ids']), `${path}.room_ids must be an array`)
    wall['room_ids'].forEach((id, j) => {
      assert(typeof id === 'string', `${path}.room_ids[${j}] must be a string`)
    })
    assert(Array.isArray(wall['vertices']), `${path}.vertices must be an array`)
    assert(wall['vertices'].length >= 2, `${path}.vertices must have at least 2 points`)
    wall['vertices'].forEach((p, j) => validatePoint(p, `${path}.vertices[${j}]`))
    assert(isFiniteNumber(wall['thickness']), `${path}.thickness must be a finite number`)
    assert(wall['thickness'] > 0, `${path}.thickness must be > 0`)
    assert(isFiniteNumber(wall['height']), `${path}.height must be a finite number`)
    assert(wall['height'] > 0, `${path}.height must be > 0`)
    assert(typeof wall['material'] === 'string', `${path}.material must be a string`)
    assert(typeof wall['is_exterior'] === 'boolean', `${path}.is_exterior must be a boolean`)
    validateConfidence(wall['confidence'], `${path}.confidence`)
    assert(Array.isArray(wall['openings']), `${path}.openings must be an array`)
    wall['openings'].forEach((opening, j) => {
      const openingPath = `${path}.openings[${j}]`
      assert(isRecord(opening), `${openingPath} must be an object`)
      assert(typeof opening['id'] === 'string', `${openingPath}.id must be a string`)
      assert(
        opening['type'] === 'door' || opening['type'] === 'window' || opening['type'] === 'archway',
        `${openingPath}.type must be "door", "window", or "archway"`,
      )
      assert(
        isFiniteNumber(opening['position_along_wall']),
        `${openingPath}.position_along_wall must be a finite number`,
      )
      assert(isFiniteNumber(opening['width']), `${openingPath}.width must be a finite number`)
      assert(opening['width'] > 0, `${openingPath}.width must be > 0`)
      assert(isFiniteNumber(opening['height']), `${openingPath}.height must be a finite number`)
      assert(opening['height'] > 0, `${openingPath}.height must be > 0`)
      assert(
        opening['swing'] === null ||
          opening['swing'] === 'inward_left' ||
          opening['swing'] === 'inward_right' ||
          opening['swing'] === 'outward_left' ||
          opening['swing'] === 'outward_right',
        `${openingPath}.swing is invalid`,
      )
      assert(
        opening['sill_height'] === null || isFiniteNumber(opening['sill_height']),
        `${openingPath}.sill_height must be a finite number or null`,
      )
      validateConfidence(opening['confidence'], `${openingPath}.confidence`)
    })
  })

  const structural = obj['structural']
  assert(Array.isArray(structural), 'structural must be an array')
  structural.forEach((element, i) => {
    const path = `structural[${i}]`
    assert(isRecord(element), `${path} must be an object`)
    assert(typeof element['id'] === 'string', `${path}.id must be a string`)
    assert(
      element['type'] === 'column' || element['type'] === 'stairs' || element['type'] === 'builtin',
      `${path}.type must be "column", "stairs", or "builtin"`,
    )
    assert(isFiniteNumber(element['x']), `${path}.x must be a finite number`)
    assert(isFiniteNumber(element['y']), `${path}.y must be a finite number`)
    assert(isFiniteNumber(element['width']), `${path}.width must be a finite number`)
    assert(isFiniteNumber(element['depth']), `${path}.depth must be a finite number`)
    assert(isFiniteNumber(element['height']), `${path}.height must be a finite number`)
    assert(
      element['note'] === null || typeof element['note'] === 'string',
      `${path}.note must be a string or null`,
    )
  })

  const furniture = obj['furniture']
  assert(Array.isArray(furniture), 'furniture must be an array')
  furniture.forEach((item, i) => {
    const path = `furniture[${i}]`
    assert(isRecord(item), `${path} must be an object`)
    assert(typeof item['id'] === 'string', `${path}.id must be a string`)
    assert(typeof item['model_id'] === 'string', `${path}.model_id must be a string`)
    assert(isFiniteNumber(item['x']), `${path}.x must be a finite number`)
    assert(isFiniteNumber(item['y']), `${path}.y must be a finite number`)
    assert(isFiniteNumber(item['rotation_y']), `${path}.rotation_y must be a finite number`)
    assert(typeof item['room_id'] === 'string', `${path}.room_id must be a string`)
    assert(typeof item['label'] === 'string', `${path}.label must be a string`)
  })

  assert(Array.isArray(obj['annotations']), 'annotations must be an array')

  const issues = obj['issues']
  assert(Array.isArray(issues), 'issues must be an array')
  issues.forEach((issue, i) => {
    const path = `issues[${i}]`
    assert(isRecord(issue), `${path} must be an object`)
    assert(typeof issue['id'] === 'string', `${path}.id must be a string`)
    assert(
      issue['severity'] === 'error' || issue['severity'] === 'warning' || issue['severity'] === 'info',
      `${path}.severity must be "error", "warning", or "info"`,
    )
    assert(typeof issue['code'] === 'string', `${path}.code must be a string`)
    assert(typeof issue['message'] === 'string', `${path}.message must be a string`)
    assert(Array.isArray(issue['element_ids']), `${path}.element_ids must be an array`)
    issue['element_ids'].forEach((id, j) => {
      assert(typeof id === 'string', `${path}.element_ids[${j}] must be a string`)
    })
  })

  return true
}

function parseUnitScale(unit: unknown): { normalizedUnit: 'meters'; scale: number; sourceUnit: string | null } {
  if (typeof unit !== 'string' || unit.trim().length === 0) {
    return { normalizedUnit: 'meters', scale: 1, sourceUnit: null }
  }

  const normalized = unit.trim().toLowerCase()

  if (normalized === 'meters' || normalized === 'meter' || normalized === 'metres' || normalized === 'metre' || normalized === 'm') {
    return { normalizedUnit: 'meters', scale: 1, sourceUnit: unit }
  }

  if (normalized === 'feet' || normalized === 'foot' || normalized === 'ft') {
    return { normalizedUnit: 'meters', scale: 0.3048, sourceUnit: unit }
  }

  if (normalized === 'inches' || normalized === 'inch' || normalized === 'in') {
    return { normalizedUnit: 'meters', scale: 0.0254, sourceUnit: unit }
  }

  return { normalizedUnit: 'meters', scale: 1, sourceUnit: unit }
}

function scaleValue(value: unknown, scale: number): number {
  const numeric = coerceNumber(value)
  if (!Number.isFinite(numeric)) return Number.NaN
  return numeric * scale
}

function coerceNumber(value: unknown): number {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NaN
}

function normalizeMetaFieldsInPlace(meta: Record<string, unknown>): void {
  if (typeof meta['floor_name'] !== 'string' || meta['floor_name'].trim().length === 0) {
    if (meta['floor_name'] === null || meta['floor_name'] === undefined) {
      meta['floor_name'] = 'Ground Floor'
    } else {
      meta['floor_name'] = String(meta['floor_name'])
    }
  }

  if (typeof meta['source_image'] !== 'string') {
    meta['source_image'] = meta['source_image'] == null ? '' : String(meta['source_image'])
  }

  if (typeof meta['schema_version'] !== 'string' || meta['schema_version'].trim().length === 0) {
    meta['schema_version'] = '1.0'
  }

  if (meta['ai_notes'] !== null && typeof meta['ai_notes'] !== 'string') {
    meta['ai_notes'] = String(meta['ai_notes'])
  }
}

function parseDimensionPair(value: unknown): [number, number] | null {
  if (typeof value !== 'string') return null
  const matches = value.match(/-?\d+(?:\.\d+)?/g)
  if (!matches || matches.length < 2) return null

  const a = Number.parseFloat(matches[0])
  const b = Number.parseFloat(matches[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return [a, b]
}

function inferBoundsFromGeometry(obj: Record<string, unknown>): { width: number; height: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const includePoint = (point: unknown) => {
    if (!isRecord(point)) return
    const x = coerceNumber(point['x'])
    const y = coerceNumber(point['y'])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  if (Array.isArray(obj['rooms'])) {
    obj['rooms'].forEach((room) => {
      if (!isRecord(room) || !Array.isArray(room['vertices'])) return
      room['vertices'].forEach(includePoint)
    })
  }

  if (Array.isArray(obj['walls'])) {
    obj['walls'].forEach((wall) => {
      if (!isRecord(wall) || !Array.isArray(wall['vertices'])) return
      wall['vertices'].forEach(includePoint)
    })
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }

  const width = Math.max(maxX - minX, 1)
  const height = Math.max(maxY - minY, 1)
  return { width, height }
}

function normalizeBoundsInPlace(meta: Record<string, unknown>, obj: Record<string, unknown>, scale: number): void {
  const boundsValue = meta['bounds']

  if (isRecord(boundsValue)) {
    const width = scaleValue(boundsValue['width'], scale)
    const height = scaleValue(boundsValue['height'], scale)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      meta['bounds'] = { width, height }
      return
    }
  }

  if (Array.isArray(boundsValue) && boundsValue.length >= 2) {
    const width = scaleValue(boundsValue[0], scale)
    const height = scaleValue(boundsValue[1], scale)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      meta['bounds'] = { width, height }
      return
    }
  }

  const parsedPair = parseDimensionPair(boundsValue)
  if (parsedPair) {
    const width = scaleValue(parsedPair[0], scale)
    const height = scaleValue(parsedPair[1], scale)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      meta['bounds'] = { width, height }
      return
    }
  }

  const inferred = inferBoundsFromGeometry(obj)
  if (inferred) {
    meta['bounds'] = {
      width: inferred.width * scale,
      height: inferred.height * scale,
    }
    return
  }

  meta['bounds'] = {
    width: 10 * scale,
    height: 10 * scale,
  }
}

function normalizeUnitsInPlace(obj: unknown): void {
  if (!isRecord(obj) || !isRecord(obj['meta'])) return

  normalizeCollectionsInPlace(obj)

  const meta = obj['meta']
  normalizeMetaFieldsInPlace(meta)
  const { scale, sourceUnit } = parseUnitScale(meta['unit'])

  meta['unit'] = 'meters'
  normalizeBoundsInPlace(meta, obj, scale)

  if (Array.isArray(obj['rooms'])) {
    obj['rooms'].forEach((room) => {
      if (!isRecord(room)) return
      if (Array.isArray(room['vertices'])) {
        room['vertices'].forEach((point) => {
          if (!isRecord(point)) return
          point['x'] = scaleValue(point['x'], scale)
          point['y'] = scaleValue(point['y'], scale)
        })
      }
      room['ceiling_height'] = scaleValue(room['ceiling_height'], scale)
    })
  }

  if (Array.isArray(obj['walls'])) {
    obj['walls'].forEach((wall) => {
      if (!isRecord(wall)) return
      if (Array.isArray(wall['vertices'])) {
        wall['vertices'].forEach((point) => {
          if (!isRecord(point)) return
          point['x'] = scaleValue(point['x'], scale)
          point['y'] = scaleValue(point['y'], scale)
        })
      }

      wall['thickness'] = scaleValue(wall['thickness'], scale)
      wall['height'] = scaleValue(wall['height'], scale)

      if (Array.isArray(wall['openings'])) {
        wall['openings'].forEach((opening) => {
          if (!isRecord(opening)) return
          opening['width'] = scaleValue(opening['width'], scale)
          opening['height'] = scaleValue(opening['height'], scale)
          if (opening['sill_height'] !== null) {
            opening['sill_height'] = scaleValue(opening['sill_height'], scale)
          }
        })
      }
    })
  }

  if (Array.isArray(obj['structural'])) {
    obj['structural'].forEach((element) => {
      if (!isRecord(element)) return
      element['x'] = scaleValue(element['x'], scale)
      element['y'] = scaleValue(element['y'], scale)
      element['width'] = scaleValue(element['width'], scale)
      element['depth'] = scaleValue(element['depth'], scale)
      element['height'] = scaleValue(element['height'], scale)
    })
  }

  if (Array.isArray(obj['furniture'])) {
    obj['furniture'].forEach((item) => {
      if (!isRecord(item)) return
      item['x'] = scaleValue(item['x'], scale)
      item['y'] = scaleValue(item['y'], scale)
    })
  }

  if (sourceUnit && sourceUnit.trim().toLowerCase() !== 'meters') {
    const previousNotes = typeof meta['ai_notes'] === 'string' ? meta['ai_notes'] : ''
    const separator = previousNotes.length > 0 ? ' | ' : ''
    meta['ai_notes'] = `${previousNotes}${separator}Parser normalized unit from ${sourceUnit} to meters.`
  }
}

export function parseGeminiResponse(rawText: string): FloorPlanSchema {
  const cleaned = stripMarkdownFences(rawText)

  let parsed: unknown
  try {
    parsed = parseJsonCandidate(cleaned)
  } catch (e) {
    throw new GeminiParseError({
      type: 'malformed_json',
      raw: rawText,
      detail: e instanceof Error ? e.message : 'JSON.parse failed',
    })
  }

  normalizeUnitsInPlace(parsed)

  try {
    validateFloorPlanSchema(parsed)
  } catch (e) {
    throw new GeminiParseError({
      type: 'schema_mismatch',
      raw: rawText,
      detail: e instanceof Error
        ? e.message
        : 'Response JSON does not match required schema',
    })
  }

  return parsed
}
