import type { FloorPlanSchema, Issue, Wall } from '@/lib/schema'

export interface AutoFix {
  type: string
  description: string
  affected_ids: string[]
}

export interface ValidationResult {
  schema: FloorPlanSchema
  autoFixLog: AutoFix[]
}

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

  const roomIds = new Set(schema.rooms.map((room) => room.id))

  if (schema.meta.bounds.width <= 0 || schema.meta.bounds.height <= 0) {
    pushIssue('error', 'invalid_bounds', 'Floor plan bounds must be positive numbers.', [])
  }

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

    if (room.ceiling_height <= 0) {
      pushIssue('warning', 'invalid_ceiling_height', `Room ${room.id} has a non-positive ceiling height.`, [room.id])
    }
  })

  schema.walls.forEach((wall) => {
    validateWall(wall, roomIds, pushIssue)

    wall.openings.forEach((opening) => {
      if (opening.position_along_wall < 0 || opening.position_along_wall > 1) {
        const clamped = clamp(opening.position_along_wall, 0, 1)
        autoFixLog.push({
          type: 'clamp_opening_position',
          description: `Clamped ${opening.id} position_along_wall from ${opening.position_along_wall.toFixed(3)} to ${clamped.toFixed(3)}.`,
          affected_ids: [wall.id, opening.id],
        })
        pushIssue(
          'warning',
          'opening_out_of_bounds',
          `Opening ${opening.id} on ${wall.id} was clamped to wall bounds.`,
          [wall.id, opening.id],
        )
        opening.position_along_wall = clamped
      }

      if (opening.width <= 0 || opening.height <= 0) {
        pushIssue(
          'error',
          'invalid_opening_dimensions',
          `Opening ${opening.id} has non-positive dimensions.`,
          [wall.id, opening.id],
        )
      }
    })
  })

  if (schema.rooms.length > 0 && schema.walls.length === 0) {
    pushIssue('error', 'missing_walls', 'Floor plan includes rooms but has no walls.', schema.rooms.map((room) => room.id))
  }

  // Step 1: Filter rooms clearly outside AI-reported meta.bounds.
  // meta.bounds is computed by the AI from labeled dimension sums (e.g. sum of room widths in widest row).
  // This is generally accurate, so any room centroid more than 2m outside meta.bounds is an AI placement error.
  const META_MARGIN = 2
  schema.rooms = schema.rooms.filter((room) => {
    const cx = room.vertices.reduce((s, v) => s + v.x, 0) / room.vertices.length
    const cy = room.vertices.reduce((s, v) => s + v.y, 0) / room.vertices.length
    const { width: metaW, height: metaH } = schema.meta.bounds
    if (cx < -META_MARGIN || cx > metaW + META_MARGIN || cy < -META_MARGIN || cy > metaH + META_MARGIN) {
      autoFixLog.push({
        type: 'remove_out_of_bounds_room',
        description: `Removed room ${room.id}: centroid (${cx.toFixed(1)}, ${cy.toFixed(1)}) is outside meta.bounds (${metaW.toFixed(1)}x${metaH.toFixed(1)}).`,
        affected_ids: [room.id],
      })
      pushIssue('error', 'room_out_of_bounds', `Room ${room.id} removed: centroid outside floor plan bounds.`, [room.id])
      return false
    }
    return true
  })

  // Step 2: Remove rooms whose centroid is a statistical outlier from the remaining cluster.
  // Uses median centroid + threshold based on plan size. This catches misplacements that squeaked
  // past the meta.bounds filter (e.g. when meta.bounds itself was slightly overestimated).
  if (schema.rooms.length >= 3) {
    // Use per-room max vertex to estimate bounds — more robust than global max which inflates on outliers.
    const roomMaxXs = schema.rooms.map((r) => Math.max(...r.vertices.filter((v) => Number.isFinite(v.x)).map((v) => v.x)))
    const roomMaxYs = schema.rooms.map((r) => Math.max(...r.vertices.filter((v) => Number.isFinite(v.y)).map((v) => v.y)))
    roomMaxXs.sort((a, b) => a - b)
    roomMaxYs.sort((a, b) => a - b)
    const p75X = roomMaxXs[Math.floor(roomMaxXs.length * 0.75)] ?? schema.meta.bounds.width
    const p75Y = roomMaxYs[Math.floor(roomMaxYs.length * 0.75)] ?? schema.meta.bounds.height

    const centroids = schema.rooms.map((room) => ({
      id: room.id,
      x: room.vertices.reduce((s, v) => s + v.x, 0) / room.vertices.length,
      y: room.vertices.reduce((s, v) => s + v.y, 0) / room.vertices.length,
    }))
    const xs = [...centroids.map((c) => c.x)].sort((a, b) => a - b)
    const ys = [...centroids.map((c) => c.y)].sort((a, b) => a - b)
    const medX = xs[Math.floor(xs.length / 2)]
    const medY = ys[Math.floor(ys.length / 2)]
    // Use 75th-percentile bounds (not global max) to avoid outliers inflating the threshold.
    const threshX = Math.min(p75X * 0.3, 4)
    const threshY = Math.min(p75Y * 0.3, 4)

    schema.rooms = schema.rooms.filter((room) => {
      const c = centroids.find((c) => c.id === room.id)!
      // Tighter multiplier (1.5x vs old 3x) so rooms only 1.5 "plan widths" from center are caught.
      if (Math.abs(c.x - medX) > threshX * 1.5 || Math.abs(c.y - medY) > threshY * 1.5) {
        autoFixLog.push({
          type: 'remove_outlier_room',
          description: `Removed room ${room.id}: centroid (${c.x.toFixed(1)}, ${c.y.toFixed(1)}) is far from plan cluster (median ${medX.toFixed(1)}, ${medY.toFixed(1)}).`,
          affected_ids: [room.id],
        })
        pushIssue('error', 'room_outlier', `Room ${room.id} removed: centroid far outside plan cluster.`, [room.id])
        return false
      }
      return true
    })
  }

  // Step 3: Recalculate final bounds from remaining rooms and update schema.
  if (schema.rooms.length > 0) {
    let maxX = 0
    let maxY = 0
    for (const room of schema.rooms) {
      for (const v of room.vertices) {
        if (Number.isFinite(v.x) && v.x > maxX) maxX = v.x
        if (Number.isFinite(v.y) && v.y > maxY) maxY = v.y
      }
    }
    if (maxX > 1 && maxY > 1) {
      schema.meta.bounds.width = maxX
      schema.meta.bounds.height = maxY
    }
  }

  const { width: bw, height: bh } = schema.meta.bounds
  const BOUNDS_TOLERANCE = 1

  // Clamp wall vertices within tolerance; flag and skip those beyond it.
  schema.walls.forEach((wall) => {
    wall.vertices.forEach((v, idx) => {
      const outsideX = v.x < 0 ? -v.x : v.x > bw ? v.x - bw : 0
      const outsideY = v.y < 0 ? -v.y : v.y > bh ? v.y - bh : 0
      if (outsideX > BOUNDS_TOLERANCE || outsideY > BOUNDS_TOLERANCE) {
        pushIssue(
          'error',
          'wall_vertex_out_of_bounds',
          `Wall ${wall.id} vertex[${idx}] (${v.x.toFixed(2)}, ${v.y.toFixed(2)}) is far outside bounds (${bw.toFixed(1)}x${bh.toFixed(1)}).`,
          [wall.id],
        )
      } else if (outsideX > 0 || outsideY > 0) {
        const clamped = { x: clamp(v.x, 0, bw), y: clamp(v.y, 0, bh) }
        autoFixLog.push({
          type: 'clamp_wall_vertex',
          description: `Clamped wall ${wall.id} vertex[${idx}] from (${v.x.toFixed(2)}, ${v.y.toFixed(2)}) to (${clamped.x.toFixed(2)}, ${clamped.y.toFixed(2)}).`,
          affected_ids: [wall.id],
        })
        v.x = clamped.x
        v.y = clamped.y
      }
    })
  })

  schema.issues = issues

  return {
    schema,
    autoFixLog,
  }
}

function validateWall(
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
        [wall.id],
      )
    }
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
