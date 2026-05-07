import {
  base64ToImageData,
  countWallPixels,
  downsample,
  erodeWhiteFast,
  threshold,
  thresholdGrayWalls,
  toGrayscale,
} from './preprocess'
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
  const darkMask = threshold(gray)
  const grayWallMask = thresholdGrayWalls(gray)
  const grayWallCoverage = countWallPixels(grayWallMask) / grayWallMask.length
  const mask = grayWallCoverage >= 0.005 ? grayWallMask : darkMask
  console.log(
    `[walkaround/cv] Wall mask: ${grayWallCoverage >= 0.005 ? 'gray structural' : 'dark fallback'} ` +
    `(gray coverage=${(grayWallCoverage * 100).toFixed(1)}%)`,
  )
  const wallCloseRadius = Math.max(1, Math.round(Math.min(dsW, dsH) * 0.002))
  const closedMask = erodeWhiteFast(mask, dsW, dsH, wallCloseRadius)
  console.log(`[walkaround/cv] Closed small wall gaps with radius=${wallCloseRadius}px`)

  console.log('[walkaround/cv] Running BFS flood-fill region detection…')
  const rawRegions = detectRegions(closedMask, dsW, dsH)

  // Scale bboxes, centroids, and polygons back to original image coordinates
  const regions: CVRegion[] = rawRegions.map((r) => ({
    ...r,
    originalBBox: {
      x: Math.round(r.pixelBBox.x * scale),
      y: Math.round(r.pixelBBox.y * scale),
      w: Math.round(r.pixelBBox.w * scale),
      h: Math.round(r.pixelBBox.h * scale),
    },
    originalPolygon: r.polygon.map((pt) => ({
      x: Math.round(pt.x * scale),
      y: Math.round(pt.y * scale),
    })),
  }))

  console.log(`[walkaround/cv] Detected ${regions.length} regions`)
  for (const r of regions) {
    console.log(
      `  [${r.id}] bbox=${r.originalBBox.x},${r.originalBBox.y} ` +
      `${r.originalBBox.w}×${r.originalBBox.h}px  area=${r.pixelArea}px  ` +
      `polygon=${r.originalPolygon.length}pts`,
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
    wallMask: mask,
    wallMaskWidth: dsW,
    wallMaskHeight: dsH,
    wallSampleRadiusPx: Math.max(3, wallCloseRadius * 2),
  }
}
