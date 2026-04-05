export interface CVPoint {
  x: number
  y: number
}

export interface CVRegion {
  /** 1-indexed sequential ID used for overlay labeling */
  id: number
  /** Bounding box in downsampled pixel space */
  pixelBBox: { x: number; y: number; w: number; h: number }
  /** Bounding box scaled back to original image pixel space */
  originalBBox: { x: number; y: number; w: number; h: number }
  /** Number of pixels in the region (downsampled space, after wall-closing erosion) */
  pixelArea: number
  /** Centroid in downsampled pixel space */
  centroid: { x: number; y: number }
  /**
   * Rectilinear polygon outlining the room in downsampled pixel coordinates.
   * Derived from BFS on the wall-closed mask — door openings are treated as solid,
   * so each room is a clean connected region. Polygon vertices are ordered clockwise
   * in pixel space (y increases downward).
   */
  polygon: CVPoint[]
  /**
   * Same polygon scaled to original image pixel coordinates.
   * Use this for drawing overlays on the original image.
   */
  originalPolygon: CVPoint[]
}

export interface CVPipelineResult {
  regions: CVRegion[]
  /** JPEG base64 (no data: prefix) of the original image with numbered polygon overlays */
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
