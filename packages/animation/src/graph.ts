import {
  AssetStore,
  defineAssetSchema,
  defineAssetType,
  defineImporter,
  type ImportedAsset,
} from '@shard/assets'
import {
  type AssetRef,
  defineResource,
  defineSchema,
  findComponent,
  isPlainObject,
  type JsonValue,
  pointer,
  ShardError,
} from '@shard/core'
import { LOOP_MODES } from './components'

// --- the runtime asset -----------------------------------------------------------------------

export const PARAMETER_TYPES = ['float', 'bool', 'trigger'] as const
export type ParameterType = (typeof PARAMETER_TYPES)[number]

/** How a bound parameter reads its field: as is, a vector's length, or one component. */
export const BIND_OPS = ['value', 'length', 'horizontal', 'x', 'y', 'z', 'not'] as const
export type BindOp = (typeof BIND_OPS)[number]

export interface GraphParameter {
  name: string
  type: ParameterType
  /** Bools and triggers are 0 or 1. */
  default: number
  /** Read each frame from a component on the animator's entity or its nearest ancestor with it. */
  bind: { component: string; field: string; op: BindOp } | null
}

/** A clip in a state, at its place in the blend space (x, y). */
export interface GraphMotion {
  clip: AssetRef<'AnimationClip'>
  x: number
  y: number
}

export const STATE_KINDS = ['empty', 'clip', 'blend1d', 'blend2d'] as const
export type StateKind = (typeof STATE_KINDS)[number]

export interface GraphState {
  name: string
  kind: StateKind
  /** One for clip states; blend1d sorted by x. */
  motions: GraphMotion[]
  /** Blend space parameters (index into the graph's parameters), or -1. */
  x: number
  y: number
  loop: (typeof LOOP_MODES)[number]
  speed: number
  /** blend2d: Delaunay triangles, three motion indices each. */
  triangles: Int32Array
  /** blend2d: the hull (or the line, when the samples are collinear), two motion indices each. */
  edges: Int32Array
}

export interface GraphTransition {
  /** State index, or -1 for any state. */
  from: number
  to: number
  /** The compiled condition (empty: always). See `test`. */
  code: Float64Array
  /** Triggers the condition reads: consumed when this transition is taken. */
  triggers: Int32Array
  duration: number
  /** Normalized time of the source state this waits for, or NaN. */
  exitTime: number
  /** The condition as written. */
  when: string
}

export interface GraphLayer {
  name: string
  weight: number
  blend: 'override' | 'additive'
  mask: AssetRef<'AnimationMask'> | null
  entry: number
  states: GraphState[]
  transitions: GraphTransition[]
  /** The most motions any state has. */
  maxMotions: number
}

export interface AnimationGraphAsset {
  parameters: GraphParameter[]
  layers: GraphLayer[]
  /** Bumped by a reload, so animators restart on the new graph. */
  revision: number
}

export const AnimationGraphs = defineResource<AssetStore<AnimationGraphAsset, 'AnimationGraph'>>(
  'animation/AnimationGraphs',
  { description: 'Animation graphs by guid.', init: () => new AssetStore('AnimationGraph') },
)

// --- conditions ------------------------------------------------------------------------------

// Opcodes: a flat array evaluated on a small stack. PARAM and CONST take one operand.
export const OP = {
  PARAM: 1,
  CONST: 2,
  NOT: 3,
  AND: 4,
  OR: 5,
  LT: 6,
  LE: 7,
  GT: 8,
  GE: 9,
  EQ: 10,
  NE: 11,
} as const

const COMPARISONS: Record<string, number> = {
  '<': OP.LT,
  '<=': OP.LE,
  '>': OP.GT,
  '>=': OP.GE,
  '==': OP.EQ,
  '!=': OP.NE,
}

const MAX_STACK = 32

interface Token {
  kind: 'name' | 'number' | 'op' | 'end'
  text: string
  /** 1-based column. */
  column: number
}

function tokenize(src: string, fail: (msg: string, column: number) => never): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    const start = i
    if (/[A-Za-z_]/.test(ch)) {
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i]!)) i++
      out.push({ kind: 'name', text: src.slice(start, i), column: start + 1 })
      continue
    }
    if (/[0-9.]/.test(ch)) {
      while (i < src.length && /[0-9.eE]/.test(src[i]!)) i++
      const text = src.slice(start, i)
      if (!Number.isFinite(Number(text))) fail(`"${text}" isn't a number`, start + 1)
      out.push({ kind: 'number', text, column: start + 1 })
      continue
    }
    const two = src.slice(i, i + 2)
    if (['&&', '||', '<=', '>=', '==', '!='].includes(two)) {
      out.push({ kind: 'op', text: two, column: start + 1 })
      i += 2
      continue
    }
    if ('!<>()-'.includes(ch)) {
      out.push({ kind: 'op', text: ch, column: start + 1 })
      i++
      continue
    }
    const hint =
      ch === '&'
        ? ' (and is "&&")'
        : ch === '|'
          ? ' (or is "||")'
          : ch === '='
            ? ' (equals is "==")'
            : ''
    fail(`unexpected "${ch}"${hint}`, start + 1)
  }
  out.push({ kind: 'end', text: '', column: src.length + 1 })
  return out
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, k) => k)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = next
    }
  }
  return row[b.length]!
}

function suggest(name: string, names: readonly string[]): string | undefined {
  let best: string | undefined
  let bestD = Math.max(2, Math.floor(name.length / 3)) + 1
  for (const n of names) {
    const d = distance(name.toLowerCase(), n.toLowerCase())
    if (d < bestD) {
      best = n
      bestD = d
    }
  }
  return best
}

