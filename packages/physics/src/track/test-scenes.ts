import { quat, Rng } from '@aethervtt/shard-core'
import type { TrackBody, TrackCollider, TrackScene } from './scene'

// Scenes for the track tests: a walled tray and convex dice thrown into it from a seed.

const PHI = (1 + Math.sqrt(5)) / 2

function hull(points: number[][], radius: number): Float32Array {
  const out = new Float32Array(points.length * 3)
  points.forEach((p, i) => {
    const len = Math.sqrt(p[0]! * p[0]! + p[1]! * p[1]! + p[2]! * p[2]!)
    for (let k = 0; k < 3; k++) out[i * 3 + k] = (p[k]! / len) * radius
  })
  return out
}

const signs = [-1, 1]
export const CUBE_POINTS = hull(
  signs.flatMap((x) => signs.flatMap((y) => signs.map((z) => [x, y, z]))),
  0.52,
)
export const OCTAHEDRON_POINTS = hull(
  [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
  0.42,
)
export const ICOSAHEDRON_POINTS = hull(
  signs.flatMap((a) =>
    signs.flatMap((b) => [
      [0, a, b * PHI],
      [a, b * PHI, 0],
      [b * PHI, 0, a],
    ]),
  ),
  0.4,
)

const SHAPES = [CUBE_POINTS, OCTAHEDRON_POINTS, ICOSAHEDRON_POINTS]

function wall(x: number, z: number, hx: number, hz: number): TrackCollider {
  return {
    shape: 'cuboid',
    halfExtents: [hx, 2, hz],
    translation: [x, 2, z],
    friction: 0.3,
    restitution: 0.4,
    density: 1,
    group: 'walls',
  }
}

/** `count` convex dice thrown from the tray's right side, velocities and spins from `seed`. */
export function trayScene(count: number, seed: number, maxSteps = 480): TrackScene {
  const rng = new Rng(seed)
  const bodies: TrackBody[] = []
  for (let i = 0; i < count; i++) {
    const rotation = quat.fromEuler(
      [0, 0, 0, 1],
      rng.range(0, 360),
      rng.range(0, 360),
      rng.range(0, 360),
    ) as [number, number, number, number]
    bodies.push({
      id: `die-${i}`,
      // A grid, so no two start inside each other.
      translation: [1 + (i % 4) * 1.1, 1.5 + Math.floor(i / 16) * 1.1, ((i >> 2) % 4) * 1.1 - 1.6],
      rotation,
      linear: [rng.range(-7, -4), rng.range(1, 3), rng.range(-2, 2)],
      angular: [rng.range(-15, 15), rng.range(-15, 15), rng.range(-15, 15)],
      colliders: [
        {
          shape: 'convex',
          points: SHAPES[i % SHAPES.length]!,
          friction: 0.6,
          restitution: 0.3,
          density: 1,
          group: 'dice',
        },
      ],
      ccd: true,
    })
  }
  return {
    version: 1,
    dim: 3,
    step: 1 / 60,
    maxSteps,
    gravity: [0, -9.81, 0],
    groups: {
      dice: { layers: 1, mask: 1 | 2 | 4 },
      walls: { layers: 2, mask: 1 },
      floor: { layers: 4, mask: 1 },
    },
    fixed: [
      {
        shape: 'cuboid',
        halfExtents: [8, 0.5, 8],
        translation: [0, -0.5, 0],
        friction: 0.6,
        restitution: 0.3,
        density: 1,
        group: 'floor',
      },
      wall(0, -4, 6, 0.2),
      wall(0, 3, 6, 0.2),
      wall(-5.5, 0, 0.2, 5),
      wall(5.5, 0, 0.2, 5),
    ],
    bodies,
  }
}
