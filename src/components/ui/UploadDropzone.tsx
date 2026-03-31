import { useState, useCallback, useRef } from 'react'
import { analyseFloorPlan } from '@/lib/ai'
import { GeminiParseError } from '@/lib/ai'
import { runValidation } from '@/lib/validator'
import { useStore } from '@/store'

type ParseStage = 'idle' | 'reading' | 'analysing' | 'validating' | 'done' | 'error'

const STAGE_LABELS: Record<ParseStage, string> = {
  idle: '',
  reading: 'Reading image…',
  analysing: 'Analysing floor plan with Gemini…',
  validating: 'Running validation…',
  done: 'Done',
  error: '',
}

export function UploadDropzone() {
  const setFloorPlan = useStore((s) => s.setFloorPlan)
  const setAppMode = useStore((s) => s.setAppMode)
  const [stage, setStage] = useState<ParseStage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(
    async (file: File) => {
      if (!file.type.match(/image\/(jpeg|png)|application\/pdf/)) {
        setError('Only JPG, PNG, and single-page PDF files are supported.')
        return
      }

      setError(null)
      setStage('reading')

      const reader = new FileReader()
      reader.onload = async () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]
        const mimeType = file.type as 'image/jpeg' | 'image/png' | 'application/pdf'

        setStage('analysing')
        try {
          const schema = await analyseFloorPlan(base64, mimeType, file.name)
          setStage('validating')
          const validationResult = runValidation(schema)
          setFloorPlan(validationResult.schema)
          setAppMode('editor')
          setStage('done')
        } catch (e) {
          let msg = 'An unexpected error occurred.'
          if (e instanceof GeminiParseError) {
            msg = `Gemini returned invalid JSON: ${e.parseError.detail}`
          } else if (e instanceof Error) {
            msg = e.message
          }
          setError(msg)
          setStage('error')
        }
      }
      reader.readAsDataURL(file)
    },
    [setFloorPlan, setAppMode],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) processFile(file)
    },
    [processFile],
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) processFile(file)
    },
    [processFile],
  )

  const loading = stage === 'reading' || stage === 'analysing' || stage === 'validating'

  return (
    <div className="flex flex-col items-center justify-center w-full h-full bg-zinc-950 text-zinc-100">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight mb-2">walkaround</h1>
        <p className="text-zinc-400 text-sm">Upload a floor plan image to get started</p>
      </div>

      <div
        className={[
          'w-80 h-48 border-2 border-dashed rounded-xl flex flex-col items-center justify-center cursor-pointer transition-colors',
          dragging ? 'border-blue-400 bg-blue-950/30' : 'border-zinc-600 hover:border-zinc-400',
          loading ? 'pointer-events-none opacity-60' : '',
        ].join(' ')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !loading && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          className="hidden"
          onChange={handleChange}
        />
        {loading ? (
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-zinc-300">{STAGE_LABELS[stage]}</span>
          </div>
        ) : (
          <>
            <svg className="w-8 h-8 text-zinc-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5V19a2 2 0 002 2h14a2 2 0 002-2v-2.5M16 12l-4-4-4 4M12 8v8" />
            </svg>
            <span className="text-sm text-zinc-400">Drop floor plan here</span>
            <span className="text-xs text-zinc-600 mt-1">JPG · PNG · PDF</span>
          </>
        )}
      </div>

      {error && (
        <div className="mt-4 w-80 bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  )
}