export interface CompiledCondition {
  code: number[]
  /** Parameter indices of the triggers it reads. */
  triggers: number[]
}

/**
 * Compiles a condition: parameter names, numbers, `true`/`false`, `!`, `&&`, `||`, comparisons
 * (`<`, `<=`, `>`, `>=`, `==`, `!=`), and parentheses. Throws `animgraph/bad-condition` (or
 * `animgraph/unknown-parameter`) naming the column. `path` is the condition's JSON pointer.
 */
export function compileCondition(
  src: string,
  parameters: readonly Pick<GraphParameter, 'name' | 'type'>[],
  path = '',
): CompiledCondition {
  const where = (column: number) => `Condition "${src}", column ${column}`
  const fail = (msg: string, column: number): never => {
    throw new ShardError('animgraph/bad-condition', `${where(column)}: ${msg}`, {
      path,
      hint: 'Conditions use parameter names, numbers, !, &&, ||, and comparisons: "grounded && speed > 0.1".',
    })
  }
  const tokens = tokenize(src, fail)
  const code: number[] = []
  const triggers: number[] = []
  let depth = 0
  let maxDepth = 0
  const push = () => {
    depth++
    if (depth > maxDepth) maxDepth = depth
  }
  let at = 0
  const peek = () => tokens[at]!
  const next = () => tokens[at++]!
  const describe = (t: Token) => (t.kind === 'end' ? 'the end' : `"${t.text}"`)

  const primary = (): void => {
    const t = next()
    if (t.kind === 'op' && t.text === '(') {
      or()
      const close = next()
      if (close.text !== ')') fail(`expected ")", got ${describe(close)}`, close.column)
      return
    }
    if (t.kind === 'op' && t.text === '-' && peek().kind === 'number') {
      code.push(OP.CONST, -Number(next().text))
      push()
      return
    }
    if (t.kind === 'number') {
      code.push(OP.CONST, Number(t.text))
      push()
      return
    }
    if (t.kind === 'name') {
      if (t.text === 'true' || t.text === 'false') {
        code.push(OP.CONST, t.text === 'true' ? 1 : 0)
        push()
        return
      }
      const index = parameters.findIndex((p) => p.name === t.text)
      if (index < 0) {
        const names = parameters.map((p) => p.name)
        const guess = suggest(t.text, names)
        throw new ShardError(
          'animgraph/unknown-parameter',
          `${where(t.column)}: no parameter "${t.text}"`,
          {
            path,
            hint: guess
              ? `Did you mean "${guess}"?`
              : names.length
                ? `Parameters: ${names.join(', ')}.`
                : 'Declare it under "parameters".',
          },
        )
      }
      if (parameters[index]!.type === 'trigger' && !triggers.includes(index)) triggers.push(index)
      code.push(OP.PARAM, index)
      push()
      return
    }
    fail(`expected a parameter or a number, got ${describe(t)}`, t.column)
  }
  const comparison = (): void => {
    primary()
    const op = COMPARISONS[peek().text]
    if (op !== undefined && peek().kind === 'op') {
      next()
      primary()
      code.push(op)
      depth--
    }
  }
  const unary = (): void => {
    const t = peek()
    if (t.kind === 'op' && t.text === '!') {
      next()
      unary()
      code.push(OP.NOT)
      return
    }
    comparison()
  }
  const and = (): void => {
    unary()
    while (peek().text === '&&') {
      next()
      unary()
      code.push(OP.AND)
      depth--
    }
  }
  const or = (): void => {
    and()
    while (peek().text === '||') {
      next()
      and()
      code.push(OP.OR)
      depth--
    }
  }
  if (peek().kind === 'end') fail('empty condition', 1)
  or()
  const rest = peek()
  if (rest.kind !== 'end') fail(`unexpected ${describe(rest)}`, rest.column)
  if (maxDepth > MAX_STACK) fail('too deeply nested', 1)
  return { code, triggers }
}

const stack = new Float64Array(MAX_STACK)

/** Evaluates compiled condition code against parameter values. Allocation-free. */
export function test(code: Float64Array, values: Float64Array): boolean {
  const n = code.length
  if (n === 0) return true
  const s = stack
  let sp = 0
  let i = 0
  while (i < n) {
    const op = code[i++]!
    if (op === OP.PARAM) {
      s[sp++] = values[code[i++]!]!
    } else if (op === OP.CONST) {
      s[sp++] = code[i++]!
    } else if (op === OP.NOT) {
      s[sp - 1] = s[sp - 1] === 0 ? 1 : 0
    } else {
      const b = s[--sp]!
      const a = s[sp - 1]!
      let r = false
      if (op === OP.AND) r = a !== 0 && b !== 0
      else if (op === OP.OR) r = a !== 0 || b !== 0
      else if (op === OP.LT) r = a < b
      else if (op === OP.LE) r = a <= b
      else if (op === OP.GT) r = a > b
      else if (op === OP.GE) r = a >= b
      else if (op === OP.EQ) r = a === b
      else r = a !== b
      s[sp - 1] = r ? 1 : 0
    }
  }
  return s[0] !== 0
}

// --- blend space triangulation ---------------------------------------------------------------

/**
 * Delaunay triangles of 2D points (Bowyer–Watson; blend spaces have a handful of samples), as
 * index triples, counter-clockwise. Collinear points give none.
 */
