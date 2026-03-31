import type { StateCreator } from 'zustand'
import type { FloorPlanSchema } from '@/lib/schema'

const MAX_HISTORY = 50

export interface HistorySlice {
  undoStack: FloorPlanSchema[]
  redoStack: FloorPlanSchema[]
  pushHistory: (snapshot: FloorPlanSchema) => void
  undo: (current: FloorPlanSchema) => FloorPlanSchema | null
  redo: (current: FloorPlanSchema) => FloorPlanSchema | null
  clearHistory: () => void
}

export const createHistorySlice: StateCreator<HistorySlice> = (set, get) => ({
  undoStack: [],
  redoStack: [],

  pushHistory: (snapshot) =>
    set((state) => ({
      undoStack: [...state.undoStack.slice(-MAX_HISTORY + 1), snapshot],
      redoStack: [],
    })),

  undo: (current) => {
    const { undoStack } = get()
    if (undoStack.length === 0) return null
    const previous = undoStack[undoStack.length - 1]
    set((state) => ({
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, current],
    }))
    return previous
  },

  redo: (current) => {
    const { redoStack } = get()
    if (redoStack.length === 0) return null
    const next = redoStack[redoStack.length - 1]
    set((state) => ({
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, current],
    }))
    return next
  },

  clearHistory: () => set({ undoStack: [], redoStack: [] }),
})
