import type { World } from '@aethervtt/shard-core'
import { OriginShift } from '@aethervtt/shard-transform'
import { Instances } from './instances'
import { RenderCounters } from './stats'
import { Cameras, shiftCameraHistory } from './view'

/**
 * Moves everything the renderer keeps from earlier frames into the new origin frame (spec 0040):
 * previous instance transforms, each camera's last view-projection, and retained gizmos. TAA history
 * textures hold colors, not positions, so they stay valid once reprojection lines up. Shadow
 * cascades and light records are rebuilt from `GlobalTransform` every frame.
 */
export function shiftRenderHistory(world: World, x: number, y: number, z: number): void {
  world.initResource(RenderCounters).originShifts++
  if (x === 0 && y === 0 && z === 0) return
  world.tryResource(Instances)?.shiftOrigin(x, y, z)
  const cameras = world.tryResource(Cameras)
  if (cameras) for (const cam of cameras.values()) shiftCameraHistory(cam, x, y, z)
}

/**
 * Follows `OriginShift` synchronously: it fires during transform propagation (PostUpdate), after
 * this frame's gameplay drew in the old frame and before extraction reads the new one.
 */
export function observeOriginShifts(world: World): () => void {
  return world.observe(OriginShift, ({ world: w, data }) => {
    shiftRenderHistory(w, data.offset[0], data.offset[1], data.offset[2])
  })
}
