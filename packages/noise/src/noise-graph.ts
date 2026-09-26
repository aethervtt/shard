import { AssetStore, defineAssetSchema, defineAssetType, defineImporter } from '@shard/assets'
import { defineResource, defineSchema, type JsonValue, ShardError } from '@shard/core'
import { compileGraph, type NoiseProgram } from './compile'
import { type ParsedGraph, parseGraph } from './graph'
import { computeOrigins } from './kernel'
import { loadNoiseKernel } from './loader'
import { noiseJsonSchema } from './schema'
import { generateWgsl } from './wgsl'

/** A program as JSON: what the importer writes and loading copies back into typed arrays. */
export interface ProgramJson {
  code: number[]
  consts: number[]
  registers: number
  result: number
  dimensions: 2 | 3 | 4
  terms: { a: number[]; b: number[]; skew: number[] }
}

/** The `noise` importer's artifact: the source graph, its program, the WGSL, and a hash. */
export interface NoiseGraphArtifact {
  format: 1
  name: string
  module: string
  source: JsonValue
  program: ProgramJson
  wgsl: string
  hash: string
}

/** The WGSL function name (`noise_<name>`) and module path (`noise::…`) for an asset path. */
export function noiseNames(path: string): { name: string; module: string } {
  const clean = (s: string) => {
    const t = s.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    return /^[a-z_]/.test(t) ? t : `_${t}`
  }
  const segments = path
    .replace(/\.noise\.json$/, '')
    .split('/')
    .filter(Boolean)
    .map(clean)
  const name = segments[segments.length - 1] ?? 'graph'
  return { name, module: `noise::${segments.join('::') || 'graph'}` }
}

