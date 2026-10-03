// Surface variation (0068), `@aethervtt/shard-render/surface`: a parameterized model that breaks up
// a material's repeat with shaped noise in surface space (patches, streaks, per-brick tones,
// weathering), presets of it as plain data, the SurfaceMaterial that applies it, and the WGSL any
// material type can call. Separate from core render: apps without it carry none of it.

import { defineResource, defineSystem, PostUpdate, t } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { defineMaterial } from './materials'
import { Shaders } from './plugin'
import {
  SURFACE_PRESETS,
  VARIATION_FIELDS,
  VARIATION_STRUCT,
  type Variation,
} from './surface-model'
import { SURFACE_VARIATION_WGSL, surfaceMaterialWgsl } from './surface-shaders'

export {
  SURFACE_PRESETS,
  type SurfaceSample,
  surfaceVariation,
  VARIATION_FIELDS,
  VARIATION_PATTERNS,
  VARIATION_STRUCT,
  type Variation,
  type VariationInit,
  type VariationPattern,
  VariationUniform,
} from './surface-model'
export { SURFACE_VARIATION_WGSL, surfaceMaterialWgsl } from './surface-shaders'

/**
 * A variation field. Give a custom material type one (`fields: { variation: VariationField }`) and
 * pass it to `surface::variation::surface_variation` in its shader. Presets are its examples.
 */
export const VariationField = t.struct(VARIATION_FIELDS, {
  wgsl: VARIATION_STRUCT,
  description: `Surface variation (0068): shaped noise that tints the base colour and shifts roughness. The examples are SURFACE_PRESETS: ${Object.keys(SURFACE_PRESETS).join(', ')}.`,
  examples: Object.values(SURFACE_PRESETS) as Variation[],
})

export const SURFACE_PROJECTIONS = ['uv', 'world'] as const

/**
 * The standard material plus surface variation. Every preset and every variation shares one
 * pipeline. Needs `surfacePlugin`.
 */
export const SurfaceMaterial = defineMaterial('render/SurfaceMaterial', {
  extends: 'standard',
  fields: {
    variation: VariationField,
    projection: t.enum(SURFACE_PROJECTIONS, {
      description:
        "Where the variation is evaluated: uv (the mesh's UV, metres on structure, continuous around arcs) or world (the world plane the surface's normal is closest to, for meshes without metre UVs).",
    }),
  },
  shader: 'surface::material',
  plugin: "surfacePlugin from '@aethervtt/shard-render/surface'",
  description:
    'The standard material with surface variation (0068): shaped noise in surface space tints the base colour and shifts roughness, breaking up a repeat without new textures.',
})

export interface SurfaceSettingsValue {
  /**
   * false links SurfaceMaterial without the variation code: it shades exactly as the standard
   * material, at the same cost. Switching relinks once.
   */
  variation: boolean
}

export const SurfaceSettings = defineResource<SurfaceSettingsValue>('render/SurfaceSettings', {
  description:
    'Surface variation quality: variation false shades SurfaceMaterial as the standard material. Write with patchResource.',
  init: () => ({ variation: true }),
  hostWritable: true,
})

/** What `surface::material` is registered as now, per world's library. */
const linked = new WeakMap<object, boolean>()

/** Registers `surface::material` for SurfaceSettings.variation when it changes (a relink). */
const applySurfaceSettings = defineSystem({
  name: 'render/surface-settings',
  description: 'Relinks SurfaceMaterial with or without variation when SurfaceSettings changes.',
  run: (_, world) => {
    const library = world.resource(Shaders)
    const on = world.resource(SurfaceSettings).variation
    if (linked.get(library) === on) return
    linked.set(library, on)
    library.register('surface::material', surfaceMaterialWgsl(on), 'engine:surface::material')
  },
})

/**
 * Surface variation: the `surface::variation` WGSL library and SurfaceMaterial's shader, and
 * SurfaceSettings (its quality switch).
 */
export const surfacePlugin = definePlugin({
  name: 'render/surface',
  dependencies: ['render'],
  provides: [SurfaceMaterial, SurfaceSettings],
  build(app) {
    app.world.initResource(SurfaceSettings)
    app.addSystems(PostUpdate, applySurfaceSettings)
  },
  ready(app) {
    const world = app.world
    const library = world.resource(Shaders)
    library.register('surface::variation', SURFACE_VARIATION_WGSL, 'engine:surface::variation')
    const on = world.resource(SurfaceSettings).variation
    linked.set(library, on)
    library.register('surface::material', surfaceMaterialWgsl(on), 'engine:surface::material')
  },
})
