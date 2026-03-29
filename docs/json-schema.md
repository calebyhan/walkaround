# JSON Schema

The floor plan JSON schema is the canonical data format shared by every layer: AI output, validator, 2D editor, and 3D renderer. TypeScript types live in `src/lib/schema/`.

## Full example

```json
{
  "meta": {
    "unit": "meters",
    "floor_name": "Ground Floor",
    "source_image": "filename.jpg",
    "bounds": {
      "width": 12.4,
      "height": 9.8
    },
    "ai_notes": "Dimension labels were partially obscured on the east wall. Estimated from context.",
    "schema_version": "1.0"
  },

  "rooms": [
    {
      "id": "room_1",
      "name": "Living Room",
      "vertices": [
        { "x": 0.0, "y": 0.0 },
        { "x": 5.2, "y": 0.0 },
        { "x": 5.2, "y": 4.1 },
        { "x": 0.0, "y": 4.1 }
      ],
      "floor_material": "hardwood",
      "ceiling_height": 2.7,
      "confidence": "high"
    }
  ],

  "walls": [
    {
      "id": "wall_1",
      "room_ids": ["room_1", "room_2"],
      "vertices": [
        { "x": 0.0, "y": 0.0 },
        { "x": 5.2, "y": 0.0 }
      ],
      "thickness": 0.2,
      "height": 2.7,
      "material": "plaster",
      "is_exterior": true,
      "confidence": "high",
      "openings": [
        {
          "id": "opening_1",
          "type": "door",
          "position_along_wall": 0.5,
          "width": 0.9,
          "height": 2.1,
          "swing": "inward_left",
          "confidence": "high"
        },
        {
          "id": "opening_2",
          "type": "window",
          "position_along_wall": 0.2,
          "width": 1.2,
          "height": 1.0,
          "sill_height": 0.9,
          "confidence": "high"
        }
      ]
    }
  ],

  "structural": [
    {
      "id": "col_1",
      "type": "column",
      "x": 2.6,
      "y": 2.0,
      "width": 0.3,
      "depth": 0.3,
      "height": 2.7
    },
    {
      "id": "stair_1",
      "type": "stairs",
      "x": 8.0,
      "y": 1.0,
      "width": 1.0,
      "depth": 2.5,
      "note": "Stairs present but not modelled in 3D in v1"
    }
  ],

  "furniture": [
    {
      "id": "furn_1",
      "model_id": "sofa_2seat",
      "x": 2.5,
      "y": 1.8,
      "rotation_y": 90,
      "room_id": "room_1",
      "label": "Sofa"
    }
  ],

  "annotations": [],

  "issues": []
}
```

---

## Field reference

### `meta`

| Field | Type | Description |
|---|---|---|
| `unit` | `"meters"` | Always meters. Gemini converts from feet/inches if needed. |
| `floor_name` | `string` | Display name for this floor level. Default: `"Ground Floor"`. |
| `source_image` | `string` | Original filename of the uploaded image. |
| `bounds.width` | `number` | Total width of the floor plan bounding box in meters. |
| `bounds.height` | `number` | Total height (depth) of the floor plan bounding box in meters. |
| `ai_notes` | `string \| null` | Free-text notes from Gemini about uncertainties or assumptions. |
| `schema_version` | `string` | Schema version. Currently `"1.0"`. |

### `rooms[]`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique ID, format `room_N`. |
| `name` | `string` | Human-readable room name. Generic fallback: `"Room 1"`, `"Room 2"`, etc. |
| `vertices` | `Point[]` | Ordered polygon vertices defining the room footprint. Origin bottom-left, +X right, +Y up. |
| `floor_material` | `string` | Material identifier. e.g. `"hardwood"`, `"tile"`, `"carpet"`. |
| `ceiling_height` | `number` | Height of ceiling above floor in meters. |
| `confidence` | `"high" \| "medium" \| "low"` | Gemini's confidence in this room's geometry. Low values are flagged in the editor. |