export function triangulate(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length
  if (n < 3) return []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]!)
    minY = Math.min(minY, ys[i]!)
    maxX = Math.max(maxX, xs[i]!)
    maxY = Math.max(maxY, ys[i]!)
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  // A super triangle holding every point: vertices n, n+1, n+2.
  const px = [...xs, cx - 20 * span, cx, cx + 20 * span]
  const py = [...ys, cy - span, cy + 20 * span, cy - span]
  const area = (a: number, b: number, c: number) =>
    (px[b]! - px[a]!) * (py[c]! - py[a]!) - (px[c]! - px[a]!) * (py[b]! - py[a]!)
  const ccw = (t: number[]): number[] => (area(t[0]!, t[1]!, t[2]!) < 0 ? [t[0]!, t[2]!, t[1]!] : t)
  let tris: number[][] = [ccw([n, n + 1, n + 2])]
  const inCircle = (t: number[], p: number): boolean => {
    const [a, b, c] = t as [number, number, number]
    const ax = px[a]! - px[p]!
    const ay = py[a]! - py[p]!
    const bx = px[b]! - px[p]!
    const by = py[b]! - py[p]!
    const qx = px[c]! - px[p]!
    const qy = py[c]! - py[p]!
    const det =
      (ax * ax + ay * ay) * (bx * qy - qx * by) -
      (bx * bx + by * by) * (ax * qy - qx * ay) +
      (qx * qx + qy * qy) * (ax * by - bx * ay)
    return det > 1e-12 * span ** 4
  }
  for (let p = 0; p < n; p++) {
    const bad = tris.filter((t) => inCircle(t, p))
    const edges: [number, number][] = []
    for (const t of bad) {
      for (let k = 0; k < 3; k++) {
        const a = t[k]!
        const b = t[(k + 1) % 3]!
        const shared = bad.some((o) => o !== t && o.includes(a) && o.includes(b))
        if (!shared) edges.push([a, b])
      }
    }
    tris = tris.filter((t) => !bad.includes(t))
    for (const [a, b] of edges) tris.push(ccw([a, b, p]))
  }
  const eps = 1e-9 * span * span
  return tris
    .filter((t) => t.every((v) => v < n) && Math.abs(area(t[0]!, t[1]!, t[2]!)) > eps)
    .flat()
}

/** The hull edges of a triangulation, or (no triangles) consecutive points along their line. */
function blendEdges(xs: readonly number[], ys: readonly number[], triangles: number[]): number[] {
  if (triangles.length > 0) {
    const count = new Map<string, [number, number, number]>()
    for (let t = 0; t < triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = triangles[t + k]!
        const b = triangles[t + ((k + 1) % 3)]!
        const key = a < b ? `${a},${b}` : `${b},${a}`
        const e = count.get(key)
        if (e) e[2]++
        else count.set(key, [a, b, 1])
      }
    }
    return [...count.values()].filter((e) => e[2] === 1).flatMap((e) => e.slice(0, 2))
  }
  if (xs.length < 2) return []
  // Collinear: along the direction from the first point to the farthest one.
  let far = 0
  let farD = -1
  for (let i = 1; i < xs.length; i++) {
    const d = (xs[i]! - xs[0]!) ** 2 + (ys[i]! - ys[0]!) ** 2
    if (d > farD) {
      farD = d
      far = i
    }
  }
  const dx = xs[far]! - xs[0]!
  const dy = ys[far]! - ys[0]!
  const order = xs
    .map((_, i) => i)
    .sort((a, b) => xs[a]! * dx + ys[a]! * dy - (xs[b]! * dx + ys[b]! * dy))
  const out: number[] = []
  for (let k = 0; k + 1 < order.length; k++) out.push(order[k]!, order[k + 1]!)
  return out
}

// --- the file format -------------------------------------------------------------------------

/** A graph as imported: validated, names resolved to indices, conditions compiled. */
export interface GraphArtifact {
  parameters: GraphParameter[]
  layers: {
    name: string
    weight: number
    blend: 'override' | 'additive'
    mask: string | null
    entry: number
    states: {
      name: string
      kind: StateKind
      motions: { clip: string; x: number; y: number }[]
      x: number
      y: number
      loop: (typeof LOOP_MODES)[number]
      speed: number
      triangles: number[]
      edges: number[]
    }[]
    transitions: {
      from: number
      to: number
      code: number[]
      triggers: number[]
      duration: number
      exitTime: number | null
      when: string
    }[]
  }[]
}

export interface ParsedGraph {
  graph: GraphArtifact
  errors: ShardError[]
  /** Unreachable states and other non-fatal problems. */
  warnings: ShardError[]
  /** Clip and mask paths the graph uses. */
  dependencies: string[]
}

const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k)

/**
 * Validates and compiles a graph file (the JSON of a `*.animgraph.json`). Every problem is
 * reported, each with a JSON pointer: unknown states, clips, and parameters, conditions that don't
 * parse (with the column), and unreachable states (warnings). Clips are `"#name"` (from the file's
 * `clips` table) or `{ "path": ... }`.
 */
