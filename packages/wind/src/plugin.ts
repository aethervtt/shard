import { defineSystem, PostUpdate, PreUpdate, ShardError, type World } from '@aethervtt/shard-core'
import { Camera3d, registerShaders, ShaderGlobals, Shaders } from '@aethervtt/shard-render'
import { definePlugin, LogResource } from '@aethervtt/shard-runtime'
import { GlobalTransform, TransformSystems } from '@aethervtt/shard-transform'
import { windMethods } from './methods'
import * as overlayModule from './overlay'
import { WIND_SLOTS, windShaders } from './shaders'
import * as stateModule from './state'
import { syncWind } from './state'
import * as windModule from './wind'
import { Wind, windBasis, windTime } from './wind'
import * as zonesModule from './zones'
import {
  gatherZones,
  MAX_UPLOADED_ZONES,
  WindField,
  type WindFieldState,
  WindZone,
  ZONE_FLOATS,
} from './zones'

const basis = new Float64Array(6)
const camera = new Float64Array(3)
let scratchDistances = new Float64Array(0)
let picked = new Uint8Array(0)

/**
 * Packs WindZones (after transforms) and writes the wind block `shard::wind` reads into
 * ShaderGlobals: the wind, the wind clock, and up to 16 zones, nearest the camera when there are
 * more.
 */
export const updateWindField = defineSystem({
  name: 'wind/field',
  description:
    'Packs WindZones by priority for windAt, and writes the wind, its clock and up to 16 zones into shard::globals for shard::wind.',
  setup: (world) => ({
    zones: world.query({ with: [WindZone, GlobalTransform] }),
    cameras: world.query({ with: [Camera3d, GlobalTransform] }),
  }),
  run: (s, world) => {
    const field = world.resource(WindField)
    gatherZones(s.zones, field)
    const wind = world.resource(Wind)
    const ok = windBasis(wind.direction, basis)
    const log = world.tryResource(LogResource)
    if (!ok && wind.speed > 0 && !field.warnedDirection) {
      field.warnedDirection = true
      log?.error(
        new ShardError('wind/bad-direction', `Wind blows at ${wind.speed} m/s in no direction`, {
          hint: 'Give wind/Wind a non-zero direction, or set speed to 0 for calm. It is calm until then.',
        }),
      )
    } else if (ok) field.warnedDirection = false
    if (field.count > MAX_UPLOADED_ZONES && field.warnedCount !== field.count) {
      log?.warn(
        `${field.count} WindZones; shaders get the ${MAX_UPLOADED_ZONES} nearest the camera (windAt uses all)`,
        { code: 'wind/too-many-zones' },
      )
    }
    field.warnedCount = field.count > MAX_UPLOADED_ZONES ? field.count : 0
    const globals = world.tryResource(ShaderGlobals)
    if (!globals || field.slot < 0) return
    const v = globals.values
    const o = 4 + field.slot * 4
    v[o] = basis[0]!
    v[o + 1] = basis[1]!
    v[o + 2] = basis[2]!
    v[o + 3] = ok ? wind.speed : 0
    v[o + 4] = basis[3]!
    v[o + 5] = basis[4]!
    v[o + 6] = basis[5]!
    v[o + 7] = wind.gustScale
    v[o + 8] = wind.gustiness
    v[o + 9] = windTime(world)
    v[o + 11] = 0
    const zones = o + 12
    if (field.count <= MAX_UPLOADED_ZONES) {
      // Copied by hand: a subarray view would allocate every frame.
      const z = field.zones
      for (let i = 0, n = field.count * ZONE_FLOATS; i < n; i++) v[zones + i] = z[i]!
      field.uploaded = field.count
    } else {
      cameraPosition(s.cameras, camera)
      field.uploaded = uploadNearest(field, v, zones)
    }
    v[o + 10] = field.uploaded
  },
})

function cameraPosition(cameras: ReturnType<World['query']>, out: Float64Array): void {
  out.fill(0)
  for (const table of cameras.tables) {
    if (table.count === 0) continue
    const m = table.column(GlobalTransform, 'matrix')
    out[0] = m[3]!
    out[1] = m[7]!
    out[2] = m[11]!
    return
  }
}

/** The MAX_UPLOADED_ZONES zones nearest the camera, in priority order. Returns how many. */
function uploadNearest(field: WindFieldState, v: Float32Array, at: number): number {
  const n = field.count
  if (scratchDistances.length < n) {
    scratchDistances = new Float64Array(n * 2)
    picked = new Uint8Array(n * 2)
  }
  const z = field.zones
  for (let i = 0; i < n; i++) {
    const o = i * ZONE_FLOATS
    // The center: -Σ row.w × row (the rows are orthonormal).
    let cx = 0
    let cy = 0
    let cz = 0
    for (let r = 0; r < 3; r++) {
      const w = z[o + r * 4 + 3]!
      cx -= w * z[o + r * 4]!
      cy -= w * z[o + r * 4 + 1]!
      cz -= w * z[o + r * 4 + 2]!
    }
    const dx = cx - camera[0]!
    const dy = cy - camera[1]!
    const dz = cz - camera[2]!
    scratchDistances[i] = dx * dx + dy * dy + dz * dz
    picked[i] = 0
  }
  for (let k = 0; k < MAX_UPLOADED_ZONES; k++) {
    let best = -1
    for (let i = 0; i < n; i++)
      if (!picked[i] && (best < 0 || scratchDistances[i]! < scratchDistances[best]!)) best = i
    picked[best] = 1
  }
  let k = 0
  for (let i = 0; i < n; i++) {
    if (!picked[i]) continue
    for (let f = 0; f < ZONE_FLOATS; f++) v[at + k * ZONE_FLOATS + f] = z[i * ZONE_FLOATS + f]!
    k++
  }
  return k
}

/**
 * Shared wind (spec 0096): the `Wind` resource (m/s), WindZones, `windAt`, and `shard::wind` for
 * shaders, with WindState keeping multiplayer clients on the server's wind. scatter and nature add
 * it when it's missing; servers get it from the `wind` manifest plugin.
 */
export const windPlugin = definePlugin({
  name: 'wind',
  // Registers the wind overlay.
  provides: [windModule, zonesModule, stateModule, overlayModule],
  build(app) {
    const world = app.world
    world.initResource(Wind)
    world.initResource(WindField)
    app.addSystems(PreUpdate, syncWind)
    app.addSystems(PostUpdate, updateWindField.after(TransformSystems))
    app.addMethod(...windMethods)
  },
  ready(app) {
    const globals = app.world.tryResource(ShaderGlobals)
    const shaders = app.world.tryResource(Shaders)
    if (!globals || !shaders) return
    const field = app.world.resource(WindField)
    field.slot = globals.reserve('wind', WIND_SLOTS)
    registerShaders(shaders, windShaders(field.slot))
  },
})
