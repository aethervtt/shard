import {
  ChildOf,
  type ComponentDef,
  defineComponent,
  defineEvent,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Time } from '@aethervtt/shard-runtime'
import { animationLayer } from './api'
import { AnimationClips } from './clip'
import { type AnimationLayerValue, AnimationPlayer } from './components'
import {
  type AnimationGraphAsset,
  AnimationGraphs,
  type GraphState,
  numericStorage,
  test,
} from './graph'

// --- components ------------------------------------------------------------------------------

export const AnimatorParams = defineComponent(
  'animation/AnimatorParams',
  {
    values: t.json({
      default: {},
      description:
        'Parameter values by name (numbers; bools and triggers as true/false). Patch it to set them; a trigger turns false when a transition takes it. Bound parameters are read from their component instead (animation.describe shows them).',
    }),
  },
  { description: "An Animator's parameters. setAnimParam(world, entity, name, value) sets one." },
)

export const Animator = defineComponent(
  'animation/Animator',
  {
    graph: t.handle('AnimationGraph', {
      description: 'The state machine (*.animgraph.json) that drives this AnimationPlayer.',
    }),
  },
  {
    description:
      "Plays an animation graph: each frame it reads parameters (bound ones from components), takes transitions, and writes the AnimationPlayer's layers. animation.describe shows the states.",
    requires: [AnimationPlayer, AnimatorParams],
  },
)

export interface AnimatorStateEnteredData {
  entity: Entity
  /** The graph layer's name. */
  layer: string
  state: string
  /** The state it left, or null for the entry state. */
  from: string | null
}

export const AnimatorStateEntered = defineEvent<AnimatorStateEnteredData>(
  'animation/AnimatorStateEntered',
  { description: 'An Animator entered a state (its entry state on the first frame).' },
)

// --- runtime state ---------------------------------------------------------------------------

/** States blending in one layer: the newest on top, fading in over the ones below. */
const STACK = 4

interface LayerRun {
  count: number
  state: Int32Array
  /** How far each entry has faded in over the ones below (the bottom one is 1). */
  blend: Float64Array
  /** Blend per second (1 / duration). */
  rate: Float64Array
  /** Normalized time, unwrapped: 2.5 is halfway through the third loop. */
  phase: Float64Array
  seconds: Float64Array
  /** The transition that pushed each entry, or -1. */
  via: Int32Array
  /** Motion weights, maxMotions per entry. */
  weights: Float64Array
  /** Each entry's share of the layer's pose (for describe). */
  share: Float64Array
}

interface AnimatorRun {
  graph: AnimationGraphAsset
  revision: number
  values: Float64Array
  /** Per parameter: the entity its binding reads, or -1. */
  bindEntity: Int32Array
  bindDef: (ComponentDef | null)[]
  /** Floats per row of the bound field. */
  bindStride: Int32Array
  /** Why a binding isn't reading (for describe), or ''. */
  bindWhy: string[]
  retryAt: number
  layers: LayerRun[]
  /** The values AnimatorParams holds, as last read or written (NaN: unknown). */
  seen: Float64Array
  /** AnimatorParams' change tick after our own write: anything else means someone patched it. */
  ownTick: number
  started: boolean
}

export interface AnimatorState {
  runs: Map<Entity, AnimatorRun>
  frame: number
}

export const AnimatorStateResource = defineResource<AnimatorState>('animation/AnimatorState', {
  description: 'Per-animator runtime state: active states, times, parameter values. Internal.',
  init: () => ({ runs: new Map(), frame: 0 }),
})

function createRun(graph: AnimationGraphAsset, frame: number): AnimatorRun {
  const n = graph.parameters.length
  const values = new Float64Array(n)
  for (let i = 0; i < n; i++) values[i] = graph.parameters[i]!.default
  return {
    graph,
    revision: graph.revision,
    values,
    bindEntity: new Int32Array(n).fill(-1),
    bindDef: graph.parameters.map(() => null),
    bindStride: new Int32Array(n),
    bindWhy: graph.parameters.map((p) => (p.bind ? 'not bound yet' : '')),
    retryAt: frame,
    seen: new Float64Array(n).fill(Number.NaN),
    ownTick: -1,
    started: false,
    layers: graph.layers.map((l) => {
      const run: LayerRun = {
        count: 1,
        state: new Int32Array(STACK),
        blend: new Float64Array(STACK),
        rate: new Float64Array(STACK),
        phase: new Float64Array(STACK),
        seconds: new Float64Array(STACK),
        via: new Int32Array(STACK).fill(-1),
        weights: new Float64Array(STACK * l.maxMotions),
        share: new Float64Array(STACK),
      }
      run.state[0] = l.entry
      run.blend[0] = 1
      return run
    }),
  }
}