export function parseAnimationGraph(json: unknown): ParsedGraph {
  const errors: ShardError[] = []
  const warnings: ShardError[] = []
  const dependencies = new Set<string>()
  const graph: GraphArtifact = { parameters: [], layers: [] }
  const add = (e: ShardError) => {
    errors.push(e)
  }
  const err = (code: string, message: string, path: string, hint?: string) => {
    errors.push(new ShardError(code, message, hint ? { path, hint } : { path }))
  }
  const typeErr = (path: string, what: string, got: unknown) =>
    err(
      'schema/type-mismatch',
      `Expected ${what} at ${path || '/'}, got ${JSON.stringify(got)}`,
      path,
    )
  if (!isPlainObject(json)) {
    typeErr('', 'an object', json)
    return { graph, errors, warnings, dependencies: [] }
  }
  for (const key of Object.keys(json)) {
    if (!['$schema', 'parameters', 'layers', 'clips'].includes(key)) {
      err(
        'schema/unknown-field',
        `Unknown field "${key}"`,
        pointer('', key),
        'A graph has parameters, layers, and clips.',
      )
    }
  }

  // Clips table.
  const clips = new Map<string, string>()
  if (has(json, 'clips')) {
    if (!isPlainObject(json.clips)) typeErr('/clips', 'an object of { "path": ... }', json.clips)
    else {
      for (const [name, ref] of Object.entries(json.clips)) {
        const at = pointer('/clips', name)
        if (!isPlainObject(ref) || typeof ref.path !== 'string' || ref.path === '')
          typeErr(at, '{ "path": "assets/model.glb#Animation/Name" }', ref)
        else clips.set(name, ref.path)
      }
    }
  }
  const clipPath = (value: unknown, at: string): string | undefined => {
    if (typeof value === 'string' && value.startsWith('#')) {
      const path = clips.get(value.slice(1))
      if (path === undefined) {
        const guess = suggest(value.slice(1), [...clips.keys()])
        add(
          new ShardError(
            'animgraph/unknown-clip',
            `No clip "${value.slice(1)}" in the graph's "clips" table`,
            {
              path: at,
              hint: guess
                ? `Did you mean "#${guess}"?`
                : 'Add it under "clips": { "name": { "path": ... } }.',
            },
          ),
        )
        return undefined
      }
      dependencies.add(path)
      return path
    }
    if (isPlainObject(value) && typeof value.path === 'string' && value.path !== '') {
      dependencies.add(value.path)
      return value.path
    }
    typeErr(at, 'a clip: "#name" or { "path": ... }', value)
    return undefined
  }

  // Parameters.
  const params = graph.parameters
  if (has(json, 'parameters')) {
    if (!isPlainObject(json.parameters)) typeErr('/parameters', 'an object', json.parameters)
    else {
      for (const [name, def] of Object.entries(json.parameters)) {
        const at = pointer('/parameters', name)
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
          add(
            new ShardError('animgraph/bad-parameter', `"${name}" can't be used in conditions`, {
              path: at,
              hint: 'Use letters, digits, _ and ., starting with a letter.',
            }),
          )
          continue
        }
        if (['true', 'false'].includes(name)) {
          add(new ShardError('animgraph/bad-parameter', `"${name}" is a keyword`, { path: at }))
          continue
        }
        if (!isPlainObject(def)) {
          typeErr(at, '{ "type": "float" | "bool" | "trigger" }', def)
          continue
        }
        const type = def.type as ParameterType
        if (!PARAMETER_TYPES.includes(type)) {
          typeErr(`${at}/type`, 'one of "float", "bool", "trigger"', def.type)
          continue
        }
        let value = 0
        if (has(def, 'default')) {
          const d = def.default
          if (type === 'float' ? typeof d !== 'number' : typeof d !== 'boolean')
            typeErr(`${at}/default`, type === 'float' ? 'a number' : 'a boolean', d)
          else value = typeof d === 'boolean' ? (d ? 1 : 0) : (d as number)
        }
        let bind: GraphParameter['bind'] = null
        if (has(def, 'bind')) {
          const b = def.bind
          if (type === 'trigger')
            add(
              new ShardError('animgraph/bad-parameter', "A trigger can't be bound", {
                path: `${at}/bind`,
                hint: 'Bind a float or bool; triggers are set with setAnimParam.',
              }),
            )
          else if (
            !isPlainObject(b) ||
            typeof b.component !== 'string' ||
            typeof b.field !== 'string'
          )
            typeErr(`${at}/bind`, '{ "component": ..., "field": ..., "op"?: ... }', b)
          else {
            const op = (b.op ?? 'value') as BindOp
            if (!BIND_OPS.includes(op))
              typeErr(`${at}/bind/op`, `one of ${BIND_OPS.join(', ')}`, b.op)
            else bind = { component: b.component, field: b.field, op }
          }
        }
        for (const key of Object.keys(def)) {
          if (!['type', 'default', 'bind'].includes(key))
            err('schema/unknown-field', `Unknown field "${key}"`, pointer(at, key))
        }
        params.push({ name, type, default: value, bind })
      }
    }
  }
  const paramIndex = (value: unknown, at: string, wantFloat: boolean): number => {
    if (typeof value !== 'string') {
      typeErr(at, 'a parameter name', value)
      return -1
    }
    const i = params.findIndex((p) => p.name === value)
    if (i < 0) {
      const guess = suggest(
        value,
        params.map((p) => p.name),
      )
      add(
        new ShardError('animgraph/unknown-parameter', `No parameter "${value}"`, {
          path: at,
          hint: guess ? `Did you mean "${guess}"?` : 'Declare it under "parameters".',
        }),
      )
      return -1
    }
    if (wantFloat && params[i]!.type !== 'float')
      err(
        'schema/type-mismatch',
        `Blend spaces need a float parameter; "${value}" is a ${params[i]!.type}`,
        at,
      )
    return i
  }

  // Layers.
  if (!Array.isArray(json.layers) || json.layers.length === 0) {
    typeErr('/layers', 'a list of at least one layer', json.layers)
    return { graph, errors, warnings, dependencies: [...dependencies] }
  }
  const layerNames = new Set<string>()
  json.layers.forEach((layerJson, li) => {
    const at = `/layers/${li}`
    if (!isPlainObject(layerJson)) {
      typeErr(at, 'a layer object', layerJson)
      return
    }
    for (const key of Object.keys(layerJson)) {
      if (!['name', 'entry', 'weight', 'blend', 'mask', 'states', 'transitions'].includes(key))
        err('schema/unknown-field', `Unknown field "${key}"`, pointer(at, key))
    }
    const name =
      typeof layerJson.name === 'string' && layerJson.name ? layerJson.name : `layer${li}`
    if (layerNames.has(name))
      add(
        new ShardError('animgraph/duplicate-layer', `Two layers are named "${name}"`, {
          path: `${at}/name`,
        }),
      )
    layerNames.add(name)
    const weight = layerJson.weight ?? 1
    if (typeof weight !== 'number' || weight < 0 || weight > 1)
      typeErr(`${at}/weight`, 'a number from 0 to 1', weight)
    const blend = layerJson.blend ?? 'override'
    if (blend !== 'override' && blend !== 'additive')
      typeErr(`${at}/blend`, '"override" or "additive"', blend)
    let mask: string | null = null
    if (layerJson.mask !== undefined && layerJson.mask !== null) {
      const m = layerJson.mask
      if (!isPlainObject(m) || typeof m.path !== 'string' || m.path === '')
        typeErr(`${at}/mask`, '{ "path": "data/masks/upper-body.mask.json" }', m)
      else {
        mask = m.path
        dependencies.add(m.path)
      }
    }
    const states: GraphArtifact['layers'][number]['states'] = []
    if (!isPlainObject(layerJson.states) || Object.keys(layerJson.states).length === 0) {
      typeErr(`${at}/states`, 'an object of states', layerJson.states)
    } else {
      for (const [stateName, s] of Object.entries(layerJson.states)) {
        const sat = pointer(`${at}/states`, stateName)
        if (!isPlainObject(s)) {
          typeErr(sat, 'a state: {}, { "clip" }, { "blend1d" }, or { "blend2d" }', s)
          continue
        }
        const kinds = ['clip', 'blend1d', 'blend2d'].filter((k) => has(s, k))
        if (kinds.length > 1)
          add(
            new ShardError(
              'animgraph/bad-state',
              `A state plays one of clip, blend1d, blend2d (this has ${kinds.join(' and ')})`,
              { path: sat },
            ),
          )
        for (const key of Object.keys(s)) {
          if (!['clip', 'blend1d', 'blend2d', 'loop', 'speed'].includes(key))
            err('schema/unknown-field', `Unknown field "${key}"`, pointer(sat, key))
        }
        const loop = s.loop ?? 'loop'
        if (!LOOP_MODES.includes(loop as never))
          typeErr(`${sat}/loop`, `one of ${LOOP_MODES.join(', ')}`, loop)
        const speed = s.speed ?? 1
        if (typeof speed !== 'number') typeErr(`${sat}/speed`, 'a number', speed)
        const state: (typeof states)[number] = {
          name: stateName,
          kind: 'empty',
          motions: [],
          x: -1,
          y: -1,
          loop: loop as (typeof LOOP_MODES)[number],
          speed: speed as number,
          triangles: [],
          edges: [],
        }
        if (has(s, 'clip')) {
          state.kind = 'clip'
          const clip = clipPath(s.clip, `${sat}/clip`)
          if (clip) state.motions.push({ clip, x: 0, y: 0 })
        } else if (has(s, 'blend1d')) {
          state.kind = 'blend1d'
          const b = s.blend1d
          const bat = `${sat}/blend1d`
          if (!isPlainObject(b))
            typeErr(bat, '{ "parameter", "clips": [[threshold, clip], ...] }', b)
          else {
            state.x = paramIndex(b.parameter, `${bat}/parameter`, true)
            if (!Array.isArray(b.clips) || b.clips.length === 0)
              typeErr(`${bat}/clips`, 'a list of [threshold, clip]', b.clips)
            else {
              b.clips.forEach((entry, k) => {
                const eat = `${bat}/clips/${k}`
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'number') {
                  typeErr(eat, '[threshold, clip]', entry)
                  return
                }
                const clip = clipPath(entry[1], `${eat}/1`)
                if (clip) state.motions.push({ clip, x: entry[0], y: 0 })
              })
              state.motions.sort((a, b2) => a.x - b2.x)
              for (let k = 1; k < state.motions.length; k++) {
                if (state.motions[k]!.x === state.motions[k - 1]!.x)
                  add(
                    new ShardError(
                      'animgraph/bad-blend',
                      `Two clips at threshold ${state.motions[k]!.x}`,
                      { path: `${bat}/clips`, hint: 'Give each clip its own threshold.' },
                    ),
                  )
              }
            }
          }
        } else if (has(s, 'blend2d')) {
          state.kind = 'blend2d'
          const b = s.blend2d
          const bat = `${sat}/blend2d`
          if (!isPlainObject(b)) typeErr(bat, '{ "x", "y", "clips": [[x, y, clip], ...] }', b)
          else {
            state.x = paramIndex(b.x, `${bat}/x`, true)
            state.y = paramIndex(b.y, `${bat}/y`, true)
            if (!Array.isArray(b.clips) || b.clips.length === 0)
              typeErr(`${bat}/clips`, 'a list of [x, y, clip]', b.clips)
            else {
              b.clips.forEach((entry, k) => {
                const eat = `${bat}/clips/${k}`
                if (
                  !Array.isArray(entry) ||
                  entry.length !== 3 ||
                  typeof entry[0] !== 'number' ||
                  typeof entry[1] !== 'number'
                ) {
                  typeErr(eat, '[x, y, clip]', entry)
                  return
                }
                const clip = clipPath(entry[2], `${eat}/2`)
                if (clip) state.motions.push({ clip, x: entry[0], y: entry[1] })
              })
              const m = state.motions
              for (let a = 0; a < m.length; a++)
                for (let c = a + 1; c < m.length; c++)
                  if (m[a]!.x === m[c]!.x && m[a]!.y === m[c]!.y)
                    add(
                      new ShardError(
                        'animgraph/bad-blend',
                        `Two clips at (${m[a]!.x}, ${m[a]!.y})`,
                        { path: `${bat}/clips`, hint: 'Give each clip its own point.' },
                      ),
                    )
              const xs = m.map((p) => p.x)
              const ys = m.map((p) => p.y)
              state.triangles = triangulate(xs, ys)
              state.edges = blendEdges(xs, ys, state.triangles)
            }
          }
        }
        states.push(state)
      }
    }
    const stateIndex = (value: unknown, path: string, any: boolean): number => {
      if (any && value === '*') return -1
      if (typeof value !== 'string') {
        typeErr(path, 'a state name', value)
        return -2
      }
      const i = states.findIndex((s) => s.name === value)
      if (i < 0) {
        const guess = suggest(
          value,
          states.map((s) => s.name),
        )
        add(
          new ShardError('animgraph/unknown-state', `No state "${value}" in layer "${name}"`, {
            path: path,
            hint: guess
              ? `Did you mean "${guess}"?`
              : `States: ${states.map((s) => s.name).join(', ')}.`,
          }),
        )
        return -2
      }
      return i
    }
    const entry = states.length
      ? stateIndex(layerJson.entry ?? states[0]!.name, `${at}/entry`, false)
      : -2
    const transitions: GraphArtifact['layers'][number]['transitions'] = []
    const tj = layerJson.transitions ?? []
    if (!Array.isArray(tj)) typeErr(`${at}/transitions`, 'a list of transitions', tj)
    else {
      tj.forEach((t, ti) => {
        const tat = `${at}/transitions/${ti}`
        if (!isPlainObject(t)) {
          typeErr(tat, '{ "from", "to", "when"?, "duration"?, "exitTime"? }', t)
          return
        }
        for (const key of Object.keys(t)) {
          if (!['from', 'to', 'when', 'duration', 'exitTime'].includes(key))
            err('schema/unknown-field', `Unknown field "${key}"`, pointer(tat, key))
        }
        const from = stateIndex(t.from, `${tat}/from`, true)
        const to = stateIndex(t.to, `${tat}/to`, false)
        const duration = t.duration ?? 0
        if (typeof duration !== 'number' || duration < 0)
          typeErr(`${tat}/duration`, 'seconds (≥ 0)', duration)
        const exitTime = t.exitTime ?? null
        if (exitTime !== null && (typeof exitTime !== 'number' || exitTime < 0))
          typeErr(`${tat}/exitTime`, 'a normalized time (≥ 0)', exitTime)
        let compiled: CompiledCondition = { code: [], triggers: [] }
        const when = t.when ?? ''
        if (typeof when !== 'string') typeErr(`${tat}/when`, 'a condition string', when)
        else if (when.trim() !== '') {
          try {
            compiled = compileCondition(when, params, `${tat}/when`)
          } catch (e) {
            if (e instanceof ShardError) errors.push(e)
            else throw e
          }
        }
        if (when === '' && exitTime === null && t.when === undefined)
          add(
            new ShardError(
              'animgraph/bad-transition',
              'A transition needs "when", "exitTime", or both',
              { path: tat, hint: 'Without either it would fire every frame.' },
            ),
          )
        transitions.push({
          from,
          to,
          code: compiled.code,
          triggers: compiled.triggers,
          duration: duration as number,
          exitTime: exitTime as number | null,
          when: typeof when === 'string' ? when : '',
        })
      })
    }
    // Reachability from the entry state.
    if (entry >= 0) {
      const seen = new Set([entry])
      const queue = [entry]
      for (const t of transitions) if (t.from === -1 && t.to >= 0) seen.add(t.to)
      queue.push(...seen)
      while (queue.length) {
        const s = queue.pop()!
        for (const t of transitions) {
          if (t.from === s && t.to >= 0 && !seen.has(t.to)) {
            seen.add(t.to)
            queue.push(t.to)
          }
        }
      }
      for (const s of states) {
        if (!seen.has(states.indexOf(s))) {
          warnings.push(
            new ShardError(
              'animgraph/unreachable-state',
              `State "${s.name}" in layer "${name}" can't be reached from "${states[entry]!.name}"`,
              {
                path: pointer(`${at}/states`, s.name),
                hint: 'Add a transition into it, or remove it.',
              },
            ),
          )
        }
      }
    }
    graph.layers.push({
      name,
      weight: typeof weight === 'number' ? weight : 1,
      blend: blend === 'additive' ? 'additive' : 'override',
      mask,
      entry,
      states,
      transitions: transitions.filter((t) => t.from >= -1 && t.to >= 0),
    })
  })
  return { graph, errors, warnings, dependencies: [...dependencies] }
}

