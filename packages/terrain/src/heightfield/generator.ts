import {
  type ComponentDef,
  defineSchema,
  type Fields,
  type InferFields,
  type JsonValue,
  ShardError,
} from '@aethervtt/shard-core'
import { computeOrigins, evalProgram, useNoiseKernel } from '@aethervtt/shard-noise'
import { defineWorkerTask, guardNondeterminism } from '@aethervtt/shard-procgen'
import {
  type BlockResult,
  bakeBlock,
  bakeNearPage,
  type KernelGenerator,
  type KernelLayout,
  type NearPage,
  type NoiseAccess,
  type Stack,
  type StackGenerator,
} from './kernel'

/**
 * A grid of samples a generator fills (spec 0119): sample (a, b) is at (x0 + a × step, z0 + b ×
 * step) metres from the terrain's corner, row by row. Areas reach past the terrain's edge by a few
 * samples (normals and borders read them).
 */
export interface TerrainArea {
  readonly x0: number
  readonly z0: number
  readonly step: number
  readonly nx: number
  readonly nz: number
}

export interface TerrainGeneratorOptions<P extends Fields, S> {
  /** Parameters: a component schema (validated and defaulted from the source's `params`). */
  params: P
  /** Bump when the code changes what it returns. Default 1. */
  version?: number
  description?: string
  /**
   * Holds the functions to math that gives the same bits in every JavaScript engine, as 0042's
   * generators: transcendental `Math` functions throw `procgen/nondeterministic` while they run,
   * and `shard check` flags them. Default false.
   */
  deterministicMath?: boolean
  /**
   * What sampling reads, built once per thread per (name, version, params) and kept: a region plan,
   * say. Pure. Without it, the state is the params.
   */
  prepare?(params: InferFields<P>): S
  /**
   * Ground heights (m) at the area's samples into `out` (nz rows of nx). Pure: a sample's value
   * depends only on its (x, z), never on the area it was asked in.
   */
  heights(state: S, area: TerrainArea, out: Float64Array): void
  /** Material layer names `weights` writes, in its order; each must be a layer of the source. */
  layers?: readonly string[]
  /**
   * Material weights 0–1 at the area's samples, `layers.length` per sample:
   * `out[(b × nx + a) × layers.length + l]`. `heights` holds the ground there (quantized, as the
   * page stores it). Pure, as `heights`.
   */
  weights?(state: S, area: TerrainArea, heights: Float64Array, out: Float32Array): void
  /**
   * Where the ground is open (spec 0120): 1 at the area's samples (cell centres) where it is, else
   * 0. A source opts in with `"holes": { "generator": name }`. Pure, as `heights`.
   */
  holes?(state: S, area: TerrainArea, out: Uint8Array): void
  /**
   * Scatter fields (spec 0121), by name: a density 0–1 at `count` points (x, z pairs in the
   * terrain's frame). A scatter rule's `masks.field` names one. Pure, as `heights`.
   */
  fields?: Readonly<
    Record<string, (state: S, xz: Float64Array, count: number, out: Float32Array) => void>
  >
}

/** A registered terrain generator (`defineTerrainGenerator`). */
export interface TerrainGenerator<P extends Fields = Fields, S = unknown> {
  readonly name: string
  readonly description: string | undefined
  readonly params: ComponentDef<P>
  readonly version: number
  readonly deterministicMath: boolean
  readonly layers: readonly string[]
  /** Bumps each time the name is defined again (hot reload). */
  readonly revision: number
  readonly options: TerrainGeneratorOptions<P, S>
}

/** The pool tasks near pages and ahead blocks of stacks with generators bake in (spec 0119). */
export const NEAR_TASK = 'terrain/near-page'
export const BLOCK_TASK = 'terrain/bake-block'

const registry = new Map<string, TerrainGenerator>()
let revisions = 0

/**
 * One near page on this thread (the generator worker module's task): the noise kernel from its
 * posted module, this thread's generators, and kernel.js's bakeNearPage.
 */
function nearPageTask(
  module: WebAssembly.Module,
  simd: boolean,
  stack: Stack,
  layout: KernelLayout,
  depth: number,
  x: number,
  z: number,
): NearPage {
  return bakeNearPage(threadNoise(module, simd), stack, layout, depth, x, z)
}

/** This thread's kernel access, with its noise kernel from a posted module. */
function threadNoise(module: WebAssembly.Module, simd: boolean): NoiseAccess {
  const kernel = useNoiseKernel(module, simd)
  return {
    state: kernel.state,
    computeOrigins: computeOrigins as NoiseAccess['computeOrigins'],
    evalProgram: evalProgram as NoiseAccess['evalProgram'],
    generator: generatorAccess,
  }
}

