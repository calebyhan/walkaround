# Furniture System

Users can place 3D furniture items from a built-in library into the floor plan. Lives in `src/components/viewer/FurnitureInstance.tsx` and `src/components/ui/FurnitureLibrary.tsx`.

## Model source

Furniture models come from **[Kenney.nl](https://kenney.nl)** CC0 3D assets in GLTF/GLB format. CC0 = no attribution required, no licensing restrictions.

Where Kenney models aren't available for a category, use simple `THREE.BoxGeometry` or `THREE.CylinderGeometry` primitives as placeholders.

## Library categories

| Category | Items |
|---|---|
| Seating | Sofa (2-seat), Armchair, Dining chair, Office chair |
| Tables | Dining table, Coffee table, Desk, Side table |
| Beds | Single bed, Double bed, King bed |
| Storage | Wardrobe, Bookshelf, Cabinet, Dresser |
| Kitchen | Counter section, Kitchen island, Refrigerator, Stove |
| Bathroom | Toilet, Sink, Bathtub, Shower |
| Misc | Rug, Floor lamp, Plant, TV + stand |

## Model registry

Each model has an entry in the model registry at `src/assets/models/registry.ts`:

```ts
type ModelRegistryEntry = {
  id: string;              // e.g. "sofa_2seat"
  label: string;           // display name: "Sofa (2-seat)"
  category: string;        // "seating"
  file: string;            // path relative to assets/models/: "kenney_sofa_2.glb"
  // Normalisation params applied on load:
  scale: number;           // uniform scale to reach real-world meters
  rotationY: number;       // degrees to rotate so the front faces +Z
  pivotOffset: [number, number, number];  // translate to centre pivot at floor level
  // Approximate footprint for placement snapping:
  footprintWidth: number;  // meters
  footprintDepth: number;  // meters
};
```

## GLTF normalisation

Kenney models have inconsistent scales and pivot points. Each model is normalised on load via the registry params:

1. **Scale** — multiply all geometry by `entry.scale` to reach real-world meters
2. **Rotation** — rotate by `entry.rotationY` so the model's front face points in the +Z direction (south in floor plan coordinates)
3. **Pivot** — translate by `entry.pivotOffset` so the pivot point sits at the model's base centre (floor level)

Normalisation is applied once when the GLTF is loaded and cached. The `FurnitureInstance` component then applies the user's `rotation_y` on top of the normalised base rotation.

## Placement flow

1. User opens the furniture library sidebar (bottom panel)
2. Library shows thumbnails grouped by category
3. User clicks a furniture item
4. Item is created in the store with:
   - Position: centre of the currently selected room (or floor plan centre if no room selected)
   - `rotation_y: 0`
   - `room_id`: selected room ID (or nearest room if none selected)
5. Item appears in the 3D view at the computed position
6. The item is automatically selected in the 3D view
7. Transform handles appear (see below)

## Transform handles

When a furniture item is selected in the 3D view:

- **Move:** Drag on the floor plane (XZ only — furniture stays on the floor)
- **Rotate:** Drag the rotation ring (Y axis only — no tilting)
- **Snap:** Movement snaps to a 10cm grid by default
- **Deselect:** Click elsewhere in the 3D view

Transform is implemented with a custom drag handler on the furniture mesh, not a full transform gizmo library, to keep it lightweight.

## Furniture in the schema

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

`x` and `y` are in floor plan schema coordinates (meters from bottom-left origin). The renderer converts to Three.js world coordinates.

`rotation_y` is in degrees, applied after the model's base normalisation rotation.

## Model loading

Models are loaded with `useGLTF` from `@react-three/drei`. Each unique `model_id` is loaded once and cached by drei's GLTF cache. Multiple instances of the same model share the same geometry via `useGLTF`'s built-in caching.

All GLB files are placed in `src/assets/models/` and imported statically so Vite bundles them.

## File structure

```
src/assets/models/
  registry.ts               # ModelRegistryEntry[] — all furniture metadata
  kenney_sofa_2.glb
  kenney_armchair.glb
  ...

src/components/viewer/
  FurnitureInstance.tsx      # Renders one placed furniture item with transform handles
  FurnitureMeshGroup.tsx     # Renders all furniture[] from store

src/components/ui/
  FurnitureLibrary.tsx       # Sidebar: category tabs + item grid
  FurnitureLibraryItem.tsx   # Single item thumbnail + click to place

src/lib/geometry/
  normaliseFurniture.ts      # Applies scale/rotation/pivot from registry entry
```
