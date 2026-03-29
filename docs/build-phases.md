# Build Phases

Recommended implementation sequence designed to de-risk early and build on stable foundations. Do not start a later phase until the current phase is solid.

See [CLAUDE.md](../CLAUDE.md) for the current phase status.

---

## Phase 0 — De-risk prototypes

**Goal:** Validate the three highest-risk unknowns before committing to full implementation. If any prototype fails, architecture decisions change.

### Prototype 1: Gemini floor plan parsing accuracy

**Risk:** Gemini may not reliably return well-structured JSON with correct coordinates.

**Test:**
- Send 10–15 varied floor plan images to Gemini 2.5 Flash with the planned schema prompt
- Include: architect PDFs with dimension labels, real estate JPGs, hand-drawn sketches

**Evaluate:**
- Does it return valid JSON every time? (or how often?)
- Are room polygons geometrically plausible?
- Does it correctly read dimension labels and convert to meters?
- How does it handle hand-drawn plans vs. architect PDFs vs. real estate photos?
- How often does the validator catch and flag errors?

**Pass criteria:** Valid JSON on ≥80% of attempts; plausible geometry on ≥60%.

**Fallback if fails:** Simplify the schema (fewer fields per element), add multi-pass prompting, or make manual tracing the primary input with AI as optional enhancement.

### Prototype 2: R3F camera modes

**Risk:** Switching between orbit and first-person modes cleanly in R3F, with WASD movement and collision, may have subtle state bugs.

**Build:** Minimal R3F scene — one box room (4 walls). Implement:
- Orbit mode with OrbitControls
- First-person mode with PointerLockControls + WASD
- Mode transition (orbit → FP → orbit)
- Basic AABB collision against the 4 walls

**Pass criteria:** Mode transitions are clean and stable; collision prevents walking through walls.

### Prototype 3: 2D editor rendering approach

**Risk:** The choice of Konva.js vs raw Canvas 2D vs SVG affects the entire editor architecture.

**Build:** Minimal wall editor with:
- 3 connected walls rendered
- Vertex dragging
- Snap-to-vertex
- Pan and zoom

Build in each candidate (Konva, Canvas 2D, SVG). Compare:
- Drag feel and hit-testing quality on thin lines
- Ease of implementing snap guides as ephemeral overlays
- Pan/zoom transform model
- Code complexity

**Pass criteria:** Pick the best candidate. Document the decision in [architecture.md](architecture.md).

---

## Phase 1 — Core pipeline

**Goal:** Upload image → Gemini parse → validate → 3D scene with basic geometry. No editing yet.

1. Project scaffold: React + Vite + Tailwind + R3F + Zustand
2. `.env.local` setup with Gemini API key
3. File upload UI (drag-and-drop zone + file picker)
4. Gemini API integration — `src/lib/ai/`
5. JSON schema TypeScript types — `src/lib/schema/`
6. Response parser (`parseResponse.ts`) with retry logic
7. Validator — geometric integrity checks only (not full suite yet)
8. Zustand store — `floorPlanSlice`, basic `historySlice`
9. Basic 3D scene: flat floor meshes + extruded wall meshes (no openings, no thickness yet)
10. Orbit camera
11. Loading states: "Analysing floor plan…" → "Running validation…" → "Building 3D scene…"

**Exit criteria:** Upload a real floor plan image and see a recognisable 3D room layout.

---

## Phase 2 — 2D Editor

**Goal:** Full editing capability for fixing AI errors.

1. 2D editor canvas setup (chosen rendering library from Phase 0)
2. Wall rendering in 2D (lines with thickness indication)
3. Room polygon fill rendering
4. Vertex drag editing with live re-validation
5. Snap system (grid + vertex snap)
6. Dimension labels (live update during drag)
7. Wall draw mode (click to add new walls)
8. Issues panel (collapsible, severity grouping, jump-to)
9. Issue visualisation on canvas (red/yellow outlines)
10. Undo/redo stack — `historySlice` middleware complete
11. Properties panel — wall and room properties

