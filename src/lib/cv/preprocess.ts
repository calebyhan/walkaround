const MAX_CV_WIDTH = 2000

export interface RawImageData {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Decode a base64 image into raw RGBA pixel data via an offscreen canvas. */
export async function base64ToImageData(base64: string, mimeType: string): Promise<RawImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Could not get 2D canvas context')); return }
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      resolve({ data: imageData.data, width: canvas.width, height: canvas.height })
    }
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = `data:${mimeType};base64,${base64}`
  })
}

/**
 * Downsample image data to at most maxWidth pixels wide, preserving aspect ratio.
 * Returns the downsampled pixel data and the scale factor (original / downsampled).
 */
export function downsample(
  src: RawImageData,
  maxWidth = MAX_CV_WIDTH,
): { data: Uint8ClampedArray; width: number; height: number; scale: number } {
  if (src.width <= maxWidth) {
    return { data: src.data.slice(), width: src.width, height: src.height, scale: 1 }
  }

  const scale = src.width / maxWidth
  const dstW = maxWidth
  const dstH = Math.round(src.height / scale)

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = src.width
  srcCanvas.height = src.height
  const srcCtx = srcCanvas.getContext('2d')!
  srcCtx.putImageData(new ImageData(src.data, src.width, src.height), 0, 0)

  const dstCanvas = document.createElement('canvas')
  dstCanvas.width = dstW
  dstCanvas.height = dstH
  const dstCtx = dstCanvas.getContext('2d')!
  dstCtx.drawImage(srcCanvas, 0, 0, dstW, dstH)

  return { data: dstCtx.getImageData(0, 0, dstW, dstH).data, width: dstW, height: dstH, scale }
}

/**
 * Convert RGBA pixel data to a grayscale Uint8Array using luma coefficients.
 * Output values: 0 (black) – 255 (white).
 */
export function toGrayscale(rgba: Uint8ClampedArray): Uint8Array {
  const n = rgba.length / 4
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return out
}

/**
 * Threshold grayscale to a binary wall mask.
 * mask[i] = 1 → non-wall (open space, light pixel)
 * mask[i] = 0 → wall (dark pixel)
 *
 * Cutoff of 180 rather than 128: floor plan backgrounds are white (255),
 * walls are dark grey/black but not always pure black.
 */
export function threshold(grayscale: Uint8Array, cutoff = 180): Uint8Array {
  const mask = new Uint8Array(grayscale.length)
  for (let i = 0; i < grayscale.length; i++) {
    mask[i] = grayscale[i] >= cutoff ? 1 : 0
  }
  return mask
}

/**
 * Morphological erosion of white (mask=1) pixels.
 * Any white pixel within `radius` of a wall pixel (mask=0) is turned into wall.
 * This thickens walls to ensure downsampling blur doesn't leave gaps between rooms.
 */
export function erodeWhite(mask: Uint8Array, width: number, height: number, radius = 2): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx] === 0) { out[idx] = 0; continue }
      let isEdge = false
      outer: for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy
          const nx = x + dx
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue
          if (mask[ny * width + nx] === 0) { isEdge = true; break outer }
        }
      }
      out[idx] = isEdge ? 0 : 1
    }
  }
  return out
}

/**
 * Fast separable morphological erosion of white (mask=1) pixels.
 *
 * Uses two O(width × height) sliding-window passes (horizontal then vertical)
 * instead of the naive O(width × height × radius²) approach. The result is
 * equivalent to a square erosion kernel of size (2*radius+1)² — any white pixel
 * with a wall neighbour within ±radius on BOTH axes is eroded. This is sufficient
 * to close door openings in floor-plan images.
 *
 * Primary use: close door/window openings before BFS room detection so that
 * rooms are isolated as separate connected components.
 */
export function erodeWhiteFast(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  // --- Horizontal pass ---
  // For each pixel, count wall neighbours (mask=0) within ±radius columns.
  // A sliding window of size 2*radius+1 tracks the count.
  const tmp = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    let wallCount = 0
    // Initialise window [0, radius]
    for (let nx = 0; nx <= Math.min(radius, width - 1); nx++) {
      if (mask[y * width + nx] === 0) wallCount++
    }
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = wallCount > 0 ? 0 : 1

      // Expand right edge
      const addX = x + radius + 1
      if (addX < width && mask[y * width + addX] === 0) wallCount++
      // Shrink left edge
      const removeX = x - radius
      if (removeX >= 0 && mask[y * width + removeX] === 0) wallCount--
    }
  }

  // --- Vertical pass (on tmp) ---
  const out = new Uint8Array(mask.length)
  for (let x = 0; x < width; x++) {
    let wallCount = 0
    // Initialise window [0, radius]
    for (let ny = 0; ny <= Math.min(radius, height - 1); ny++) {
      if (tmp[ny * width + x] === 0) wallCount++
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = wallCount > 0 ? 0 : 1

      // Expand bottom edge
      const addY = y + radius + 1
      if (addY < height && tmp[addY * width + x] === 0) wallCount++
      // Shrink top edge
      const removeY = y - radius
      if (removeY >= 0 && tmp[removeY * width + x] === 0) wallCount--
    }
  }

  return out
}
