import type { CVRegion } from './types'

const OVERLAY_FILL_ALPHA = 0.20
const OVERLAY_STROKE_ALPHA = 0.85
const COLORS = [
  '#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE',
]

/**
 * Draw the original floor plan image with numbered polygon overlays for each CV region.
 * Returns the composite as a JPEG base64 string (no data: prefix).
 *
 * Polygons reflect the actual detected room shapes (including L-shaped, T-shaped rooms),
 * making it easy for Gemini to match region numbers to the room labels visible in the
 * original image.
 */
export async function drawLabeledOverlay(
  originalBase64: string,
  mimeType: string,
  regions: CVRegion[],
): Promise<string> {
  const img = await loadImage(`data:${mimeType};base64,${originalBase64}`)

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!

  // Draw original image
  ctx.drawImage(img, 0, 0)

  for (const region of regions) {
    const poly = region.originalPolygon
    if (poly.length < 3) continue

    const color = COLORS[(region.id - 1) % COLORS.length]
    const lineWidth = Math.max(2, Math.round(img.naturalWidth / 500))

    // Build the polygon path
    ctx.beginPath()
    ctx.moveTo(poly[0].x, poly[0].y)
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y)
    }
    ctx.closePath()

    // Semi-transparent fill
    ctx.globalAlpha = OVERLAY_FILL_ALPHA
    ctx.fillStyle = color
    ctx.fill()

    // Solid border
    ctx.globalAlpha = OVERLAY_STROKE_ALPHA
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.stroke()

    // Region ID label — white text with dark outline, placed at polygon centroid.
    // Use arithmetic mean of polygon vertices (not bbox center) so the label
    // stays inside the room for non-rectangular shapes like L-shaped rooms.
    ctx.globalAlpha = 1
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length
    const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length
    const fontSize = Math.max(16, Math.round(Math.min(region.originalBBox.w, region.originalBBox.h) * 0.3))
    ctx.font = `bold ${fontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.lineWidth = Math.max(3, fontSize * 0.15)
    ctx.strokeStyle = '#000000'
    ctx.strokeText(String(region.id), cx, cy)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(String(region.id), cx, cy)
  }

  ctx.globalAlpha = 1

  // Strip the "data:image/jpeg;base64," prefix
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return dataUrl.split(',')[1]
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image for overlay'))
    img.src = src
  })
}