// --- parameters ------------------------------------------------------------------------------

/** Finds each bound parameter's component on the entity or its nearest ancestor. Cold path. */
function bindParameters(world: World, entity: Entity, run: AnimatorRun, frame: number): void {
  const params = run.graph.parameters
  let missing = false
  for (let i = 0; i < params.length; i++) {
    const bind = params[i]!.bind
    if (!bind || run.bindEntity[i]! >= 0) continue
    const def = findComponent(bind.component)
    if (!def) {
      run.bindWhy[i] = `component ${bind.component} not defined`
      missing = true
      continue
    }
    const layout = def.layout.find((l) => l.name === bind.field)
    if (!layout || !numericStorage.has(layout.storage)) {
      run.bindWhy[i] = layout
        ? `${bind.field} isn't numeric`
        : `${bind.component} has no ${bind.field}`
      continue
    }
    let e: Entity | null = entity
    for (let guard = 0; e !== null && guard < 64; guard++) {
      if (world.has(e, def)) break
      e = world.has(e, ChildOf) ? world.get(e, ChildOf).parent : null
    }
    if (e === null) {
      run.bindWhy[i] = `no ${bind.component} on the entity or its ancestors`
      missing = true
      continue
    }
    run.bindEntity[i] = e
    run.bindDef[i] = def
    run.bindStride[i] = layout.stride
    run.bindWhy[i] = ''
  }
  // Components added later (a character controller spawning) are picked up on a retry.
  run.retryAt = missing ? frame + 30 : Number.POSITIVE_INFINITY
}

/** Reads bound parameters from their components into run.values. */
function readBindings(world: World, run: AnimatorRun): void {
  const params = run.graph.parameters
  for (let i = 0; i < params.length; i++) {
    const e = run.bindEntity[i]!
    if (e < 0) continue
    const def = run.bindDef[i]!
    if (!world.isAlive(e)) {
      run.bindEntity[i] = -1
      run.bindWhy[i] = 'bound entity is gone'
      run.retryAt = 0
      continue
    }
    const table = world.entityTableUnchecked(e)
    const storage = table.storage(def)
    if (!storage) {
      run.bindEntity[i] = -1
      run.bindWhy[i] = `${def.name} was removed`
      run.retryAt = 0
      continue
    }
    const bind = params[i]!.bind!
    const col = storage.byName[bind.field] as Float32Array
    const row = world.entityRowUnchecked(e)
    const op = bind.op
    const s = run.bindStride[i]!
    const o = row * s
    let v: number
    if (op === 'value' || op === 'x' || op === 'not') v = col[o]!
    else {
      if (op === 'y') v = s > 1 ? col[o + 1]! : 0
      else if (op === 'z') v = s > 2 ? col[o + 2]! : 0
      else if (op === 'horizontal') {
        const x = col[o]!
        const z = s > 2 ? col[o + 2]! : 0
        v = Math.sqrt(x * x + z * z)
      } else {
        let sum = 0
        for (let k = 0; k < s; k++) sum += col[o + k]! * col[o + k]!
        v = Math.sqrt(sum)
      }
    }
    if (op === 'not') v = v === 0 ? 1 : 0
    else if (params[i]!.type === 'bool') v = v !== 0 ? 1 : 0
    run.values[i] = v
  }
}

/**
 * Reads unbound parameters from the AnimatorParams object (what code and the protocol set). Only
 * after someone else changed it: loading a number from a JSON object can allocate.
 */
function readValues(run: AnimatorRun, obj: Record<string, unknown>): void {
  const params = run.graph.parameters
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    const v = obj[p.name]
    const n = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number.NaN
    run.seen[i] = n
    if (run.bindEntity[i]! < 0 && !Number.isNaN(n)) run.values[i] = n
  }
}

