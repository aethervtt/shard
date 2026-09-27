import { hashSeed, ShardError } from '@aethervtt/shard-core'
import { type GraphInput, type GraphNode, type ParsedGraph, pointer } from './graph'
import { computeOrigins, type OriginTerms } from './kernel'
import { CELL_DISTANCES, CELL_RETURNS, SOURCE_KINDS } from './nodes'

/** i32 words per instruction: `[op, dst, a, b, c, d, e, f, k, n, seed, salt]`. */
export const WIDTH = 12
/** Registers 0–3 hold the local position (x, y, z, w). */
export const POSITION_REGS = 4

/** Opcodes, matching `crates/shard-noise/src/program.rs`. */
export const OP = {
  CONST: 0,
  SOURCE: 1,
  ADD: 2,
  MUL: 3,
  MIN: 4,
  MAX: 5,
  LERP: 6,
  SELECT: 7,
  REMAP: 8,
  CLAMP: 9,
  CURVE: 10,
  TERRACE: 11,
  ABS: 12,
  POWER: 13,
  WARP: 14,
  SCALE_DISP: 15,
} as const

export const FRACTAL = { NONE: 0, FBM: 1, RIDGED: 2, BILLOW: 3 } as const

/** Skew applied to a source's lattice coordinates: none, or the simplex skew for 2, 3, or 4 dims. */
export const SKEW = { NONE: 0, SIMPLEX2: 2, SIMPLEX3: 3, SIMPLEX4: 4 } as const

/**
 * A compiled graph: instructions in topological order, their constants in one Float32Array, and one
 * origin term per source octave (how that octave's lattice position depends on the sample origin).
 */
export interface NoiseProgram {
  readonly code: Int32Array
  readonly consts: Float32Array
  /** Registers the program uses (each holds one block of points). */
  readonly registers: number
  /** The register holding the result. */
  readonly result: number
  readonly dimensions: 2 | 3 | 4
  readonly terms: OriginTerms
  /** Origin records for sampling at absolute positions (origin zero). */
  readonly zeroOrigins: Int32Array
  /** Instructions: `code.length / WIDTH`. */
  readonly instructions: number
}

interface Ctx {
  /** The node sees `s × p + t + disp` for world position p. */
  readonly s: readonly number[]
  readonly t: readonly number[]
  /** First of four registers holding the warp displacement, or -1. */
  readonly disp: number
  /** Seed salt for warp channels (0: none). */
  readonly salt: number
  readonly key: string
}

const ctxKey = (s: readonly number[], t: readonly number[], disp: number, salt: number) =>
  `${s.join(',')}|${t.join(',')}|${disp}|${salt}`

const ROOT: Ctx = {
  s: [1, 1, 1, 1],
  t: [0, 0, 0, 0],
  disp: -1,
  salt: 0,
  key: ctxKey([1, 1, 1, 1], [0, 0, 0, 0], -1, 0),
}

const fround = Math.fround
/** Past this, a lattice coordinate no longer fits the i32 cell of an origin record. */
const I32_LIMIT = 2 ** 31
/**
 * How much a source's skew can grow one coordinate of a point within the extent: the 3D rotation is
 * orthogonal (none), the 2D and 4D skews add up to √2·F₂ and 2·F₄.
 */
const SKEW_GROWTH = [1, 1, 1.52, 1, 1.62]

class Compiler {
  readonly code: number[] = []
  readonly consts: number[] = []
  readonly a: number[] = []
  readonly b: number[] = []
  readonly skew: number[] = []
  readonly errors: ShardError[] = []
  registers = POSITION_REGS
  private readonly memo = new Map<string, number>()
  private readonly constRegs = new Map<number, number>()
  private readonly ids = new WeakMap<GraphNode, number>()
  private nextId = 0
  private readonly stack: string[] = []

  readonly graph: ParsedGraph

  constructor(graph: ParsedGraph) {
    this.graph = graph
  }

  reg(count = 1): number {
    const r = this.registers
    this.registers += count
    return r
  }