/**
 * Checks what import can't: that bound components and fields exist and are numbers. Needs the
 * project's components defined (shard validate runs it after loading scripts).
 */
export function checkGraphBindings(graph: GraphArtifact): ShardError[] {
  const out: ShardError[] = []
  graph.parameters.forEach((p) => {
    if (!p.bind) return
    const at = `${pointer('/parameters', p.name)}/bind`
    const def = findComponent(p.bind.component)
    if (!def) {
      out.push(
        new ShardError('animgraph/unknown-component', `No component "${p.bind.component}"`, {
          path: `${at}/component`,
        }),
      )
      return
    }
    const layout = def.layout.find((l) => l.name === p.bind!.field)
    if (!layout) {
      out.push(
        new ShardError(
          'animgraph/unknown-field',
          `${p.bind.component} has no field "${p.bind.field}"`,
          {
            path: `${at}/field`,
            hint: `Fields: ${def.layout.map((l) => l.name).join(', ')}.`,
          },
        ),
      )
    } else if (!numericStorage.has(layout.storage)) {
      out.push(
        new ShardError(
          'animgraph/unknown-field',
          `${p.bind.component}.${p.bind.field} isn't a number, bool, or vector`,
          {
            path: `${at}/field`,
          },
        ),
      )
    }
  })
  return out
}

