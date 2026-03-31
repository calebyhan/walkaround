import { Fragment, useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { Stage, Layer, Line, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useStore } from '@/store'
import type { Point } from '@/lib/schema'

const SCALE_BY = 1.05

interface StageSize {
  width: number
  height: number
}

export function EditorCanvasKonva() {
  const floorPlan = useStore((s) => s.floorPlan)
  const stageRef = useRef<Konva.Stage>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState<StageSize>({ width: 0, height: 0 })

  useEffect(() => {
    const measure = () => {
      const el = containerRef.current
      if (!el) return
      setStageSize({ width: el.clientWidth, height: el.clientHeight })
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const worldBounds = useMemo(() => {
    if (!floorPlan) return null

    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    const includePoint = (point: Point) => {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }

    floorPlan.rooms.forEach((room) => room.vertices.forEach(includePoint))
    floorPlan.walls.forEach((wall) => wall.vertices.forEach(includePoint))

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      minX = 0
      minY = 0
      maxX = floorPlan.meta.bounds.width
      maxY = floorPlan.meta.bounds.height
    }

    const width = Math.max(maxX - minX, floorPlan.meta.bounds.width, 1)
    const height = Math.max(maxY - minY, floorPlan.meta.bounds.height, 1)

    return { minX, minY, width, height }
  }, [floorPlan])

  const toCanvas = useCallback((point: Point): [number, number] => {
    if (!worldBounds || stageSize.width === 0 || stageSize.height === 0) {
      return [point.x, point.y]
    }

    const padding = 32
    const availableWidth = Math.max(stageSize.width - padding * 2, 1)
    const availableHeight = Math.max(stageSize.height - padding * 2, 1)
    const scale = Math.min(availableWidth / worldBounds.width, availableHeight / worldBounds.height)

    const x = (point.x - worldBounds.minX) * scale + padding
    const y = stageSize.height - ((point.y - worldBounds.minY) * scale + padding)
    return [x, y]
  }, [stageSize.height, stageSize.width, worldBounds])

  const handleWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return

    const oldScale = stage.scaleX()
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    }

    const direction = e.evt.deltaY < 0 ? 1 : -1
    const newScale = direction > 0 ? oldScale * SCALE_BY : oldScale / SCALE_BY

    stage.scale({ x: newScale, y: newScale })
    stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    })
  }, [])

  return (
    <div ref={containerRef} className="relative w-full h-full bg-zinc-900">
      <div className="absolute top-2 left-2 z-10 text-xs text-zinc-400 bg-zinc-800 px-2 py-1 rounded">
        2D floor plan — scroll to zoom, drag canvas to pan
      </div>
      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        draggable
        onWheel={handleWheel}
      >
        <Layer>
          {floorPlan?.rooms.map((room) => {
            const points = room.vertices.flatMap((point) => toCanvas(point))
            const labelPoint = room.vertices[0]
            const [labelX, labelY] = toCanvas(labelPoint)

            return (
              <Fragment key={`room-${room.id}`}>
                <Line
                  points={points}
                  closed
                  fill="#2563eb22"
                  stroke="#1d4ed8"
                  strokeWidth={1.5}
                />
                <Text
                  x={labelX + 4}
                  y={labelY - 16}
                  text={room.name}
                  fontSize={11}
                  fill="#cbd5e1"
                />
              </Fragment>
            )
          })}

          {floorPlan?.walls.map((wall) => {
            const points = wall.vertices.flatMap((point) => toCanvas(point))
            return (
              <Line
                key={`wall-${wall.id}`}
                points={points}
                stroke={wall.is_exterior ? '#93c5fd' : '#38bdf8'}
                strokeWidth={3}
                lineCap="round"
                lineJoin="round"
              />
            )
          })}

          {!floorPlan && (
            <Text
              x={24}
              y={56}
              text="Upload a plan to render parsed geometry here"
              fontSize={13}
              fill="#a1a1aa"
            />
          )}
        </Layer>
      </Stage>
    </div>
  )
}
