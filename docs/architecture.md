# Architecture

## System overview

Walkaround is a fully client-side React application. There is no backend. The only external service is the Gemini 2.5 Flash API, called directly from the browser.

All application state lives in a single Zustand store. The 2D editor and 3D viewer are separate React subtrees that both read from and write to the same store, keeping them in sync without any explicit wiring between them.

## Data flow

```
User uploads image
       │
       ▼
Gemini 2.5 Flash API
  (image + system prompt)
       │
       ▼
Raw JSON response
       │
       ▼
JSON parser + schema validation
  (is it parseable? does it match the schema shape?)
       │
       ▼
Geometry validator
  (are the walls connected? are openings in bounds? etc.)
  Populates the `issues` array
  Applies safe auto-fixes
       │
       ▼
Zustand store
  (floorPlan slice holds the canonical FloorPlanSchema object)
       │
     ┌─┴─────────────────┐
     ▼                   ▼
2D Editor            3D Viewer
(Konva canvas)       (React Three Fiber)
reads + writes       reads only
floor plan state     floor plan state,
via store            rebuilds geometry
                     on element change
```

## Component map

```
App
├── Toolbar
│     ├── UploadButton
│     ├── ModeToggle (2D/3D split vs. full 3D)
│     ├── UndoRedoButtons
│     └── SettingsMenu
│
├── UploadDropzone          ← shown only before first upload
│
├── EditorPanel (left)      ← 2D editor
│     ├── EditorCanvas      ← Konva stage
│     │     ├── WallLayer
│     │     ├── RoomLayer
│     │     ├── OpeningLayer
│     │     └── SnapGuideLayer
│     ├── IssuesPanel       ← collapsible sidebar
│     └── SnapToolbar
│
├── ViewerPanel (right)     ← 3D viewer
│     ├── R3FCanvas         ← React Three Fiber canvas
│     │     ├── FloorMeshes
│     │     ├── WallMeshes
│     │     ├── FurnitureMeshes
│     │     ├── Lighting
│     │     └── CameraController
│     └── ViewerToolbar
│           ├── CameraModeToggle
│           └── ResetCameraButton
│
└── BottomPanel
      ├── PropertiesPanel   ← context-sensitive, selected element
      └── FurnitureLibrary  ← furniture sidebar
```

## Zustand store slices

```
store/
  floorPlanSlice.ts    ← FloorPlanSchema object, the canonical data
  historySlice.ts      ← undo/redo stack, undoable action middleware
  uiSlice.ts           ← selected element ID, hover state, panel open/closed
  cameraSlice.ts       ← current camera mode, last orbit position
```

The `floorPlanSlice` holds a single `FloorPlanSchema` object (defined in `src/lib/schema/`). Every edit to the floor plan goes through an undoable action that:
1. Pushes the current state onto the undo stack
2. Applies the mutation
3. Re-runs validation on affected elements

## Source directory structure

```
src/
  components/
    editor/        # 2D editor React + Konva components
    viewer/        # 3D viewer React Three Fiber components
    ui/            # Shared panels, toolbars, buttons
  store/           # Zustand slices
  lib/
    ai/            # Gemini API call, prompt builder, response parser
    schema/        # TypeScript types for FloorPlanSchema (canonical)
    validator/     # Validation checks + auto-fix logic
    geometry/      # 3D geometry generation (wall extrusion, CSG, etc.)
  hooks/           # Custom React hooks
  utils/           # Pure utility functions (math, geometry helpers)
  assets/
    models/        # GLTF/GLB furniture models
    textures/      # Wall and floor textures
```

## Tech stack decisions

### React + Vite

Standard fast-iteration setup. Vite's HMR is important here because geometry changes require frequent visual verification.

### React Three Fiber (R3F) over raw Three.js

R3F lets 3D scene elements be React components that respond to store changes via hooks. This avoids manual imperative scene management and makes incremental geometry updates straightforward.

### Zustand over Redux / Context

Zustand's selector-based subscriptions let the 3D renderer subscribe to individual wall or room objects and rebuild only what changed. Redux would require more boilerplate for the same result; Context would cause too many re-renders.

### 2D editor library: TBD

The choice between Konva.js, raw Canvas 2D, and SVG is deferred to the Phase 0 prototype. See [build-phases.md](build-phases.md#phase-0--de-risk-prototypes) for evaluation criteria.

### No backend

All data lives in memory for the session. The Gemini API key is stored in `.env.local` and accessed via `import.meta.env` — it is exposed to the browser. For a personal tool with no public deployment this is acceptable. Do not change this pattern without discussion.

## Key interfaces between layers

### AI layer → store

`src/lib/ai/parseResponse.ts` takes raw Gemini response text and returns a `FloorPlanSchema` or throws a typed `ParseError`. It does not write to the store — the calling component does.

### Validator → store

`src/lib/validator/runValidation.ts` takes a `FloorPlanSchema` and returns the same schema with the `issues` array populated. It also returns an `autoFixLog` array describing what was silently fixed. It is pure — no store access.

### Store → 3D renderer

The R3F scene components use Zustand selectors to subscribe to individual walls, rooms, and furniture items. Each mesh component is responsible for rebuilding its own geometry when its data changes. There is no top-level "rebuild scene" function.

### Store → 2D editor

The Konva canvas reads element arrays from the store and renders them. User interactions (drag, click, draw) dispatch store mutations via undoable actions.
