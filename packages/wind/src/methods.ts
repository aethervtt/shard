import { defineSchema, type Entity, findComponent, t, type World } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { serverTick } from './state'
import { BREEZE, Wind, windAt, windSample, windTime } from './wind'
import { WindField, WindZone } from './zones'

/** Beaufort names by upper bound in m/s, for describe. */
const BEAUFORT: [number, string][] = [
  [0.5, 'calm'],
  [1.6, 'light air'],
  [3.4, 'light breeze'],
  [5.5, 'gentle breeze'],
  [8, 'moderate breeze'],
  [10.8, 'fresh breeze'],
  [13.9, 'strong breeze'],
  [17.2, 'near gale'],
  [20.8, 'gale'],
  [24.5, 'strong gale'],
  [28.5, 'storm'],
  [32.7, 'violent storm'],
]

/** The Beaufort name for a speed in m/s ("gentle breeze"). */
export function beaufort(speed: number): string {
  for (const [max, name] of BEAUFORT) if (speed < max) return name
  return 'hurricane'
}

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

export const windMethods: AppMethod[] = [
  {
    name: 'wind.describe',
    description:
      'The wind (0096) as data: the Wind resource (m/s, with its Beaufort name and the sway strength speed / 6), the wind clock and server tick, every WindZone in the order they apply (and how many shaders get), and windAt at a point: direction, steady speed and the gust now.',
    params: defineSchema('wind/DescribeParams', {
      position: t.vec3({
        description: 'Where to sample windAt (world space). Default the origin.',
      }),
    }),
    handler: ({ world }, p) => {
      const wind = world.tryResource(Wind)
      const field = world.tryResource(WindField)
      const position = [...(p.position as number[])] as [number, number, number]
      const at = windAt(world, position, windSample())
      return {
        wind: wind ?? null,
        beaufort: wind ? beaufort(wind.speed) : null,
        strength: wind ? wind.speed / BREEZE : 0,
        time: windTime(world),
        tick: serverTick(world),
        zones: (field?.entities.slice(0, field.count) ?? []).map((entity) => ({
          entity,
          path: scenePath(world, entity),
          ...world.get(entity, WindZone),
        })),
        uploaded: field?.uploaded ?? 0,
        at: { position, ...at, beaufort: beaufort(at.speed) },
      }
    },
  },
]
