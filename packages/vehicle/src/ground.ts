import type { Entity, World } from '@aethervtt/shard-core'
import { Collider, RigidBody, type SurfacePreset, surfacePreset } from '@aethervtt/shard-physics'
import { Transform } from '@aethervtt/shard-transform'

/**
 * Flat ground of 250 m box tiles, a long strip along Z (one huge box makes shape casts lose precision), top at y = 0,
 * or tilted by `grade` (rise over run), uphill toward −Z, through `at`.
 */
export function groundTiles(
  world: World,
  options: {
    surface?: SurfacePreset
    /** Width across X and length along Z covered, m (default a 1 km × 8 km strip). */
    width?: number
    length?: number
    at?: [number, number, number]
    grade?: number
    friction?: number
  } = {},
): Entity[] {
  const tile = 250
  const nx = Math.max(1, Math.round((options.width ?? 1000) / tile))
  const nz = Math.max(1, Math.round((options.length ?? 8000) / tile))
  const angle = Math.atan(options.grade ?? 0)
  const at = options.at ?? [0, 0, 0]
  const half = angle / 2
  const rotation: [number, number, number, number] = [Math.sin(half), 0, 0, Math.cos(half)]
  const tiles: Entity[] = []
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      // Tile center in the slope's frame, then rotated about X through `at`.
      const u = (i - (nx - 1) / 2) * tile
      const v = (j - (nz - 1) / 2) * tile
      const y = -0.5
      const cy = y * Math.cos(angle) - v * Math.sin(angle)
      const cz = y * Math.sin(angle) + v * Math.cos(angle)
      tiles.push(
        world.spawn(
          [RigidBody, { kind: 'fixed' }],
          [
            Collider,
            {
              shape: 'cuboid',
              halfExtents: [tile / 2, 0.5, tile / 2],
              friction: options.friction ?? 0.8,
              surface: options.surface ? surfacePreset(options.surface) : null,
            },
          ],
          [Transform, { translation: [at[0] + u, at[1] + cy, at[2] + cz], rotation }],
        ),
      )
    }
  }
  return tiles
}
