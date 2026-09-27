import { ShardError } from '@aethervtt/shard-core'
import { MAX_OCTAVES, type NodeDef, nodeDef, type ParamDef } from './nodes'

/** Where a node input comes from: another named node, an inline node, or a number. */
export type GraphInput =
  | { readonly kind: 'ref'; readonly name: string; readonly path: string }
  | { readonly kind: 'node'; readonly node: GraphNode }
  | { readonly kind: 'const'; readonly value: number }

export type ParamValue =
  | number
  | boolean
  | string
  | readonly number[]
  | readonly (readonly [number, number])[]
  | GraphInput
  | readonly GraphInput[]

/** A node with its parameters filled in from the table's defaults. */
export interface GraphNode {
  readonly type: string
  readonly def: NodeDef
  readonly params: Readonly<Record<string, ParamValue>>
  /** JSON pointer to the node's body (`/nodes/mask/remap`). */
  readonly path: string
}

export interface ParsedGraph {
  readonly output: string
  /** 3 unless the file says 2 or 4. A 4D graph reads w; 4D sources need one. */
  readonly dimensions: 2 | 3 | 4
  /** Largest distance from the origin the graph is sampled at (a planet's radius), if set. */
  readonly extent: number | undefined
  readonly description: string | undefined
  readonly nodes: ReadonlyMap<string, GraphNode>
}

/** Escapes a JSON pointer segment. */
export function pointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

const fail = (code: string, path: string, message: string, hint?: string) =>
  new ShardError(code, message, { path, ...(hint ? { hint } : {}) })

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parses and validates a `*.noise.json` graph. Returns every error found (each with a JSON
 * pointer), and the graph when there are none.
 */
export function parseGraph(json: unknown): { graph?: ParsedGraph; errors: ShardError[] } {
  const errors: ShardError[] = []
  if (!isObject(json)) {
    errors.push(
      new ShardError('noise/invalid-graph', 'A noise graph is a JSON object', {
        path: '',
        hint: 'Start from { "output": "height", "nodes": { … } }.',
      }),
    )
    return { errors }
  }
  for (const key of Object.keys(json)) {
    if (!['$schema', 'output', 'nodes', 'dimensions', 'extent', 'description'].includes(key)) {
      errors.push(
        fail(
          'noise/invalid-graph',
          `/${pointer(key)}`,
          `Unknown graph field "${key}"`,
          'Graph fields: output, nodes, dimensions, extent, description.',
        ),
      )
    }
  }
  const dimensions = json.dimensions ?? 3
  if (dimensions !== 2 && dimensions !== 3 && dimensions !== 4) {
    errors.push(fail('noise/invalid-graph', '/dimensions', '"dimensions" must be 2, 3, or 4'))
  }
  const dims = (dimensions === 2 || dimensions === 4 ? dimensions : 3) as 2 | 3 | 4
  const extent = json.extent
  if (extent !== undefined && (typeof extent !== 'number' || !(extent > 0))) {
    errors.push(
      fail('noise/invalid-graph', '/extent', '"extent" must be a positive number of units'),
    )
  }
  if (json.description !== undefined && typeof json.description !== 'string') {
    errors.push(fail('noise/invalid-graph', '/description', '"description" must be a string'))
  }

  const nodes = new Map<string, GraphNode>()
  if (!isObject(json.nodes) || Object.keys(json.nodes).length === 0) {
    errors.push(
      fail(
        'noise/invalid-graph',
        '/nodes',
        'A graph needs a "nodes" object with at least one node',
        'Add "nodes": { "height": { "fbm": { "octaves": 5 } } }.',
      ),
    )
  } else {
    for (const [name, body] of Object.entries(json.nodes)) {
      const node = parseNode(body, `/nodes/${pointer(name)}`, dims, errors)
      if (node) nodes.set(name, node)
    }
  }

  const output = json.output
  if (typeof output !== 'string') {
    errors.push(
      fail('noise/invalid-graph', '/output', '"output" must name the node the graph returns'),
    )
  } else if (isObject(json.nodes) && !(output in json.nodes)) {
    errors.push(
      fail(
        'noise/unknown-node',
        '/output',
        `"output" names "${output}", which isn't a node`,
        hintFor(output, json.nodes),
      ),
    )
  }

  if (isObject(json.nodes)) {
    for (const node of nodes.values()) checkRefs(node, json.nodes, errors)
    checkCycles(nodes, errors)
  }

  if (errors.length > 0) return { errors }
  return {
    graph: {
      output: output as string,
      dimensions: dims,
      extent: extent as number | undefined,
      description: json.description as string | undefined,
      nodes,
    },
    errors,
  }
}

function hintFor(_name: string, nodes: Record<string, unknown>): string {
  const names = Object.keys(nodes)
  return names.length > 0
    ? `Nodes in this graph: ${names.join(', ')}.`
    : 'Add the node under "nodes".'
}

