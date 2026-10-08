import {
  defineSchema,
  type Entity,
  findComponent,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { GlobalTransform, worldPosition64 } from '@aethervtt/shard-transform'
import { isRemoved, Removed, removedKey, ScatterBudget } from './components'
import { FOLIAGE } from './rules'
import { chunkState, finalPlacements, Scatter, type SurfaceScatter } from './runtime'
import {
  P_CELL,
  P_ITEM,
  P_SCALE,
  P_VARIANT,
  P_X,
  PLACEMENT_STRIDE,
  type SurfaceChunk,
} from './surface'

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  const v = world.tryGet(entity, member) as { path?: string } | undefined
  return v?.path || null
}

/** A scattered surface (a planet or a ScatterSurface entity), by id or scene path; the only one when omitted. */
export function resolveSurface(world: World, ref: unknown): SurfaceScatter {
  const surfaces = world.tryResource(Scatter)?.surfaces
  if (!surfaces || surfaces.size === 0) {
    throw new ShardError('scatter/no-surface', 'Nothing in the world scatters', {
      hint: 'Give a Planet (or a Biome) a scatter set, or add scatter/ScatterSurface to a mesh entity; and add the scatter plugin.',
    })
  }
  if (ref === undefined || ref === null || ref === '') {
    if (surfaces.size > 1) {
      throw new ShardError('scatter/which-surface', `${surfaces.size} surfaces scatter; name one`, {
        hint: 'Pass surface: an entity id or a scene path (scatter.describe lists them).',
      })
    }
    return [...surfaces.values()][0]!
  }
  for (const ss of surfaces.values()) {
    if (ss.surface.entity === ref) return ss
    const path = scenePath(world, ss.surface.entity)
    if (typeof ref === 'string' && path && (path === ref || path.endsWith(`/${ref}`))) return ss
  }
  throw new ShardError(
    'scatter/not-a-surface',
    `No scattered surface matches ${JSON.stringify(ref)}`,
    {
      hint: 'scatter.describe lists every surface with its entity and scene path.',
    },
  )
}

const round = (v: number, digits = 3) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

function describeSurface(world: World, ss: SurfaceScatter) {
  const surface = ss.surface
  const rules = surface.rules.map((rule) => {
    const s = ss.stats[rule.index]
    const out: Record<string, unknown> = {
      name: rule.name,
      id: rule.id,
      kind: rule.kind === FOLIAGE ? 'foliage' : 'prop',
      biome: rule.biome,
      range: rule.range,
      cellsPerChunk: surface.cells[rule.index],
    }
    if (rule.kind === FOLIAGE) {
      const f = ss.foliage.get(rule.index)
      let drawn = 0
      let shadows = 0
      if (f) {
        for (const view of f.layer.views.keys()) {
          const v = f.layer.visible(view)
          drawn += v.drawn
          shadows += v.shadows
        }
      }
      out.foliage = f
        ? {
            chunks: f.layer.chunkCount,
            capacity: f.layer.capacity,
            visible: drawn,
            shadowCasters: shadows,
            meshes: f.layer.options.meshes.length,
          }
        : {
            chunks: 0,
            capacity: 0,
            visible: 0,
            shadowCasters: 0,
            meshes: 0,
            note: 'No renderer: foliage is GPU-only.',
          }
    } else {
      out.chunksInRange = s?.chunks ?? 0
      out.placed = s?.placed ?? 0
      out.spawned = s?.spawned ?? 0
      out.candidates = s?.candidates ?? 0
    }
    return out
  })
  return {
    entity: surface.entity,
    path: scenePath(world, surface.entity),
    kind: surface.kind,
    ready: ss.ready,
    waiting: ss.waiting,
    problem: ss.problem
      ? { code: ss.problem.code, message: ss.problem.message, path: ss.problem.path }
      : null,
    rules,
    chunksCached: ss.chunks.size,
    spawnedLastFrame: ss.spawnedLast,
    despawnedLastFrame: ss.despawnedLast,
    msLastFrame: round(ss.ms),
  }
}

const surfaceField = t.json({
  description:
    'The surface: a planet or ScatterSurface entity id or scene path (default: the only one).',
})

const probe = new Float64Array(3)