export const numericStorage = new Set(['f32', 'f64', 'i8', 'i16', 'i32', 'u8', 'u16', 'u32'])

// --- asset type and importer -----------------------------------------------------------------

function toAsset(
  a: GraphArtifact,
  resolve: (path: string) => AssetRef | undefined,
): AnimationGraphAsset {
  const ref = <T extends string>(type: T, path: string): AssetRef<T> => {
    const r = resolve(path)
    return { type, guid: r?.guid, path: r?.path ?? path } as AssetRef<T>
  }
  return {
    revision: 0,
    parameters: a.parameters.map((p) => ({ ...p, bind: p.bind && { ...p.bind } })),
    layers: a.layers.map((l) => ({
      name: l.name,
      weight: l.weight,
      blend: l.blend,
      mask: l.mask === null ? null : ref('AnimationMask', l.mask),
      entry: l.entry,
      maxMotions: Math.max(1, ...l.states.map((s) => s.motions.length)),
      states: l.states.map((s) => ({
        name: s.name,
        kind: s.kind,
        motions: s.motions.map((m) => ({ clip: ref('AnimationClip', m.clip), x: m.x, y: m.y })),
        x: s.x,
        y: s.y,
        loop: s.loop,
        speed: s.speed,
        triangles: Int32Array.from(s.triangles),
        edges: Int32Array.from(s.edges),
      })),
      transitions: l.transitions.map((t) => ({
        from: t.from,
        to: t.to,
        code: Float64Array.from(t.code),
        triggers: Int32Array.from(t.triggers),
        duration: t.duration,
        exitTime: t.exitTime ?? Number.NaN,
        when: t.when,
      })),
    })),
  }
}

