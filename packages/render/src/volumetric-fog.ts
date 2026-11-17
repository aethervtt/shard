import {
  affine,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  t,
} from '@aethervtt/shard-core'
import { Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Camera3d } from './camera'
import { Views } from './plugin'
import { Fog, PostEffect, postAliases } from './post'
import { cameraOf, viewAliases } from './view'

export const VolumetricFog = defineComponent(
  'render/VolumetricFog',
  {
    distance: t.f32({
      default: 96,
      min: 1,
      unit: 'm',
      description:
        "Metres the froxel volume covers; the camera's Fog continues analytically beyond.",
    }),
    quality: t.enum(['low', 'medium', 'high'], {
      default: 'medium',
      description: 'Froxel size and slices: low 16 px × 32, medium 8 px × 64, high 4 px × 128.',
    }),
    depthCurve: t.f32({
      default: 2,
      min: 1,
      max: 4,
      description: 'Slice distribution: 1 uniform, higher packs slices near the camera.',
    }),
    anisotropy: t.f32({
      default: 0.3,
      min: -0.95,
      max: 0.95,
      description:
        'Henyey-Greenstein g: 0 scatters evenly, toward 1 glows around lights you look at.',
    }),
    temporal: t.f32({
      default: 0.9,
      min: 0,
      max: 0.98,
      description: "Weight of last frame's lit volume: smooths the per-frame jitter.",
    }),
    lights: t.bool({ default: true, description: 'Point and spot lights scatter in the fog.' }),
    ambient: t.f32({
      default: 1,
      min: 0,
      description: 'Scale of the sky light the fog scatters.',
    }),
  },
  {
    description:
      "Volumetric fog (0132) on a camera: the camera's Fog and every FogVolume as a froxel volume lit by shadowed sun, moon, point and spot lights. Beyond distance, the Fog continues analytically.",
    requires: [Camera3d],
  },
)

export const FogVolume = defineComponent(
  'render/FogVolume',
  {
    shape: t.enum(['box', 'sphere'], {
      description: "A unit cube or sphere (diameter 1), sized by the entity's Transform.",
    }),
    density: t.f32({ default: 0.05, min: 0, unit: '1/m', description: 'Extinction inside.' }),
    albedo: t.color({ default: [0.9, 0.9, 0.9, 1] }),
    emission: t.color({
      default: [0, 0, 0, 1],
      description: 'Light the fog gives off itself, cd/m² per unit density (glowing gas).',
    }),
    edge: t.f32({
      default: 0.25,
      min: 0.001,
      max: 1,
      description: 'Fraction of the shape that fades to nothing at its boundary.',
    }),
    heightFalloff: t.f32({
      default: 0,
      min: 0,
      unit: '1/m',
      description: "Thins with height above the shape's bottom: mist that hugs the ground.",
    }),
    noise: t.f32({ default: 0.5, min: 0, max: 1, description: 'How much noise breaks it up.' }),
    noiseScale: t.f32({ default: 0.2, min: 0, unit: '1/m' }),
    noiseSpeed: t.vec3({ default: [0.3, 0, 0.1], unit: 'm/s', description: 'Drift of the noise.' }),
    blend: t.enum(['add', 'max'], { description: 'add to the fog around it, or the denser wins.' }),
    anisotropy: t.f32({
      default: -1,
      min: -1,
      max: 0.95,
      description: "Henyey-Greenstein g of this volume; -1 uses the camera's.",
    }),
    ambient: t.f32({
      default: 1,
      min: 0,
      max: 1,
      description:
        'How much sky light reaches the fog inside: 0 in a closed room, so only lights and sunbeams through openings show in it.',
    }),
  },
  {
    description:
      'Local fog (0132): a box or sphere of fog with its own density, color, glow and drifting noise, for VolumetricFog cameras.',
    requires: [GlobalTransform],
  },
)

/** FogVolumes the light pass reads; beyond, the first ones found (render/fog-volume-too-many). */
export const MAX_FOG_VOLUMES = 64
/** Floats per volume in the volume buffer (eight vec4). */
export const VOLUME_FLOATS = 32

