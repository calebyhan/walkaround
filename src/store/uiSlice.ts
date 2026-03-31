import type { StateCreator } from 'zustand'

export type AppMode = 'upload' | 'editor'
export type ViewMode = 'split' | '3d'
export type CameraMode = 'orbit' | 'firstperson'

export interface UISlice {
  appMode: AppMode
  viewMode: ViewMode
  cameraMode: CameraMode
  selectedElementId: string | null
  hoveredElementId: string | null
  issuesPanelOpen: boolean
  furniturePanelOpen: boolean
  setAppMode: (mode: AppMode) => void
  setViewMode: (mode: ViewMode) => void
  setCameraMode: (mode: CameraMode) => void
  setSelectedElement: (id: string | null) => void
  setHoveredElement: (id: string | null) => void
  setIssuesPanelOpen: (open: boolean) => void
  setFurniturePanelOpen: (open: boolean) => void
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  appMode: 'upload',
  viewMode: 'split',
  cameraMode: 'orbit',
  selectedElementId: null,
  hoveredElementId: null,
  issuesPanelOpen: false,
  furniturePanelOpen: false,
  setAppMode: (appMode) => set({ appMode }),
  setViewMode: (viewMode) => set({ viewMode }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setSelectedElement: (selectedElementId) => set({ selectedElementId }),
  setHoveredElement: (hoveredElementId) => set({ hoveredElementId }),
  setIssuesPanelOpen: (issuesPanelOpen) => set({ issuesPanelOpen }),
  setFurniturePanelOpen: (furniturePanelOpen) => set({ furniturePanelOpen }),
})