  konst(values: readonly number[]): number {
    const k = this.consts.length
    for (const v of values) this.consts.push(fround(v))
    return k
  }

  emit(
    op: number,
    dst: number,
    ins: readonly number[] = [],
    k = 0,
    n = 0,
    seed = 0,
    salt = 0,
  ): void {
    const w = [op, dst, -1, -1, -1, -1, -1, -1, k, n, seed | 0, salt | 0]
    for (let i = 0; i < ins.length; i++) w[2 + i] = ins[i]!
    this.code.push(...w)
  }

  constant(value: number): number {
    const v = fround(value)
    let r = this.constRegs.get(v)
    if (r === undefined) {
      r = this.reg()
      this.emit(OP.CONST, r, [], this.konst([v]))
      this.constRegs.set(v, r)
    }
    return r
  }

  input(input: GraphInput, ctx: Ctx): number {
    if (input.kind === 'const') return this.constant(input.value)
    if (input.kind === 'ref') return this.named(input.name, ctx)
    return this.node(input.node, ctx)
  }

  named(name: string, ctx: Ctx): number {
    const key = `n:${name}@${ctx.key}`
    const hit = this.memo.get(key)
    if (hit !== undefined) return hit
    const node = this.graph.nodes.get(name)!
    this.stack.push(name)
    const r = this.build(node, ctx)
    this.stack.pop()
    this.memo.set(key, r)
    return r
  }

  node(node: GraphNode, ctx: Ctx): number {
    let id = this.ids.get(node)
    if (id === undefined) {
      id = this.nextId++
      this.ids.set(node, id)
    }
    const key = `i:${id}@${ctx.key}`
    const hit = this.memo.get(key)
    if (hit !== undefined) return hit
    const r = this.build(node, ctx)
    this.memo.set(key, r)
    return r
  }