/** This frame's FogVolumes, packed for the light pass. */
export class FogVolumeData {
  readonly data = new Float32Array(MAX_FOG_VOLUMES * VOLUME_FLOATS)
  count = 0
  /** Bumps when `data` changes. */
  version = 0
  /** Seconds, for the noise drift. */
  time = 0
}

export const FogVolumes = defineResource<FogVolumeData>('render/FogVolumes', {
  description: 'FogVolumes packed for the volumetric fog light pass (0132).',
  init: () => new FogVolumeData(),
})

const inverse = new Float32Array(12)
const matrix = new Float32Array(12)

/**
 * Packs FogVolumes, and takes VolumetricFog cameras' analytic Fog out of the post chain: their fog
 * is drawn by the volume and its analytic continuation instead.
 */
export const extractVolumetricFog = defineSystem({
  name: 'render/volumetric-fog-extract',
  description:
    'Packs FogVolumes for the volumetric fog (0132) and leaves VolumetricFog cameras out of the analytic fog pass.',
  setup: (world) => ({ q: world.query({ with: [FogVolume, GlobalTransform] }) }),
  run: ({ q }, world) => {
    const volumes = world.resource(FogVolumes)
    volumes.time = world.tryResource(Time)?.elapsed ?? 0
    const d = volumes.data
    let n = 0
    for (const table of q.tables) {
      const g = table.column(GlobalTransform, 'matrix')
      const shape = table.column(FogVolume, 'shape')
      const density = table.column(FogVolume, 'density')
      const albedo = table.column(FogVolume, 'albedo')
      const emission = table.column(FogVolume, 'emission')
      const edge = table.column(FogVolume, 'edge')
      const falloff = table.column(FogVolume, 'heightFalloff')
      const noise = table.column(FogVolume, 'noise')
      const scale = table.column(FogVolume, 'noiseScale')
      const speed = table.column(FogVolume, 'noiseSpeed')
      const blend = table.column(FogVolume, 'blend')
      const g0 = table.column(FogVolume, 'anisotropy')
      const ambient = table.column(FogVolume, 'ambient')
      for (let i = 0; i < table.count && n < MAX_FOG_VOLUMES; i++) {
        for (let k = 0; k < 12; k++) matrix[k] = g[i * 12 + k]!
        if (!affine.invert(inverse, matrix)) continue
        const o = n * VOLUME_FLOATS
        for (let k = 0; k < 12; k++) d[o + k] = inverse[k]!
        d[o + 12] = density[i]!
        d[o + 13] = edge[i]!
        d[o + 14] = falloff[i]!
        d[o + 15] = shape[i]!
        d[o + 16] = albedo[i * 4]!
        d[o + 17] = albedo[i * 4 + 1]!
        d[o + 18] = albedo[i * 4 + 2]!
        d[o + 19] = g0[i]!
        d[o + 20] = emission[i * 4]!
        d[o + 21] = emission[i * 4 + 1]!
        d[o + 22] = emission[i * 4 + 2]!
        d[o + 23] = noise[i]!
        d[o + 24] = scale[i]!
        d[o + 25] = speed[i * 3]!
        d[o + 26] = speed[i * 3 + 1]!
        d[o + 27] = speed[i * 3 + 2]!
        // The bottom of the shape in world y: where heightFalloff measures from (the local −y face).
        d[o + 28] = g[i * 12 + 7]! - 0.5 * Math.abs(g[i * 12 + 5]!)
        d[o + 29] = blend[i]!
        d[o + 30] = ambient[i]!
        d[o + 31] = 0
        n++
      }
    }
    volumes.count = n
    volumes.version++
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam || !world.has(cam.entity as Entity, VolumetricFog)) continue
      const before = cam.post.effects
      cam.post.effects &= ~PostEffect.Fog
      if (cam.post.effects !== before) view.aliases = postAliases(cam, viewAliases(cam))
      view.data.volumetricFog = world.get(cam.entity as Entity, VolumetricFog)
      view.data.volumetricFogMedium = world.has(cam.entity as Entity, Fog)
    }
  },
})
