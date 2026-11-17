import { defineResource, defineSystem, type Entity } from '@aethervtt/shard-core'
import { Camera3d, ShaderGlobals } from '@aethervtt/shard-render'
import { FixedTime } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { SkyFrame } from './celestial'
import { Clouds } from './components'
import { SHADOW_EXTENT, SHADOW_SIZE } from './shaders'

/** How far the wind has carried the clouds (0131): integrated per fixed tick, so every machine agrees. */
export interface CloudMotionState {
  /** Advection in world xz (m), plus the Clouds' phase. */
  offset: Float64Array
  /** Metres of shape evolution. */
  evolution: number
  /** First shard::globals slot of shard::sky_occlusion, or -1. */
  slot: number
  /** The cloud shadow map's center (world xz, snapped to its texels) this frame. */
  shadowCenter: Float64Array
}

export const CloudMotion = defineResource<CloudMotionState>('sky/CloudMotion', {
  description: 'The clouds’ wind advection (m) and evolution, integrated per fixed tick (0131).',
  init: () => ({
    offset: new Float64Array(2),
    evolution: 0,
    slot: -1,
    shadowCenter: new Float64Array(2),
  }),
})

/**
 * A flash inside the clouds this frame (0133's lightning): world position (m) and strength (the
 * cloud radiance it adds near that point, cd/m²; 0 for none). Weather writes it; the clouds read it.
 */
export interface SkyFlashValue {
  position: Float64Array
  strength: number
}

export const SkyFlash = defineResource<SkyFlashValue>('sky/Flash', {
  description: 'A lightning flash lighting the clouds from inside this frame (0131, 0133).',
  init: () => ({ position: new Float64Array(3), strength: 0 }),
})

/** Carries the clouds along the wind (wind/Wind × windScale, or the Clouds' own speed). */
export const advectClouds = defineSystem({
  name: 'sky/advect-clouds',
  description: 'Integrates the cloud offset from wind/Wind each fixed tick (0131).',
  run: (_, world) => {
    const frame = world.resource(SkyFrame)
    if (frame.entity < 0 || !world.has(frame.entity as Entity, Clouds)) return
    const clouds = world.get(frame.entity as Entity, Clouds)
    const step = world.tryResource(FixedTime)?.step ?? 1 / 60
    const motion = world.resource(CloudMotion)
    let dx = clouds.direction[0]
    let dz = clouds.direction[2]
    let speed = clouds.speed
    const wind = clouds.windInfluence > 0 ? world.tryResource(Wind) : undefined
    if (wind) {
      dx = wind.direction[0]
      dz = wind.direction[2]
      speed = wind.speed * clouds.windInfluence * clouds.windScale
    }
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    motion.offset[0] = motion.offset[0]! + (dx / len) * speed * step
    motion.offset[1] = motion.offset[1]! + (dz / len) * speed * step
    motion.evolution += clouds.evolution * step * 1000
  },
})

/** Writes shard::sky_occlusion's block: the shadow map, the layer and the cloud map. */
export const uploadOcclusion = defineSystem({
  name: 'sky/occlusion',
  description:
    "Centers the cloud shadow map on the camera and writes the cloud shadows' globals block (0131).",
  setup: (world) => ({ cameras: world.query({ with: [Camera3d, GlobalTransform] }) }),
  run: ({ cameras }, world) => {
    const motion = world.resource(CloudMotion)
    if (motion.slot < 0) return
    const globals = world.tryResource(ShaderGlobals)
    if (!globals) return
    const v = globals.values
    const o = 4 + motion.slot * 4
    const frame = world.resource(SkyFrame)
    const on =
      frame.entity >= 0 && frame.mode !== 'none' && world.has(frame.entity as Entity, Clouds)
    if (!on) {
      v[o + 6] = 0
      return
    }
    for (const table of cameras.tables) {
      if (table.count === 0) continue
      const g = table.column(GlobalTransform, 'matrix')
      const texel = SHADOW_EXTENT / SHADOW_SIZE
      motion.shadowCenter[0] = Math.round(g[3]! / texel) * texel
      motion.shadowCenter[1] = Math.round(g[11]! / texel) * texel
      break
    }
    const clouds = world.get(frame.entity as Entity, Clouds)
    v[o] = motion.shadowCenter[0]!
    v[o + 1] = motion.shadowCenter[1]!
    v[o + 2] = 1 / SHADOW_EXTENT
    v[o + 3] = clouds.coverage
    v[o + 4] = clouds.bottom + clouds.thickness * 0.35
    v[o + 5] = clouds.shadowStrength
    v[o + 6] = clouds.shadows ? 1 : 0
    // Stratus is thin: its shadows are lighter than a cumulonimbus'.
    v[o + 7] = 0.55 + 0.45 * clouds.type
    v[o + 8] = motion.offset[0]! + clouds.phase
    v[o + 9] = motion.offset[1]!
    v[o + 10] = clouds.mapScale
  },
})
