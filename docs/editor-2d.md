# 2D Editor

The 2D editor is the primary correction and editing surface. It renders the parsed floor plan as a top-down view and lets the user fix AI mistakes and make design changes.

Lives in `src/components/editor/`.

## Rendering library

**TBD** — the choice between Konva.js, raw Canvas 2D API, and SVG is deferred to the Phase 0 prototype. See [build-phases.md](build-phases.md#phase-0--de-risk-prototypes).

Requirements the chosen library must satisfy:
- Drag-and-drop vertex editing with hit testing on thin lines
- Snap-to-grid and snap-to-vertex
- Pan and zoom (mouse wheel + drag)
- Live dimension labels that update during drag
- Performance adequate for ~100 wall segments without jank

## Canvas layers

The editor canvas uses a layered structure (regardless of rendering library):

| Layer | Contents |
|---|---|
| Background | Grid lines |
| Rooms | Filled room polygons (semi-transparent) |
| Walls | Wall line segments, thickness indicated |
| Openings | Door/window symbols on wall lines |
| Snap guides | Extension lines, snap indicators (ephemeral) |
| Labels | Dimension labels, room name labels |
| Selection | Highlight ring on selected element |

## Core interactions

| Action | Behaviour |
|---|---|
| Click wall | Select wall, show properties panel |
| Click vertex | Select vertex, show coordinate display |
| Drag vertex | Move vertex; walls connected to it follow; re-validate live |
| Click room | Select room, show room properties |
| Double-click room label | Edit room name inline |
| Click opening | Select door/window, show opening properties |
| Drag opening | Reposition along parent wall |
| Right-click wall | Context menu: Add vertex, Delete wall, Add opening |
| Right-click canvas | Context menu: Add wall (enter draw mode) |
| Scroll | Zoom in/out centred on cursor |
| Middle-drag or Space+drag | Pan canvas |
| Escape | Cancel current action (drawing, drag) |

## Drawing new walls

1. Right-click canvas → Add wall (or toolbar button)
2. Click to place the first vertex
3. Click to add subsequent vertices — a preview line follows the cursor
4. Snap guides appear for grid, vertices, and wall extensions
5. Double-click to end the wall at the last vertex
6. Escape cancels the current wall in progress
7. New wall is added to the store as an undoable action

## Snap system

Four snap modes, all active by default. Can be toggled individually in the toolbar.

### Grid snap

- Default grid size: 10cm
- All vertex positions snap to the nearest grid point
- Grid size is configurable (5cm, 10cm, 20cm, 50cm)

### Vertex snap

- While dragging or drawing: if the cursor is within a pixel threshold (configurable, default 8px screen-space) of any existing vertex, the position snaps to that vertex
- Visual indicator: circle highlight appears on the target vertex

### Wall midpoint snap

- Snaps to the exact midpoint of any wall segment
- Visual indicator: square highlight at midpoint

### Wall extension snap

- Shows guide lines extending along the axis of existing walls (like CAD extension lines)
- Cursor snaps to the intersection of the current cursor position with these guide lines
- Visual indicator: dashed grey extension line

### Snap toggle

A toolbar button turns all snapping on/off. State is local UI — not persisted.

## Dimension labels

- Every wall segment shows its length in meters as a floating label at the wall midpoint, perpendicular to the wall
- Labels update live during vertex dragging — no debounce
- Clicking a dimension label enters inline editing mode: the user types an exact length value and presses Enter
  - The wall endpoint snaps to achieve the entered length (the start vertex is fixed, the end vertex moves)
  - Escape cancels without applying

## Undo / redo

- Full undo/redo stack via Zustand history middleware
- Keyboard shortcuts: Ctrl+Z (undo), Ctrl+Shift+Z (redo)
- Every discrete user action is undoable:
  - Vertex move
  - Wall add / delete
  - Opening add / delete / reposition
  - Room property change (name, material, ceiling height)
  - Wall property change (thickness, height, material)
  - Dimension label edit
- Undo stack is cleared when a new file is uploaded
- Max stack depth: 100 actions (configurable constant)

## Issue visualisation

- Elements with `error` issues: red outline
- Elements with `warning` issues: yellow outline
- Elements with only `info` issues: blue dot indicator
- Hovering an issue in the issues panel → highlights the affected element in the canvas
- Clicking an element in the canvas → highlights its issues in the panel
- "Jump to" button in issues panel → pans and zooms canvas to centre the affected element

## Issues panel

Collapsible sidebar within the editor panel.

- Lists all issues grouped by severity (errors → warnings → info)
- Each entry shows: severity icon, message, affected element name, Jump to button
- User can dismiss `info`-level issues (they are removed from the list but the element is not changed)
- Issue count badge shown on the panel toggle button when collapsed
- Panel width: fixed 280px

## Properties panel

Shown in the bottom panel when an element is selected. Context-sensitive by selection type.

### Wall selected

- Thickness (number input, meters)
- Height (number input, meters)
- Material (dropdown)
- Exterior / interior toggle
- List of openings on this wall, each clickable to select

### Room selected

- Name (text input)
- Floor material (dropdown)
- Ceiling height (number input, meters)
- Calculated area (read-only, derived from vertex polygon)

### Opening selected

- Type (dropdown: door / window / archway)
- Width (number input, meters)
- Height (number input, meters)
- Position along wall (number input, meters from start vertex)
- Swing direction (dropdown, doors only)
- Sill height (number input, meters, windows only)

### Vertex selected

- X, Y coordinates (number inputs, meters)
- Editable — typing a value moves the vertex to that exact position

## File structure

```
src/components/editor/
  EditorPanel.tsx          # Top-level editor panel with canvas + issues sidebar
  EditorCanvas.tsx         # Konva Stage (or equivalent) + layer setup
  layers/
    BackgroundLayer.tsx    # Grid
    RoomLayer.tsx          # Room polygon fills
    WallLayer.tsx          # Wall lines and thickness
    OpeningLayer.tsx       # Door/window symbols
    SnapGuideLayer.tsx     # Ephemeral snap lines
    LabelLayer.tsx         # Dimension + room name labels
    SelectionLayer.tsx     # Selection highlight
  IssuesPanel.tsx          # Collapsible issues sidebar
  SnapToolbar.tsx          # Snap mode toggles
  useDrawMode.ts           # Hook for wall drawing state machine
  useSnapSystem.ts         # Hook that computes snap candidate points
  usePanZoom.ts            # Hook for canvas pan and zoom transform
```