/**
 * Writes values that changed (consumed triggers, defaults) into the object. Bound parameters stay
 * out of it: storing a changing number into a JSON object allocates, every frame.
 */
function writeValues(run: AnimatorRun, obj: Record<string, unknown>): boolean {
  const params = run.graph.parameters
  let changed = false
  for (let i = 0; i < params.length; i++) {
    if (run.graph.parameters[i]!.bind) continue
    const v = run.values[i]!
    if (v === run.seen[i]) continue
    run.seen[i] = v
    const p = params[i]!
    if (p.type === 'float') obj[p.name] = v
    else obj[p.name] = v !== 0
    changed = true
  }
  return changed
}

// --- blend spaces ----------------------------------------------------------------------------

/** Writes a state's motion weights (summing to 1) into w at o. */
function stateWeights(state: GraphState, values: Float64Array, w: Float64Array, o: number): void {
  const m = state.motions
  const n = m.length
  for (let k = 0; k < n; k++) w[o + k] = 0
  if (n === 0) return
  if (state.kind !== 'blend1d' && state.kind !== 'blend2d') {
    w[o] = 1
    return
  }
  if (state.kind === 'blend1d' || n === 1) {
    const v = state.x >= 0 ? values[state.x]! : 0
    if (n === 1 || v <= m[0]!.x) {
      w[o] = 1
      return
    }
    if (v >= m[n - 1]!.x) {
      w[o + n - 1] = 1
      return
    }
    let k = 0
    while (k < n - 2 && v >= m[k + 1]!.x) k++
    const a = m[k]!.x
    const u = (v - a) / (m[k + 1]!.x - a)
    w[o + k] = 1 - u
    w[o + k + 1] = u
    return
  }
  const px = state.x >= 0 ? values[state.x]! : 0
  const py = state.y >= 0 ? values[state.y]! : 0
  // Inside a triangle: barycentric weights of its three samples.
  const tri = state.triangles
  for (let t = 0; t < tri.length; t += 3) {
    const a = m[tri[t]!]!
    const b = m[tri[t + 1]!]!
    const c = m[tri[t + 2]!]!
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
    const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / det
    const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / det
    const l3 = 1 - l1 - l2
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) {
      w[o + tri[t]!] = l1 < 0 ? 0 : l1
      w[o + tri[t + 1]!] = l2 < 0 ? 0 : l2
      w[o + tri[t + 2]!] = l3 < 0 ? 0 : l3
      return
    }
  }
  // Outside the hull (or collinear samples): the nearest point on an edge.
  const edges = state.edges
  let best = Number.POSITIVE_INFINITY
  let bi = 0
  let bj = 0
  let bu = 0
  for (let e = 0; e < edges.length; e += 2) {
    const a = m[edges[e]!]!
    const b = m[edges[e + 1]!]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = dx * dx + dy * dy
    let u = len > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len : 0
    if (u < 0) u = 0
    else if (u > 1) u = 1
    const qx = a.x + dx * u - px
    const qy = a.y + dy * u - py
    const d = qx * qx + qy * qy
    if (d < best) {
      best = d
      bi = edges[e]!
      bj = edges[e + 1]!
      bu = u
    }
  }
  if (best === Number.POSITIVE_INFINITY) {
    w[o] = 1
    return
  }
  w[o + bi] = 1 - bu
  w[o + bj] = w[o + bj]! + bu
}

// --- the system ------------------------------------------------------------------------------

/** Entering a state: push it over the layer's stack (the bottom falls off when full). */
function enter(run: LayerRun, state: number, via: number, duration: number): void {
  if (run.count === STACK) {
    for (let k = 1; k < STACK; k++) {
      run.state[k - 1] = run.state[k]!
      run.blend[k - 1] = run.blend[k]!
      run.rate[k - 1] = run.rate[k]!
      run.phase[k - 1] = run.phase[k]!
      run.seconds[k - 1] = run.seconds[k]!
      run.via[k - 1] = run.via[k]!
    }
    run.blend[0] = 1
    run.count--
  }
  const k = run.count++
  run.state[k] = state
  run.blend[k] = duration > 0 ? 0 : 1
  run.rate[k] = duration > 0 ? 1 / duration : 0
  run.phase[k] = 0
  run.seconds[k] = 0
  run.via[k] = via
}