/** Placements of prop rules within `radius` of a surface-frame point, nearest first. */
export function samplePlacements(
  ss: SurfaceScatter,
  x: number,
  y: number,
  z: number,
  radius: number,
  frame: number,
  removed?: { props: string[] },
): Record<string, unknown>[] {
  const surface = ss.surface
  const out: { d: number; v: Record<string, unknown> }[] = []
  for (const rule of surface.rules) {
    if (rule.kind === FOLIAGE) continue
    // The rule's chunks around the point: probes over the circle, deduplicated.
    const seen = new Map<string, SurfaceChunk>()
    surface.upAt(x, y, z, probe)
    const steps = 4
    for (let j = -steps; j <= steps; j++) {
      for (let i = -steps; i <= steps; i++) {
        const s = radius / steps
        // Two tangents at the point.
        const ux = probe[0]!
        const uy = probe[1]!
        const uz = probe[2]!
        const ax = Math.abs(uy) < 0.9 ? 0 : 1
        const ay = Math.abs(uy) < 0.9 ? 1 : 0
        let e1x = ay * uz
        let e1y = -ax * uz
        let e1z = ax * uy - ay * ux
        const l = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z) || 1
        e1x /= l
        e1y /= l
        e1z /= l
        const e2x = uy * e1z - uz * e1y
        const e2y = uz * e1x - ux * e1z
        const e2z = ux * e1y - uy * e1x
        const c = surface.chunkAt(
          rule,
          x + (e1x * i + e2x * j) * s,
          y + (e1y * i + e2y * j) * s,
          z + (e1z * i + e2z * j) * s,
        )
        seen.set(c.key, c)
      }
    }
    for (const chunk of seen.values()) {
      const id = `${rule.index}|${chunk.key}`
      let c = ss.chunks.get(id)
      if (!c) {
        c = chunkState(id, chunk, frame)
        ss.chunks.set(id, c)
      }
      const p = finalPlacements(ss, c, frame)
      for (let k = 0; k < p.count; k++) {
        const o = k * PLACEMENT_STRIDE
        const px = chunk.center[0]! + p.data[o + P_X]!
        const py = chunk.center[1]! + p.data[o + P_X + 1]!
        const pz = chunk.center[2]! + p.data[o + P_X + 2]!
        const d = Math.hypot(px - x, py - y, pz - z)
        if (d > radius) continue
        const item = rule.items[p.data[o + P_ITEM]!]!
        const index = p.data[o + P_CELL]!
        out.push({
          d,
          v: {
            rule: rule.name,
            set: rule.id.slice(0, rule.id.lastIndexOf(':')),
            item: item.generator || item.prefab?.path || '',
            variant: p.data[o + P_VARIANT]!,
            position: [round(px), round(py), round(pz)],
            distance: round(d),
            scale: round(p.data[o + P_SCALE]!),
            chunk: chunk.key,
            index,
            removed: removed ? isRemoved(removed, removedKey(rule.id, chunk.key, index)) : false,
          },
        })
      }
    }
  }
  out.sort((a, b) => a.d - b.d)
  return out.map((o) => o.v)
}

/** A point in a surface's frame: given directly, from an entity, or (planets) a latitude and longitude. */
function pointOf(world: World, ss: SurfaceScatter, p: Record<string, unknown>): number[] {
  if (Array.isArray(p.position)) return (p.position as number[]).slice(0, 3)
  if (p.entity !== undefined && p.entity !== null) {
    let e: Entity | undefined
    if (typeof p.entity === 'number') e = p.entity as Entity
    else {
      const member = findComponent('scene/SceneMember')
      for (const table of world.allTables()) {
        if (!member || !table.has(member)) continue
        for (let row = 0; row < table.count; row++) {
          const ent = table.entities[row]! as Entity
          const path = (world.get(ent, member) as { path?: string }).path
          if (path === p.entity || path?.endsWith(`/${p.entity}`)) e = ent
        }
      }
    }
    if (e === undefined || !world.isAlive(e)) {
      throw new ShardError('scatter/bad-point', `No entity ${JSON.stringify(p.entity)}`, {
        hint: 'Pass an entity id or a scene path.',
      })
    }
    if (ss.surface.kind === 'planet') {
      return Array.from(worldPosition64(world, e, new Float64Array(3), ss.surface.entity))
    }
    // A mesh surface: through its inverse world transform, then into metres.
    const g = world.get(e, GlobalTransform).matrix
    const s = world.get(ss.surface.entity, GlobalTransform).matrix
    const w = [g[3]!, g[7]!, g[11]!]
    const inv = invertAffine(s)
    const scale = (ss.surface as unknown as { scale: number }).scale
    return [0, 1, 2].map(
      (r) =>
        (inv[r * 4]! * w[0]! +
          inv[r * 4 + 1]! * w[1]! +
          inv[r * 4 + 2]! * w[2]! +
          inv[r * 4 + 3]!) *
        scale,
    )
  }
  if (Array.isArray(p.latlon) && ss.surface.kind === 'planet') {
    const [lat, lon] = p.latlon as number[]
    const a = (lat! * Math.PI) / 180
    const b = (lon! * Math.PI) / 180
    const r = (ss.surface as unknown as { rt: { settings: { radius: number } } }).rt.settings.radius
    return [Math.cos(a) * Math.sin(b) * r, Math.sin(a) * r, Math.cos(a) * Math.cos(b) * r]
  }
  throw new ShardError('scatter/bad-point', 'Say where: position, entity, or latlon (planets)', {
    hint: 'e.g. { "entity": "landing-pad", "radius": 10 }.',
  })
}

