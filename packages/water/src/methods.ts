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
import { RIVER_STRIDE, type RiverShape } from './rivers'
import { INFO_LEVELS, INFO_SIZE } from './shaders'

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

const finite = (n: number) => (Number.isFinite(n) ? n : null)

/** A river's extent as describe shows it (0123): length, and its ranges of width and flow. */
function describeRiver(r: RiverShape) {
  let w0 = Infinity
  let w1 = -Infinity
  let f0 = Infinity
  let f1 = -Infinity
  for (let i = 0; i < r.count; i++) {
    const w = r.samples[i * RIVER_STRIDE + 3]! * 2
    const f = r.flows[i]!
    w0 = Math.min(w0, w)
    w1 = Math.max(w1, w)
    f0 = Math.min(f0, f)
    f1 = Math.max(f1, f)
  }
  const round = (v: number) => Math.round(v * 100) / 100
  return {
    samples: r.count,
    length: round(r.length),
    width: [round(w0), round(w1)],
    flow: [round(f0), round(f1)],
    bounds: [...r.bounds],
  }
}

function describeBody(world: World, r: WaterBodyRecord, drawn: boolean) {
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
    river: r.river ? describeRiver(r.river) : null,
    drawn,
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
  const drawn = new Set(state.sorted.slice(0, state.count))
  return {
    bodies: bodies.map((r) => describeBody(world, r, drawn.has(r))),
    /** Valid bodies (no problem): what waterAt finds, drawn or not (0123). */
    valid: state.all.length,
    drawn: state.count,
    /** Valid bodies past MAX_WATER_BODIES that don't draw: the farthest from the camera (0123). */
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
      'Water (0097) as data: every body (kind, level, priority, outline points and bounds, a river’s length and width and flow ranges, whether it draws, optics and whether it fell back to clear, its wind, any water/bad-spline problem), how many are valid and drawn (the 64 nearest the camera, 0123), the zone’s info clipmap levels (texel size, corner, extent) and redraws, and the water pass’s GPU time.',
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