/** One ahead block (0071's bakeBlock) of a stack with generators, on this thread. */
function blockTask(
  module: WebAssembly.Module,
  simd: boolean,
  stack: Stack,
  layout: KernelLayout,
  bx: number,
  bz: number,
): BlockResult {
  return bakeBlock(threadNoise(module, simd), stack, layout, bx, bz)
}

/**
 * Defines a terrain generator (spec 0119): heights, and optionally material weights, as a pure
 * function of its params and (x, z), for a source's `{ "generator": name }` layers. Runs on the
 * main thread and in the generator worker module. Names are namespaced (`risen/Ground`). Defining
 * a name again replaces it, and terrains using it rebake.
 */
export function defineTerrainGenerator<const P extends Fields, S = InferFields<P>>(
  name: string,
  options: TerrainGeneratorOptions<P, S>,
): TerrainGenerator<P, S> {
  if (!/^[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new ShardError('terrain/bad-generator', `"${name}" isn't a terrain generator name`, {
      hint: 'Names are "<namespace>/<Name>", e.g. "risen/Ground".',
    })
  }
  const layers = options.layers ?? []
  if (layers.length > 0 && !options.weights) {
    throw new ShardError('terrain/bad-generator', `${name} lists layers but has no weights()`, {
      hint: 'Either write weights(state, area, heights, out) or drop `layers`.',
    })
  }
  const gen: TerrainGenerator<P, S> = {
    name,
    description: options.description,
    params: defineSchema(`${name}TerrainParams`, options.params, {
      description: `Parameters of the ${name} terrain generator.`,
    }),
    version: options.version ?? 1,
    deterministicMath: options.deterministicMath ?? false,
    layers,
    revision: ++revisions,
    options,
  }
  registry.set(name, gen as unknown as TerrainGenerator)
  // The worker module runs the project's code, so it has the task wherever it has a generator.
  defineWorkerTask(NEAR_TASK, nearPageTask)
  defineWorkerTask(BLOCK_TASK, blockTask)
  return gen
}

export function findTerrainGenerator(name: string): TerrainGenerator | undefined {
  return registry.get(name)
}

/** A generator's params validated and defaulted, as canonical JSON (keys in schema order). */
export function canonicalTerrainParams(
  gen: TerrainGenerator,
  params: unknown,
  path = '',
): Record<string, JsonValue> {
  const json = (params ?? {}) as JsonValue
  const errors = gen.params.validate(json)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new ShardError('terrain/bad-source', `${gen.name}: ${first.message}`, {
      path: `${path}${first.path ?? ''}`,
      hint: first.hint ?? `See ${gen.name}'s params.`,
      details: errors,
    })
  }
  const value = gen.params.serialize(gen.params.deserialize(json)) as Record<string, JsonValue>
  const out: Record<string, JsonValue> = {}
  for (const key of Object.keys(gen.params.fields)) if (key in value) out[key] = value[key]!
  return out
}

/** A stack's view of a generator: its name, version and canonical params (cloneable). */
export function stackGenerator(
  gen: TerrainGenerator,
  params: unknown,
  path?: string,
): StackGenerator {
  return { name: gen.name, version: gen.version, params: canonicalTerrainParams(gen, params, path) }
}

interface Prepared {
  gen: TerrainGenerator
  access: KernelGenerator
}

/** Prepared generators on this thread, by name, version, revision and params. */
const prepared = new Map<string, Prepared>()

function notFinite(gen: string, what: string, x: number, z: number): ShardError {
  return new ShardError(
    'terrain/bad-generator-output',
    `${gen} gave a ${what} that isn't a finite number at (${x.toFixed(1)}, ${z.toFixed(1)})`,
    { hint: 'Heights are metres and weights 0–1, for every sample of the area it was asked for.' },
  )
}

function failed(gen: string, err: unknown): ShardError {
  if (err instanceof ShardError) return err
  return new ShardError('terrain/generator-failed', `${gen} threw: ${String(err)}`, {
    hint: 'Terrain generators run on workers and the main thread; they must not throw for any (x, z).',
    cause: err,
  })
}

/**
 * The kernel's access to a stack's generator on this thread (spec 0119): the definition from this
 * thread's registry, prepared once for its params. Throws `terrain/unknown-generator` when this
 * thread hasn't defined it, `terrain/generator-failed` when it throws, and
 * `terrain/bad-generator-output` for a non-finite height or weight.
 */
