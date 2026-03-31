// Canonical floor plan types — shared by AI layer, validator, editor, and 3D renderer.
// Do not create parallel type definitions elsewhere.

export type Confidence = 'high' | 'medium' | 'low'

export interface Point {
  x: number
  y: number
}

export interface FloorPlanMeta {
  unit: 'meters'
  floor_name: string
  source_image: string
  bounds: {
    width: number
    height: number
  }
  ai_notes: string | null
  schema_version: string
}

export interface Room {
  id: string
  name: string
  vertices: Point[]
  floor_material: string
  ceiling_height: number
  confidence: Confidence
}

export type DoorSwing =
  | 'inward_left'
  | 'inward_right'
  | 'outward_left'
  | 'outward_right'
  | null

export interface Opening {
  id: string
  type: 'door' | 'window' | 'archway'
  position_along_wall: number
  width: number
  height: number
  swing: DoorSwing
  sill_height: number | null
  confidence: Confidence
}

export interface Wall {
  id: string
  room_ids: string[]
  vertices: Point[]
  thickness: number
  height: number
  material: string
  is_exterior: boolean
  confidence: Confidence
  openings: Opening[]
}

export interface StructuralElement {
  id: string
  type: 'column' | 'stairs' | 'builtin'
  x: number
  y: number
  width: number
  depth: number
  height: number
  note: string | null
}

export interface FurnitureItem {
  id: string
  model_id: string
  x: number
  y: number
  rotation_y: number
  room_id: string
  label: string
}

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface Issue {
  id: string
  severity: IssueSeverity
  code: string
  message: string
  element_ids: string[]
}

export interface FloorPlanSchema {
  meta: FloorPlanMeta
  rooms: Room[]
  walls: Wall[]
  structural: StructuralElement[]
  furniture: FurnitureItem[]
  annotations: unknown[]
  issues: Issue[]
}