function parseInput(
  v: unknown,
  path: string,
  dims: 2 | 3 | 4,
  errors: ShardError[],
): GraphInput | undefined {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      errors.push(
        new ShardError('noise/invalid-param', 'Numbers must be finite', {
          path,
          hint: 'Check the parameter against .shard/schemas/noise.schema.json.',
        }),
      )
      return undefined
    }
    return { kind: 'const', value: v }
  }
  if (typeof v === 'string') return { kind: 'ref', name: v, path }
  if (isObject(v)) {
    const node = parseNode(v, path, dims, errors)
    return node ? { kind: 'node', node } : undefined
  }
  errors.push(
    fail('noise/invalid-param', path, 'An input is a node name, an inline node, or a number'),
  )
  return undefined
}

function parseNode(
  body: unknown,
  path: string,
  dims: 2 | 3 | 4,
  errors: ShardError[],
): GraphNode | undefined {
  if (typeof body === 'number') {
    const def = nodeDef('constant')!
    return { type: 'constant', def, params: { value: body }, path }
  }
  if (!isObject(body) || Object.keys(body).length !== 1) {
    errors.push(
      new ShardError('noise/invalid-node', 'A node is an object with exactly one key: its type', {
        path,
        hint: 'For example { "fbm": { "octaves": 5 } }.',
      }),
    )
    return undefined
  }
  const [type, raw] = Object.entries(body)[0]!
  const def = nodeDef(type)
  const at = `${path}/${pointer(type)}`
  if (!def) {
    errors.push(
      new ShardError('noise/unknown-type', `Unknown node type "${type}"`, {
        path: at,
        hint: 'Types: value, perlin, simplex, cellular, fbm, ridged, billow, add, multiply, min, max, lerp, select, remap, clamp, curve, terrace, abs, power, constant, warp, scale, translate.',
      }),
    )
    return undefined
  }

  if (def.form === 'value') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(fail('noise/invalid-param', at, `"${type}" takes a number`))
      return undefined
    }
    return { type, def, params: { value: raw }, path: at }
  }

  if (def.form === 'list') {
    if (!Array.isArray(raw) || raw.length < 2) {
      errors.push(
        new ShardError('noise/arity', `"${type}" takes an array of two or more inputs`, {
          path: at,
          hint: 'Give it two or more inputs: node names, inline nodes, or numbers, e.g. ["a", "b"].',
        }),
      )
      return undefined
    }
    const inputs: GraphInput[] = []
    raw.forEach((v, i) => {
      const input = parseInput(v, `${at}/${i}`, dims, errors)
      if (input) inputs.push(input)
    })
    return { type, def, params: { inputs }, path: at }
  }

  let fields: Record<string, unknown>
  if (def.form === 'unary' && !isObject(raw)) fields = { input: raw }
  else if (def.form === 'unary' && isObject(raw) && !('input' in raw)) fields = { input: raw }
  else if (isObject(raw)) fields = raw
  else {
    errors.push(
      fail(
        'noise/invalid-node',
        at,
        `"${type}" takes an object of parameters`,
        `Parameters: ${Object.keys(def.params).join(', ')}.`,
      ),
    )
    return undefined
  }

  const params: Record<string, ParamValue> = {}
  for (const key of Object.keys(fields)) {
    if (!(key in def.params)) {
      errors.push(
        fail(
          'noise/invalid-param',
          `${at}/${pointer(key)}`,
          `"${type}" has no parameter "${key}"`,
          `Parameters: ${Object.keys(def.params).join(', ')}.`,
        ),
      )
    }
  }
  for (const [key, p] of Object.entries(def.params)) {
    const value = parseParam(p, fields[key], `${at}/${pointer(key)}`, type, key, dims, errors)
    if (value !== undefined) params[key] = value
  }
  return { type, def, params, path: at }
}

