import { type Artifact, findAssetType } from '@shard/assets'
import { type JsonValue, ShardError } from '@shard/core'
import { useNoiseKernel } from '@shard/noise'
import {
  type ContextState,
  createContext,
  guardNondeterminism,
  type LoadedDependency,
} from './context'
import { type GenRequest, identityOf, requireGenerator } from './generator'
import { encodeOutput, type GenOutputAsset } from './outputs'

/** An asset a job's params point at: its artifact (workers rebuild it) or the loaded object. */
export interface JobDependency {
  guid: string | undefined
  path: string | undefined
  type: string
  artifact?: Artifact
  object?: unknown
}

/** One generator run, as posted to a worker: all of it is structured-clonable. */
export interface GenJob extends GenRequest {
  deps: JobDependency[]
  /** Identities of the generators that asked for this one (cycle checks). */
  chain: string[]
  /** The noise kernel module, so a worker samples without fetching the .wasm. */
  noise?: WebAssembly.Module
  noiseSimd?: boolean
  /** Guard the clock and Math.random for the whole run (workers), not just its first turn. */
  guardAll?: boolean
  /** Check entities' components here (default true). Workers leave it to the main thread. */
  checkComponents?: boolean
}

export interface GenResult {
  assets: GenOutputAsset[]
  /** Outputs this one referenced through `ctx.generate`. */
  children: GenRequest[]
  warnings: { message: string; path?: string }[]
  /** Time in `run` and encoding, in ms. */
  ms: number
}

function wrap(err: unknown, job: GenJob): ShardError {
  if (err instanceof ShardError && err.code.startsWith('procgen/')) return err
  const message = (err as Error)?.message ?? String(err)
  return new ShardError(
    'procgen/generator-failed',
    `${job.generator} failed (seed ${job.seed}, params ${JSON.stringify(job.params)}): ${message}`,
    {
      hint: 'The error is in the generator; procgen.run with the same seed and params reproduces it.',
      cause: err,
    },
  )
}

async function loadDependencies(job: GenJob): Promise<LoadedDependency[]> {
  const out: LoadedDependency[] = []
  for (const d of job.deps) {
    if (d.object !== undefined) {
      out.push({ guid: d.guid, path: d.path, type: d.type, object: d.object })
      continue
    }
    const type = findAssetType(d.type)
    if (!type || !d.artifact) {
      throw new ShardError(
        'procgen/dependency-failed',
        `${job.generator} needs ${d.path ?? d.guid}, a ${d.type}, which can't be loaded here`,
        { hint: 'Add the plugin that defines the asset type to the project.' },
      )
    }
    const object = await type.load(d.artifact, {
      guid: d.guid ?? '',
      path: d.path ?? '',
      resolve: () => undefined,
    })
    out.push({ guid: d.guid, path: d.path, type: d.type, object })
  }
  return out
}

/**
 * Runs a generator job and encodes its output: the same code inline and on a worker. Throws
 * `procgen/*` errors; anything else the generator throws becomes `procgen/generator-failed`.
 */
export async function executeJob(job: GenJob): Promise<GenResult> {
  const gen = requireGenerator(job.generator)
  if (job.noise) useNoiseKernel(job.noise, job.noiseSimd ?? true)
  const deps = await loadDependencies(job)
  const state: ContextState = { children: [], warnings: [] }
  const params = gen.params.deserialize(job.params)
  const ctx = createContext(gen, job, deps, job.chain, state)
  const start = performance.now()
  let restore: (() => void) | undefined = guardNondeterminism(gen.name)
  try {
    let result: unknown = gen.run(ctx, params as never)
    if (!job.guardAll) {
      restore()
      restore = undefined
    }
    if (result instanceof Promise) result = await result
    const assets = encodeOutput(gen, result, { checkComponents: job.checkComponents })
    restore?.()
    restore = undefined
    return {
      assets,
      children: state.children,
      warnings: state.warnings,
      ms: performance.now() - start,
    }
  } catch (err) {
    throw wrap(err, job)
  } finally {
    restore?.()
  }
}

/** Plain-object errors cross the worker boundary; this keeps code, hint, and path. */
export function jobError(err: unknown): {
  code: string
  message: string
  hint?: string
  path?: string
} {
  const e = err as ShardError
  return {
    code: e?.code ?? 'procgen/generator-failed',
    message: e?.message ?? String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    ...(e?.path ? { path: e.path } : {}),
  }
}

export type { GenOutputAsset, JsonValue }

/** The identity of a job's request (for logs and stats). */
export function jobIdentity(job: GenJob): string {
  return identityOf(job)
}
