import { type AssetEntry, assetServer } from '@shard/assets'
import {
  type AssetRef,
  defineComponent,
  defineTag,
  type Entity,
  isPlainObject,
  type JsonValue,
  pointer,
  ShardError,
  t,
  type World,
} from '@shard/core'
import { LogResource } from '@shard/runtime'
import { defineInstanceKind } from '@shard/scene'
import { findGenerator, type Generator, type GenRequest, requestOf } from './generator'
import { GeneratorBindings, procgen } from './runtime'

/**
 * Spawns an `entities` generator's fragment as this entity's children (and merges the fragment
 * root's components into it), like a PrefabInstance. Changing `seed` or `params` regenerates; the
 * children whose path is unchanged keep their entity.
 */
export const GeneratorInstance = defineComponent(
  'procgen/GeneratorInstance',
  {
    generator: t.handle('Generator', {
      description:
        'The generator, by name ({ "path": "star-explorer/StarSystem" }), or a generator file\'s #Generator ({ "path": "generators/sol.gen.json#Generator" }), whose seed and params are defaults.',
    }),
    seed: t.u32({
      description: "The seed. 0 uses the generator file's seed (0 for a generator by name).",
    }),
    params: t.json({
      default: {},
      description:
        "Params, checked against the generator's schema; missing ones take the file's or the defaults.",
    }),
    overrides: t.json({
      default: {},
      description:
        "Changes to generated entities by path relative to this entity, as in scene/PrefabInstance. Saves write the children's runtime changes here.",
    }),
  },
  {
    description:
      "Spawns an entities generator's output as children (procgen/Generated). Patching seed or params regenerates on the pool; children at unchanged paths keep their entity ids. Saves write only this component.",
  },
)

/** On every entity a GeneratorInstance spawned. Such entities are never written to scene files. */
export const Generated = defineTag('procgen/Generated', {
  description: 'Spawned by a GeneratorInstance; rebuilt from the generator, never saved.',
  serialize: false,
})

/** The request an instance's value makes, or undefined while its generator file loads. */
export function instanceRequest(
  world: World,
  value: { generator?: unknown; seed?: unknown; params?: unknown },
): { request: GenRequest; gen: Generator } | { pending: AssetEntry } | undefined {
  const ref = value.generator as AssetRef | null | undefined
  if (!ref) return undefined
  const server = assetServer(world)
  const entry = server.entry(ref)
  if (!entry) {
    throw new ShardError(
      'procgen/unknown-generator',
      `No generator ${JSON.stringify(ref.path ?? ref.guid)}`,
      { hint: 'Name a generator ("star-explorer/StarSystem") or a *.gen.json#Generator.' },
    )
  }
  if (entry.state !== 'loaded') {
    if (entry.state === 'unloaded') server.request(entry.guid)
    return { pending: entry }
  }
  const binding = world.resource(GeneratorBindings).get(entry)
  const gen = binding && findGenerator(binding.generator)
  if (!gen) {
    throw new ShardError('procgen/unknown-generator', `No generator "${binding?.generator}"`, {
      hint: 'Define it with project.generator in scripts/.',
    })
  }
  if (gen.output !== 'entities') {
    throw new ShardError(
      'procgen/output-mismatch',
      `GeneratorInstance needs an entities generator; ${gen.name} makes a ${gen.outputType}`,
      {
        hint: 'Use its output as a handle instead (a mesh: render/Mesh3d { "mesh": { "path": "procedural:…" } }).',
      },
    )
  }
  const params = {
    ...(binding.params ?? {}),
    ...(isPlainObject(value.params) ? (value.params as Record<string, JsonValue>) : {}),
  }
  const seed = (value.seed as number) || binding.seed || 0
  return { request: requestOf(gen, params, seed), gen }
}

/** The last error each instance logged, so a bad value logs once rather than every update. */
const reported = new WeakMap<World, Map<Entity, string>>()

defineInstanceKind({
  def: GeneratorInstance,
  mark: Generated,
  keepIds: true,
  nested: true,
  source(world, value, entity) {
    let seen = reported.get(world)
    if (!seen) {
      seen = new Map()
      reported.set(world, seen)
    }
    try {
      const made = instanceRequest(world, value)
      if (!made) return undefined
      if ('pending' in made) return made.pending
      seen.delete(entity)
      return procgen(world).entryFor(made.request)
    } catch (err) {
      const message = (err as Error).message
      if (seen.get(entity) !== message) {
        seen.set(entity, message)
        world.tryResource(LogResource)?.error(err)
      }
      return undefined
    }
  },
  validate(world, json, base, errors, options) {
    if (!options.catalog) return
    const ref = json.generator
    if (!isPlainObject(ref)) return
    const entry = assetServer(world).entry(ref as { path?: string; guid?: string })
    if (!entry) return // reported as schema/asset-not-found
    const binding =
      entry.state === 'loaded' ? world.resource(GeneratorBindings).get(entry) : undefined
    const gen = binding && findGenerator(binding.generator)
    if (!gen) return
    if (gen.output !== 'entities') {
      errors.push(
        new ShardError(
          'procgen/output-mismatch',
          `${gen.name} makes a ${gen.outputType}, not entities`,
          {
            path: pointer(base, 'generator'),
            hint: 'GeneratorInstance spawns entities generators; put other outputs in a handle field (procedural:…).',
          },
        ),
      )
      return
    }
    const params = {
      ...(binding.params ?? {}),
      ...(isPlainObject(json.params) ? (json.params as Record<string, JsonValue>) : {}),
    }
    for (const e of gen.params.validate(params)) {
      errors.push(
        new ShardError('procgen/bad-params', `${gen.name}: ${e.message}`, {
          path: `${pointer(base, 'params')}${e.path ?? ''}`,
          hint: e.hint ?? `${gen.name}'s params are in .agents/generators.md.`,
        }),
      )
    }
  },
})