function throwFirst(errors: readonly ShardError[]): never {
  const first = errors[0]!
  throw new ShardError(
    first.code,
    `${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
    { path: first.path, hint: first.hint, details: errors },
  )
}

function fnv(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}

function programHash(p: NoiseProgram): string {
  const parts = [
    new Uint8Array(p.code.buffer, p.code.byteOffset, p.code.byteLength),
    new Uint8Array(p.consts.buffer, p.consts.byteOffset, p.consts.byteLength),
    new Uint8Array(p.terms.a.buffer, p.terms.a.byteOffset, p.terms.a.byteLength),
    new Uint8Array(p.terms.b.buffer, p.terms.b.byteOffset, p.terms.b.byteLength),
    p.terms.skew,
    new Uint8Array([
      p.registers & 255,
      p.registers >> 8,
      p.result & 255,
      p.result >> 8,
      p.dimensions,
    ]),
  ]
  let a = 0x811c9dc5
  let b = 0x9747b28c
  for (const part of parts) {
    a = fnv(a, part)
    b = fnv(b ^ 0x5bd1e995, part)
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

function programFromJson(p: ProgramJson): NoiseProgram {
  const terms = {
    a: new Float64Array(p.terms.a),
    b: new Float64Array(p.terms.b),
    skew: new Uint8Array(p.terms.skew),
  }
  const zeroOrigins = new Int32Array(terms.skew.length * 8)
  computeOrigins(terms, [0, 0, 0, 0], zeroOrigins)
  const code = new Int32Array(p.code)
  return {
    code,
    consts: new Float32Array(p.consts),
    registers: p.registers,
    result: p.result,
    dimensions: p.dimensions,
    terms,
    zeroOrigins,
    instructions: code.length / 12,
  }
}

function programToJson(p: NoiseProgram): ProgramJson {
  return {
    code: [...p.code],
    consts: [...p.consts],
    registers: p.registers,
    result: p.result,
    dimensions: p.dimensions,
    terms: { a: [...p.terms.a], b: [...p.terms.b], skew: [...p.terms.skew] },
  }
}

/**
 * A noise graph ready to sample: the validated graph, its compiled program (what the CPU kernel
 * runs), and its WGSL module (what shaders import). One JSON source gives both the same function.
 */
export class NoiseGraph {
  /** Bumps on hot reload. */
  version = 0
  private nodePrograms = new Map<string, NoiseProgram>()

  /** The graph file's JSON (without `$schema`). */
  source: JsonValue
  graph: ParsedGraph
  /** What the CPU kernel runs. */
  program: NoiseProgram
  /** Function suffix: the WGSL exports `noise_<name>` and `noise_<name>_at`. */
  name: string
  /** WGSL module path, e.g. `noise::assets::noise::planet`. */
  module: string
  wgsl: string
  /** Hash of the program: equal hashes sample equal values. */
  hash: string

  constructor(
    source: JsonValue,
    graph: ParsedGraph,
    program: NoiseProgram,
    name: string,
    module: string,
    wgsl: string,
    hash: string,
  ) {
    this.source = source
    this.graph = graph
    this.program = program
    this.name = name
    this.module = module
    this.wgsl = wgsl
    this.hash = hash
  }

  /** The WGSL function for positions near the origin. */
  get fn(): string {
    return `noise_${this.name}`
  }

  /** Parses, validates, and compiles a graph. Throws its first error, with the rest in `details`. */
  static fromJson(json: unknown, options: { name?: string; module?: string } = {}): NoiseGraph {
    let source = json
    if (source && typeof source === 'object' && !Array.isArray(source) && '$schema' in source) {
      const { $schema: _, ...rest } = source as Record<string, unknown>
      source = rest
    }
    const { graph, errors } = parseGraph(source)
    if (!graph) throwFirst(errors)
    const program = compileGraph(graph)
    const names = options.name
      ? { name: options.name, module: options.module ?? `noise::${options.name}` }
      : noiseNames('graph')
    const wgsl = generateWgsl(program, { name: names.name })
    return new NoiseGraph(
      source as JsonValue,
      graph,
      program,
      names.name,
      names.module,
      wgsl,
      programHash(program),
    )
  }

  /** `fromJson` once the kernel is loaded, so the graph can be sampled synchronously. */
  static async create(
    json: unknown,
    options: { name?: string; module?: string } = {},
  ): Promise<NoiseGraph> {
    await loadNoiseKernel()
    return NoiseGraph.fromJson(json, options)
  }

  static fromArtifact(artifact: NoiseGraphArtifact): NoiseGraph {
    const { graph, errors } = parseGraph(artifact.source)
    if (!graph) throwFirst(errors)
    return new NoiseGraph(
      artifact.source,
      graph,
      programFromJson(artifact.program),
      artifact.name,
      artifact.module,
      artifact.wgsl,
      artifact.hash,
    )
  }

  toArtifact(): NoiseGraphArtifact {
    return {
      format: 1,
      name: this.name,
      module: this.module,
      source: this.source,
      program: programToJson(this.program),
      wgsl: this.wgsl,
      hash: this.hash,
    }
  }

  /** The program with `node` as its output (the graph's own output by default), for previews. */
  programFor(node?: string): NoiseProgram {
    if (node === undefined || node === this.graph.output) return this.program
    let p = this.nodePrograms.get(node)
    if (!p) {
      p = compileGraph(this.graph, node)
      this.nodePrograms.set(node, p)
    }
    return p
  }

  /** Hot reload: takes `next`'s graph, program, and WGSL, and bumps `version`. */
  copyFrom(next: NoiseGraph): void {
    this.source = next.source
    this.graph = next.graph
    this.program = next.program
    this.name = next.name
    this.module = next.module
    this.wgsl = next.wgsl
    this.hash = next.hash
    this.nodePrograms = new Map()
    this.version++
  }
}

export class NoiseGraphStore extends AssetStore<NoiseGraph, 'NoiseGraph'> {
  constructor() {
    super('NoiseGraph')
  }
}

export const NoiseGraphs = defineResource<NoiseGraphStore>('noise/NoiseGraphs', {
  description: 'Loaded noise graphs by guid.',
  init: () => new NoiseGraphStore(),
})

export const NoiseGraphAssetType = defineAssetType<NoiseGraph>('NoiseGraph', {
  store: NoiseGraphs,
  // The kernel loads with the first graph, so every loaded graph can be sampled synchronously.
  load: async (artifact) => {
    await loadNoiseKernel()
    return NoiseGraph.fromArtifact(artifact.json as unknown as NoiseGraphArtifact)
  },
  update: (existing, next) => existing.copyFrom(next),
})

const NoSettings = defineSchema(
  'noise/NoSettings',
  {},
  { description: 'None: the graph is the file.' },
)

/** `*.noise.json`: a noise graph, validated with pointers into the file and compiled. */
export const NoiseGraphImporter = defineImporter({
  name: 'noise',
  version: 1,
  extensions: ['.noise.json'],
  settings: NoSettings,
  async import(source) {
    let json: unknown
    try {
      json = JSON.parse(source.text())
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
        path: source.path,
        cause,
      })
    }
    const names = noiseNames(source.path)
    const graph = NoiseGraph.fromJson(json, names)
    return {
      assets: [
        {
          label: '',
          type: 'NoiseGraph',
          json: graph.toArtifact() as unknown as JsonValue,
          info: {
            nodes: graph.graph.nodes.size,
            instructions: graph.program.instructions,
            octaves: graph.program.terms.skew.length,
            module: graph.module,
            function: graph.fn,
          },
        },
      ],
    }
  },
})

defineAssetSchema('noise.schema.json', noiseJsonSchema)
