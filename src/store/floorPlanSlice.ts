import type { StateCreator } from 'zustand'
import type { FloorPlanSchema } from '@/lib/schema'

export interface FloorPlanSlice {
  floorPlan: FloorPlanSchema | null
  setFloorPlan: (plan: FloorPlanSchema) => void
  clearFloorPlan: () => void
}

export const createFloorPlanSlice: StateCreator<FloorPlanSlice> = (set) => ({
  floorPlan: null,
  setFloorPlan: (plan) => set({ floorPlan: plan }),
  clearFloorPlan: () => set({ floorPlan: null }),
})
