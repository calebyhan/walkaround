import { geminiModel } from './client'
import { buildSemanticPrompt, buildLLMOnlyPrompt } from './systemPrompt'
import {
  parseLayoutDraftFromRaw,
  convertDraftToSchema,
  parseLLMSemanticOutput,
  mergeWithLLMLabels,
} from './convertLayout'
import { runCVPipeline, CVUnsupportedError } from '@/lib/cv'
import type { FloorPlanSchema } from '@/lib/schema'

export type { ParseError } from './parseResponse'
export { GeminiParseError } from './parseResponse'

/**
 * Main entry point for floor plan analysis.
 *
 * For JPEG/PNG: runs the CV pipeline first to detect room regions geometrically,
 * then asks Gemini only to identify room names and dimensions (semantic extraction).
 * Falls back to LLM-only if CV finds fewer than 3 regions.
 *
 * For PDF: falls back directly to LLM-only (CV requires pixel decoding).
 */
export async function analyseFloorPlan(
  imageBase64: string,
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf',
  sourceFilename: string,
): Promise<FloorPlanSchema> {
  if (mimeType !== 'application/pdf') {
    try {
      const cvResult = await runCVPipeline(imageBase64, mimeType)
      if (cvResult.regions.length >= 3) {
        console.log(`[walkaround] CV path: ${cvResult.regions.length} regions detected`)
        const schema = await analyseWithCV(imageBase64, mimeType, cvResult)
        schema.meta.source_image = sourceFilename
        return schema
      }
      console.warn(
        `[walkaround] CV found only ${cvResult.regions.length} regions — falling back to LLM-only`,
      )
    } catch (e) {
      if (e instanceof CVUnsupportedError) {
        console.warn(`[walkaround] CV unsupported: ${e.message}`)
      } else {
        console.warn('[walkaround] CV pipeline failed, falling back to LLM-only:', e)
      }
    }
  }

  console.log('[walkaround] LLM-only path')
  const schema = await analyseFloorPlanLLMOnly(imageBase64, mimeType)
  schema.meta.source_image = sourceFilename
  return schema
}

// ---------------------------------------------------------------------------
// CV-assisted path
// ---------------------------------------------------------------------------

async function analyseWithCV(
  imageBase64: string,
  mimeType: 'image/jpeg' | 'image/png',
  cvResult: Awaited<ReturnType<typeof runCVPipeline>>,
): Promise<FloorPlanSchema> {
  const prompt = buildSemanticPrompt()

  console.log('[walkaround] Sending original + overlay to Gemini for semantic extraction…')
  const t0 = performance.now()

  const result = await geminiModel.generateContent([
    prompt,
    { inlineData: { data: imageBase64, mimeType } },
    { inlineData: { data: cvResult.overlayBase64, mimeType: 'image/jpeg' } },
  ])

  const rawText = result.response.text()
  console.log(
    `[walkaround] Gemini responded in ${((performance.now() - t0) / 1000).toFixed(1)}s, ${rawText.length} chars`,
  )

  const llmOutput = parseLLMSemanticOutput(rawText)
  console.log(
    `[walkaround] LLM labeled ${llmOutput.rooms.length} rooms, ${llmOutput.openings.length} openings`,
  )

  const draft = mergeWithLLMLabels(cvResult, llmOutput)
  return convertDraftToSchema(draft)
}

// ---------------------------------------------------------------------------
// LLM-only fallback path (original behaviour)
// ---------------------------------------------------------------------------

async function analyseFloorPlanLLMOnly(
  imageBase64: string,
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf',
): Promise<FloorPlanSchema> {
  const prompt = buildLLMOnlyPrompt()

  const imagePart = { inlineData: { data: imageBase64, mimeType } }

  console.log('[walkaround] Sending image to Gemini…')
  const t0 = performance.now()

  const result = await geminiModel.generateContent([prompt, imagePart])
  const rawText = result.response.text()
  console.log(
    `[walkaround] Gemini responded in ${((performance.now() - t0) / 1000).toFixed(1)}s, ${rawText.length} chars`,
  )

  const draft = parseLayoutDraftFromRaw(rawText)
  console.log(
    '[walkaround] Draft rooms:',
    draft.rooms.map((r) => ({ id: r.id, name: r.name, bbox: r.image_bbox })),
  )
  return convertDraftToSchema(draft)
}
