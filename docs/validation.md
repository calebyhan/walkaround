# Validation

The validator runs immediately after Gemini returns a parsed `FloorPlanSchema`, before anything is rendered. It also re-runs on affected elements after every user edit in the 2D editor.

Entry point: `src/lib/validator/runValidation.ts`

## What it returns

```ts
type ValidationResult = {
  schema: FloorPlanSchema;   // same schema with issues[] populated
  autoFixLog: AutoFix[];     // list of fixes silently applied
};

type AutoFix = {
  type: string;
  description: string;
  affected_ids: string[];
};
```

The validator is **pure** — it takes a schema, returns a new schema with issues populated, and applies safe auto-fixes to the returned copy. It does not write to the Zustand store.

## Issue structure

```ts
type Issue = {
  id: string;                  // "issue_1", "issue_2", ...
  severity: 'error' | 'warning' | 'info';
  type: IssueType;             // see full list below
  message: string;             // human-readable description
  affected_ids: string[];      // IDs of walls/rooms/openings involved
  auto_fixable: boolean;
  auto_fix_description: string | null;
};
```

## Severity levels

| Level | Colour | Meaning |
|---|---|---|
| `error` | Red | Geometry is broken. 3D cannot render correctly. Must fix before continuing. |
| `warning` | Yellow | Suspicious but renderable. Should review. |
| `info` | Blue | Minor note. Probably fine. Can dismiss. |

## Validation checks

### Geometric integrity

| Type | Severity | Description | Auto-fix |
|---|---|---|---|
| `disconnected_wall_endpoint` | error | Wall endpoint not connected to any other wall or vertex | No |
| `near_miss_vertices` | warning | Two endpoints within 2cm but not snapped | Yes — snap them |
| `intersecting_walls_no_vertex` | warning | Two walls cross without a shared vertex at the intersection | No |
| `unclosed_room_polygon` | error | Room polygon's last vertex doesn't return to first | Yes — if within 2cm |
| `overlapping_walls` | error | Two walls share the same start and end points | No |
| `zero_length_wall` | error | Wall start and end vertex are at the same position | No |

### Dimensional consistency

| Type | Severity | Description | Auto-fix |
|---|---|---|---|
| `room_area_mismatch` | warning | Room polygon area vs. labeled dimensions disagree by >15% | No |
| `implausibly_small_room` | warning | Room area < 1m² — likely a misparse | No |
| `implausibly_large_floorplan` | error | Floor plan bounds > 1000m² — likely a unit conversion error | No |
| `ceiling_height_out_of_range` | warning | Ceiling height < 2.0m or > 5.0m | No |

### Opening integrity

| Type | Severity | Description | Auto-fix |
|---|---|---|---|
| `opening_wider_than_wall` | error | Opening width exceeds parent wall length | No |
| `opening_out_of_bounds` | error | Opening position places it (partially) outside wall bounds | Yes — clamp to wall bounds |
| `overlapping_openings` | error | Two openings on the same wall overlap | No |
| `door_swing_into_wall` | warning | Door swing direction points into a solid wall | No |
| `sealed_room` | warning | Room has no openings (no doors or archways) | No |

### Topological sense

| Type | Severity | Description | Auto-fix |
|---|---|---|---|
| `room_no_adjacent_walls` | error | Room polygon has no walls associated with it | No |
| `isolated_room` | warning | Room shares no walls with the rest of the floor plan | No |
| `overlapping_rooms` | error | Two room polygons fully overlap | No |
| `single_room_floor_plan` | info | Floor plan contains only one room — Gemini may have failed to segment | No |

## Auto-fix behaviour

Safe auto-fixes are applied silently before the schema is returned. They are logged in `autoFixLog` so the user can see what changed.

| Fix | Condition | Action |
|---|---|---|
| Snap near-miss vertices | Two endpoints within 2cm threshold | Move both to their midpoint |
| Close unclosed room polygon | Last vertex within 2cm of first | Add closing vertex |
| Clamp opening position | Opening extends past wall bounds | Adjust `position_along_wall` to keep opening within wall |

All other issues require user action in the 2D editor.

## Re-validation on edit

Every user edit in the 2D editor triggers re-validation on the affected element(s) only — not the full floor plan. The store update cycle is:

1. User performs edit (vertex drag, wall add/delete, opening reposition, etc.)
2. Undoable action updates the store with the new geometry
3. Store update triggers `runValidationForElement(elementId)` on affected IDs
4. Issues array is updated with the new results for those elements
5. The issues panel and element visual states react to the updated issues

Issues are never stale — they always reflect the current geometry.

## File structure

```
src/lib/validator/
  runValidation.ts        # Main entry: validates full schema, returns ValidationResult
  checks/
    geometric.ts          # Disconnected endpoints, near-miss, intersections, etc.
    dimensional.ts        # Room area, implausible sizes, ceiling heights
    openings.ts           # Opening bounds, overlaps, swing direction
    topological.ts        # Isolated rooms, single-room detection, etc.
  autoFix.ts              # Auto-fix functions, returns updated schema + fix log
  types.ts                # Issue, IssueType, AutoFix, ValidationResult types
```

Each check file exports an array of check functions with a common signature:

```ts
type CheckFn = (schema: FloorPlanSchema) => Issue[];
```

`runValidation.ts` calls all checks, merges results into the `issues` array, then calls `autoFix.ts` on the result.