function failWith(source: string, errors: ShardError[]): never {
  const first = errors[0]!
  throw new ShardError(
    first.code,
    `${source}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
    { path: first.path, hint: first.hint, details: errors },
  )
}

/**
 * A graph made in code (tests, tools): the same JSON as a `*.animgraph.json`. Clips and masks are
 * `{ "path" }` or `{ "guid" }` refs (store refs from `add` work). Throws the first problem.
 */
export function createAnimationGraph(json: unknown): AnimationGraphAsset {
  const refs = new Map<string, AssetRef>()
  // Refs with a guid (runtime assets) stand in as their path while parsing.
  const swap = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(swap)
    if (!isPlainObject(v)) return v
    if (
      typeof v.guid === 'string' &&
      Object.keys(v).every((k) => ['guid', 'path', 'type'].includes(k))
    ) {
      const key = `ref:${v.guid}`
      refs.set(key, v as unknown as AssetRef)
      return { path: key }
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]))
  }
  const parsed = parseAnimationGraph(swap(json))
  if (parsed.errors.length) failWith('graph', parsed.errors)
  return toAsset(parsed.graph, (path) => refs.get(path) ?? ({ guid: undefined, path } as AssetRef))
}

export const AnimationGraphAssetType = defineAssetType<AnimationGraphAsset>('AnimationGraph', {
  store: AnimationGraphs,
  load: (artifact, ctx) =>
    toAsset(artifact.json as unknown as GraphArtifact, (p) => ctx.resolve(p)),
  // Animators holding the graph restart on it (revision changed).
  update: (existing, next) => {
    const revision = existing.revision + 1
    Object.assign(existing, next)
    existing.revision = revision
  },
})

const GraphSettings = defineSchema(
  'animation/GraphImportSettings',
  {},
  {
    description: 'Animation graphs have no import settings.',
  },
)

const decoder = new TextDecoder()

/** `*.animgraph.json`: animation state machines, imported as AnimationGraph. */
export const GraphImporter = defineImporter({
  name: 'animation-graph',
  version: 1,
  extensions: ['.animgraph.json'],
  settings: GraphSettings,
  async import(source, ctx) {
    let json: unknown
    try {
      json = JSON.parse(decoder.decode(source.bytes))
    } catch (cause) {
      throw new ShardError('animgraph/invalid-json', `${source.path} isn't valid JSON`, {
        path: '',
        cause,
      })
    }
    const parsed = parseAnimationGraph(json)
    if (parsed.errors.length) failWith(source.path, parsed.errors)
    for (const w of parsed.warnings) ctx.warn(`[${w.code}] ${w.message}`, w.path)
    const asset: ImportedAsset = {
      label: '',
      type: 'AnimationGraph',
      json: parsed.graph as unknown as JsonValue,
      ...(parsed.dependencies.length ? { dependencies: parsed.dependencies } : {}),
      info: {
        parameters: parsed.graph.parameters.map(
          (p) => `${p.name}: ${p.type}${p.bind ? ` ← ${p.bind.component}.${p.bind.field}` : ''}`,
        ),
        layers: parsed.graph.layers.map((l) => ({
          name: l.name,
          states: l.states.map((s) => s.name),
          transitions: l.transitions.length,
        })),
      },
    }
    return { assets: [asset] }
  },
  check(json, resolveAsset) {
    const graph = json as unknown as GraphArtifact
    const out = checkGraphBindings(graph)
    // What's at a path: '' when it's an asset of the type, else the problem.
    const problem = (path: string, type: string): string => {
      const found = resolveAsset({ path, guid: undefined })
      if (!found) return `No asset at "${path}"`
      return found.type === type ? '' : `"${path}" is a ${found.type}, not an ${type}`
    }
    graph.layers.forEach((l, li) => {
      const maskProblem = l.mask ? problem(l.mask, 'AnimationMask') : ''
      if (maskProblem)
        out.push(
          new ShardError('animgraph/unknown-mask', maskProblem, {
            path: `/layers/${li}/mask`,
            hint: 'Masks are *.mask.json files; check the path.',
          }),
        )
      for (const s of l.states) {
        for (const m of s.motions) {
          const clipProblem = problem(m.clip, 'AnimationClip')
          if (clipProblem)
            out.push(
              new ShardError('animgraph/unknown-clip', clipProblem, {
                path: pointer(`/layers/${li}/states`, s.name),
                hint: 'glTF clips are "assets/model.glb#Animation/Name"; get_asset on the model lists them.',
              }),
            )
        }
      }
    })
    return out
  },
})

