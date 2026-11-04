import {
  defineResource,
  defineSchema,
  type Entity,
  findComponent,
  ProfilerResource,
  t,
  type World,
} from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { MAX_WATER_BODIES, WaterBodies, WaterBodiesState, type WaterBodyRecord } from './bodies'
import { levelTexel } from './clipmap'
import { waterAt, waterSample } from './query'
import { WaterRender } from './render'
import { INFO_LEVELS, INFO_SIZE } from './shaders'

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

const finite = (n: number) => (Number.isFinite(n) ? n : null)

function describeBody(world: World, r: WaterBodyRecord) {
  const s = r.shape
  return {
    entity: r.entity,
    path: scenePath(world, r.entity),
    kind: r.kind,
    level: r.level,
    priority: r.priority,
    outline: s
      ? {
          points: s.count,
          bounds: [...s.bounds],
          triangles: s.triangles.length / 6,
        }
      : null,
    optics: {
      asset: r.opticsRef?.path ?? r.opticsRef?.guid ?? null,
      fallback: r.missingOptics
        ? 'clear (water/no-optics)'
        : r.opticsLoading
          ? 'clear (loading)'
          : null,
      ...r.optics,
    },
    wind: r.windOwn
      ? { own: true, speed: r.windSpeed, direction: [...r.windDirection] }
      : { own: false },
    problem: r.problem ? { code: r.problem.code, message: r.problem.message } : null,
  }
}

/** Sections plugins add to `water.describe` (0098's waves). */
export const WaterDescribers = defineResource<Map<string, (world: World) => unknown>>(
  'water/Describers',
  { description: 'Sections plugins add to water.describe.', init: () => new Map() },
)

/** `water.describe`: bodies, the zone's clipmap, and what the water pass costs. */
export function describeWater(world: World) {
  const state = world.tryResource(WaterBodies) ?? new WaterBodiesState()
  const render = world.tryResource(WaterRender)
  const profiler = world.tryResource(ProfilerResource)
  const bodies = [...state.records.values()].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.entity - b.entity,
  )
  const clip = render?.clip
  return {
    bodies: bodies.map((r) => describeBody(world, r)),
    drawn: state.count,
    /** Bodies past MAX_WATER_BODIES that don't draw (lowest priorities). */
    skipped: state.skipped,
    maxBodies: MAX_WATER_BODIES,
    unbounded: state.unbounded,
    bounds: state.count > 0 && !state.unbounded ? [...state.bounds] : null,
    zone: clip
      ? {
          levels: Array.from({ length: INFO_LEVELS }, (_, l) => ({
            level: l,
            texel: levelTexel(l),
            size: INFO_SIZE,
            corner: [clip.corner(l, 0), clip.corner(l, 1)],
            extent: levelTexel(l) * INFO_SIZE,
            groundFilling: clip.pending[l] === 1,
          })),
          rebuildsLastFrame: clip.rebuilds,
          rebuilds: clip.totalRebuilds,
          groundTexelsLastFrame: clip.filled,
        }
      : null,
    terrains: state.terrainCount,
    /** GPU time of the water pass and the info texture's redraws (ms), when timestamps work. */
    gpuMs: {
      water: profiler?.timing('gpu:water')?.last ?? null,
      info: profiler?.timing('gpu:water/info')?.last ?? null,
    },
    ...Object.fromEntries(
      [...(world.tryResource(WaterDescribers) ?? new Map<string, (w: World) => unknown>())].map(
        ([name, fn]) => [name, fn(world)],
      ),
    ),
  }
}

export const waterMethods: AppMethod[] = [
  {
    name: 'water.describe',
    description:
      'Water (0097) as data: every body (kind, level, priority, outline points and bounds, optics and whether it fell back to clear, its wind, any water/bad-spline problem), the zone’s info clipmap levels (texel size, corner, extent) and redraws, and the water pass’s GPU time.',
    params: defineSchema('water/DescribeParams', {}),
    handler: ({ world }) => describeWater(world),
  },
  {
    name: 'water.sample',
    description:
      'waterAt at a world position: the body there, its surface height, the point’s depth below it, the ground under it, the surface normal and flow, and whether the point is under water. CPU only, the same headless.',
    params: defineSchema('water/SampleParams', {
      position: t.vec3({ required: true, description: 'World-space point.' }),
    }),
    handler: ({ world }, p) => {
      const position = [...(p.position as number[])] as [number, number, number]
      const s = waterAt(world, position, waterSample())
      return {
        position,
        body: s.body,
        path: s.body !== null ? scenePath(world, s.body) : null,
        surfaceHeight: finite(s.surfaceHeight),
        depth: finite(s.depth),
        groundHeight: finite(s.groundHeight),
        flow: s.flow,
        normal: s.normal,
        underwater: s.underwater,
        optics: s.optics,
      }
    },
  },
]
