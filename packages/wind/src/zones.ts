import { defineComponent, defineResource, type Entity, type Query, t } from '@aethervtt/shard-core'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'

/** Zones `shard::wind` holds; with more, the ones nearest the camera (`wind/too-many-zones`). */
export const MAX_UPLOADED_ZONES = 16

export const WindZone = defineComponent(
  'wind/WindZone',
  {
    shape: t.enum(['box', 'sphere'], {
      description: 'The volume it covers, around its transform.',
    }),
    size: t.vec3({
      default: [10, 10, 10],
      min: 0,
      unit: 'm',
      description: 'box: full size along its local axes. sphere: diameter, from size[0].',
    }),
    falloff: t.f32({
      default: 2,
      min: 0,
      unit: 'm',
      description: 'Blend outside the shape: full effect inside, none this many metres out.',
    }),
    speedScale: t.f32({
      default: 1,
      min: 0,
      description: 'Multiplies the wind inside: 0 stills it (a sheltered valley).',
    }),
    override: t.bool({
      description:
        'Inside, blow toward `direction` at `speed` (then × speedScale), not the wind around it.',
    }),
    direction: t.vec3({
      default: [1, 0, 0],
      description: 'World-space direction when override is on (normalized when used).',
    }),
    speed: t.f32({ default: 0, min: 0, unit: 'm/s', description: 'Speed when override is on.' }),
    priority: t.i32({
      description: 'Zones apply lowest priority first, so the highest wins where they overlap.',
    }),
  },
  {
    requires: [Transform],
    description:
      'A local wind override (0096): a box or sphere that scales the wind (speedScale 0 shelters) or replaces it (override: a storm cell), blending over falloff metres. Its transform places it; scale is ignored.',
  },
)

/** Floats per zone row: world→zone rows (3 × vec4), size + falloff, override + scale, flags. */
export const ZONE_FLOATS = 24

/** Every zone as rows the CPU and `shard::wind` read, lowest priority first (the wind plugin fills it). */
export class WindFieldState {
  zones = new Float32Array(MAX_UPLOADED_ZONES * ZONE_FLOATS)
  count = 0
  /** Each row's entity. */
  entities: Entity[] = []
  /** The ShaderGlobals slot of `shard::wind`'s block; -1 without a renderer. */
  slot = -1
  /** Zones in the uploaded block (≤ MAX_UPLOADED_ZONES). */
  uploaded = 0
  /** Last zone count `wind/too-many-zones` was logged for, and whether `wind/bad-direction` was. */
  warnedCount = 0
  warnedDirection = false
  // Scratch for gathering: rows in query order, then sorted.
  scratch = new Float32Array(MAX_UPLOADED_ZONES * ZONE_FLOATS)
  scratchEntities: Entity[] = []
  priorities: number[] = []
  order: number[] = []
}

export const WindField = defineResource<WindFieldState>('wind/WindField', {
  description: 'WindZones as packed rows, sorted by priority: what windAt and shard::wind read.',
  init: () => new WindFieldState(),
})

/** Packs every WindZone (lowest priority first; ties by entity) into `field`. */
export function gatherZones(query: Query, field: WindFieldState): void {
  let n = 0
  const ents = field.scratchEntities
  const prio = field.priorities
  ents.length = 0
  prio.length = 0
  for (const table of query.tables) {
    const count = table.count
    if (count === 0) continue
    const g = table.column(GlobalTransform, 'matrix')
    const shape = table.column(WindZone, 'shape')
    const size = table.column(WindZone, 'size')
    const falloff = table.column(WindZone, 'falloff')
    const scale = table.column(WindZone, 'speedScale')
    const own = table.column(WindZone, 'override')
    const dir = table.column(WindZone, 'direction')
    const speed = table.column(WindZone, 'speed')
    const priority = table.column(WindZone, 'priority')
    for (let i = 0; i < count; i++) {
      if ((n + 1) * ZONE_FLOATS > field.scratch.length) {
        const grown = new Float32Array(field.scratch.length * 2)
        grown.set(field.scratch)
        field.scratch = grown
      }
      writeZone(field.scratch, n * ZONE_FLOATS, g, i * 12, shape[i]!, size, i * 3, falloff[i]!)
      const o = n * ZONE_FLOATS
      const r = field.scratch
      const on = own[i] !== 0
      let dx = dir[i * 3]!
      let dy = dir[i * 3 + 1]!
      let dz = dir[i * 3 + 2]!
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const s = on && l > 1e-9 ? speed[i]! / l : 0
      dx *= s
      dy *= s
      dz *= s
      r[o + 16] = dx
      r[o + 17] = dy
      r[o + 18] = dz
      r[o + 19] = scale[i]!
      r[o + 21] = on ? 1 : 0
      ents.push(table.entities[i]!)
      prio.push(priority[i]!)
      n++
    }
  }
  // Insertion sort (zones are few): priority, then entity, so the order is the same everywhere.
  const order = field.order
  order.length = 0
  for (let i = 0; i < n; i++) {
    let j = i
    order.push(i)
    while (j > 0 && before(prio, ents, i, order[j - 1]!)) {
      order[j] = order[j - 1]!
      j--
    }
    order[j] = i
  }
  if (field.zones.length < field.scratch.length)
    field.zones = new Float32Array(field.scratch.length)
  field.entities.length = n
  for (let k = 0; k < n; k++) {
    const from = order[k]!
    for (let f = 0; f < ZONE_FLOATS; f++)
      field.zones[k * ZONE_FLOATS + f] = field.scratch[from * ZONE_FLOATS + f]!
    field.entities[k] = ents[from]!
  }
  field.count = n
}

