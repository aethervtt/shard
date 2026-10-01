import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  type Entity,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { cube } from '@aethervtt/shard-mesh'
import type { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { Gpu, Shaders } from './plugin'
import { OffscreenTarget } from './target'

// Shader variants no scene shows (0064): `shard shaders bake` runs the project's scenes and records
// every pipeline they make, then runs `shaders.variants.json`, whose entries name variants a host
// can select at runtime. Each entry is `{ "<source>": … }`; a plugin registers the source that
// understands it and shows those variants, so their pipelines are made and recorded too.
//
//   { "variants": [
//       { "material": { "path": "materials/water.material.json", "params": { "foam": 1 } } },
//       { "dice": { "skins": "*", "kinds": "*" } } ] }

/** A kind of manifest entry, and how to show the variants it names. */
export interface ShaderVariantSource {
  /** The entry's key: `{ "dice": … }` is run by the source named `dice`. */
  readonly name: string
  readonly description: string
  /**
   * Shows every variant `entry` names for at least a frame, stepping the app until their pipelines
   * are made (`app.update`, then `Shaders.whenIdle` and `gpu.pipelines.whenIdle`). Returns how many
   * variants it showed.
   */
  show(app: App, entry: unknown): Promise<number>
}

export const ShaderVariantSources = defineResource<Map<string, ShaderVariantSource>>(
  'render/ShaderVariantSources',
  {
    description:
      'Kinds of shaders.variants.json entries (0064) and how to show their variants, for `shard shaders bake`.',
    init: () => new Map(),
  },
)

/** Registers a manifest entry kind. Plugins call it in `build`. */
export function addShaderVariantSource(world: World, source: ShaderVariantSource): void {
  world.initResource(ShaderVariantSources).set(source.name, source)
}

/** The manifest's shape. */
export interface ShaderVariantManifest {
  variants: Record<string, unknown>[]
}

/** Runs one manifest entry through its source. Throws `render/unknown-variant-source` for a key no plugin registered. */
export function showVariants(app: App, entry: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(entry)
  if (keys.length !== 1) {
    throw new ShardError(
      'render/variant-entry',
      `A shaders.variants.json entry has one key, its source: got ${keys.length ? keys.join(', ') : 'none'}`,
    )
  }
  const name = keys[0]!
  const source = app.world.tryResource(ShaderVariantSources)?.get(name)
  if (!source) {
    const known = [...(app.world.tryResource(ShaderVariantSources)?.keys() ?? [])]
    throw new ShardError('render/unknown-variant-source', `No shader variant source "${name}"`, {
      hint: `Known: ${known.join(', ') || 'none'}. Plugins register theirs with addShaderVariantSource.`,
    })
  }
  return source.show(app, entry[name])
}

/** A material asset's path (or guid) and parameter overrides. */
export interface MaterialVariantEntry {
  path?: string
  guid?: string
  params?: Record<string, unknown>
}

/** Where variants are shown: far from anything a scene puts in view. */
const STAGE: [number, number, number] = [50_000, 0, 50_000]

/**
 * Shows what `spawn` makes to a camera of its own (an offscreen target, a shadowed sun), stepping
 * the app until every pipeline it asked for is made, then takes it all away again. For variant
 * sources: what's drawn is what a bake records.
 */
export async function showToCamera(
  app: App,
  spawn: (at: [number, number, number]) => Entity[],
): Promise<void> {
  const world = app.world
  const gpu = world.resource(Gpu)
  const target = new OffscreenTarget(gpu, { label: 'shader-variants', width: 64, height: 64 })
  const ref = world.resource(RenderTargets).add(target, `render:variants/${STAGE.join(',')}`)
  const eye: [number, number, number] = [STAGE[0], STAGE[1] + 2, STAGE[2] + 4]
  const made: Entity[] = [
    world.spawn(
      [Camera3d, { target: ref as AssetRef<'RenderTarget'>, order: 90 }],
      [Transform, { translation: eye, rotation: lookAt(eye, STAGE) }],
    ),
    world.spawn(
      [DirectionalLight, { shadows: true }],
      [Transform, { translation: STAGE, rotation: lookAt([0, 0, 0], [-0.4, -1, -0.3]) }],
    ),
    ...spawn(STAGE),
  ]
  try {
    for (let i = 0; i < 8; i++) {
      app.update(1 / 60)
      await world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
    }
  } finally {
    for (const e of made) if (world.isAlive(e)) world.despawn(e)
    app.update(1 / 60)
    target.destroy?.()
  }
}

/** `{ "material": { "path": …, "params": … } }`: a material asset, with its parameters set, on a cube. */
export const materialVariants: ShaderVariantSource = {
  name: 'material',
  description: 'A material asset by path or guid, with parameter overrides: { path, params? }.',
  async show(app, entry) {
    const list = (Array.isArray(entry) ? entry : [entry]) as MaterialVariantEntry[]
    const world = app.world
    for (const m of list) {
      const ref = (m.guid ? { guid: m.guid } : { path: m.path }) as AssetRef<'Material'>
      await assetServer(world).load(ref)
      const material = world.resource(Materials).get(ref)
      if (!material) {
        throw new ShardError('render/variant-material', `No material ${m.guid ?? m.path}`)
      }
      if (m.params) material.set(m.params)
      const mesh = world.resource(Meshes).add(cube({ size: 1 }))
      await showToCamera(app, (at) => [
        world.spawn(
          [Mesh3d, { mesh }],
          [MeshMaterial, { material: ref }],
          [Transform, { translation: at }],
        ),
      ])
    }
    return list.length
  },
}
