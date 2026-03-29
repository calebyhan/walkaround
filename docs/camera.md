# Camera System

Two camera modes with a toggle in the 3D viewer toolbar. Lives in `src/components/viewer/CameraController.tsx`.

## Orbit mode (default)

Uses `OrbitControls` from `@react-three/drei`.

| Control | Action |
|---|---|
| Left-click drag | Rotate around the target point |
| Right-click drag | Pan (translate target + camera) |
| Scroll wheel | Zoom in/out |

Default camera position on load: above the floor plan looking down at a 45° angle, centred on the floor plan bounds midpoint. Distance scaled so the entire floor plan is visible.

A "Reset camera" button in the viewer toolbar returns to this default position.

Orbit controls configuration:
- `minDistance`: 1.0m
- `maxDistance`: 100m
- `maxPolarAngle`: `Math.PI / 2` — prevents going below the floor plane

## First-person mode

Uses `PointerLockControls` from Three.js directly (not from drei, which has wrapper quirks with R3F).

### Entering FP mode

1. Click the "Walk through" button in the viewer toolbar
2. The 3D canvas requests pointer lock (`canvas.requestPointerLock()`)
3. Mouse is captured; the OS cursor disappears
4. On pointer lock granted: switch to FP camera, position at current orbit target at floor level + eye height

### Controls

| Input | Action |
|---|---|
| Mouse movement | Look left / right / up / down |
| W or Arrow Up | Move forward |
| S or Arrow Down | Move backward |
| A or Arrow Left | Strafe left |
| D or Arrow Right | Strafe right |

Eye height: **1.6m** above the floor (Y = 1.6 in Three.js coordinates).

Movement speed: **1.4 m/s** (configurable constant `FP_MOVE_SPEED`). This is a normal walking pace.

Look sensitivity: configurable constant `FP_LOOK_SENSITIVITY`, default value tuned during prototype.

The camera can look up/down but is clamped to ±85° pitch to prevent flipping.

### Exiting FP mode

- Press **Escape** → releases pointer lock → returns to orbit mode
- Pointer lock is also released if the user clicks outside the browser window

On exit, the orbit camera returns to its last position before FP mode was entered (stored in `cameraSlice`).

## Collision detection

Basic AABB (axis-aligned bounding box) collision against wall geometry.

Each frame in FP mode:
1. Compute the desired new camera position based on WASD input
2. Test the new position against all wall AABBs (pre-computed from wall geometry)
3. If the new position intersects a wall AABB:
   - Resolve only the penetrating axis (allows sliding along walls)
   - Apply movement on the non-penetrating axis only
4. Apply the resolved position

Wall AABBs are computed once when wall geometry changes and cached. They are not recomputed each frame.

Limitations accepted for v1:
- Does not prevent clipping through very thin geometry (<10cm)
- No ceiling or floor collision (camera stays at fixed eye height)
- Furniture has no collision
- Stairs have no collision (camera passes through)

## Mode toggle

`CameraController.tsx` renders either `OrbitControls` or `FirstPersonController` based on `cameraSlice.mode`.

Switching modes:
- Orbit → FP: preserve current orbit target as the FP start position (at floor level)
- FP → Orbit: restore the last orbit camera position stored before entering FP mode

The mode toggle button lives in `ViewerToolbar.tsx` and dispatches to `cameraSlice`.

## Zustand camera slice

```ts
// src/store/cameraSlice.ts
type CameraSlice = {
  mode: 'orbit' | 'first-person';
  lastOrbitPosition: THREE.Vector3;    // saved when entering FP mode
  lastOrbitTarget: THREE.Vector3;      // saved when entering FP mode
  setMode: (mode: CameraMode) => void;
  saveOrbitState: (position, target) => void;
};
```

## File structure

```
src/components/viewer/
  CameraController.tsx        # Switches between orbit and FP, handles mode transition
  FirstPersonController.tsx   # WASD movement loop, PointerLockControls, collision
  ViewerToolbar.tsx           # Mode toggle button, reset camera button

src/store/
  cameraSlice.ts              # Mode, saved orbit state

src/lib/geometry/
  wallAabb.ts                 # Compute wall AABBs for collision (cached)
```