function before(prio: number[], ents: Entity[], a: number, b: number): boolean {
  return prio[a]! < prio[b]! || (prio[a] === prio[b] && ents[a]! < ents[b]!)
}

/** A zone's transform and shape as rows: world→zone (rotation and translation only), size, falloff. */
function writeZone(
  out: Float32Array,
  o: number,
  m: ArrayLike<number>,
  mo: number,
  shape: number,
  size: ArrayLike<number>,
  so: number,
  falloff: number,
): void {
  const tx = m[mo + 3]!
  const ty = m[mo + 7]!
  const tz = m[mo + 11]!
  // The basis columns, normalized: zone axes in world space. Each becomes a row of world→zone.
  for (let c = 0; c < 3; c++) {
    let x = m[mo + c]!
    let y = m[mo + 4 + c]!
    let z = m[mo + 8 + c]!
    const l = Math.sqrt(x * x + y * y + z * z) || 1
    x /= l
    y /= l
    z /= l
    out[o + c * 4] = x
    out[o + c * 4 + 1] = y
    out[o + c * 4 + 2] = z
    out[o + c * 4 + 3] = -(x * tx + y * ty + z * tz)
  }
  // Half sizes; a sphere's radius is the first.
  out[o + 12] = size[so]! / 2
  out[o + 13] = size[so + 1]! / 2
  out[o + 14] = size[so + 2]! / 2
  out[o + 15] = falloff
  out[o + 20] = shape === 1 ? 1 : 0
  out[o + 22] = 0
  out[o + 23] = 0
}

/**
 * Blends zone rows into the velocity `out` (xyz), in order: inside a zone its target wind, fading
 * to the wind around it over `falloff` metres outside. The same math as `wind_at`.
 */
export function applyZones(
  zones: Float32Array,
  count: number,
  px: number,
  py: number,
  pz: number,
  out: Float64Array,
): void {
  for (let i = 0; i < count; i++) {
    const o = i * ZONE_FLOATS
    const lx = zones[o]! * px + zones[o + 1]! * py + zones[o + 2]! * pz + zones[o + 3]!
    const ly = zones[o + 4]! * px + zones[o + 5]! * py + zones[o + 6]! * pz + zones[o + 7]!
    const lz = zones[o + 8]! * px + zones[o + 9]! * py + zones[o + 10]! * pz + zones[o + 11]!
    let outside: number
    if (zones[o + 20]! > 0.5) {
      outside = Math.max(Math.sqrt(lx * lx + ly * ly + lz * lz) - zones[o + 12]!, 0)
    } else {
      const qx = Math.max(Math.abs(lx) - zones[o + 12]!, 0)
      const qy = Math.max(Math.abs(ly) - zones[o + 13]!, 0)
      const qz = Math.max(Math.abs(lz) - zones[o + 14]!, 0)
      outside = Math.sqrt(qx * qx + qy * qy + qz * qz)
    }
    const falloff = zones[o + 15]!
    const w = falloff > 0 ? Math.min(Math.max(1 - outside / falloff, 0), 1) : outside <= 0 ? 1 : 0
    if (w <= 0) continue
    const scale = zones[o + 19]!
    const own = zones[o + 21]! > 0.5
    for (let k = 0; k < 3; k++) {
      const target = (own ? zones[o + 16 + k]! : out[k]!) * scale
      out[k] = out[k]! + (target - out[k]!) * w
    }
  }
}
