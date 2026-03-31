import { GoogleGenerativeAI } from '@google/generative-ai'

const genai = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY as string)

// VITE_GEMINI_MODEL controls which model to use. Options:
//   gemini-2.5-flash (default) — 250 RPD free tier, good balance
//   gemini-2.5-pro             — 100 RPD free tier, stronger spatial reasoning
const modelName = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-2.5-flash'

// thinkingBudget: 4096 gives the model meaningful reasoning headroom for spatial
// floor-plan extraction without risking the timeout issues seen with unlimited thinking.
export const geminiModel = genai.getGenerativeModel({
  model: modelName,
  generationConfig: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thinkingConfig: { thinkingBudget: 4096 } as any,
    temperature: 0.1,
  },
})
