# UI Layout

Desktop-only three-panel layout. No mobile support in v1.

## Panel structure

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

| Panel | Position | Size |
|---|---|---|
| Toolbar | Top | Fixed height ~48px |
| 2D Editor | Left | Resizable, min width 320px |
| 3D Viewer | Right / main | Takes remaining space |
| Bottom panel | Bottom | Collapsible, ~280px tall when open |
| Issues panel | Inside 2D editor (left sidebar) | Collapsible, fixed 280px wide |

The 2D editor and 3D viewer panels are side by side and fill the space between toolbar and bottom panel.

## Toolbar contents

Left to right:
- App logo / name
- Upload button (opens file picker; also accepts drag-and-drop onto the main area)
- Camera mode toggle (Orbit / Walk)
- Undo / Redo buttons
- Settings (gear icon — snap grid size, ceiling toggle, etc.)

## Bottom panel

Split horizontally:
- **Left half:** Properties panel — context-sensitive display for the currently selected element (wall, room, opening, vertex, furniture). Hidden / shows placeholder text when nothing is selected.
- **Right half:** Furniture library — category tabs + item grid.

The bottom panel is collapsible. When collapsed it shows a thin handle bar. State persists in the UI slice of the Zustand store.


## Upload state

On first load (before any file is uploaded):
- The 3D viewer area shows a large centred drag-and-drop zone
- Instructions: "Upload a floor plan to get started — JPG, PNG, or PDF"
- The 2D editor panel and bottom panel are hidden (no content to show)
- Accepted file types: `image/jpeg`, `image/png`, `application/pdf`
- Max file size: reasonable limit TBD (suggest 20MB)

Once a file is uploaded and parsed, the layout switches to the full three-panel view.

## Loading state

While Gemini is processing the uploaded image, an overlay covers the 3D viewer panel with a progress indicator and sequential status messages:

1. "Analysing floor plan…" — Gemini API call in progress
2. "Running validation…" — validator processing the parsed JSON
3. "Building 3D scene…" — geometry generation

If parsing fails (network error, malformed response, retry failure), the overlay shows an error state with:
- Error message (human-readable, not a stack trace)
- "Try again" button (retries with the same image)
- "Upload a different file" button

## Core user flow

```
1. User opens Walkaround in browser
2. Uploads a floor plan image (JPG, PNG) or PDF
3. Image is sent to Gemini 2.5 Flash API with a structured prompt
4. Gemini returns a JSON object describing the floor plan
5. Validator runs on the JSON — flags errors and warnings, applies safe auto-fixes
6. App renders:
     - 2D editor (left panel) showing the parsed floor plan with issue highlights
     - 3D scene (main panel) showing extruded walls and floors
7. User reviews flagged issues in the 2D editor and fixes as needed
8. User furnishes the space, changes materials, adds annotations
9. User enters first-person mode and walks through the space
```