  build(node: GraphNode, ctx: Ctx): number {
    const p = node.params
    const inp = (name: string) => this.input(p[name] as GraphInput, ctx)
    const num = (name: string) => p[name] as number
    switch (node.type) {
      case 'value':
      case 'perlin':
      case 'simplex':
      case 'cellular':
        return this.source(node, node.type, FRACTAL.NONE, ctx)
      case 'fbm':
        return this.source(node, p.source as string, FRACTAL.FBM, ctx)
      case 'ridged':
        return this.source(node, p.source as string, FRACTAL.RIDGED, ctx)
      case 'billow':
        return this.source(node, p.source as string, FRACTAL.BILLOW, ctx)
      case 'add':
      case 'multiply':
      case 'min':
      case 'max': {
        const op = { add: OP.ADD, multiply: OP.MUL, min: OP.MIN, max: OP.MAX }[node.type]
        const inputs = (p.inputs as GraphInput[]).map((i) => this.input(i, ctx))
        let acc = inputs[0]!
        for (let i = 1; i < inputs.length; i++) {
          const dst = this.reg()
          this.emit(op, dst, [acc, inputs[i]!])
          acc = dst
        }
        return acc
      }
      case 'lerp': {
        const [a, b, t] = [inp('a'), inp('b'), inp('t')]
        const dst = this.reg()
        this.emit(OP.LERP, dst, [a, b, t])
        return dst
      }
      case 'select': {
        const [a, b, c] = [inp('a'), inp('b'), inp('control')]
        const th = num('threshold')
        const fo = num('falloff')
        const dst = this.reg()
        this.emit(
          OP.SELECT,
          dst,
          [a, b, c],
          this.konst([th, fo, th - fo, fo > 0 ? 1 / (2 * fo) : 0]),
        )
        return dst
      }
      case 'remap': {
        const a = inp('input')
        const [f0, f1] = p.from as number[]
        const [t0, t1] = p.to as number[]
        const scale = f1 === f0 ? 0 : (t1! - t0!) / (f1! - f0!)
        const dst = this.reg()
        this.emit(
          OP.REMAP,
          dst,
          [a],
          this.konst([f0!, t0!, scale, Math.min(t0!, t1!), Math.max(t0!, t1!)]),
          p.clamp ? 1 : 0,
        )
        return dst
      }
      case 'clamp': {
        const a = inp('input')
        const dst = this.reg()
        this.emit(OP.CLAMP, dst, [a], this.konst([num('min'), num('max')]))
        return dst
      }
      case 'curve': {
        const a = inp('input')
        const pts = p.points as [number, number][]
        const values: number[] = []
        for (let i = 0; i + 1 < pts.length; i++) {
          const [x0, y0] = pts[i]!
          const [x1, y1] = pts[i + 1]!
          const fx0 = fround(x0)
          const fy0 = fround(y0)
          values.push(fx0, fy0, 1 / (fround(x1) - fx0), fround(y1) - fy0)
        }
        const dst = this.reg()
        this.emit(OP.CURVE, dst, [a], this.konst(values), pts.length)
        return dst
      }
      case 'terrace': {
        const a = inp('input')
        const [lo, hi] = p.range as number[]
        const steps = num('steps')
        const span = hi! - lo! || 1
        const dst = this.reg()
        this.emit(
          OP.TERRACE,
          dst,
          [a],
          this.konst([lo!, steps / span, 1 / Math.max(1 - num('sharpness'), 1e-4), span / steps]),
        )
        return dst
      }
      case 'abs': {
        const a = inp('input')
        const dst = this.reg()
        this.emit(OP.ABS, dst, [a])
        return dst
      }
      case 'power': {
        const a = inp('input')
        const dst = this.reg()
        this.emit(OP.POWER, dst, [a], this.konst([num('exponent')]))
        return dst
      }
      case 'constant':
        return this.constant(num('value'))
      case 'warp': {
        const by = p.by as GraphInput
        const channels: number[] = []
        for (let axis = 0; axis < this.graph.dimensions; axis++) {
          const salt = axis === 0 ? ctx.salt : hashSeed(ctx.salt, axis + 1) || 1
          channels.push(
            this.input(by, axis === 0 ? ctx : this.withCtx(ctx, ctx.s, ctx.t, ctx.disp, salt)),
          )
        }
        while (channels.length < 4) channels.push(-1)
        const disp = this.reg(4)
        this.emit(OP.WARP, disp, [ctx.disp, ...channels], this.konst([num('amount')]))
        return this.input(p.input as GraphInput, this.withCtx(ctx, ctx.s, ctx.t, disp, ctx.salt))
      }
      case 'scale': {
        const by = p.by as number[]
        const s = ctx.s.map((v, i) => v * by[i]!)
        const t = ctx.t.map((v, i) => v * by[i]!)
        let disp = ctx.disp
        if (disp >= 0) {
          const dst = this.reg(4)
          this.emit(OP.SCALE_DISP, dst, [disp], this.konst(by))
          disp = dst
        }
        return this.input(p.input as GraphInput, this.withCtx(ctx, s, t, disp, ctx.salt))
      }
      case 'translate': {
        const by = p.by as number[]
        const t = ctx.t.map((v, i) => v + by[i]!)
        return this.input(p.input as GraphInput, this.withCtx(ctx, ctx.s, t, ctx.disp, ctx.salt))
      }
    }
    throw new ShardError('noise/unknown-type', `No compiler for node type "${node.type}"`, {
      path: node.path,
    })
  }

  withCtx(_ctx: Ctx, s: readonly number[], t: readonly number[], disp: number, salt: number): Ctx {
    return { s, t, disp, salt, key: ctxKey(s, t, disp, salt) }
  }

