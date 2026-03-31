import { useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { FirstPersonController } from './FirstPersonController'

interface WallAabb {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

interface Props {
  mode: 'orbit' | 'firstperson'
  wallAabbs?: WallAabb[]
  onExitFirstPerson: () => void
}

export function CameraController({ mode, wallAabbs = [], onExitFirstPerson }: Props) {
  const { camera } = useThree()
  const lastOrbitPosition = useRef(new THREE.Vector3(5, 8, 10))
  const lastOrbitTarget = useRef(new THREE.Vector3(0, 0, 0))

  if (mode === 'firstperson') {
    return (
      <FirstPersonController
        wallAabbs={wallAabbs}
        onExit={() => {
          // Restore orbit position
          camera.position.copy(lastOrbitPosition.current)
          camera.lookAt(lastOrbitTarget.current)
          onExitFirstPerson()
        }}
      />
    )
  }

  return (
    <OrbitControls
      makeDefault
      minDistance={1}
      maxDistance={100}
      maxPolarAngle={Math.PI / 2}
      onChange={() => {
        // Keep saving last known orbit state for FP entry
        lastOrbitPosition.current.copy(camera.position)
      }}
    />
  )
}
