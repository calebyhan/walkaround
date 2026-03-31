import type { CVRegion } from './types'

// Minimum contiguous dark run fraction for wall signal — different for rows vs columns.
//
// Column projection (scanning vertical runs per column):
//   - Furniture items (stove=60px, toilet=100px, counter=30px tall) → short vertical runs
//   - Real vertical walls span the full room height → 300px+ runs
//   - 0.25 × 1166px ≈ 292px filters furniture while catching walls ✓
const MIN_COL_SEGMENT_FRAC = 0.25
//
// Row projection (scanning horizontal runs per row):
//   - Horizontal walls are broken by door openings (~116px wide at this scale)
//   - Dimension annotation lines span 1 room (~350-500px) — must be filtered
//   - Real floor-separator walls span ALL columns, giving 0.7–0.9 projection
//   - 0.15 × 2000px = 300px: annotation spans within one room (sub-300px runs)
//     are excluded; real multi-column walls easily exceed this per section
const MIN_ROW_SEGMENT_FRAC = 0.15
// A column is a wall divider if its filtered dark fraction ≥ this value.
// Columns only need to clear noise — furniture is filtered by MIN_COL_SEGMENT_FRAC.
const COL_PROJ_THRESHOLD = 0.06
// Rows: interior structural walls project ~0.12+ after run filtering.
// Annotation-only lines are caught by MIN_ROW_SEGMENT_FRAC=0.15 (runs <300px excluded).
// 0.12 detects interior walls; scale accuracy is handled by plan_width_m/plan_height_m.
const ROW_PROJ_THRESHOLD = 0.12
// Wall divider bands must be at least this many pixels wide to be a real wall.
// Text strokes / dimension lines are 1-3px; real walls are 4-15px in a 2000px-wide image.
const MIN_BAND_WIDTH_PX = 4
// Wall bands within this many pixels of each other are merged into one divider
const BAND_MERGE_GAP = 20
// A grid cell must have ≥ this fraction of light pixels to count as a room
const MIN_ROOM_WHITE_FRAC = 0.35
// Room must occupy ≥ 0.3% of total image area (filters noise slivers)
const MIN_AREA_FRACTION = 0.003
// Minimum cell width/height in pixels (filters paper-thin cells at wall positions)
const MIN_CELL_PX = 50
const MAX_REGIONS = 30

/**
 * Projection-based room region detection for architectural floor plans.
 *
 * BFS connected-components fails because rooms connect through door openings.
 * Simple projection fails because furniture and annotations create false peaks.
 *
 * This approach uses FILTERED projections: only dark pixels in contiguous runs
 * ≥ MIN_WALL_SEGMENT_FRAC of the image dimension contribute to the wall signal.
 * This eliminates furniture (which creates short isolated dark runs) while
 * preserving real walls (which span hundreds of pixels even with door openings).
 */
