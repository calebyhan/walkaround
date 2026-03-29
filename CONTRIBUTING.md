# Contributing

Personal project — these docs are primarily for dev setup consistency and onboarding future-me.

## Dev setup

### Prerequisites

- Node.js 20+
- npm 10+
- A Google AI Studio API key (free, no credit card — [aistudio.google.com](https://aistudio.google.com))

### First run

```bash
git clone https://github.com/calebyhan/walkaround.git
cd walkaround
npm install
cp .env.example .env.local   # then fill in VITE_GEMINI_API_KEY
npm run dev
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `VITE_GEMINI_API_KEY` | Yes | Google AI Studio API key for Gemini 2.5 Flash |

### Available scripts

```bash
npm run dev        # Vite dev server with HMR
npm run build      # Production build to dist/
npm run preview    # Preview production build locally
npm run lint       # ESLint
npm run typecheck  # TypeScript type check (no emit)
```

## Project structure

```
src/
  components/       # React components
    editor/         # 2D editor components
    viewer/         # 3D viewer and R3F components
    ui/             # Shared UI primitives (panels, toolbars, etc.)
  store/            # Zustand store slices
  lib/
    ai/             # Gemini API integration and prompt building
    schema/         # TypeScript types for the floor plan JSON schema
    validator/      # Validation checks and auto-fix logic
    geometry/       # 3D geometry generation utilities
  assets/
    models/         # GLTF/GLB furniture models
    textures/       # Wall and floor textures
  hooks/            # Custom React hooks
  utils/            # Pure utility functions
```

## Conventions

### TypeScript

- Strict mode enabled. No `any` unless explicitly unavoidable and commented.
- Prefer `type` over `interface` for data shapes; `interface` for component props.
- All Zustand store slices are typed. State shape lives in `src/store/types.ts`.
- The floor plan JSON schema types live in `src/lib/schema/` and are the single source of truth — do not duplicate them.

### Components

- One component per file. File name matches component name in PascalCase.
- Collocate component-specific styles, hooks, and sub-components in the same directory.
- No inline styles. Use Tailwind utility classes. One-off layout values go in a `cn()` call.
- R3F components live in `src/components/viewer/` and are never imported by 2D editor code.

### State

- All floor plan data lives in the Zustand store. Components do not hold floor plan state locally.
- Undo/redo is managed via a custom Zustand middleware. Every user edit that modifies floor plan geometry must go through the undoable action pattern — see `src/store/history.ts`.
- Transient UI state (selected element, hover, panel open/closed) can live in local component state or a separate UI slice — never mixed into the floor plan data slice.

### Naming

| Thing | Convention | Example |
|---|---|---|
| Components | PascalCase | `WallSegment.tsx` |
| Hooks | `use` prefix, camelCase | `useSnapSystem.ts` |
| Store slices | camelCase noun | `floorPlanStore.ts` |
| Utility fns | camelCase verb | `computeWallNormal.ts` |
| Types/interfaces | PascalCase | `FloorPlanSchema` |
| Constants | UPPER_SNAKE | `DEFAULT_WALL_HEIGHT` |
| IDs in schema | snake_case with type prefix | `wall_1`, `room_3`, `opening_2` |

### Git

- Branch from `main`. Branch names: `feature/short-description`, `fix/short-description`.
- Commits are imperative mood, present tense: `Add vertex snap to 2D editor`, not `Added` or `Adding`.
- No `--no-verify`. Fix the lint/type error instead.

## Architecture decisions

Before making structural changes, read [docs/architecture.md](docs/architecture.md). Key decisions already made:

- Walls are **separate** from rooms in the schema — do not merge them
- The JSON schema in `src/lib/schema/` is canonical — AI output, validator input, editor state, and 3D renderer all use the same types
- 3D geometry is rebuilt incrementally per element, not as a full scene rebuild
- CSG for door/window openings — see [docs/renderer-3d.md](docs/renderer-3d.md) for the approach
