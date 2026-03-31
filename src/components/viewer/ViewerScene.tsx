// 3D scene: each room rendered as an independent box (floor + 4 walls).
// Rooms from adjacent areas will produce double-walls at shared edges,
// which is visually acceptable and avoids the fragility of adjacency detection.
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { useStore } from '@/store'
import { CameraController } from './CameraController'
import type { Room } from '@/lib/schema'

// Schema coords: origin bottom-left, +X right, +Y up (depth).
// Three.js floor plane is XZ. rotation=[+PI/2, 0, 0] maps schema Y → Three.js +Z.


interface RoomBoxProps {
  room: Room
  boundsWidth: number
  boundsHeight: number
}

function RoomBox({ room, boundsWidth, boundsHeight }: RoomBoxProps) {
  // Filter rooms with obviously garbage coordinates (3m tolerance for balconies/overhangs)
  const margin = 3
  const inBounds = room.vertices.every(
    (v) => v.x >= -margin && v.x <= boundsWidth + margin && v.y >= -margin && v.y <= boundsHeight + margin
  )
  if (!inBounds) return null

  const xs = room.vertices.map((v) => v.x)
  const ys = room.vertices.map((v) => v.y)
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)

  const w = xMax - xMin
  const d = yMax - yMin
  if (w < 0.1 || d < 0.1) return null

  const h = room.ceiling_height > 0 ? room.ceiling_height : 2.7
  const t = 0.15 // wall thickness
  const isExteriorCandidate = true // color hinting — all rooms treated the same for now
  const color = isExteriorCandidate ? '#8a8a9a' : '#6a6a7a'

  // Group centered at room center; schema Y maps to Three.js +Z
  const cx = xMin + w / 2
  const cz = yMin + d / 2

  return (
    <group position={[cx, 0, cz]}>
      {/* Floor: local coords centered at room center, +PI/2 maps local Y → Three.js +Z */}
      <mesh rotation={[Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#4a4a52" />
      </mesh>
      {/* North wall (+Z face) */}
      <mesh position={[0, h / 2, d / 2]} castShadow receiveShadow>
        <boxGeometry args={[w + t, h, t]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* South wall (-Z face) */}
      <mesh position={[0, h / 2, -d / 2]} castShadow receiveShadow>
        <boxGeometry args={[w + t, h, t]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* East wall (+X face) */}
      <mesh position={[w / 2, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[t, h, d + t]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* West wall (-X face) */}
      <mesh position={[-w / 2, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[t, h, d + t]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
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
    // Camera on the north side (negative Z) looking toward +Z
    camera.position.set(cx, dist, cz - dist)
    camera.lookAt(cx, 0, cz)
    if (controls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orbit = controls as any
      orbit.target.set(cx, 0, cz)
      orbit.update()
    }
  }, [camera, controls, floorPlan])

  return null
}

export function ViewerScene() {
  const floorPlan = useStore((s) => s.floorPlan)
  const cameraMode = useStore((s) => s.cameraMode)
  const setCameraMode = useStore((s) => s.setCameraMode)

  const boundsWidth = floorPlan?.meta.bounds.width ?? 20
  const boundsHeight = floorPlan?.meta.bounds.height ?? 20

  // Compute wall AABBs from room bboxes for first-person collision detection
  const wallAabbs = (floorPlan?.rooms ?? []).flatMap((room) => {
    const xs = room.vertices.map((v) => v.x)
    const ys = room.vertices.map((v) => v.y)
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const yMin = Math.min(...ys)
    const yMax = Math.max(...ys)
    const t = 0.15
    // Return 4 AABBs (one per wall face) for collision
    return [
      // North wall
      { minX: xMin, maxX: xMax, minZ: yMax - t / 2, maxZ: yMax + t / 2 },
      // South wall
      { minX: xMin, maxX: xMax, minZ: yMin - t / 2, maxZ: yMin + t / 2 },
      // East wall
      { minX: xMax - t / 2, maxX: xMax + t / 2, minZ: yMin, maxZ: yMax },
      // West wall
      { minX: xMin - t / 2, maxX: xMin + t / 2, minZ: yMin, maxZ: yMax },
    ]
  })

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

      {floorPlan?.rooms.map((room) => (
        <RoomBox
          key={room.id}
          room={room}
          boundsWidth={boundsWidth}
          boundsHeight={boundsHeight}
        />
      ))}

      {!floorPlan && <gridHelper args={[20, 20, '#3f3f46', '#27272a']} />}
    </>
  )
}
