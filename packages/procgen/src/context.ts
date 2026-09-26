import { type AssetRef, type Fields, hashSeed, Rng, ShardError } from '@shard/core'
import {
  type NoiseGraph,
  sampleGrid2d,
  sampleNoise,
  sampleNoiseGradient,
  sampleOffset,
  sampleSpherePatch,
} from '@shard/noise'
import type { Generator, GenParams, GenRequest, OutputAsset, OutputSpec } from './generator'
import { guidOf, identityOf, proceduralPath, requestOf } from './generator'
import { type MeshBuilderApi, meshBuilder } from './mesh-builder'

/** Noise sampling inside a generator: 0041's sync functions, on the generator's thread. */
export interface NoiseApi {
  /** Values at absolute points (`xyz…`); see `sampleNoise`. */
  sample(
    graph: NoiseGraph,
    seed: number,
    points: Float32Array,
    out: Float32Array,
    node?: string,
  ): void
  /** Values at `origin + local` (precise far from the origin); see `sampleOffset`. */
  offset(
    graph: NoiseGraph,
    seed: number,
    origin: ArrayLike<number>,
    local: Float32Array,
    out: Float32Array,
    node?: string,
  ): void
  grid2d: typeof sampleGrid2d
  spherePatch: typeof sampleSpherePatch
  gradient: typeof sampleNoiseGradient
}

const noiseApi: NoiseApi = {
  sample: sampleNoise,
  offset: sampleOffset,
  grid2d: sampleGrid2d,
  spherePatch: sampleSpherePatch,
  gradient: sampleNoiseGradient,
}

/** What `run` gets besides its params. Everything here is deterministic. */
export interface GenContext {
  readonly seed: number
  /** Seeded from `hashSeed(seed, generatorName)`: the only randomness a generator has. */
  readonly rng: Rng
  /** `hashSeed(seed, label)`: a stable seed per label, for parts and nested generators. */
  childSeed(label: string | number): number
  readonly noise: NoiseApi
  /**
   * An asset a param points at (a NoiseGraph, a mesh, a data value), loaded before `run`. Only
   * handles in the params can be loaded, so a generator never does I/O.
   */
  load<T = unknown>(ref: AssetRef | { guid?: string; path?: string } | null | undefined): T
  /**
   * Another generator's output, as a reference to put in this one's output (a mesh handle in a
   * fragment). It's cached on its own: changing it rebuilds only it.
   */
  generate<const P extends Fields, const O extends OutputSpec>(
    gen: Generator<P, O>,
    params: GenParams<P>,
    seed: number,
  ): Promise<AssetRef<OutputAsset<O>>>
  readonly mesh: MeshBuilderApi
  /** A GPU for compute, when one exists. Absent in workers and headless runs. */
  readonly gpu?: undefined
  /** A non-fatal problem, shown by procgen.run and asset.get. */
  warn(message: string, path?: string): void
}

export interface ContextState {
  children: GenRequest[]
  warnings: { message: string; path?: string }[]
}

/** A dependency as the job carries it: the handle's guid and path, and the loaded object. */
export interface LoadedDependency {
  guid: string | undefined
  path: string | undefined
  type: string
  object: unknown
}

export function createContext(
  gen: Generator,
  request: GenRequest,
  deps: readonly LoadedDependency[],
  chain: readonly string[],
  state: ContextState,
): GenContext {
  const self = identityOf(request)
  return {
    seed: request.seed,
    rng: new Rng(hashSeed(request.seed, gen.name)),
    childSeed: (label) => hashSeed(request.seed, label),
    noise: noiseApi,
    load<T>(ref: { guid?: string; path?: string } | null | undefined): T {
      const dep =
        ref &&
        deps.find(
          (d) =>
            (ref.guid !== undefined && d.guid === ref.guid) ||
            (ref.path !== undefined && d.path === ref.path),
        )
      if (!dep) {
        throw new ShardError(
          'procgen/undeclared-dependency',
          `${gen.name} loaded ${JSON.stringify(ref ?? null)}, which isn't one of its params`,
          {
            hint: 'ctx.load takes the handles in the params (declare a t.handle param and pass the asset in).',
          },
        )
      }
      return dep.object as T
    },
    generate: (child, params, seed) => {
      const req = requestOf(child as unknown as Generator, params as never, seed)
      const id = identityOf(req)
      if (id === self || chain.includes(id)) {
        return Promise.reject(
          new ShardError(
            'procgen/cycle',
            `${gen.name} generates ${child.name} with the same inputs as one of its callers`,
            {
              hint: 'A generator that calls itself needs different params or a different seed (ctx.childSeed) each level.',
            },
          ),
        )
      }
      if (!state.children.some((c) => identityOf(c) === id)) state.children.push(req)
      return Promise.resolve({
        type: child.outputType,
        guid: guidOf(req),
        path: proceduralPath(req),
      } as AssetRef<never>)
    },
    mesh: meshBuilder,
    warn: (message, path) =>
      state.warnings.push(path === undefined ? { message } : { message, path }),
  }
}

// --- determinism -----------------------------------------------------------------------------------

/**
 * Replaces `Math.random`, `Date.now`, and `performance.now` with functions that throw
 * `procgen/nondeterministic`. Returns a function that restores them.
 */
export function guardNondeterminism(generator: string): () => void {
  const fail = (what: string) => () => {
    throw new ShardError('procgen/nondeterministic', `${generator} called ${what}`, {
      hint: 'Generators are pure: use ctx.rng for randomness and pass times in as params.',
    })
  }
  const random = Math.random
  const now = Date.now
  const perf = globalThis.performance as { now?: () => number } | undefined
  const ownNow = perf ? Object.getOwnPropertyDescriptor(perf, 'now') : undefined
  Math.random = fail('Math.random()')
  Date.now = fail('Date.now()')
  if (perf) {
    Object.defineProperty(perf, 'now', {
      value: fail('performance.now()'),
      configurable: true,
      writable: true,
    })
  }
  return () => {
    Math.random = random
    Date.now = now
    if (perf) {
      if (ownNow) Object.defineProperty(perf, 'now', ownNow)
      else delete perf.now
    }
  }
}
