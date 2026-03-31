export interface CVRegion {
  /** 1-indexed sequential ID used for overlay labeling */
  id: number
  /** Bounding box in downsampled pixel space */
  pixelBBox: { x: number; y: number; w: number; h: number }
  /** Bounding box scaled back to original image pixel space */
  originalBBox: { x: number; y: number; w: number; h: number }
  /** Number of pixels in the region (downsampled space) */
  pixelArea: number
  /** Centroid in downsampled pixel space */
  centroid: { x: number; y: number }
}

export interface CVPipelineResult {
  regions: CVRegion[]
  /** JPEG base64 (no data: prefix) of the original image with numbered region overlays */
  overlayBase64: string
  /** Original image width in pixels */
  imageWidth: number
  /** Original image height in pixels */
  imageHeight: number
  /** Factor by which the image was downsampled for CV: original_px / downsampled_px */
  downsampleScale: number
}

export class CVUnsupportedError extends Error {
  constructor(reason: string) {
    super(`CV pipeline unsupported: ${reason}`)
    this.name = 'CVUnsupportedError'
  }
}
