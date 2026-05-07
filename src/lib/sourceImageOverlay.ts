export interface SourceImageOverlayAnnotation {
  type: 'source_image_overlay'
  data: string
  mimeType: 'image/jpeg' | 'image/png'
  imageWidth: number
  imageHeight: number
  crop: {
    x0: number
    y0: number
    x1: number
    y1: number
  }
}

export function getSourceImageOverlay(annotations: unknown[] | undefined): SourceImageOverlayAnnotation | null {
  const overlay = annotations?.find((annotation): annotation is SourceImageOverlayAnnotation => {
    if (typeof annotation !== 'object' || annotation === null) return false
    const record = annotation as Record<string, unknown>
    if (record['type'] !== 'source_image_overlay') return false
    if (typeof record['data'] !== 'string') return false
    if (record['mimeType'] !== 'image/jpeg' && record['mimeType'] !== 'image/png') return false
    if (typeof record['imageWidth'] !== 'number' || typeof record['imageHeight'] !== 'number') return false
    const crop = record['crop']
    if (typeof crop !== 'object' || crop === null) return false
    const cropRecord = crop as Record<string, unknown>
    return (
      typeof cropRecord['x0'] === 'number' &&
      typeof cropRecord['y0'] === 'number' &&
      typeof cropRecord['x1'] === 'number' &&
      typeof cropRecord['y1'] === 'number'
    )
  })

  return overlay ?? null
}
