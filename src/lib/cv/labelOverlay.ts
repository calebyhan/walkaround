import type { CVRegion } from './types'

const OVERLAY_ALPHA = 0.25
const COLORS = [
  '#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE',
]

/**
 * Draw the original floor plan image with numbered bounding-box overlays for each CV region.
 * Returns the composite as a JPEG base64 string (no data: prefix).
 *
 * The overlay makes it easy for Gemini to match region numbers to room labels
 * visible in the original image.
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
    const { x, y, w, h } = region.originalBBox
    const color = COLORS[(region.id - 1) % COLORS.length]

    // Semi-transparent fill
    ctx.globalAlpha = OVERLAY_ALPHA
    ctx.fillStyle = color
    ctx.fillRect(x, y, w, h)

    // Solid border
    ctx.globalAlpha = 0.8
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, Math.round(img.naturalWidth / 500))
    ctx.strokeRect(x, y, w, h)

    // Region ID label — white text with dark outline for legibility
    ctx.globalAlpha = 1
    const fontSize = Math.max(16, Math.round(Math.min(w, h) * 0.3))
    ctx.font = `bold ${fontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const cx = x + w / 2
    const cy = y + h / 2

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
