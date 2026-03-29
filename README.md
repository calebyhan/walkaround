# Walkaround

A personal, browser-based tool that converts a floor plan image into an interactive, editable 3D viewer.

Upload a photo or PDF of any floor plan → AI parses it into structured geometry → edit in 2D → walk through in 3D.

## What it does

1. Upload a floor plan image (JPG, PNG) or single-page PDF
2. Gemini 2.5 Flash parses walls, rooms, doors, windows, and dimensions into a structured JSON schema
3. A validation layer flags geometry errors and auto-fixes safe issues
4. A 2D editor lets you correct AI mistakes — drag vertices, add/delete walls, reposition openings
5. A live 3D scene renders extruded walls, floors, and openings, synced in real time with the editor
6. First-person walk-through mode with basic collision detection
7. Place furniture from a CC0 3D library and repaint surfaces

## Tech stack

| Layer | Choice |
|---|---|
| Framework | React + Vite |
| Styling | Tailwind CSS |
| 3D | Three.js via React Three Fiber + @react-three/drei |
| 2D editor | Konva.js (TBD — see [architecture](docs/architecture.md)) |
| AI | Gemini 2.5 Flash API |
| State | Zustand |
| Hosting | Vercel free tier |

## Setup

### Prerequisites

- Node.js 20+
- A [Google AI Studio](https://aistudio.google.com) API key (free tier, no credit card required)

### Install

```bash
git clone https://github.com/calebyhan/walkaround.git
cd walkaround
npm install
```

### Environment variables

Create a `.env.local` file in the project root:

```
VITE_GEMINI_API_KEY=your_api_key_here
```

### Run

```bash
npm run dev
```

Open `http://localhost:5173`.

## Documentation

- [Architecture](docs/architecture.md) — system overview, data flow, component map
- [JSON Schema](docs/json-schema.md) — canonical floor plan data format
- [AI Parsing](docs/ai-parsing.md) — Gemini integration and prompt strategy
- [Validation](docs/validation.md) — geometry checks, issue severity, auto-fix rules
- [2D Editor](docs/editor-2d.md) — interactions, snap system, undo/redo
- [3D Renderer](docs/renderer-3d.md) — geometry generation, materials, lighting
- [Camera System](docs/camera.md) — orbit and first-person modes
- [Furniture System](docs/furniture.md) — library, placement, GLTF normalization
- [UI Layout](docs/ui-layout.md) — three-panel layout, upload state, loading state
- [Build Phases](docs/build-phases.md) — phased implementation plan

## Constraints

Personal tool — no auth, no backend, no persistence between sessions, desktop only, single floor.
See [Build Phases](docs/build-phases.md) for v1 scope and post-v1 backlog.
