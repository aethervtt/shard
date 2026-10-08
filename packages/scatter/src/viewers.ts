import type { Query, World } from '@aethervtt/shard-core'
import { Camera3d } from '@aethervtt/shard-render'
import { GlobalTransform } from '@aethervtt/shard-transform'

/** The query `cameraPositions` reads: every 3D camera with a world transform. */
export function cameraQuery(world: World): Query {
  return world.query({ with: [Camera3d, GlobalTransform] })
}

/**
 * Calls `visit` with each active camera's world position (origin-relative, as GlobalTransform
 * holds it) and its index; returns how many. Headless runs have cameras too (scenes spawn them),
 * so scatter ranges work the same with or without a GPU.
 */
export function cameraPositions(
  _world: World,
  cameras: Query,
  visit: (x: number, y: number, z: number, index: number) => void,
): number {
  let n = 0
  for (const table of cameras.tables) {
    const active = table.column(Camera3d, 'active')
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      if (!active[row]) continue
      visit(m[row * 12 + 3]!, m[row * 12 + 7]!, m[row * 12 + 11]!, n)
      n++
    }
  }
  return n
}
