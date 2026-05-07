import { useRef, useEffect, useCallback } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const FP_MOVE_SPEED = 1.4 // m/s
const FP_LOOK_SENSITIVITY = 0.002
const EYE_HEIGHT = 1.6 // meters above floor

interface WallAabb {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

interface Props {
  wallAabbs: WallAabb[]
  onExit: () => void
}

export function FirstPersonController({ wallAabbs, onExit }: Props) {
  const { camera, gl } = useThree()
  const keys = useRef(new Set<string>())
  const yaw = useRef(0)
  const pitch = useRef(0)
  const locked = useRef(false)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!locked.current) return
    yaw.current -= e.movementX * FP_LOOK_SENSITIVITY
    pitch.current -= e.movementY * FP_LOOK_SENSITIVITY
    pitch.current = Math.max(-Math.PI * 0.47, Math.min(Math.PI * 0.47, pitch.current))
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    keys.current.add(e.code)
  }, [])

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    keys.current.delete(e.code)
  }, [])

  const handlePointerLockChange = useCallback(() => {
    locked.current = document.pointerLockElement === gl.domElement
    if (!locked.current) {
      onExit()
    }
  }, [gl.domElement, onExit])

  useEffect(() => {
    // Set initial eye height
    camera.position.y = EYE_HEIGHT

    gl.domElement.requestPointerLock()

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('keyup', handleKeyUp)
    document.addEventListener('pointerlockchange', handlePointerLockChange)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('keyup', handleKeyUp)
      document.removeEventListener('pointerlockchange', handlePointerLockChange)
      if (document.pointerLockElement === gl.domElement) {
        document.exitPointerLock()
      }
    }
  }, [camera, gl.domElement, handleMouseMove, handleKeyDown, handleKeyUp, handlePointerLockChange])

  useFrame((_, delta) => {
    if (!locked.current) return

    // Apply yaw/pitch to camera
    camera.rotation.order = 'YXZ'
    camera.rotation.y = yaw.current
    camera.rotation.x = pitch.current

    // Compute movement in camera-relative XZ plane
    const forward = new THREE.Vector3(
      -Math.sin(yaw.current),
      0,
      -Math.cos(yaw.current),
    )
    const right = new THREE.Vector3(
      Math.cos(yaw.current),
      0,
      -Math.sin(yaw.current),
    )

    const move = new THREE.Vector3()
    if (keys.current.has('KeyW') || keys.current.has('ArrowUp')) move.addScaledVector(forward, 1)
    if (keys.current.has('KeyS') || keys.current.has('ArrowDown')) move.addScaledVector(forward, -1)
    if (keys.current.has('KeyA') || keys.current.has('ArrowLeft')) move.addScaledVector(right, -1)
    if (keys.current.has('KeyD') || keys.current.has('ArrowRight')) move.addScaledVector(right, 1)

    if (move.lengthSq() === 0) return
    move.normalize().multiplyScalar(FP_MOVE_SPEED * delta)

    const desired = camera.position.clone().add(move)
    desired.y = EYE_HEIGHT

    // AABB collision — resolve per axis to allow wall sliding
    const px = resolveAxis(camera.position.x, desired.x, camera.position.z, wallAabbs, 'x')
    const pz = resolveAxis(camera.position.z, desired.z, px, wallAabbs, 'z')

    camera.position.set(px, EYE_HEIGHT, pz)
  })

  return null
}

// Try to move from `current` to `desired` along `axis`, testing against AABBs.
// Returns the resolved position for that axis.
function resolveAxis(
  current: number,
  desired: number,
  otherAxisPosition: number,
  aabbs: WallAabb[],
  axis: 'x' | 'z',
): number {
  const PLAYER_RADIUS = 0.2

  const testX = axis === 'x' ? desired : otherAxisPosition
  const testZ = axis === 'z' ? desired : otherAxisPosition

  for (const aabb of aabbs) {
    const overlapX = testX > aabb.minX - PLAYER_RADIUS && testX < aabb.maxX + PLAYER_RADIUS
    const overlapZ = testZ > aabb.minZ - PLAYER_RADIUS && testZ < aabb.maxZ + PLAYER_RADIUS
    if (overlapX && overlapZ) {
      return current
    }
  }

  return desired
}