function parseParam(
  p: ParamDef,
  v: unknown,
  path: string,
  type: string,
  key: string,
  dims: 2 | 3 | 4,
  errors: ShardError[],
): ParamValue | undefined {
  const bad = (what: string) => {
    errors.push(fail('noise/invalid-param', path, `"${type}.${key}" ${what}`, p.description))
    return undefined
  }
  if (v === undefined) {
    if (p.type === 'input') {
      errors.push(fail('noise/arity', path, `"${type}" needs "${key}"`, p.description))
      return undefined
    }
    if (p.type === 'points') {
      errors.push(fail('noise/arity', path, `"${type}" needs "${key}"`, p.description))
      return undefined
    }
    if ('default' in p && p.default !== undefined) {
      if (key === 'dims' && dims === 2) return 2
      return p.default as ParamValue
    }
    return undefined
  }
  switch (p.type) {
    case 'input':
      return parseInput(v, path, dims, errors)
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('must be a number')
      if (p.positive && !(v > 0)) return bad('must be greater than 0')
      if (p.min !== undefined && v < p.min) return bad(`must be at least ${p.min}`)
      if (p.max !== undefined && v > p.max) return bad(`must be at most ${p.max}`)
      return v
    }
    case 'integer': {
      if (typeof v !== 'number' || !Number.isInteger(v)) return bad('must be an integer')
      if (key === 'octaves' && v > MAX_OCTAVES) {
        errors.push(
          new ShardError(
            'noise/too-many-octaves',
            `"${type}" has ${v} octaves; the most is ${MAX_OCTAVES}`,
            {
              path,
              hint: 'Past 16 octaves the extra detail is below a pixel anywhere; raise frequency instead.',
            },
          ),
        )
        return undefined
      }
      if (p.min !== undefined && v < p.min) return bad(`must be at least ${p.min}`)
      if (p.max !== undefined && v > p.max) return bad(`must be at most ${p.max}`)
      return v
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : bad('must be true or false')
    case 'enum': {
      if (!p.values.includes(v as string | number))
        return bad(`must be one of ${p.values.join(', ')}`)
      if (key === 'dims' && v === 4 && dims !== 4) {
        errors.push(
          new ShardError('noise/domain-mismatch', `"${type}" is 4D but the graph is ${dims}D`, {
            path,
            hint: 'Set "dimensions": 4 on the graph and sample it with a w coordinate, or use dims 3.',
          }),
        )
        return undefined
      }
      return v as string | number
    }
    case 'pair': {
      if (
        !Array.isArray(v) ||
        v.length !== 2 ||
        !v.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        return bad('must be [a, b]')
      }
      return v as number[]
    }
    case 'vec': {
      if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v, v]
      if (
        !Array.isArray(v) ||
        v.length < 2 ||
        v.length > 4 ||
        !v.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        return bad('must be a number or [x, y, z]')
      }
      const fill = key === 'by' && type === 'scale' ? 1 : 0
      return [v[0], v[1], v[2] ?? fill, v[3] ?? fill] as number[]
    }
    case 'points': {
      if (!Array.isArray(v) || v.length < 2) {
        errors.push(
          fail('noise/arity', path, `"${type}.${key}" needs at least two points`, p.description),
        )
        return undefined
      }
      let last = -Infinity
      for (let i = 0; i < v.length; i++) {
        const pt = v[i]
        if (
          !Array.isArray(pt) ||
          pt.length !== 2 ||
          !pt.every((x) => typeof x === 'number' && Number.isFinite(x))
        ) {
          errors.push(fail('noise/invalid-param', `${path}/${i}`, 'A point is [x, y]'))
          return undefined
        }
        if (pt[0] <= last) {
          errors.push(fail('noise/invalid-param', `${path}/${i}`, 'Curve points need increasing x'))
          return undefined
        }
        last = pt[0]
      }
      return v as [number, number][]
    }
  }
}

function eachInput(node: GraphNode, f: (input: GraphInput) => void): void {
  for (const value of Object.values(node.params)) {
    if (Array.isArray(value)) {
      for (const v of value) if (isInput(v)) f(v)
    } else if (isInput(value)) f(value)
  }
}

function isInput(v: unknown): v is GraphInput {
  return isObject(v) && (v.kind === 'ref' || v.kind === 'node' || v.kind === 'const')
}

/** Calls `f` on every node input, inline nodes included. */
export function forEachInput(node: GraphNode, f: (input: GraphInput) => void): void {
  eachInput(node, f)
}

function checkRefs(node: GraphNode, names: Record<string, unknown>, errors: ShardError[]): void {
  eachInput(node, (input) => {
    if (input.kind === 'ref' && !(input.name in names)) {
      errors.push(
        // Hint for the docs: name a node under "nodes", or add it there.
        new ShardError('noise/unknown-node', `"${input.name}" isn't a node in this graph`, {
          path: input.path,
          hint: hintFor(input.name, names),
        }),
      )
    } else if (input.kind === 'node') checkRefs(input.node, names, errors)
  })
}

function checkCycles(nodes: ReadonlyMap<string, GraphNode>, errors: ShardError[]): void {
  const state = new Map<string, 'visiting' | 'done'>()
  const reported = new Set<string>()
  const visit = (name: string, trail: string[]): void => {
    const s = state.get(name)
    if (s === 'done') return
    if (s === 'visiting') {
      const loop = trail.slice(trail.indexOf(name))
      const key = [...loop].sort().join('>')
      if (!reported.has(key)) {
        reported.add(key)
        errors.push(
          new ShardError('noise/cycle', `Nodes form a cycle: ${[...loop, name].join(' → ')}`, {
            path: `/nodes/${pointer(name)}`,
            hint: 'A node can’t depend on itself; break the loop with a separate node.',
          }),
        )
      }
      return
    }
    const node = nodes.get(name)
    if (!node) return
    state.set(name, 'visiting')
    const walk = (n: GraphNode) =>
      eachInput(n, (input) => {
        if (input.kind === 'ref') visit(input.name, [...trail, name])
        else if (input.kind === 'node') walk(input.node)
      })
    walk(node)
    state.set(name, 'done')
  }
  for (const name of nodes.keys()) visit(name, [])
}