const clipSchema = {
  description: '"#name" from the clips table, or { "path": "assets/hero.glb#Animation/Idle" }.',
  oneOf: [
    { type: 'string', pattern: '^#' },
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  ],
}
const loopSchema = { enum: [...LOOP_MODES], description: 'loop (default), once, or ping-pong.' }
const speedSchema = { type: 'number', description: 'Playback rate. Default 1.' }

defineAssetSchema('animgraph.schema.json', () => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Animation graph (*.animgraph.json)',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    parameters: {
      type: 'object',
      description: 'Inputs conditions and blend spaces read, by name.',
      additionalProperties: {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: {
            enum: [...PARAMETER_TYPES],
            description: 'trigger: true until a transition takes it.',
          },
          default: { type: ['number', 'boolean'] },
          bind: {
            type: 'object',
            description:
              "Read each frame from a component on the animator's entity (or its nearest ancestor with it).",
            required: ['component', 'field'],
            additionalProperties: false,
            properties: {
              component: { type: 'string', description: 'e.g. "physics/CharacterState".' },
              field: { type: 'string', description: 'e.g. "velocity", "grounded".' },
              op: {
                enum: [...BIND_OPS],
                description:
                  'value (default), length of a vector, horizontal (xz length), x/y/z, or not (a bool inverted).',
              },
            },
          },
        },
      },
    },
    layers: {
      type: 'array',
      minItems: 1,
      description: 'State machines blended in order, like AnimationPlayer layers.',
      items: {
        type: 'object',
        required: ['states'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          entry: { type: 'string', description: 'The starting state. Default: the first.' },
          weight: { type: 'number', minimum: 0, maximum: 1 },
          blend: { enum: ['override', 'additive'] },
          mask: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            description: 'A *.mask.json: which joints this layer animates.',
          },
          states: {
            type: 'object',
            description: 'By name. {} plays nothing (the layers below show through).',
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              properties: {
                clip: clipSchema,
                blend1d: {
                  type: 'object',
                  required: ['parameter', 'clips'],
                  properties: {
                    parameter: { type: 'string' },
                    clips: {
                      type: 'array',
                      description: '[threshold, clip] pairs.',
                      items: { type: 'array', minItems: 2, maxItems: 2 },
                    },
                  },
                },
                blend2d: {
                  type: 'object',
                  required: ['x', 'y', 'clips'],
                  properties: {
                    x: { type: 'string' },
                    y: { type: 'string' },
                    clips: {
                      type: 'array',
                      description: '[x, y, clip] samples.',
                      items: { type: 'array', minItems: 3, maxItems: 3 },
                    },
                  },
                },
                loop: loopSchema,
                speed: speedSchema,
              },
            },
          },
          transitions: {
            type: 'array',
            description: 'Checked in order; the first that matches is taken.',
            items: {
              type: 'object',
              required: ['from', 'to'],
              additionalProperties: false,
              properties: {
                from: { type: 'string', description: 'A state, or "*" for any state.' },
                to: { type: 'string' },
                when: {
                  type: 'string',
                  description:
                    'Parameters, numbers, !, &&, ||, < <= > >= == !=, parentheses: "!grounded", "speed > 0.1 && !attack".',
                },
                duration: { type: 'number', minimum: 0, description: 'Crossfade seconds.' },
                exitTime: {
                  type: 'number',
                  minimum: 0,
                  description: 'Wait for this normalized time of the source state (1: its end).',
                },
              },
            },
          },
        },
      },
    },
    clips: {
      type: 'object',
      description: 'Clips by name, used as "#name" in states.',
      additionalProperties: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  required: ['layers'],
}))
