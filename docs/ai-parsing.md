# AI Parsing

Walkaround uses **Gemini 2.5 Flash** to convert a floor plan image into a structured `FloorPlanSchema` JSON object. The integration lives in `src/lib/ai/`.

## Why Gemini 2.5 Flash

- Free tier: 10 RPM, 250 requests/day — sufficient for personal use
- Vision capable — reads and interprets floor plan images
- 1M token context window — handles large prompts with schema examples
- No credit card required for Google AI Studio API key

## API call

The image is sent to Gemini as a base64-encoded inline part alongside a system prompt. The request is a single `generateContent` call.

```ts
// src/lib/ai/client.ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const genai = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY);
const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
```

The model is `gemini-2.5-flash`. Do not change this without testing.

## Prompt strategy

The system prompt sent with every request does the following:

1. Explains the expected JSON schema with a complete example (few-shot)
2. Instructs Gemini to return **only JSON** — no prose, no markdown code fences
3. Sets the coordinate system: origin at bottom-left, +X right, +Y up, units meters
4. Instructs it to convert feet/inches to meters if dimension labels use imperial
5. Instructs it to read dimension labels visible in the image when present
6. If dimension labels are absent: estimate based on standard room sizes and note this in `ai_notes`
7. For unclear walls (partially obscured, ambiguous): draw best-guess and set `confidence: "low"`
8. If room names are not labeled: use generic names (`Room 1`, `Room 2`, etc.)
9. Places all uncertainties in `ai_notes` (meta) or the `confidence` field (per element)

The few-shot example in the prompt is a simple rectangular floor plan → complete JSON. It demonstrates the schema structure, coordinate system, and how to handle openings.

### Prompt file location

`src/lib/ai/systemPrompt.ts` exports a `buildSystemPrompt()` function that assembles the prompt string. The schema example is inlined in the prompt, not loaded from `json-schema.md` at runtime.

Keep the example in the prompt minimal (one rectangular room, two walls with one door and one window) — enough to demonstrate the format without consuming excessive tokens.

## Response parsing

After the API returns, the response is parsed in `src/lib/ai/parseResponse.ts`:

1. Extract the text content from the Gemini response object
2. Strip any accidental markdown fences (` ```json ``` `) — Gemini sometimes adds these despite instructions
3. `JSON.parse()` the cleaned text
4. Validate against the `FloorPlanSchema` TypeScript types using a runtime schema check (Zod or manual)
5. If valid: return the `FloorPlanSchema` object
6. If invalid: throw a typed `ParseError` with the raw text and error detail

```ts
// src/lib/ai/parseResponse.ts
export type ParseError = {
  type: 'malformed_json' | 'schema_mismatch';
  raw: string;
  detail: string;
};

export function parseGeminiResponse(rawText: string): FloorPlanSchema | never;
```

## Retry logic

If `parseResponse` throws a `ParseError`, the caller attempts **one retry** with an error-correction prompt:

```
The previous response was not valid JSON. Here is the error:
[error detail]

Please return the floor plan as valid JSON only, with no markdown, no prose, and no code fences.
The JSON must match this schema: [schema example]
```

If the retry also fails, the error is surfaced to the user with the raw response shown for debugging.

## Error handling

| Scenario | Behaviour |
|---|---|
| Network failure | Show error toast with retry button |
| Gemini API error (rate limit, quota) | Show specific error message with quota info |
| Malformed JSON (first attempt) | Retry once with correction prompt |
| Malformed JSON (second attempt) | Surface error to user with raw response |
| Schema mismatch (valid JSON, wrong shape) | Surface error, show which fields were missing |
| Empty response | Treat as malformed JSON, retry |

## Handling ambiguous floor plans

Gemini is instructed to never refuse to parse — it should always return a best-effort JSON. The `confidence` field on walls, rooms, and openings communicates uncertainty to the validator and editor.

Expected quality spectrum:
- **Architect PDFs with dimension labels** → high accuracy, minimal corrections needed
- **Real estate photos (clean)** → medium accuracy, some wall positions estimated
- **Hand-drawn sketches** → lower accuracy, more validator flags, more user correction needed
- **Partial/cropped images** → lowest accuracy, many `confidence: "low"` elements

## Multi-pass option (post-v1)

For complex floor plans where Gemini loses coherence across the full schema, a two-pass approach may improve accuracy:

1. **Pass 1:** Extract rooms and overall bounding dimensions only
2. **Pass 2:** For each room, extract wall vertices and openings in detail (room image crop + context)

This is a post-v1 stretch goal. Do not implement until single-pass is proven insufficient.

## File structure

```
src/lib/ai/
  client.ts          # Gemini SDK initialisation
  systemPrompt.ts    # buildSystemPrompt() — assembles the full prompt string
  parseResponse.ts   # parseGeminiResponse() — JSON extraction and schema validation
  index.ts           # analyseFloorPlan(imageBase64, mimeType) — main entry point
```

The `analyseFloorPlan` function is the single entry point used by the upload flow. It handles the full cycle: send → receive → parse → retry → return or throw.
