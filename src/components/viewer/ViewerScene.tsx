import { useEffect, useMemo, useState } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '@/store'
import { CameraController } from './CameraController'
import {
  buildRoomFloorGeometry,
  buildWallCollisionAabbs,
  buildWallRenderBoxes,
  type WallRenderBox,
} from '@/lib/geometry/rendering'
import type { Room } from '@/lib/schema'
import { getSourceImageOverlay, type SourceImageOverlayAnnotation } from '@/lib/sourceImageOverlay'

interface FloorMeshProps {
  room: Room
}

function FloorMesh({ room }: FloorMeshProps) {
  const geometry = useMemo(
    () => (room.vertices.length >= 3 ? buildRoomFloorGeometry(room) : null),
    [room],
  )

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return null

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial color={floorColor(room.floor_material)} side={THREE.DoubleSide} />
    </mesh>
  )
}

interface WallBoxMeshProps {
  box: WallRenderBox
}

function WallBoxMesh({ box }: WallBoxMeshProps) {
  return (
    <mesh position={box.position} rotation={[0, box.rotationY, 0]} castShadow receiveShadow>
      <boxGeometry args={box.size} />
      <meshStandardMaterial color={box.isExterior ? '#8a8a9a' : '#747484'} />
    </mesh>
  )
}

function SourceFloorPlanMesh({
  overlay,
  bounds,
}: {
  overlay: SourceImageOverlayAnnotation
  bounds: { width: number; height: number }
}) {
  const texture = useSourceImageTexture(overlay)
  if (!texture) return null

  return (
    <mesh position={[bounds.width / 2, 0.004, bounds.height / 2]} rotation={[Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[bounds.width, bounds.height]} />
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} transparent opacity={0.86} />
    </mesh>
  )
}

function CameraAutoCenter() {
  const { camera, controls } = useThree()
  const floorPlan = useStore((s) => s.floorPlan)

  useEffect(() => {
    if (!floorPlan) return
    const { width, height } = floorPlan.meta.bounds
    const cx = width / 2
    const cz = height / 2
    const dist = Math.max(width, height) * 0.9

    camera.position.set(cx, dist, cz - dist)
    camera.lookAt(cx, 0, cz)
    if (controls) {
      const orbit = controls as { target?: THREE.Vector3; update?: () => void }
      orbit.target?.set(cx, 0, cz)
      orbit.update?.()
    }
  }, [camera, controls, floorPlan])

  return null
}

export function ViewerScene() {
  const floorPlan = useStore((s) => s.floorPlan)
  const cameraMode = useStore((s) => s.cameraMode)
  const setCameraMode = useStore((s) => s.setCameraMode)
  const sourceOverlay = useMemo(
    () => getSourceImageOverlay(floorPlan?.annotations),
    [floorPlan?.annotations],
  )

  const wallBoxes = useMemo(
    () => buildWallRenderBoxes(floorPlan?.walls ?? []),
    [floorPlan?.walls],
  )
  const wallAabbs = useMemo(
    () => buildWallCollisionAabbs(floorPlan?.walls ?? []),
    [floorPlan?.walls],
  )

  return (
    <>
      <color attach="background" args={['#18181b']} />
      <ambientLight intensity={1.2} />
      <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow />
      <directionalLight position={[-10, 10, -10]} intensity={0.5} />

      <CameraAutoCenter />

      <CameraController
        mode={cameraMode}
        wallAabbs={wallAabbs}
        onExitFirstPerson={() => setCameraMode('orbit')}
      />

      {floorPlan && sourceOverlay ? (
        <SourceFloorPlanMesh overlay={sourceOverlay} bounds={floorPlan.meta.bounds} />
      ) : (
        floorPlan?.rooms.map((room) => (
          <FloorMesh key={room.id} room={room} />
        ))
      )}

      {wallBoxes.map((box) => (
        <WallBoxMesh key={box.id} box={box} />
      ))}

      {!floorPlan && <gridHelper args={[20, 20, '#3f3f46', '#27272a']} />}
    </>
  )
}

function useSourceImageTexture(overlay: SourceImageOverlayAnnotation): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)

  useEffect(() => {
    let cancelled = false
    const img = new Image()

    img.onload = () => {
      if (cancelled) return
      const cropW = Math.max(1, Math.round(overlay.crop.x1 - overlay.crop.x0))
      const cropH = Math.max(1, Math.round(overlay.crop.y1 - overlay.crop.y0))
      const canvas = document.createElement('canvas')
      canvas.width = cropW
      canvas.height = cropH
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.drawImage(
        img,
        overlay.crop.x0,
        overlay.crop.y0,
        cropW,
        cropH,
        0,
        0,
        cropW,
        cropH,
      )

      const nextTexture = new THREE.CanvasTexture(canvas)
      nextTexture.colorSpace = THREE.SRGBColorSpace
      // The floor plane is viewed from the back side after mapping image Y to plan Z;
      // counter-flip X so source text/rooms match the 2D plan instead of mirroring.
      nextTexture.wrapS = THREE.ClampToEdgeWrapping
      nextTexture.offset.x = 1
      nextTexture.repeat.x = -1
      nextTexture.needsUpdate = true
      setTexture((previous) => {
        previous?.dispose()
        return nextTexture
      })
    }
    img.onerror = () => {
      if (!cancelled) setTexture(null)
    }
    img.src = `data:${overlay.mimeType};base64,${overlay.data}`

    return () => {
      cancelled = true
      setTexture((previous) => {
        previous?.dispose()
        return null
      })
    }
  }, [overlay])

  return texture
}

function floorColor(material: string): string {
  switch (material) {
    case 'hardwood':
      return '#8b5a2b'
    case 'tile':
      return '#8c9198'
    case 'carpet':
      return '#58626f'
    case 'concrete':
      return '#6b7280'
    default:
      return '#4a4a52'
  }
}