### `walls[]`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique ID, format `wall_N`. |
| `room_ids` | `string[]` | IDs of rooms this wall borders. Exterior walls have one entry; shared walls have two. |
| `vertices` | `Point[]` | Ordered polyline defining the wall centreline. Minimum 2 points. More for angled/complex walls. |
| `thickness` | `number` | Wall thickness in meters. Default `0.2`. |
| `height` | `number` | Wall height in meters. Should match `ceiling_height` of adjacent rooms. |
| `material` | `string` | Surface material identifier. e.g. `"plaster"`, `"brick"`, `"concrete"`. |
| `is_exterior` | `boolean` | Whether this is an exterior (outer) wall. |
| `confidence` | `"high" \| "medium" \| "low"` | Gemini's confidence. |
| `openings` | `Opening[]` | Doors and windows on this wall. See below. |

### `walls[].openings[]`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique ID, format `opening_N`. |
| `type` | `"door" \| "window" \| "archway"` | Opening type. |
| `position_along_wall` | `number` | Position as a fraction of wall length. `0.0` = start vertex, `1.0` = end vertex, `0.5` = midpoint. Refers to the centre of the opening. |
| `width` | `number` | Opening width in meters. |
| `height` | `number` | Opening height in meters. |
| `swing` | `"inward_left" \| "inward_right" \| "outward_left" \| "outward_right" \| null` | Door swing direction. Null for windows and archways. |
| `sill_height` | `number \| null` | Height of window sill above floor in meters. Null for doors and archways. |
| `confidence` | `"high" \| "medium" \| "low"` | Gemini's confidence. |

### `structural[]`

Columns, stairs, and built-in elements that are not walls.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique ID, format `col_N` or `stair_N` etc. |
| `type` | `"column" \| "stairs" \| "builtin"` | Element type. |
| `x`, `y` | `number` | Position of the element's bottom-left corner in floor plan coordinates. |
| `width`, `depth` | `number` | Footprint dimensions in meters. |
| `height` | `number` | Height in meters. |
| `note` | `string \| null` | Optional free-text note. |

### `furniture[]`

User-placed furniture items. Empty array on initial parse; populated during editing.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique ID, format `furn_N`. |
| `model_id` | `string` | Key into the furniture model registry (see [furniture.md](furniture.md)). |
| `x`, `y` | `number` | Position of the item's centre in floor plan coordinates. |
| `rotation_y` | `number` | Rotation in degrees around the vertical axis. |
| `room_id` | `string` | ID of the room this item belongs to. |
| `label` | `string` | Display name. Can be edited by the user. |

### `annotations[]`

User-added dimension annotations and text labels. Empty in v1 — structure TBD during Phase 5.

### `issues[]`

Populated by the validator, never by Gemini. See [validation.md](validation.md) for the full issue structure.

---

## Coordinate system

- Origin `(0, 0)` at the **bottom-left** corner of the floor plan bounding box
- **+X** = right
- **+Y** = up (towards the top of the original image)
- Units: meters
- 3D renderer maps these to Three.js coordinates: X→X, Y→Z (floor plane), Z is the vertical axis

## Design decisions

**Walls are separate from rooms.** Rooms define a polygon footprint for visual rendering and material assignment. Walls define the actual geometry — the extruded surfaces with thickness, openings, and materials. A shared wall between two rooms belongs to both rooms via `room_ids`. This prevents duplication and makes the editor cleaner.

**Walls use polyline vertices, not just start/end.** A two-vertex wall is a straight segment. More vertices support angled walls, bay windows, diagonal runs, and alcoves without special-casing.

**Openings use fractional `position_along_wall`.** This is invariant under wall scaling and makes it easy for the editor to reposition openings as a drag along the wall. The 3D renderer converts to world coordinates at render time.

**The `issues` array is validator-only.** Gemini's uncertainties go in `ai_notes` (meta level) or `confidence` fields (per element). The `issues` array is always computed from geometry, never from AI output.
