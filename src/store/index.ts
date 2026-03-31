import { create } from 'zustand'
import { createFloorPlanSlice, type FloorPlanSlice } from './floorPlanSlice'
import { createUISlice, type UISlice } from './uiSlice'
import { createHistorySlice, type HistorySlice } from './historySlice'

export type AppStore = FloorPlanSlice & UISlice & HistorySlice

export const useStore = create<AppStore>()((...a) => ({
  ...createFloorPlanSlice(...a),
  ...createUISlice(...a),
  ...createHistorySlice(...a),
}))
