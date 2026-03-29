# Walkaround — Project Design Document

> A personal, browser-based tool that converts a house or apartment floor plan image into an interactive, editable 3D viewer.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Core User Flow](#2-core-user-flow)
3. [Tech Stack](#3-tech-stack)
4. [AI Parsing Layer](#4-ai-parsing-layer)
5. [JSON Schema](#5-json-schema)
6. [Validation Layer](#6-validation-layer)
7. [2D Editor](#7-2d-editor)
8. [3D Viewer](#8-3d-viewer)
9. [Furniture System](#9-furniture-system)
10. [Camera System](#10-camera-system)
11. [UI Layout](#11-ui-layout)
12. [Constraints & Scope](#12-constraints--scope)
13. [Open Questions & De-risk Prototypes](#13-open-questions--de-risk-prototypes)
14. [Feature Backlog](#14-feature-backlog)
15. [Build Order & MVP](#15-build-order--mvp)

---

## 1. Project Overview

**Walkaround** is a fun personal tool that lets you:

1. Upload a photo or PDF of any floor plan
2. Have AI (Gemini 2.5 Flash) automatically parse the walls, rooms, doors, windows, and dimensions
3. View the result as an interactive 3D scene
4. Edit the floor plan in a full 2D editor if the AI got anything wrong
5. Furnish rooms with 3D objects, repaint walls, annotate dimensions
6. Walk through the space in first-person mode

### Design Philosophy

- **Personal tool** — no auth, no backend, no multi-user complexity
- **AI-first, human fallback** — Gemini does the heavy lifting; the editor catches its mistakes
- **Desktop only** — no mobile layout concerns for now
- **Single floor** — no multi-storey support in v1
- **Session-fresh** — no persistence between sessions; everything lives in memory

---

## 2. Core User Flow

```
1. User opens Walkaround in browser
2. Uploads a floor plan image (JPG, PNG) or PDF
3. Image is sent to Gemini 2.5 Flash API with a structured prompt
4. Gemini returns a JSON object describing the floor plan
5. Validator runs on the JSON — flags errors and warnings
6. App renders:
     - 2D editor (left panel) showing the parsed floor plan with any issue flags
     - 3D scene (main panel) showing extruded walls
7. User reviews flagged issues in the 2D editor and fixes as needed
8. User furnishes the space, changes materials, adds annotations
9. User enters first-person mode and walks through the space
```

---

## 3. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | React + Vite | Fast dev, component model, good R3F support |
| Styling | Tailwind CSS | Utility-first, no CSS overhead |
| 3D engine | Three.js via React Three Fiber (R3F) | Battle-tested 3D, React-friendly bindings |
| 3D helpers | @react-three/drei | Orbit controls, GLTF loader, grid, etc. |
| 2D editor | Konva.js (or Canvas 2D API — TBD) | Interactive canvas with drag/select/snap |
| AI | Gemini 2.5 Flash API (Google AI Studio) | Free tier, vision capable, 250 req/day |
| 3D models | Kenney.nl CC0 assets (GLTF/GLB) | Free, consistent style, no licensing issues |
| State | Zustand | Lightweight global state for floor plan data |
| Undo/redo | Custom stack via Zustand middleware | Required for editor |
| Hosting | Vercel free tier | Zero config, free for personal projects |

### Why Gemini 2.5 Flash specifically

- Free tier: 10 RPM, 250 requests/day — more than enough for personal use
- Vision capable — can read and interpret floor plan images
- 1M token context window — can handle large, detailed prompts with schema examples
- No credit card required

### Note on 2D editor rendering

The choice between **Konva.js**, raw **Canvas 2D API**, and **SVG** is unresolved and should be prototyped. Key requirements are:
- Drag-and-drop vertex editing
- Snap-to-grid and snap-to-vertex
- Pan and zoom
- Hit testing on thin wall lines
- Live dimension labels while dragging

---

## 4. AI Parsing Layer

### The prompt strategy

Gemini is sent the floor plan image along with a system prompt that:
1. Explains the expected JSON schema (with an example)
2. Instructs it to extract real-world units from dimension labels visible in the image
3. Instructs it to use meters as the output unit (converting from feet/inches if needed)
4. Sets the coordinate origin at the **bottom-left corner** of the floor plan bounding box
5. Instructs it to treat the positive X axis as right, positive Y axis as up (top of image)
6. Asks it to identify rooms by name if labeled (Kitchen, Bedroom, etc.)
7. Asks it to flag anything it's uncertain about in an `ai_notes` field

### Handling ambiguity

- If dimension labels are absent, Gemini should estimate based on standard room sizes and note it
- If a wall is unclear (e.g. partially obscured), it should draw a best-guess and set `"confidence": "low"` on that wall
- If room names are not labeled, use generic names: Room 1, Room 2, etc.

### Multi-pass option (stretch goal)

For complex plans, a two-pass approach may work better:
1. Pass 1: Extract rooms and overall bounding dimensions
2. Pass 2: For each room, extract wall vertices and openings in detail

This reduces the chance of Gemini losing track of the full schema in one large response.

### Prompt engineering notes (to be expanded during implementation)

- Provide a few-shot example of a simple floor plan → JSON in the prompt
- Explicitly tell Gemini to return **only JSON**, no prose, no markdown fences
- Validate that the response is parseable before passing to the validator
- If JSON is malformed, retry once with an error correction prompt

---

## 5. JSON Schema

This is the canonical data format for a parsed floor plan. It is the single source of truth shared between the AI parser, validator, 2D editor, and 3D renderer.

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

  "furniture": [],

  "annotations": [],

  "issues": []
}
```

### Schema design decisions

- **Walls are separate from rooms** — walls reference which rooms they border via `room_ids`. This handles shared walls cleanly and makes the editor more flexible.
- **Walls use polyline vertices** — not just start/end points. A straight wall has 2 vertices; an angled or curved wall has more. This handles bay windows, diagonal walls, alcoves, etc.
- **Openings belong to walls** — positioned by `position_along_wall` (0.0 = start vertex, 1.0 = end vertex, 0.5 = midpoint).
- **Confidence field** — on walls, rooms, and openings. Values: `"high"`, `"medium"`, `"low"`. Low-confidence elements are flagged visually in the editor.
- **Structural elements** — columns, stairs, built-ins tracked separately from walls.
- **Furniture and annotations** — empty arrays initially, populated by the user during editing.
- **Issues array** — populated by the validator, not by Gemini.

---

## 6. Validation Layer

The validator runs immediately after Gemini returns JSON, before anything is rendered. It produces an annotated version of the same JSON with an `issues` array populated.

### Issue structure

```json
{
  "id": "issue_1",
  "severity": "error",
  "type": "disconnected_wall",
  "message": "Wall wall_3 has no connection at its endpoint (5.2, 0.0)",
  "affected_ids": ["wall_3"],
  "auto_fixable": true,
  "auto_fix_description": "Snap endpoint to nearest wall vertex within 5cm threshold"
}
```

### Severity levels

| Level | Colour | Meaning |
|---|---|---|
| `error` | 🔴 Red | Geometry is broken. 3D cannot render correctly. Must fix. |
| `warning` | 🟡 Yellow | Suspicious but renderable. Should review. |
| `info` | 🔵 Blue | Minor note. Probably fine. Can dismiss. |

### Validation checks

**Geometric integrity**
- Walls with a dangling endpoint (not connected to any other wall or vertex)
- Near-miss vertices — endpoints within 2cm of each other but not snapped (auto-fixable: snap them)
- Walls that intersect each other without a shared vertex
- Room polygons that don't close (last vertex doesn't return to first — auto-fixable)
- Overlapping walls (two walls sharing the same path)
- Zero-length walls

**Dimensional consistency**
- Room polygon area vs. labeled dimensions don't agree (tolerance: >15% discrepancy = warning)
- Wall length doesn't match any nearby dimension label
- Implausibly small room (< 1m² — likely a misparse)
- Implausibly large floor plan (> 1000m² — likely a unit error, e.g. parsed feet as meters)
- Ceiling heights outside normal range (< 2.0m or > 5.0m — warning)

**Opening integrity**
- Opening wider than its parent wall
- Opening position that places it outside the wall bounds
- Two openings overlapping on the same wall
- Door with `swing` direction pointing into a wall
- Room with no openings of any kind (sealed room — likely a misparse)

**Topological sense**
- Room with no adjacent walls
- Isolated room — not sharing any walls with the rest of the floor plan
- Fully overlapping rooms
- Floor plan contains only one room (Gemini likely failed to segment)

### Auto-fix behaviour

Fixes that are safe to apply silently (no user input needed):
- Snap near-miss vertices within 2cm threshold
- Close unclosed room polygons where last vertex is within 2cm of first
- Clamp out-of-bounds opening positions to wall length

Everything else is flagged for the user. Auto-fixes are logged so the user can see what was changed.

### Re-validation

Every time the user edits something in the 2D editor, the affected validations re-run on that element. If fixed, the issue clears automatically. Issues are never stale.

---

## 7. 2D Editor

The 2D editor is the primary correction and editing surface. It renders the parsed floor plan as an overhead (top-down) view and lets the user fix AI mistakes and make design changes.

### Core interactions

| Action | Behaviour |
|---|---|
| Click wall | Select wall, show properties panel |
| Click vertex | Select vertex, show coordinates |
| Drag vertex | Move vertex, walls connected to it follow, re-validate live |
| Click room | Select room, show room properties |
| Double-click room label | Edit room name inline |
| Click opening | Select door/window, show opening properties |
| Drag opening | Reposition along wall |
| Right-click wall | Context menu: Add vertex, Delete wall, Add opening |
| Right-click canvas | Context menu: Add wall (start drawing) |
| Scroll | Zoom in/out |
| Middle-drag or Space+drag | Pan canvas |

### Drawing new walls

- Click to start a wall at a point
- Click again to place the next vertex
- Double-click to end the wall
- Snaps to existing vertices and grid points while drawing
- Escape cancels the current wall being drawn

### Snap system

- **Snap to grid** — configurable grid size (default 10cm)
- **Snap to vertex** — within a pixel threshold, snaps to nearest existing vertex
- **Snap to wall midpoint** — snaps to the midpoint of any wall
- **Snap to wall extension** — shows guide lines extending from existing walls (like CAD)
- Toggle snapping on/off with a toolbar button

### Issue visualisation

- Walls/rooms with errors get a red outline
- Walls/rooms with warnings get a yellow outline
- Hovering an issue in the issues panel highlights the affected element in the canvas and vice versa
- A "jump to" button in the issues panel pans and zooms the canvas to the affected element

### Issues panel

- Collapsible sidebar within the 2D editor
- Lists all issues grouped by severity
- Each issue has: severity icon, message, affected element name, "Jump to" button
- Errors at top, then warnings, then info
- User can dismiss info-level issues
- Issue count badge shown on panel toggle when collapsed

### Dimension labels

- Every wall shows its length in meters as a label along the wall while in the editor
- Labels update live while dragging vertices
- User can click a dimension label to type an exact value — snaps the wall endpoint to match

### Undo/redo

- Full undo/redo stack (Ctrl+Z / Ctrl+Shift+Z)
- Every vertex move, wall add/delete, opening change is a discrete undoable action
- Undo stack is cleared on new file upload

### Properties panel

When an element is selected in the 2D editor, the right panel shows editable properties:

**Wall selected:**
- Thickness (meters)
- Height (meters)
- Material dropdown
- Exterior/interior toggle
- List of openings on this wall

**Room selected:**
- Name (text input)
- Floor material dropdown
- Ceiling height (meters)
- Calculated area (read-only)

**Opening selected:**
- Type (door / window / archway)
- Width, height (meters)
- Position along wall (meters from start)
- Swing direction (doors only)
- Sill height (windows only)

---

## 8. 3D Viewer

The 3D viewer renders the floor plan JSON as a live 3D scene. It updates in real time as the user edits the 2D plan.

### Geometry generation

From the JSON schema, the 3D renderer builds:

- **Floor** — a flat plane covering the room polygon footprint, per room (allows different floor materials per room)
- **Walls** — extruded from wall polyline vertices to wall height, with wall thickness applied outward from the inner face
- **Openings** — Boolean subtraction from wall geometry (CSG) to cut door and window holes
- **Ceiling** — optional flat plane at ceiling height (can be toggled off for overhead clarity)
- **Structural elements** — columns as box geometry, stairs as a placeholder box in v1

### Wall thickness approach

Walls are offset outward from their inner face by the thickness value. Corner joints are mitre-joined where two walls meet. This requires computing corner angles and adjusting vertex positions — a non-trivial geometry step.

### Materials

Default materials on load:
- Walls: flat white/cream
- Floor: light wood texture (or solid colour per material type)
- Ceiling: off-white

User can override per wall or per room via the properties panel.

### Real-time sync

The 3D scene listens to the same Zustand store as the 2D editor. Any change in the editor (vertex moved, wall added, material changed) triggers a geometry rebuild for the affected element only — not a full scene rebuild.

### Lighting

Default lighting setup:
- Ambient light (soft, fills shadows)
- Directional light from above-left (simulates daylight)
- Optional: hemisphere light for sky/ground colour bounce

Stretch goal: day/night toggle that shifts light colour and intensity.

---

## 9. Furniture System

### Library

Furniture is sourced from **Kenney.nl CC0 3D assets** (GLTF/GLB format), supplemented by simple primitive shapes where models aren't available.

Categories:
- Seating (sofa, armchair, dining chair, office chair)
- Tables (dining table, coffee table, desk, side table)
- Beds (single, double, king)
- Storage (wardrobe, bookshelf, cabinet, dresser)
- Kitchen (counter, island, appliances)
- Bathroom (toilet, sink, bathtub, shower)
- Misc (rug, lamp, plant, TV)

### Placement flow

1. User opens furniture sidebar (right panel)
2. Clicks a furniture item
3. Item appears at the centre of the currently selected room
4. User clicks the item in the 3D view to select it
5. Transform handles appear: move (XZ plane only), rotate (Y axis only)
6. User drags to position
7. Furniture snaps to a grid (default 10cm) for clean placement

### GLTF normalisation

Each GLTF model needs a normalisation wrapper on load that:
- Corrects scale to real-world meters
- Corrects rotation so Y is up
- Centres the pivot point at the base (floor level)

This is applied per-model and stored in a model registry config file.

### Furniture in the JSON schema

```json
{
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
  ]
}
```

---

## 10. Camera System

Two camera modes with a toggle button in the toolbar.

### Orbit mode (default)

- `OrbitControls` from `@react-three/drei`
- Rotate: left-click drag
- Pan: right-click drag
- Zoom: scroll wheel
- Default position: above the floor plan looking down at a 45° angle
- Can be reset to default with a "Reset camera" button

### First-person mode

- `PointerLockControls` from Three.js
- Click the 3D view to lock the pointer
- Mouse movement: look left/right/up/down
- WASD or arrow keys: move forward/back/strafe left/right
- Eye height: 1.6m above floor
- Movement speed: configurable (default ~1.4 m/s walking pace)
- Press Escape to exit pointer lock and return to orbit mode

### Collision detection

Basic AABB (axis-aligned bounding box) collision against wall geometry:
- Camera position is tested against wall bounding boxes each frame
- If a move would intersect a wall, it is blocked
- Allows sliding along walls (resolve only the penetration axis)
- Does not prevent clipping through very thin geometry — acceptable for v1

### Mode toggle

A button in the 3D toolbar toggles between orbit and first-person. When switching to first-person, camera position is preserved at floor level. When switching back to orbit, camera returns to the last orbit position.

---

## 11. UI Layout

Three-panel desktop layout:

```
┌─────────────────────────────────────────────────────────────────┐
│  Toolbar: Logo | Upload | Mode toggle | Undo/Redo | Settings    │
├──────────────────────┬──────────────────────────────────────────┤
│                      │                                          │
│   2D Editor          │   3D Viewer                              │
│                      │                                          │
│   - Floor plan       │   - Three.js scene                       │
│   - Snap controls    │   - Camera controls                      │
│   - Issues panel     │   - Lighting                             │
│   (collapsible)      │                                          │
│                      │                                          │
├──────────────────────┴──────────────────────────────────────────┤
│  Properties panel (context-sensitive) | Furniture library        │
└─────────────────────────────────────────────────────────────────┘
```

- Top toolbar: global actions
- Left panel: 2D editor (resizable, min width 320px)
- Right/main panel: 3D viewer (takes remaining space)
- Bottom panel: properties + furniture (collapsible, ~280px tall)
- Issues panel: collapsible sidebar within the 2D editor

### Upload state

On first load (before any file is uploaded), the 3D viewer panel shows a large drag-and-drop zone with instructions. Once a file is uploaded and parsed, the layout switches to the three-panel view.

### Loading state

While Gemini is processing:
- Overlay on the 3D panel with a progress indicator
- Message: "Analysing floor plan…"
- Followed by: "Running validation…"
- Followed by: "Building 3D scene…"

---

## 12. Constraints & Scope

### In scope (v1)

- Image upload (JPG, PNG, PDF single page)
- Gemini AI parsing
- Validation layer with error/warning/info levels
- Full 2D editor with vertex editing, wall add/delete, opening management
- 3D scene with extruded walls, floors, ceilings
- Orbit camera
- First-person camera with basic collision
- Furniture placement from a library
- Wall and floor material/colour changes
- Dimension annotations
- Undo/redo

### Out of scope (v1)

- User accounts / authentication
- Cloud save / persistence between sessions
- Multi-floor / multi-storey
- Mobile layout
- PDF multi-page support
- Curved wall geometry (approximated with polyline segments)
- Roof geometry
- Lighting design beyond basic presets
- Export (OBJ, glTF, PDF render, screenshot)
- Collaboration / sharing
- Gemini multi-pass parsing

---

## 13. Open Questions & De-risk Prototypes

These are the known unknowns that should be prototyped **before** building the full application. They could change architecture decisions if the answer is "this doesn't work well."

### 1. Gemini floor plan parsing accuracy

**Risk:** Gemini may not reliably return well-structured JSON with correct coordinates for complex floor plans.

**Prototype:** Send 10–15 varied floor plan images to Gemini 2.5 Flash with the planned schema prompt. Evaluate:
- Does it return valid JSON every time?
- Are room polygons geometrically correct?
- Does it correctly read dimension labels and convert to meters?
- How does it handle hand-drawn plans vs. architect PDFs vs. real estate photos?
- How often does the validator catch errors?

**Fallback if it fails:** Simplify the schema, add a multi-pass prompting strategy, or make manual tracing the primary input method with AI as optional enhancement.

### 2. React Three Fiber + PointerLockControls integration

**Risk:** Switching between orbit and first-person modes cleanly, combined with WASD movement and collision, may have subtle state bugs in R3F.

**Prototype:** Build a minimal R3F scene with a box room, implement both camera modes, test the transition, implement basic collision.

### 3. 2D editor rendering approach

**Risk:** The choice of Konva.js vs. raw Canvas 2D vs. SVG affects the entire editor architecture.

**Prototype:** Build a minimal wall editor with 3 walls, vertex dragging, snap-to-vertex, and pan/zoom in each candidate and compare feel and code complexity.

---

## 14. Feature Backlog

Post-v1 ideas, in rough priority order:

- **Screenshot / export** — save a render of the 3D view as PNG
- **First-person collision polish** — stair handling, door opening animations
- **Curved wall support** — bezier curve walls with configurable segments
- **Day/night lighting toggle**
- **Shadow rendering** — soft shadows for realism
- **Multi-floor support** — add/switch floors, staircases
- **Roof generator** — auto-generate a simple roof from the outer wall polygon
- **Local storage save** — persist the current session to localStorage
- **Export to glTF** — export the full furnished scene
- **Annotation tools** — arrows, text labels, area labels
- **Room statistics panel** — total area, room count, room areas
- **Gemini re-parse** — re-run AI parsing on a different image without losing furniture
- **Custom furniture import** — drag in your own GLB file
- **Texture upload** — use a custom image as a wall or floor texture

---

## 15. Build Order & MVP

Recommended implementation sequence to de-risk early and build on stable foundations:

### Phase 0 — De-risk (before full build)
1. Gemini parsing prototype (10–15 test images)
2. R3F camera modes prototype
3. 2D editor rendering decision

### Phase 1 — Core pipeline
1. Project scaffold: React + Vite + Tailwind + R3F + Zustand
2. File upload UI
3. Gemini API integration + prompt
4. JSON schema types/interfaces
5. Validator (geometric integrity checks only)
6. Basic 3D scene: flat floor + extruded walls (no openings yet)
7. Orbit camera

### Phase 2 — Editor
1. 2D editor canvas (chosen library)
2. Wall rendering in 2D
3. Vertex drag editing
4. Issues panel
5. Snap system (grid + vertex)
6. Dimension labels
7. Undo/redo

### Phase 3 — 3D completeness
1. Door/window openings in 3D geometry (CSG)
2. Wall thickness corner joints
3. Materials/colours system
4. First-person camera + collision

### Phase 4 — Furniture
1. GLTF model loader + normalisation
2. Furniture sidebar
3. Placement and transform controls

### Phase 5 — Polish
1. Full validation suite
2. Loading states and error handling
3. Properties panel (all element types)
4. Annotations
5. UI polish

---

*Document version: 1.0 — Generated from design conversation. Intended as input for Claude Code to expand into full technical documentation and implement.*
