import { Canvas } from '@react-three/fiber'
import { useStore } from '@/store'
import { UploadDropzone } from '@/components/ui/UploadDropzone'
import { EditorCanvasKonva } from '@/components/editor/EditorCanvasKonva'
import { ViewerScene } from '@/components/viewer/ViewerScene'

export default function App() {
  const appMode = useStore((s) => s.appMode)
  const cameraMode = useStore((s) => s.cameraMode)
  const setCameraMode = useStore((s) => s.setCameraMode)

  if (appMode === 'upload') {
    return <UploadDropzone />
  }

  return (
    <div className="flex flex-col w-full h-full bg-zinc-950">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 h-10 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <span className="text-sm font-medium text-zinc-100">walkaround</span>
        <div className="flex-1" />
        <button
          className={[
            'px-3 py-1 rounded text-xs font-medium transition-colors',
            cameraMode === 'orbit'
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600',
          ].join(' ')}
          onClick={() => setCameraMode('orbit')}
        >
          Orbit
        </button>
        <button
          className={[
            'px-3 py-1 rounded text-xs font-medium transition-colors',
            cameraMode === 'firstperson'
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600',
          ].join(' ')}
          onClick={() => setCameraMode('firstperson')}
        >
          Walk
        </button>
      </div>

      {/* Main panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* 2D Editor */}
        <div className="w-1/2 border-r border-zinc-800 overflow-hidden">
          <EditorCanvasKonva />
        </div>

        {/* 3D Viewer */}
        <div className="w-1/2 overflow-hidden">
          <Canvas
            shadows
            camera={{ position: [5, 8, 10], fov: 60 }}
            className="w-full h-full"
          >
            <ViewerScene />
          </Canvas>
        </div>
      </div>
    </div>
  )
}