export function generatorAccess(spec: StackGenerator): KernelGenerator {
  const gen = registry.get(spec.name)
  if (!gen) {
    throw new ShardError(
      'terrain/unknown-generator',
      `No terrain generator named "${spec.name}" here`,
      {
        hint: 'Define it with defineTerrainGenerator in the project’s scripts, which run before the terrain bakes (and in the worker module).',
      },
    )
  }
  if (gen.version !== spec.version) {
    throw new ShardError(
      'terrain/unknown-generator',
      `${spec.name} is version ${gen.version} here, the terrain wants ${spec.version}`,
      { hint: 'The worker module is older than the main thread’s code: it rebuilds on save.' },
    )
  }
  const key = `${spec.name}\u0000${gen.revision}\u0000${JSON.stringify(spec.params)}`
  let p = prepared.get(key)
  if (p) return p.access
  const o = gen.options
  const guard = () => guardNondeterminism(gen.name, { deterministicMath: gen.deterministicMath })
  let state: unknown
  const restore = guard()
  try {
    state = o.prepare
      ? o.prepare(gen.params.deserialize(spec.params as JsonValue) as never)
      : spec.params
  } catch (err) {
    throw failed(gen.name, err)
  } finally {
    restore()
  }
  const layers = gen.layers.length
  const area = { x0: 0, z0: 0, step: 1, nx: 0, nz: 0 }
  const access: KernelGenerator = {
    layers,
    heights(x0, z0, step, nx, nz, out) {
      area.x0 = x0
      area.z0 = z0
      area.step = step
      area.nx = nx
      area.nz = nz
      const restore = guard()
      try {
        o.heights(state, area, out)
      } catch (err) {
        throw failed(gen.name, err)
      } finally {
        restore()
      }
      for (let i = 0; i < nx * nz; i++) {
        if (!Number.isFinite(out[i]!))
          throw notFinite(gen.name, 'height', x0 + (i % nx) * step, z0 + Math.floor(i / nx) * step)
      }
    },
    holes(x0, z0, step, nx, nz, out) {
      area.x0 = x0
      area.z0 = z0
      area.step = step
      area.nx = nx
      area.nz = nz
      out.fill(0, 0, nx * nz)
      const restore = guard()
      try {
        o.holes!(state, area, out)
      } catch (err) {
        throw failed(gen.name, err)
      } finally {
        restore()
      }
      for (let i = 0; i < nx * nz; i++) {
        if (out[i]! > 1) {
          throw new ShardError(
            'terrain/bad-generator-output',
            `${gen.name}'s holes gave ${out[i]} at (${(x0 + (i % nx) * step).toFixed(1)}, ${(z0 + Math.floor(i / nx) * step).toFixed(1)}); a mask is 0 or 1`,
            { hint: 'Write 1 where the ground is open, 0 elsewhere.' },
          )
        }
      }
    },
    field(name, xz, count, out) {
      const f = o.fields?.[name]
      if (!f) {
        throw new ShardError('terrain/unknown-field', `${gen.name} has no field "${name}"`, {
          hint: `Its fields: ${Object.keys(o.fields ?? {}).join(', ') || '(none)'}.`,
        })
      }
      const restore = guard()
      try {
        f(state, xz, count, out)
      } catch (err) {
        throw failed(gen.name, err)
      } finally {
        restore()
      }
      for (let i = 0; i < count; i++) {
        const v = out[i]!
        if (!Number.isFinite(v))
          throw notFinite(gen.name, `${name} density`, xz[i * 2]!, xz[i * 2 + 1]!)
        out[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    },
    weights(x0, z0, step, nx, nz, heights, out) {
      area.x0 = x0
      area.z0 = z0
      area.step = step
      area.nx = nx
      area.nz = nz
      const restore = guard()
      try {
        o.weights!(state, area, heights, out)
      } catch (err) {
        throw failed(gen.name, err)
      } finally {
        restore()
      }
      for (let i = 0; i < nx * nz * layers; i++) {
        if (!Number.isFinite(out[i]!)) {
          const s = Math.floor(i / layers)
          throw notFinite(gen.name, 'weight', x0 + (s % nx) * step, z0 + Math.floor(s / nx) * step)
        }
      }
    },
  }
  // Older revisions of this generator are dropped with their state.
  for (const [k, v] of prepared) if (v.gen.name === gen.name && v.gen !== gen) prepared.delete(k)
  p = { gen, access }
  prepared.set(key, p)
  return access
}

/**
 * A stack's scatter field (spec 0121): the field `name` of the first of its generators that has
 * one, prepared with that generator's params on this thread. Undefined when none has it.
 */
export function stackField(
  stack: Stack,
  name: string,
): ((xz: Float64Array, count: number, out: Float32Array) => void) | undefined {
  for (const spec of stack.generators) {
    if (!findTerrainGenerator(spec.name)?.options.fields?.[name]) continue
    const access = generatorAccess(spec)
    return (xz, count, out) => access.field(name, xz, count, out)
  }
  return undefined
}

/** Every field the stack's generators give, for hints. */
export function stackFieldNames(stack: Stack): string[] {
  const names = new Set<string>()
  for (const spec of stack.generators)
    for (const name of Object.keys(findTerrainGenerator(spec.name)?.options.fields ?? {}))
      names.add(name)
  return [...names]
}