**Exit criteria:** Can fix a floor plan with 5+ AI errors using the editor, with undo/redo working.

---

## Phase 3 — 3D completeness

**Goal:** Accurate 3D geometry matching the real floor plan.

1. Wall thickness with mitre corner joints
2. Door/window opening cutouts (CSG) in wall geometry
3. Ceiling meshes (toggleable)
4. Structural element rendering (columns as boxes, stairs as placeholder)
5. Materials / colour system — wall material dropdown, floor material dropdown
6. Material registry (`src/lib/geometry/materials.ts`)
7. First-person camera + WASD movement
8. Basic AABB collision against walls

**Exit criteria:** The 3D scene accurately represents the floor plan with openings and correct wall corners; first-person walk-through is functional.

---

## Phase 4 — Furniture

**Goal:** Place and arrange 3D furniture in the scene.

1. Model registry (`src/assets/models/registry.ts`) with initial model list
2. GLTF loader + normalisation (`normaliseFurniture.ts`)
3. Furniture library sidebar (categories + item grid)
4. Furniture placement: click item → appears in selected room
5. Selection in 3D view (click mesh → select)
6. Move transform: drag on floor plane with grid snap
7. Rotate transform: rotation ring on Y axis
8. Furniture schema integration (save position/rotation to store)
9. Properties panel: furniture label edit

**Exit criteria:** Can place, move, and rotate at least 5 furniture types; state persists in the schema.

---

## Phase 5 — Polish

**Goal:** Complete validation suite, UI polish, edge case handling.

1. Full validation suite (all checks in [validation.md](validation.md))
2. Auto-fix log display (show user what was silently fixed)
3. Properties panel — opening properties (door swing, window sill height)
4. Opening snap: drag to reposition along wall with `position_along_wall` update
5. Dimension label editing (click label → type exact value)
6. Wall extension snap in the 2D editor
7. Error handling for Gemini API failures (rate limits, network errors)
8. Toolbar polish (icons, keyboard shortcuts)
9. Upload state UX (drag highlight, file type validation, size limit)
10. Performance pass: profile geometry rebuild times, optimise if >16ms per edit

**Exit criteria:** Walkaround can handle a complex real floor plan end-to-end with good UX.

---

## V1 scope

### In scope

- Image upload (JPG, PNG, PDF single page)
- Gemini AI parsing with structured prompt
- Validation layer with error / warning / info levels
- Full 2D editor: vertex editing, wall add/delete, opening management
- 3D scene: extruded walls, floors, ceilings
- Orbit camera
- First-person camera with basic AABB collision
- Furniture placement from a built-in library
- Wall and floor material / colour changes
- Dimension annotations
- Undo/redo

### Out of scope (v1)

- User accounts / authentication
- Cloud save / persistence between sessions
- Multi-floor / multi-storey
- Mobile layout
- PDF multi-page support
- Curved wall geometry (approximated with polyline segments in v1)
- Roof geometry
- Lighting design beyond basic presets
- Export (OBJ, glTF, PDF render, screenshot)
- Collaboration / sharing
- Gemini multi-pass parsing

---

## Post-v1 backlog

In rough priority order:

- Screenshot / PNG export of the 3D view
- First-person collision polish (door opening animations, stair handling)
- Day/night lighting toggle
- Shadow rendering (soft shadows)
- Curved wall support (bezier curve with configurable polyline segments)
- Local storage save — persist current session to `localStorage`
- Multi-floor support — add/switch floors, staircases
- Roof generator — auto-generate simple roof from outer wall polygon
- Export to glTF — export full furnished scene
- Annotation tools — arrows, text labels, area labels
- Room statistics panel — total area, room count
- Gemini re-parse — re-run AI parsing on a different image without losing furniture
- Custom furniture import — drag in user's own GLB file
- Texture upload — use custom image as wall or floor texture

---

## Current status

> **Phase 0 — nothing built yet.** Start with the three de-risk prototypes before writing any application code.
