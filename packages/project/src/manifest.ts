import { defineSchema, type Infer, type JsonSchema, ShardError, t } from '@aethervtt/shard-core'
import type { Platform } from '@aethervtt/shard-platform'

const NAMESPACE = /^[a-z][a-z0-9-]*$/

/** The `shard.json` schema. Defined with the schema system so validation and JSON Schema match. */
export const Manifest = defineSchema(
  'project/Manifest',
  {
    $schema: t.string({ description: 'Path to the generated schema, for editor validation.' }),
    name: t.string({
      required: true,
      description:
        'Project name: lowercase letters, digits, dashes. Also the namespace of project components.',
    }),
    version: t.string({ default: '0.1.0' }),
    engine: t.string({ default: '0.x', description: 'Engine version range.' }),
    entry: t.string({ default: 'scripts/main.ts', description: 'The project plugin module.' }),
    startScene: t.string({
      default: 'scenes/main.scene.json',
      description: 'Scene loaded at startup.',
    }),
    seed: t.u32({ default: 1, description: 'Root seed for GlobalRng. Same seed, same world.' }),
    window: t.struct(
      {
        width: t.u32({ default: 1280, min: 1 }),
        height: t.u32({ default: 720, min: 1 }),
        msaa: t.u8({ default: 4, min: 1, max: 4, description: '1 or 4.' }),
      },
      { description: 'Window (or headless render target) size and anti-aliasing.' },
    ),
    assetRoots: t.list(t.string, {
      default: ['assets', 'materials', 'data', 'prefabs', 'locales', 'generators'],
      description: 'Folders the asset database imports from. Nothing outside them is imported.',
    }),
    procgen: t.struct(
      {
        cacheSize: t.u32({
          default: 256,
          min: 1,
          unit: 'MB',
          description: 'Generator outputs kept in memory (and in browser storage), in megabytes.',
        }),
      },
      { description: 'Generators (0042): output cache limits.' },
    ),
    graphics: t.struct(
      {
        baseline: t.enum(['optional', 'required'], {
          default: 'optional',
          description:
            "required: the project must run at the baseline tier (WebGPU compatibility mode, WebGL2), and shard validate checks it. optional: what the tier can't run is reported when it runs.",
        }),
      },
      { description: 'Graphics tiers (0064).' },
    ),
    plugins: t.list(t.string, {
      default: ['render/forward', 'input'],
      description:
        'Engine plugins to enable, by name: render, render/forward, sprite, text, particles, animation, physics3d, physics2d, input, audio, ui, nav, nav/grid, dice, core/transform.',
    }),
  },
  { description: 'shard.json: the project manifest.' },
)

export type ManifestValue = Infer<typeof Manifest>

/** Validates a manifest: the schema plus rules the schema can't express. Collects every error. */
export function validateManifest(json: unknown): ShardError[] {
  const errors = Manifest.validate(json)
  const value = json as Partial<ManifestValue> | null
  if (typeof value?.name === 'string' && !NAMESPACE.test(value.name)) {
    errors.push(
      new ShardError(
        'project/invalid-name',
        `Project name "${value.name}" isn't a valid namespace`,
        {
          path: '/name',
          hint: 'Use lowercase letters, digits, and dashes, starting with a letter (e.g. "star-explorer").',
        },
      ),
    )
  }
  const msaa = value?.window?.msaa
  if (msaa !== undefined && msaa !== 1 && msaa !== 4) {
    errors.push(
      new ShardError('schema/out-of-range', 'window.msaa must be 1 or 4', { path: '/window/msaa' }),
    )
  }
  for (const [i, plugin] of (value?.plugins ?? []).entries()) {
    if (typeof plugin === 'string' && !(plugin in BUILTIN_PLUGINS)) {
      errors.push(
        new ShardError('project/unknown-plugin', `Unknown engine plugin "${plugin}"`, {
          path: `/plugins/${i}`,
          hint: `Built-in plugins: ${Object.keys(BUILTIN_PLUGINS).join(', ')}.`,
        }),
      )
    }
  }
  return errors
}

/** Built-in engine plugins a manifest can name, with what they bring. */
export const BUILTIN_PLUGINS = {
  render: 'GPU device, render graph, views, shaders',
  'render/forward':
    'cameras, meshes, standard material, lights (includes render and core/transform)',
  sprite: 'sprites, atlases, frame animation, tilemaps (includes render/forward)',
  text: 'Text and ScreenText with imported fonts (includes render/forward)',
  particles: 'GPU particle effects from *.particles.json (includes render/forward)',
  animation:
    'AnimationPlayer: glTF and .anim.json clips on joints and fields, blending, root motion; Animator graphs from .animgraph.json (includes render/forward)',
  physics3d: 'Rapier 3D rigid bodies, colliders, joints, raycasts (includes core/transform)',
  physics2d: 'Rapier 2D physics in the XY plane (includes core/transform)',
  input: 'keyboard, mouse, gamepad, touch, action maps',
  audio:
    'AudioSource, AudioListener, playSound, buses and ducking, spatial audio, voice limits (includes core/transform)',
  ui: 'UiNode trees under a UiRoot: flexbox layout, text, images, buttons, sliders, text fields, world-anchored markers, themes (includes core/transform)',
  nav: 'navigation: NavGrid A* (2D), NavMesh baked by Recast from NavSource geometry, OffMeshLink, path queries, NavAgent steering (includes core/transform)',
  'nav/grid':
    'navigation on NavGrids only, without loading the Recast WASM (includes core/transform)',
  terrain:
    'planets: Planet cube-sphere terrain from noise graphs with LOD, geomorphing, oceans, biomes, collider chunks around characters, navmeshes on the surface; terrain.* methods (includes core/transform; add render/forward to draw it, physics3d for colliders)',
  dice: 'the dice table (0054): dice skins, face layouts and effect recipes as data, dice.play and dice.describe, dice/RollRequest in scenes; tracks record on the calling thread (includes render/forward)',
  'core/transform': 'Transform and hierarchy propagation',
} as const

export function manifestJsonSchema(): JsonSchema {
  const schema = Manifest.jsonSchema()
  schema.title = 'shard.json'
  ;(schema.properties as Record<string, JsonSchema>).name!.pattern = NAMESPACE.source
  return schema
}

export interface ProjectInfo {
  manifest: ManifestValue
}

/** Reads and validates `shard.json` through the platform (rooted at the project folder). */
export async function loadProject(platform: Platform): Promise<ProjectInfo> {
  let text: string
  try {
    text = await platform.fs.readText('shard.json')
  } catch (cause) {
    throw new ShardError('project/not-found', 'No shard.json in the project folder', {
      hint: 'Run `shard init <dir>` to create a project, or run from a project folder.',
      cause,
    })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new ShardError(
      'project/invalid-json',
      `shard.json is not valid JSON: ${(cause as Error).message}`,
      {
        path: 'shard.json',
      },
    )
  }
  const errors = validateManifest(json)
  if (errors.length > 0) {
    throw new ShardError(
      'project/invalid-manifest',
      `shard.json has ${errors.length} error(s); first: ${errors[0]!.message}`,
      {
        path: errors[0]!.path,
        hint: errors[0]!.hint,
        details: errors,
      },
    )
  }
  return { manifest: Manifest.deserialize(json) }
}
