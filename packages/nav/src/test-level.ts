import type { Entity, World } from '@shard/core'
import { Collider } from '@shard/physics'
import { App, type Plugin } from '@shard/runtime'
import { Transform, TransformPlugin } from '@shard/transform'
import { NavSource } from './components'
import { navPlugin } from './plugin'

const DT = 1 / 60

export async function navApp(...plugins: Plugin[]): Promise<App> {
  const a = new App().addPlugin(TransformPlugin, navPlugin, ...plugins)
  await a.init()
  return a
}

export function frames(a: App, n: number): void {
  for (let i = 0; i < n; i++) a.update(DT)
}

/** A box whose top face is at `top`, centered on (x, z). */
export function slab(
  world: World,
  x: number,
  z: number,
  hx: number,
  hz: number,
  top: number,
  area = 0,
): Entity {
  return world.spawn(
    [NavSource, { area }],
    [Collider, { shape: 'cuboid', halfExtents: [hx, 0.5, hz] }],
    [Transform, { translation: [x, top - 0.5, z] }],
  )
}

/**
 * A ramp `width` wide rising toward -z from (x, 0, z0) at `degrees`, until it reaches `rise`.
 * Its top surface passes through (x, 0, z0).
 */
export function ramp(
  world: World,
  x: number,
  z0: number,
  degrees: number,
  rise: number,
  width = 3,
): Entity {
  const a = (degrees * Math.PI) / 180
  const half = rise / Math.sin(a) / 2
  return world.spawn(
    [NavSource, {}],
    [Collider, { shape: 'cuboid', halfExtents: [width / 2, 0.25, half] }],
    [
      Transform,
      {
        translation: [
          x,
          Math.sin(a) * half - Math.cos(a) * 0.25,
          z0 - Math.cos(a) * half - Math.sin(a) * 0.25,
        ],
        rotation: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)],
      },
    ],
  )
}

/**
 * Two floors: ground (40 × 40, top y = 0) and an upper floor (top y = 3) north of it, joined by a
 * 27° ramp. A second platform (also y = 3) is only reachable by a 60° ramp.
 */
export function level(world: World): {
  upper: [number, number, number]
  steep: [number, number, number]
} {
  slab(world, 0, 0, 20, 20, 0)
  slab(world, 6, -12, 4, 4, 3) // upper floor: x 2..10, z -16..-8
  ramp(world, 6, -2, 26.57, 3) // from z = -2 up to z ≈ -8
  slab(world, -8, -12, 3, 3, 3) // steep platform: x -11..-5, z -15..-9
  ramp(world, -8, -6, 60, 3)
  return { upper: [6, 3, -12], steep: [-8, 3, -12] }
}
