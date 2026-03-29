# 3D Renderer

The 3D viewer renders the floor plan JSON as a live Three.js scene via React Three Fiber. It updates in real time as the user edits the 2D plan.

Lives in `src/components/viewer/` and `src/lib/geometry/`.

## Coordinate mapping

The floor plan schema uses a 2D coordinate system (X right, Y up, origin bottom-left). Three.js uses a right-handed 3D system where Y is the vertical axis.

Mapping:
- Schema X → Three.js X
- Schema Y → Three.js Z (the floor plane depth axis)
- Three.js Y is the vertical axis (wall height, ceiling height)

All geometry generation functions in `src/lib/geometry/` operate in Three.js coordinates.

## Scene structure

```
R3FCanvas
├── Lighting
│     ├── AmbientLight
│     ├── DirectionalLight
│     └── HemisphereLight (optional)
├── FloorMeshGroup
│     └── FloorMesh (one per room)
├── WallMeshGroup
│     └── WallMesh (one per wall)
├── CeilingMeshGroup (optional, toggleable)
│     └── CeilingMesh (one per room)
├── StructuralMeshGroup
│     └── ColumnMesh / StairsMesh (one per structural element)
├── FurnitureMeshGroup
│     └── FurnitureInstance (one per furniture item)
└── CameraController
      ├── OrbitControls (when in orbit mode)
      └── FirstPersonController (when in FP mode)
```

## Geometry generation

### Floors

One `THREE.ShapeGeometry` per room. The room's vertex polygon is converted to a Three.js `Shape`, then extruded as a flat plane at Y=0. The floor is assigned the room's `floor_material`.

### Walls

Each wall is generated from its polyline vertices. The process:

1. For each segment in the polyline, compute the wall normal (perpendicular to the segment direction)
2. Offset the inner face vertices outward by `thickness / 2` on each side to produce the outer face
3. At corners where two segments meet, compute the mitre angle and adjust corner vertices to close the joint cleanly
4. Extrude the resulting closed polygon shape to `wall.height`
5. Cut opening holes using CSG (see below)

This produces a single `THREE.BufferGeometry` per wall with openings subtracted.

### Opening cutouts (CSG)

Door and window holes are Boolean-subtracted from wall geometry using CSG (Constructive Solid Geometry). Library: `three-bvh-csg` or equivalent.

Process:
1. Build the wall geometry as a solid box (no openings)
2. For each opening on the wall:
   - Compute the opening's world-space position along the wall (from `position_along_wall` × wall length)
   - Build a box geometry matching `opening.width × opening.height × (wall.thickness + epsilon)`, positioned at the opening centre
   - For windows: offset vertically by `sill_height`
3. Subtract all opening boxes from the wall geometry using CSG union then subtraction
4. The result is the wall mesh with clean cutouts

CSG is computationally expensive — only re-run when the wall or its openings change, not on every frame.

### Corner joints (mitre join)

When two walls meet at a vertex, their extruded faces must be trimmed to avoid overlap. The algorithm:

1. At a shared vertex, identify the two wall segments meeting there
2. Compute the angle bisector of the two segments
3. Trim each wall face along the bisector plane
4. This handles both convex (outer corners) and concave (inner corners) joints

For walls that meet at exactly 90°, this reduces to a standard mitre at 45°.

### Structural elements

- **Columns:** `THREE.BoxGeometry` at the column's position, sized by `width × height × depth`
- **Stairs:** Placeholder `THREE.BoxGeometry` in v1. No actual stair step geometry.

## Materials

Default materials on load:

| Surface | Default material |
|---|---|
| Walls | `MeshStandardMaterial`, colour `#f5f0eb` (off-white/cream) |
| Floors | `MeshStandardMaterial` with texture per `floor_material` type |
| Ceilings | `MeshStandardMaterial`, colour `#ffffff` |
| Structural | `MeshStandardMaterial`, colour `#cccccc` |

Material overrides are applied per wall or per room and stored in the schema's `material` fields. The renderer maps string material identifiers to `THREE.Material` instances via a material registry in `src/lib/geometry/materials.ts`.

### Floor material textures

Mapped from `floor_material` string to texture file:

| Value | Texture |
|---|---|
| `hardwood` | `assets/textures/floor_hardwood.jpg` |
| `tile` | `assets/textures/floor_tile.jpg` |
| `carpet` | `assets/textures/floor_carpet.jpg` |
| `concrete` | `assets/textures/floor_concrete.jpg` |
| `default` | Solid colour `#d4c9b0` |

Textures use `THREE.RepeatWrapping` with repeat scale proportional to room size.

## Lighting

```
AmbientLight       intensity: 0.4, colour: #ffffff
DirectionalLight   intensity: 0.8, colour: #fff8f0, position: (5, 10, 5)
HemisphereLight    sky: #c9e8ff, ground: #8b7355, intensity: 0.3
```

The hemisphere light provides subtle sky/ground colour bounce to avoid the flat look of ambient-only lighting.

Stretch goal: day/night toggle that shifts directional light colour and intensity.

## Real-time sync

The 3D scene subscribes to individual elements in the Zustand store using selectors. Each mesh component is responsible for its own geometry:

```ts
// WallMesh.tsx
function WallMesh({ wallId }: { wallId: string }) {
  const wall = useFloorPlanStore(state => state.floorPlan.walls.find(w => w.id === wallId));
  const geometry = useMemo(() => buildWallGeometry(wall), [wall]);
  return <mesh geometry={geometry} material={wallMaterial} />;
}
```

When a wall changes (vertex moved, opening added, material changed), only that wall's component re-renders and rebuilds its geometry. There is no full scene rebuild.

The wall ID list is subscribed separately so that wall additions and deletions add or remove `WallMesh` components without affecting other walls.

## Ceiling toggle

A toolbar button in the viewer toggles ceiling meshes on/off. Ceilings are off by default (overhead clarity for layout work). The toggle state lives in the UI slice of the Zustand store.

## File structure

```
src/components/viewer/
  ViewerPanel.tsx           # Container for R3F canvas + toolbar
  R3FCanvas.tsx             # Canvas setup, scene graph root
  FloorMesh.tsx             # Per-room floor plane
  WallMesh.tsx              # Per-wall extruded geometry with CSG openings
  CeilingMesh.tsx           # Per-room ceiling plane
  StructuralMesh.tsx        # Columns, stairs
  FurnitureInstance.tsx     # Loaded GLTF furniture item
  Lighting.tsx              # Scene lighting setup
  CameraController.tsx      # Switches between orbit and first-person
  ViewerToolbar.tsx

src/lib/geometry/
  buildWallGeometry.ts      # Wall extrusion + corner joints + CSG openings
  buildFloorGeometry.ts     # Room polygon → flat mesh
  wallCsg.ts                # CSG helper: subtract opening boxes from wall mesh
  mitreJoint.ts             # Corner joint computation
  materials.ts              # Material registry: string → THREE.Material
  coordinates.ts            # Schema 2D ↔ Three.js 3D coordinate mapping
```
