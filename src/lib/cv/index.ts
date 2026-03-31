import { base64ToImageData, downsample, toGrayscale, threshold } from './preprocess'
import { detectRegions } from './regionDetect'
import { drawLabeledOverlay } from './labelOverlay'
import { CVUnsupportedError } from './types'
import type { CVPipelineResult, CVRegion } from './types'

export { CVUnsupportedError }
export type { CVPipelineResult, CVRegion }

/**
 * Run the full CV pipeline on a floor plan image:
 *   decode → downsample → grayscale → threshold → BFS regions → labeled overlay
 *
 * Throws CVUnsupportedError for PDF inputs (cannot be decoded to pixel data
 * without a dedicated PDF renderer; caller should fall back to LLM-only).
 */
export async function runCVPipeline(
  base64: string,
  mimeType: string,
): Promise<CVPipelineResult> {
  if (mimeType === 'application/pdf') {
    throw new CVUnsupportedError('PDF inputs require a PDF renderer — use LLM-only path')
  }

  console.log('[walkaround/cv] Decoding image…')
  const original = await base64ToImageData(base64, mimeType)

  const { data: dsData, width: dsW, height: dsH, scale } = downsample(original)
  console.log(
    `[walkaround/cv] Original ${original.width}×${original.height}, ` +
    `downsampled to ${dsW}×${dsH} (scale=${scale.toFixed(2)})`,
  )

  const gray = toGrayscale(dsData)
  const mask = threshold(gray)

  console.log('[walkaround/cv] Running BFS region detection…')
  const rawRegions = detectRegions(mask, dsW, dsH)

  // Scale bboxes and centroids back to original image coordinates
  const regions: CVRegion[] = rawRegions.map((r) => ({
    ...r,
    originalBBox: {
      x: Math.round(r.pixelBBox.x * scale),
      y: Math.round(r.pixelBBox.y * scale),
      w: Math.round(r.pixelBBox.w * scale),
      h: Math.round(r.pixelBBox.h * scale),
    },
  }))

  console.log(`[walkaround/cv] Detected ${regions.length} regions`)
  for (const r of regions) {
    console.log(
      `  [${r.id}] bbox=${r.originalBBox.x},${r.originalBBox.y} ` +
      `${r.originalBBox.w}×${r.originalBBox.h}px  area=${r.pixelArea}px`,
    )
  }

  console.log('[walkaround/cv] Drawing labeled overlay…')
  const overlayBase64 = await drawLabeledOverlay(base64, mimeType, regions)

  return {
    regions,
    overlayBase64,
    imageWidth: original.width,
    imageHeight: original.height,
    downsampleScale: scale,
  }
}