/** Drops entries fully covered by one above them. */
function collapse(run: LayerRun): void {
  let top = 0
  for (let k = run.count - 1; k > 0; k--) {
    if (run.blend[k]! >= 1) {
      top = k
      break
    }
  }
  if (top === 0) return
  for (let k = top; k < run.count; k++) {
    const d = k - top
    run.state[d] = run.state[k]!
    run.blend[d] = run.blend[k]!
    run.rate[d] = run.rate[k]!
    run.phase[d] = run.phase[k]!
    run.seconds[d] = run.seconds[k]!
    run.via[d] = run.via[k]!
  }
  run.count -= top
  run.blend[0] = 1
}

/** Gets a player layer to write, growing the list (never shrinking it: no churn per frame). */
function slot(layers: AnimationLayerValue[], k: number): AnimationLayerValue {
  if (k >= layers.length) layers.push(animationLayer(null, { fadeSpeed: 0 }))
  return layers[k]!
}

/** Scratch: coefficient per written player layer. */
let coefficients = new Float64Array(64)

// This frame's delta rides in here: V8 boxes a double passed to a call it doesn't inline.
const dtArg = new Float64Array(1)

/**
 * Advances one animator: parameters, transitions, blends, and the player layers it writes. Returns
 * how many player layers it used.
 */
function step(
  world: World,
  entity: Entity,
  run: AnimatorRun,
  layers: AnimationLayerValue[],
  clips: { get(ref: { guid: string | undefined } | null): { duration: number } | undefined },
): number {
  const dt = dtArg[0]!
  const graph = run.graph
  const values = run.values
  let used = 0
  for (let li = 0; li < graph.layers.length; li++) {
    const gl = graph.layers[li]!
    const lr = run.layers[li]!
    if (!run.started) {
      world.send(AnimatorStateEntered, {
        entity,
        layer: gl.name,
        state: gl.states[gl.entry]!.name,
        from: null,
      })
    }
    // Transitions: first match wins, one per frame.
    const top = lr.count - 1
    const current = lr.state[top]!
    const transitions = gl.transitions
    for (let ti = 0; ti < transitions.length; ti++) {
      const tr = transitions[ti]!
      if (tr.from === -1 ? tr.to === current : tr.from !== current) continue
      // Exit times allow float error: 0.8 of a 0.5 s clip is reached at 0.4 s.
      if (!Number.isNaN(tr.exitTime) && lr.phase[top]! < tr.exitTime - 1e-6) continue
      if (!test(tr.code, values)) continue
      for (let k = 0; k < tr.triggers.length; k++) values[tr.triggers[k]!] = 0
      enter(lr, tr.to, ti, tr.duration)
      world.send(AnimatorStateEntered, {
        entity,
        layer: gl.name,
        state: gl.states[tr.to]!.name,
        from: gl.states[current]!.name,
      })
      break
    }
    // Fades.
    for (let k = 1; k < lr.count; k++) {
      if (lr.blend[k]! < 1) {
        const b = lr.blend[k]! + lr.rate[k]! * dt
        // Snap float error: a 0.15 s transition ends at 0.15 s, not a frame later.
        lr.blend[k] = b >= 1 - 1e-6 ? 1 : b
      }
    }
    collapse(lr)
    // Each entry's share: its blend times what the entries above leave.
    let remaining = 1
    for (let k = lr.count - 1; k >= 0; k--) {
      const b = k === 0 ? 1 : lr.blend[k]!
      lr.share[k] = b * remaining
      remaining *= 1 - b
    }
    // Player layers: every motion with weight, bottom entry first.
    const M = gl.maxMotions
    const first = used
    let total = 0
    const additive = gl.blend === 'additive'
    for (let k = 0; k < lr.count; k++) {
      const state = gl.states[lr.state[k]!]!
      const wo = k * M
      stateWeights(state, values, lr.weights, wo)
      // Blended duration: synced clips all reach their end together.
      let d = 0
      const motions = state.motions
      for (let m = 0; m < motions.length; m++) {
        const clip = clips.get(motions[m]!.clip)
        if (clip) d += lr.weights[wo + m]! * clip.duration
      }
      const rate = d > 0 ? state.speed / d : 1
      const phase = lr.phase[k]!
      const share = lr.share[k]! * gl.weight
      for (let m = 0; m < motions.length; m++) {
        const w = lr.weights[wo + m]!
        if (w <= 0 || share <= 0) continue
        const motion = motions[m]!
        const clip = clips.get(motion.clip)
        const cd = clip ? clip.duration : 0
        const layer = slot(layers, used)
        if (used >= coefficients.length) {
          const bigger = new Float64Array(coefficients.length * 2)
          bigger.set(coefficients)
          coefficients = bigger
        }
        coefficients[used] = share * w
        total += share * w
        used++
        layer.clip = motion.clip
        layer.mask = gl.mask
        layer.blend = gl.blend
        layer.loop = state.loop
        layer.playing = true
        layer.fadeSpeed = 0
        // The player advances from here by dt × speed, landing on the new phase.
        layer.speed = rate * cd
        if (state.loop === 'once') layer.time = (phase > 1 ? 1 : phase < 0 ? 0 : phase) * cd
        else if (state.loop === 'ping-pong') {
          let p = phase % 2
          if (p < 0) p += 2
          layer.time = p * cd
        } else {
          let p = phase % 1
          if (p < 0) p += 1
          layer.time = p * cd
        }
      }
      let next = phase + dt * rate
      if (state.loop === 'once') next = next > 1 ? 1 : next < 0 ? 0 : next
      lr.phase[k] = next
      lr.seconds[k] = lr.seconds[k]! + dt
    }
    // Override layers lerp in order, so coefficient c_k becomes weight c_k / (1 − T + S_k): the
    // pose below keeps 1 − T and each clip ends with exactly its coefficient.
    let sum = 0
    for (let k = first; k < used; k++) {
      const c = coefficients[k]!
      sum += c
      const w = additive ? c : c / (1 - total + sum)
      const layer = layers[k]!
      layer.weight = w > 1 ? 1 : w
      layer.fadeTo = layer.weight
    }
  }
  run.started = true
  return used
}

