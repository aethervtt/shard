import { type Entity, ShardError, type World } from '@aethervtt/shard-core'
import { Camera3d } from '@aethervtt/shard-render'
import { MapControls, OrbitControls } from './components'
import { snapControls } from './controls'

const DEG = Math.PI / 180

/** The floor height a control's view shows across its middle, at its target. */
function visibleHeight(world: World, entity: Entity): number {
  const map = world.tryGet(entity, MapControls)
  if (map) return map.height / map.zoom
  const orbit = world.tryGet(entity, OrbitControls)
  if (orbit) return 2 * orbit.distance * Math.tan((world.get(entity, Camera3d).fovY * DEG) / 2)
  throw new ShardError(
    'controls/no-controls',
    `Entity ${entity} has no MapControls or OrbitControls`,
    {
      hint: 'syncViews takes two cameras that each have a control.',
    },
  )
}

/**
 * Puts camera `to` over the same target as `from`, showing about the same floor area (0060): the
 * orthographic height against the perspective distance × tan(fov/2) × 2. Between two orbit
 * controls the yaw and pitch carry over too. `to` jumps there (no easing).
 *
 * The host calls it when switching views; it never runs by itself, so switching one reader's view
 * can't change another's.
 */
export function syncViews(world: World, from: Entity, to: Entity): void {
  const height = visibleHeight(world, from)
  const source = world.tryGet(from, MapControls) ?? world.get(from, OrbitControls)
  const target = [source.target[0], source.target[1], source.target[2]] as [number, number, number]
  const map = world.tryGet(to, MapControls)
  if (map) {
    const zoom = Math.min(Math.max(map.height / height, map.minZoom), map.maxZoom)
    world.set(to, MapControls, { target, zoom })
  } else {
    const orbit = world.tryGet(to, OrbitControls)
    if (!orbit) visibleHeight(world, to) // throws the error
    const fov = world.get(to, Camera3d).fovY * DEG
    const distance = Math.min(
      Math.max(height / (2 * Math.tan(fov / 2)), orbit!.minDistance),
      orbit!.maxDistance,
    )
    const fromOrbit = world.tryGet(from, OrbitControls)
    world.set(to, OrbitControls, {
      target,
      distance,
      ...(fromOrbit ? { yaw: fromOrbit.yaw, pitch: fromOrbit.pitch } : {}),
    })
  }
  snapControls(world, to)
}