export function detectRegions(mask: Uint8Array, width: number, height: number): CVRegion[] {
  const minRowSeg = Math.round(width * MIN_ROW_SEGMENT_FRAC)   // horizontal segments between door gaps
  const minColSeg = Math.round(height * MIN_COL_SEGMENT_FRAC)  // vertical: filters furniture symbols

  // For each row: sum dark pixels that belong to contiguous runs ≥ minRowSeg
  const rowWall = new Float32Array(height)
  for (let y = 0; y < height; y++) {
    let run = 0, total = 0
    for (let x = 0; x <= width; x++) {
      if (x < width && mask[y * width + x] === 0) {
        run++
      } else {
        if (run >= minRowSeg) total += run
        run = 0
      }
    }
    rowWall[y] = total / width
  }

  // For each col: sum dark pixels that belong to contiguous runs ≥ minColSeg
  const colWall = new Float32Array(width)
  for (let x = 0; x < width; x++) {
    let run = 0, total = 0
    for (let y = 0; y <= height; y++) {
      if (y < height && mask[y * width + x] === 0) {
        run++
      } else {
        if (run >= minColSeg) total += run
        run = 0
      }
    }
    colWall[x] = total / height
  }

  console.log(
    `[walkaround/cv] Filtered projections — col peaks: ${countPeaks(colWall, COL_PROJ_THRESHOLD)}, ` +
    `row peaks: ${countPeaks(rowWall, ROW_PROJ_THRESHOLD)} ` +
    `(minSeg: col=${minColSeg}px row=${minRowSeg}px thresholds: col=${COL_PROJ_THRESHOLD} row=${ROW_PROJ_THRESHOLD})`,
  )

  const wallCols = findWallDividers(colWall, COL_PROJ_THRESHOLD, BAND_MERGE_GAP, width)
  const wallRows = findWallDividers(rowWall, ROW_PROJ_THRESHOLD, BAND_MERGE_GAP, height)

  console.log(
    `[walkaround/cv] Grid: ${wallCols.length - 1} col divisions × ${wallRows.length - 1} row divisions` +
    ` = ${(wallCols.length - 1) * (wallRows.length - 1)} cells`,
  )

  const minArea = width * height * MIN_AREA_FRACTION
  const candidates: Omit<CVRegion, 'id' | 'originalBBox'>[] = []

  for (let ci = 0; ci + 1 < wallCols.length; ci++) {
    for (let ri = 0; ri + 1 < wallRows.length; ri++) {
      const x0 = wallCols[ci]
      const x1 = wallCols[ci + 1]
      const y0 = wallRows[ri]
      const y1 = wallRows[ri + 1]
      const cellW = x1 - x0
      const cellH = y1 - y0
      if (cellW < MIN_CELL_PX || cellH < MIN_CELL_PX) continue
      const cellArea = cellW * cellH
      if (cellArea < minArea) continue

      let white = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (mask[y * width + x] === 1) white++
        }
      }
      if (white / cellArea < MIN_ROOM_WHITE_FRAC) continue

      candidates.push({
        pixelBBox: { x: x0, y: y0, w: cellW, h: cellH },
        pixelArea: white,
        centroid: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
      })
    }
  }

  candidates.sort((a, b) => b.pixelArea - a.pixelArea)
  return candidates.slice(0, MAX_REGIONS).map((r, i): CVRegion => ({
    id: i + 1,
    pixelBBox: r.pixelBBox,
    originalBBox: r.pixelBBox,
    pixelArea: r.pixelArea,
    centroid: r.centroid,
  }))
}

function findWallDividers(
  proj: Float32Array,
  threshold: number,
  mergeGap: number,
  size: number,
): number[] {
  const bands: { start: number; end: number }[] = []
  let i = 0
  while (i < size) {
    if (proj[i] >= threshold) {
      const start = i
      while (i < size && proj[i] >= threshold) i++
      // Reject bands thinner than MIN_BAND_WIDTH_PX — these are text strokes or dimension lines
      if (i - start >= MIN_BAND_WIDTH_PX) {
        bands.push({ start, end: i - 1 })
      }
    } else {
      i++
    }
  }

  const merged: { start: number; end: number }[] = []
  for (const b of bands) {
    if (merged.length > 0 && b.start - merged[merged.length - 1].end <= mergeGap) {
      merged[merged.length - 1].end = b.end
    } else {
      merged.push({ ...b })
    }
  }

  const dividers = [0]
  for (const b of merged) {
    const mid = Math.round((b.start + b.end) / 2)
    if (mid > 0 && mid < size - 1) dividers.push(mid)
  }
  dividers.push(size - 1)
  return dividers
}

function countPeaks(proj: Float32Array, threshold: number): number {
  let count = 0, inPeak = false
  for (let i = 0; i < proj.length; i++) {
    if (proj[i] >= threshold) { if (!inPeak) { count++; inPeak = true } }
    else inPeak = false
  }
  return count
}