/**
 * Evaluates every Animator: reads its parameters (bound ones from components), takes transitions,
 * advances blends, and writes the AnimationPlayer's layers. Runs in PostUpdate before sampling.
 */
export const evaluateGraphs = defineSystem({
  name: 'animation/graph',
  description:
    "Runs animation graphs: parameters, transitions, blend spaces, and the players' layers.",
  setup: (world) => ({ q: world.query({ with: [Animator, AnimationPlayer, AnimatorParams] }) }),
  run: ({ q }, world) => {
    const state = world.resource(AnimatorStateResource)
    const frame = ++state.frame
    const graphs = world.resource(AnimationGraphs)
    const clips = world.resource(AnimationClips)
    dtArg[0] = world.resource(Time).delta
    const tables = q.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const n = table.count
      if (n === 0) continue
      const refs = table.column(Animator, 'graph') as ({ guid: string | undefined } | null)[]
      const layerLists = table.column(AnimationPlayer, 'layers') as AnimationLayerValue[][]
      const params = table.column(AnimatorParams, 'values') as Record<string, unknown>[]
      const paramTicks = table.changedTicks(AnimatorParams)
      for (let i = 0; i < n; i++) {
        const entity = table.entities[i]!
        const graph = graphs.get(refs[i])
        if (!graph) continue
        let run = state.runs.get(entity)
        if (!run || run.graph !== graph || run.revision !== graph.revision) {
          run = createRun(graph, frame)
          state.runs.set(entity, run)
        }
        if (frame >= run.retryAt) bindParameters(world, entity, run, frame)
        let obj = params[i]
        if (!obj || typeof obj !== 'object') {
          obj = {}
          params[i] = obj
        }
        if (paramTicks[i] !== run.ownTick) readValues(run, obj)
        readBindings(world, run)
        const layers = layerLists[i]!
        const used = step(world, entity, run, layers, clips)
        for (let k = used; k < layers.length; k++) {
          const layer = layers[k]!
          layer.clip = null
          layer.weight = 0
          layer.fadeTo = 0
          layer.fadeSpeed = 0
        }
        table.markChanged(AnimationPlayer, i)
        if (writeValues(run, obj)) table.markChanged(AnimatorParams, i)
        run.ownTick = paramTicks[i]!
      }
    }
  },
})

