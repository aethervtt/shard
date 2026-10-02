import { OrbitControls, type OrbitControlsValue } from '@aethervtt/shard-controls'

/** `?still` holds turntables, for steady frame times to measure against. */
export const still = new URLSearchParams(location.search).has('still')

type Vec3 = [number, number, number]

/**
 * Orbit controls (0060) that start a demo's camera at `eye`, looking at `target`: left or right
 * drag orbits, middle drag (or Shift+right) pans, the wheel zooms to the cursor, and touch pinches,
 * pans and twists. `turn` (degrees a second) makes it a turntable; `?still` holds it.
 */
export function orbitFrom(
  eye: Vec3,
  target: Vec3,
  options: { turn?: number } & Partial<OrbitControlsValue> = {},
) {
  const { turn = 0, ...fields } = options
  const dx = eye[0] - target[0]
  const dy = eye[1] - target[1]
  const dz = eye[2] - target[2]
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const pitch = (Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI
  return [
    OrbitControls,
    {
      target,
      distance,
      yaw: (Math.atan2(dx, dz) * 180) / Math.PI,
      pitch,
      minPitch: Math.min(5, pitch),
      maxPitch: 89,
      minDistance: distance / 10,
      maxDistance: distance * 5,
      autoRotate: still ? 0 : turn,
      ...fields,
    },
  ] as const
}
