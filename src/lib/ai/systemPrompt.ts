/**
 * Prompt for the CV-assisted path.
 * Two images are sent to Gemini:
 *   IMAGE 1 — the original floor plan (for reading text labels and dimensions)
 *   IMAGE 2 — the same floor plan with room regions numbered by the CV detector
 *
 * Gemini's only job: match region numbers to names + dimensions, and list openings.
 * No coordinate estimation. No bounding boxes. Geometry comes from the CV stage.
 */
export function buildSemanticPrompt(): string {
  return `You are a floor plan label extractor. You will receive TWO images:

IMAGE 1: The original floor plan.
IMAGE 2: The same floor plan with room regions detected by a computer vision algorithm, each numbered with a white label.

Your task is to match each numbered region to the text labels and dimensions visible in IMAGE 1.

Return ONLY a JSON object — no markdown, no prose, no code fences.

DIMENSION CONVERSION (apply before returning):
- 1 foot = 0.3048 m, 1 inch = 0.0254 m
- "12'0" = 3.658 m, "18'2" = 5.537 m, "10'6" = 3.200 m, "8'4" = 2.540 m
- "7'4" = 2.235 m, "13'0" = 3.962 m, "11'0" = 3.353 m, "15'0" = 4.572 m, "10'3" = 3.124 m

RULES:
- Every numbered region must appear in the output, even if unlabeled (use generic names like "Room 1")
- width_m is the horizontal dimension, depth_m is the vertical dimension of the room
- If a room has only one dimension label, use it for whichever axis fits the region's visual shape
- confidence: "high" if explicit dimension label found, "medium" if name only, "low" if guessed
- wall directions: "north" = top of image, "south" = bottom, "east" = right, "west" = left
- position_along_wall: fraction [0.0, 1.0] along the wall from start to end where the opening center sits
- Return the total floor plan name in floor_name if visible (e.g. "Ground Floor"), else use "Floor 1"
- plan_width_m: sum the widths of all rooms along the widest horizontal row → total plan width in meters
- plan_height_m: sum the depths of all rooms along the tallest vertical column → total plan height in meters

SCHEMA:
{
  "floor_name": "Ground Floor",
  "plan_width_m": 10.5,
  "plan_height_m": 8.2,
  "rooms": [
    {
      "region_id": 1,
      "name": "Living Room",
      "width_m": 3.658,
      "depth_m": 5.537,
      "confidence": "high"
    }
  ],
  "openings": [
    {
      "region_id": 1,
      "type": "door",
      "wall": "east",
      "position_along_wall": 0.5,
      "width_m": 0.9,
      "height_m": 2.1,
      "swing": "inward_left",
      "sill_height_m": null,
      "confidence": "high"
    },
    {
      "region_id": 2,
      "type": "window",
      "wall": "north",
      "position_along_wall": 0.4,
      "width_m": 1.2,
      "height_m": 1.0,
      "swing": null,
      "sill_height_m": 0.9,
      "confidence": "medium"
    }
  ]
}

Now analyse the two floor plan images and return the JSON for the actual floor plan shown.`
}

/**
 * Fallback prompt for the LLM-only path (no CV overlay).
 * Used when CV fails (PDF, too few regions, etc.).
 * This is the full spatial estimation prompt.
 */
export function buildLLMOnlyPrompt(): string {
  return `You are a floor plan parser. Analyse the provided floor plan image and return ONLY a JSON object matching the schema below. No markdown, no prose, no code fences — raw JSON only.

STEP 1 — READ AND CONVERT ALL LABELED DIMENSIONS:
Scan the image for every labeled dimension. Convert each to meters before doing anything else:
- 1 foot = 0.3048m, 1 inch = 0.0254m
- "12'0"" = 3.658m, "18'2"" = 5.537m, "10'6"" = 3.200m, "8'4"" = 2.540m
- "7'4"" = 2.235m, "13'0"" = 3.962m, "11'0"" = 3.353m, "15'0"" = 4.572m, "10'3"" = 3.124m
Write down every (room_name, width_m, depth_m) pair before placing anything.

STEP 2 — DERIVE TOTAL FLOOR PLAN BOUNDS FROM LABELED DIMENSIONS:
Do NOT estimate bounds visually. Calculate them from the labeled rooms:
a) Find the widest row of rooms (rooms side-by-side horizontally). Sum their widths → total plan width.
b) Find the deepest column of rooms (rooms stacked vertically). Sum their depths → total plan height.
Set meta.bounds.width and meta.bounds.height to these calculated values.

STEP 3 — OUTPUT EACH ROOM WITH IMAGE BOUNDING BOX (image_bbox):
Each room must have an image_bbox object with {x0, y0, x1, y1} expressed as IMAGE FRACTIONS in [0.0, 1.0]:
- x0=0.0 = leftmost wall of the entire plan, x1=1.0 = rightmost wall
- y0=0.0 = TOP of the image, y1=1.0 = BOTTOM (Y increases downward)

HOW TO COMPUTE FRACTIONS FROM LABELED DIMENSIONS:
- Fractional width = room_width_m / meta.bounds.width
- Fractional height = room_depth_m / meta.bounds.height
- Sum fractions left-to-right for x, top-to-bottom for y

STEP 4 — OUTPUT OPENINGS AT TOP LEVEL:
Output all doors, windows, and arches as a top-level "openings" array.
Each opening: id, room_id, wall (north/south/east/west), position_along_wall [0,1],
type (door/window/archway), width, height, swing, sill_height, confidence.

DO NOT output a "walls" array.

SCHEMA EXAMPLE:
{
  "meta": {
    "unit": "meters",
    "floor_name": "Ground Floor",
    "source_image": "",
    "bounds": { "width": 10.5, "height": 5.0 },
    "ai_notes": null,
    "schema_version": "1.0"
  },
  "rooms": [
    {
      "id": "room_1",
      "name": "Living Room",
      "image_bbox": { "x0": 0.0, "y0": 0.0, "x1": 0.348, "y1": 1.0 },
      "floor_material": "hardwood",
      "ceiling_height": 2.7,
      "confidence": "high"
    }
  ],
  "openings": [
    {
      "id": "opening_1",
      "room_id": "room_1",
      "wall": "east",
      "position_along_wall": 0.3,
      "type": "door",
      "width": 0.9,
      "height": 2.1,
      "swing": "inward_left",
      "sill_height": null,
      "confidence": "high"
    }
  ],
  "structural": [],
  "furniture": [],
  "annotations": [],
  "issues": []
}

Now analyse the provided floor plan image and return the JSON for the actual floor plan shown.`
}