// --- API -------------------------------------------------------------------------------------

/**
 * Sets an Animator parameter: a number for floats, a boolean for bools and triggers (a trigger
 * stays true until a transition takes it). Takes effect on the graph's next evaluation.
 */
export function setAnimParam(
  world: World,
  entity: Entity,
  name: string,
  value: number | boolean,
): void {
  if (!world.isAlive(entity) || !world.has(entity, AnimatorParams)) {
    throw new ShardError('animgraph/no-animator', `Entity ${entity} has no Animator`, {
      hint: 'Add animation/Animator (with a graph) to the entity first.',
    })
  }
  const graph = world.resource(AnimationGraphs).get(world.get(entity, Animator).graph)
  if (graph && !graph.parameters.some((p) => p.name === name)) {
    throw new ShardError('animgraph/unknown-parameter', `The graph has no parameter "${name}"`, {
      hint: `Parameters: ${graph.parameters.map((p) => p.name).join(', ') || 'none'}.`,
    })
  }
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  const col = table.column(AnimatorParams, 'values') as Record<string, unknown>[]
  let obj = col[row]
  if (!obj || typeof obj !== 'object') {
    obj = {}
    col[row] = obj
  }
  obj[name] = value
  table.markChanged(AnimatorParams, row)
}

/** Forgets an animator's state when its component goes away. */
export function forgetAnimator(world: World, entity: Entity): void {
  world.tryResource(AnimatorStateResource)?.runs.delete(entity)
}

/** What an Animator is doing, for animation.describe. Null without one. */
export function describeAnimator(world: World, entity: Entity) {
  if (!world.has(entity, Animator)) return null
  const ref = world.get(entity, Animator).graph
  const graph = world.tryResource(AnimationGraphs)?.get(ref)
  const run = world.tryResource(AnimatorStateResource)?.runs.get(entity)
  const clips = world.resource(AnimationClips)
  const path = ref?.path ?? ref?.guid ?? null
  const parameters: Record<string, number | boolean> = {}
  if (!graph || !run) return { graph: path, loaded: graph !== undefined, layers: [], parameters }
  const bindings: Record<string, string> = {}
  graph.parameters.forEach((p, i) => {
    parameters[p.name] = p.type === 'float' ? run.values[i]! : run.values[i] !== 0
    if (p.bind) {
      bindings[p.name] = run.bindWhy[i]
        ? `unbound: ${run.bindWhy[i]}`
        : `${p.bind.component}.${p.bind.field}${p.bind.op === 'value' ? '' : ` (${p.bind.op})`} of entity ${run.bindEntity[i]}`
    }
  })
  return {
    graph: path,
    loaded: true,
    parameters,
    bindings,
    layers: graph.layers.map((gl, li) => {
      const lr = run.layers[li]!
      const top = lr.count - 1
      const state = gl.states[lr.state[top]!]!
      const via = lr.via[top]!
      const transition =
        top > 0 && lr.blend[top]! < 1 && via >= 0
          ? {
              from: gl.states[lr.state[top - 1]!]!.name,
              to: state.name,
              when: gl.transitions[via]!.when,
              duration: gl.transitions[via]!.duration,
              progress: lr.blend[top]!,
            }
          : null
      const active = []
      for (let k = 0; k < lr.count; k++) {
        const s = gl.states[lr.state[k]!]!
        active.push({
          state: s.name,
          share: lr.share[k]!,
          normalizedTime: lr.phase[k]!,
          time: lr.seconds[k]!,
          motions: s.motions.map((m, mi) => ({
            clip: m.clip.path ?? m.clip.guid ?? null,
            name: clips.get(m.clip)?.name ?? null,
            weight: lr.weights[k * gl.maxMotions + mi]!,
          })),
        })
      }
      return {
        name: gl.name,
        state: state.name,
        timeInState: lr.seconds[top]!,
        normalizedTime: lr.phase[top]!,
        transition,
        weight: gl.weight,
        active,
      }
    }),
  }
}