  source(node: GraphNode, kind: string, fractal: number, ctx: Ctx): number {
    const p = node.params
    const dims = p.dims as number
    const octaves = fractal === FRACTAL.NONE ? 1 : (p.octaves as number)
    const freq = p.frequency as number
    const lacunarity = fractal === FRACTAL.NONE ? 1 : (p.lacunarity as number)
    const gain = fractal === FRACTAL.NONE ? 1 : (p.gain as number)
    const kindIndex = SOURCE_KINDS.indexOf(kind as never)
    const skew = kind === 'simplex' ? dims : SKEW.NONE
    const metric = CELL_DISTANCES.indexOf((p.distance ?? 'euclidean') as never)
    const ret = CELL_RETURNS.indexOf((p.return ?? 'f1') as never)

    let ampSum = 0
    const amps: number[] = []
    for (let o = 0; o < octaves; o++) {
      const amp = fround(gain ** o)
      amps.push(amp)
      ampSum += amp
    }
    const values = [(p.jitter as number | undefined) ?? 1, 1 / ampSum]
    const originBase = this.skew.length
    for (let o = 0; o < octaves; o++) {
      const f = freq * lacunarity ** o
      for (let axis = 0; axis < 4; axis++) {
        const a = axis < dims ? fround(f * ctx.s[axis]!) : 0
        values.push(a)
        this.a.push(a)
        this.b.push(axis < dims ? f * ctx.t[axis]! : 0)
      }
      values.push(f, amps[o]!)
      this.skew.push(skew)
      this.checkRange(node, dims, skew, originBase + o)
    }
    const dst = this.reg()
    this.emit(
      OP.SOURCE,
      dst,
      [ctx.disp, originBase, kindIndex, dims, fractal, metric | (ret << 4)],
      this.konst(values),
      octaves,
      (p.seed as number) >>> 0,
      ctx.salt,
    )
    return dst
  }

  /** With an extent, every lattice coordinate must fit an i32 at that distance. */
  checkRange(node: GraphNode, dims: number, skew: number, term: number): void {
    const extent = this.graph.extent
    if (extent === undefined) return
    let worst = 0
    for (let axis = 0; axis < dims; axis++) {
      worst = Math.max(
        worst,
        Math.abs(this.a[term * 4 + axis]!) * extent + Math.abs(this.b[term * 4 + axis]!),
      )
    }
    worst *= SKEW_GROWTH[skew]!
    if (worst >= I32_LIMIT) {
      const where =
        this.stack.length > 0 ? `/nodes/${pointer(this.stack[this.stack.length - 1]!)}` : node.path
      this.errors.push(
        new ShardError(
          'noise/frequency-too-high',
          `A frequency in "${node.type}" reaches lattice cell ${worst.toExponential(2)} at extent ${extent}, past what an i32 cell holds (2³¹)`,
          {
            path: node.path.startsWith('/nodes/') ? node.path : where,
            hint: 'Lower the frequency or octaves: features that fine are invisible anywhere they apply at this extent.',
          },
        ),
      )
    }
  }
}

/**
 * Compiles a parsed graph (or one of its nodes, for previews) into a program. Throws the first
 * error with the rest in `details`.
 */
export function compileGraph(graph: ParsedGraph, output = graph.output): NoiseProgram {
  if (!graph.nodes.has(output)) {
    throw new ShardError('noise/unknown-node', `"${output}" isn't a node in this graph`, {
      path: '/output',
      hint: `Nodes: ${[...graph.nodes.keys()].join(', ')}.`,
    })
  }
  const c = new Compiler(graph)
  const result = c.named(output, ROOT)
  if (c.errors.length > 0) {
    const first = c.errors[0]!
    throw new ShardError(first.code, first.message, {
      path: first.path,
      hint: first.hint,
      details: c.errors,
    })
  }
  const terms: OriginTerms = {
    a: new Float64Array(c.a),
    b: new Float64Array(c.b),
    skew: new Uint8Array(c.skew),
  }
  const zeroOrigins = new Int32Array(terms.skew.length * 8)
  computeOrigins(terms, ZERO, zeroOrigins)
  return {
    code: new Int32Array(c.code),
    consts: new Float32Array(c.consts),
    registers: c.registers,
    result,
    dimensions: graph.dimensions,
    terms,
    zeroOrigins,
    instructions: c.code.length / WIDTH,
  }
}

const ZERO = new Float64Array(4)