function invertAffine(m: ArrayLike<number>): number[] {
  const a = m[0]!
  const b = m[1]!
  const c = m[2]!
  const d = m[4]!
  const e = m[5]!
  const f = m[6]!
  const g = m[8]!
  const h = m[9]!
  const i = m[10]!
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1
  const r = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ]
  const tx = m[3]!
  const ty = m[7]!
  const tz = m[11]!
  return [
    r[0]!,
    r[1]!,
    r[2]!,
    -(r[0]! * tx + r[1]! * ty + r[2]! * tz),
    r[3]!,
    r[4]!,
    r[5]!,
    -(r[3]! * tx + r[4]! * ty + r[5]! * tz),
    r[6]!,
    r[7]!,
    r[8]!,
    -(r[6]! * tx + r[7]! * ty + r[8]! * tz),
  ]
}

export const scatterMethods: AppMethod[] = [
  {
    name: 'scatter.describe',
    description:
      'Scatter as data: per surface (a planet, or a ScatterSurface mesh), whether it is ready (or what it waits for, or its problem), and per rule its kind and range; props: chunks in range, placements, spawned entities, lattice candidates; foliage: GPU chunks, instance capacity, and instances visible and casting shadows (last read back). Also props spawned and despawned last frame and the main-thread milliseconds it took.',
    params: defineSchema('scatter/DescribeParams', { surface: surfaceField }),
    handler: ({ world }, p) => {
      const surfaces = world.tryResource(Scatter)?.surfaces
      if (!surfaces) return { surfaces: [] }
      const removed = world.tryResource(Removed)?.props.length ?? 0
      const budget = world.tryResource(ScatterBudget)
      const list =
        p.surface !== undefined && p.surface !== null && p.surface !== ''
          ? [resolveSurface(world, p.surface)]
          : [...surfaces.values()]
      return { surfaces: list.map((ss) => describeSurface(world, ss)), removed, budget }
    },
  },
  {
    name: 'scatter.sample',
    description:
      'Prop placements near a point, from the CPU placement (headless-safe, whether or not they are spawned): rule, set, item, variant, position (surface frame), distance, scale, chunk and index, and whether the game removed it. Ask "what is within 10 m of the landing pad" and move the pad. Foliage is GPU-only and not listed.',
    params: defineSchema('scatter/SampleParams', {
      surface: surfaceField,
      position: t.json({
        description:
          'A point in the surface’s frame: [x, y, z] (planet frame, or the mesh’s local metres).',
      }),
      entity: t.json({
        description: 'Or an entity (id or scene path) whose position is the point.',
      }),
      latlon: t.json({ description: 'Or, on a planet, [lat, lon] in degrees.' }),
      radius: t.f32({ default: 10, min: 0.1, max: 500, unit: 'm' }),
    }),
    handler: ({ world }, p) => {
      const ss = resolveSurface(world, p.surface)
      if (ss.problem) throw ss.problem
      if (!ss.ready || !ss.surface.ready) {
        throw new ShardError(
          'scatter/not-ready',
          `The surface is waiting for ${ss.waiting ?? 'its sets'}`,
          {
            hint: 'Sets and item meshes load asynchronously; step a frame and ask again.',
          },
        )
      }
      const [x, y, z] = pointOf(world, ss, p as Record<string, unknown>)
      const frame = world.resource(Scatter).frame
      const placements = samplePlacements(
        ss,
        x!,
        y!,
        z!,
        p.radius as number,
        frame,
        world.tryResource(Removed),
      )
      return {
        point: [round(x!), round(y!), round(z!)],
        radius: p.radius,
        count: placements.length,
        placements,
      }
    },
  },
]
