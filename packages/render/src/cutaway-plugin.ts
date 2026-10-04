import { defineResource, defineSystem, type Entity, Last, type World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { definePlugin, LogResource } from '@aethervtt/shard-runtime'
import { Camera3d } from './camera'
import { CutawayPath, type CutawaySupport, CutawayView, MAX_REVEAL_POINTS } from './cutaway'
import { addRenderFeatures } from './features'
import {
  INSTANCE_FLOATS,
  InstanceFlags,
  type InstanceStore,
  Instances,
  prepareInstances,
} from './instances'
import { Gpu, RenderDescribers, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'
import { Cameras } from './view'

// Cutaways (0070): Cutaway surfaces between a camera and its reveal points are removed, with an
// ordered dither at the rim. The test is linked into the forward, prepass, G-buffer and picking
// variants of batches that hold Cutaway instances, in views with reveal points; shadow variants
// never link it, so a cut roof still casts.

/**
 * Floats in a camera's cutaway uniform: 16 points (xyz, 0), their lines of sight (xyz, 0), then
 * radius, margin, edge, count.
 */
const CUTAWAY_FLOATS = MAX_REVEAL_POINTS * 8 + 4
/** Where the lines of sight start, and the parameters. */
const DIRS = MAX_REVEAL_POINTS * 4
const PARAMS = MAX_REVEAL_POINTS * 8

export const CUTAWAY_SHADERS: Record<string, string> = {
  'shard::cutaway': `
struct Cutaway {
  /** Reveal points (xyz). */
  points: array<vec4f, ${MAX_REVEAL_POINTS}>,
  /**
   * Each point's line of sight, unit (xyz): from the eye through it, or the view direction when
   * orthographic. Made on the CPU once a frame, not per fragment.
   */
  dirs: array<vec4f, ${MAX_REVEAL_POINTS}>,
  /** radius, margin, edge (m), and how many points. */
  params: vec4f,
}

@group(3) @binding(0) var<uniform> cutaway: Cutaway;

/** InstanceFlags.Cutaway in the record's flags word. */
const CUTAWAY_FLAG: u32 = 0x10000000u;

/** 0 to 1 across an edge band of width \`edge\` ending at 0 (a step when edge is 0). */
fn cutaway_ramp(inside: f32, edge: f32) -> f32 {
  if (edge <= 0.0) { return select(0.0, 1.0, inside > 0.0); }
  return clamp(inside / edge, 0.0, 1.0);
}

/**
 * How cut a world point is, 0 (whole) to 1: within radius of the line from the eye through a
 * reveal point (along the view direction when orthographic), and nearer the camera than the point
 * by more than margin. The edge band ramps both.
 */
fn cutaway_amount(world: vec3f) -> f32 {
  let radius = cutaway.params.x;
  let margin = cutaway.params.y;
  let edge = cutaway.params.z;
  let count = u32(cutaway.params.w);
  var amount = 0.0;
  for (var i = 0u; i < count; i++) {
    let d = world - cutaway.points[i].xyz;
    let along = dot(d, cutaway.dirs[i].xyz);
    // Not in front of the point by the margin, or outside the radius: this point cuts nothing.
    let ahead = -along - margin;
    if (ahead <= 0.0) { continue; }
    let across2 = max(dot(d, d) - along * along, 0.0);
    if (across2 >= radius * radius) { continue; }
    amount = max(amount, min(cutaway_ramp(radius - sqrt(across2), edge), cutaway_ramp(ahead, edge)));
    if (amount >= 1.0) { break; }
  }
  return amount;
}

/** An ordered 4×4 dither threshold at a pixel, in (0, 1). */
fn cutaway_threshold(frag: vec2f) -> f32 {
  let x = u32(frag.x);
  let y = u32(frag.y);
  let low = (((x ^ y) & 1u) << 1u) | (y & 1u);
  let high = ((((x ^ y) >> 1u) & 1u) << 1u) | ((y >> 1u) & 1u);
  return (f32(low * 4u + high) + 0.5) / 16.0;
}

/** Removes the fragment of a Cutaway instance that stands in front of a reveal point. */
fn cutaway_clip(world: vec3f, frag: vec2f, flags: u32) {
  if ((flags & CUTAWAY_FLAG) == 0u) { return; }
  if (cutaway_amount(world) > cutaway_threshold(frag)) { discard; }
}`,
}

/** A camera's reveal points as uploaded, and the bind group over them. */
interface CutawayCamera {
  data: Float32Array
  buffer: GpuBuffer | undefined
  bindGroup: GPUBindGroup | undefined
  /** The device generation and buffer version the bind group was made for. */
  boundGeneration: number
  boundVersion: number
  /** Points in use (at most MAX_REVEAL_POINTS). */
  count: number
  /** Points the component listed. */
  listed: number
  frame: number
  /** Too many points was reported for this camera. */
  warned: boolean
  /** The device generation its buffer was last written on (a new device loses the contents). */
  written: number
  /** Per batch index: 1 when a point can cut one of its Cutaway instances this frame. */
  cuts: Uint8Array
}

export interface CutawayState {
  cameras: Map<Entity, CutawayCamera>
  frame: number
  layout: { layout: GPUBindGroupLayout; generation: number } | undefined
}

export const CutawayCameras = defineResource<CutawayState>('render/CutawayCameras', {
  description: "Each camera's reveal points as the cutaway variants read them (0070).",
  init: () => ({ cameras: new Map(), frame: 0, layout: undefined }),
})

/** The camera's uniform, made on first use. */
function cameraOf(state: CutawayState, camera: Entity): CutawayCamera {
  let c = state.cameras.get(camera)
  if (!c) {
    c = {
      data: new Float32Array(CUTAWAY_FLOATS),
      buffer: undefined,
      bindGroup: undefined,
      boundGeneration: -1,
      boundVersion: -1,
      count: -1,
      listed: 0,
      frame: -1,
      warned: false,
      written: -1,
      cuts: new Uint8Array(64),
    }
    state.cameras.set(camera, c)
  }
  return c
}

function warnTooMany(world: World, camera: Entity, listed: number): void {
  world
    .tryResource(LogResource)
    ?.log(
      'warn',
      `Camera ${camera} has ${listed} reveal points; only the first ${MAX_REVEAL_POINTS} cut`,
      {
        code: 'render/too-many-reveal-points',
        hint: `Give CutawayView at most ${MAX_REVEAL_POINTS} points: the party, or the selected tokens.`,
        data: { camera, points: listed },
      },
    )
}

/** Writes `v` (as an f32) at `o`; returns whether it changed. */
function put(d: Float32Array, o: number, v: number): boolean {
  if (d[o] === Math.fround(v)) return false
  d[o] = v
  return true
}

/**
 * Packs each camera's CutawayView into its uniform, with each point's line of sight from the
 * camera. Only a camera whose values changed uploads (a camera moving changes the lines); a still
 * frame writes nothing and allocates nothing.
 */
export const extractCutaways = defineSystem({
  name: 'render/extract-cutaways',
  description: "Packs cameras' reveal points for the cutaway variants (0070).",
  setup: (world) => ({ q: world.query({ with: [Camera3d, CutawayView] }) }),
  run: ({ q }, world) => {
    const state = world.resource(CutawayCameras)
    const gpu = world.resource(Gpu)
    const cameras = world.resource(Cameras)
    const store = world.resource(Instances)
    const frame = ++state.frame
    for (const table of q.tables) {
      const points = table.column(CutawayView, 'points')
      const radius = table.column(CutawayView, 'radius')
      const margin = table.column(CutawayView, 'margin')
      const edge = table.column(CutawayView, 'edge')
      for (let i = 0; i < table.count; i++) {
        const camera = table.entities[i]!
        const c = cameraOf(state, camera)
        c.frame = frame
        const list = (points[i] ?? EMPTY) as ArrayLike<ArrayLike<number>>
        const listed = list.length
        const count = Math.min(listed, MAX_REVEAL_POINTS)
        if (listed > MAX_REVEAL_POINTS && !c.warned) {
          c.warned = true
          warnTooMany(world, camera, listed)
        }
        c.listed = listed
        // Not rendering this frame (inactive, no target): nothing to cut for.
        const cam = cameras.get(camera)
        const n = cam ? count : 0
        const d = c.data
        let changed = c.count !== n
        for (let k = 0; k < n; k++) {
          const p = list[k]!
          const o = k * 4
          changed = put(d, o, p[0]!) || changed
          changed = put(d, o + 1, p[1]!) || changed
          changed = put(d, o + 2, p[2]!) || changed
          // The line of sight: from the eye through the point, or the view direction (ortho).
          const f = cam!.forward
          let x = f[0]!
          let y = f[1]!
          let z = f[2]!
          if (!cam!.orthographic) {
            const e = cam!.position
            const dx = p[0]! - e[0]!
            const dy = p[1]! - e[1]!
            const dz = p[2]! - e[2]!
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
            if (len > 1e-5) {
              x = dx / len
              y = dy / len
              z = dz / len
            }
          }
          changed = put(d, DIRS + o, x) || changed
          changed = put(d, DIRS + o + 1, y) || changed
          changed = put(d, DIRS + o + 2, z) || changed
        }
        changed = put(d, PARAMS, radius[i]!) || changed
        changed = put(d, PARAMS + 1, margin[i]!) || changed
        changed = put(d, PARAMS + 2, edge[i]!) || changed
        changed = put(d, PARAMS + 3, n) || changed
        c.count = n
        if (n > 0) markCuts(c, store)
        if (n > 0 && (changed || c.written !== gpu.generation)) {
          c.written = gpu.generation
          c.buffer ??= new GpuBuffer(gpu, {
            label: `camera:${camera}/cutaway`,
            usage: GPUBufferUsage.UNIFORM,
            size: CUTAWAY_FLOATS * 4,
          })
          c.buffer.write(d)
        }
      }
    }
    // Cameras that lost the component (or despawned): only then is a camera unseen.
    let live = 0
    for (const table of q.tables) live += table.count
    if (state.cameras.size > live) {
      for (const [camera, c] of state.cameras) {
        if (c.frame === frame) continue
        c.buffer?.destroy()
        state.cameras.delete(camera)
      }
    }
  },
})

const EMPTY: readonly never[] = []
const box = new Float32Array(6)

/**
 * World bounds of a slot: its mesh's box through the slot's affine transform (centre, then
 * half-extents), into `box`.
 */
function slotBox(f: Float32Array, o: number, b: Float32Array): void {
  const cx = (b[0]! + b[3]!) * 0.5
  const cy = (b[1]! + b[4]!) * 0.5
  const cz = (b[2]! + b[5]!) * 0.5
  const ex = (b[3]! - b[0]!) * 0.5
  const ey = (b[4]! - b[1]!) * 0.5
  const ez = (b[5]! - b[2]!) * 0.5
  for (let r = 0; r < 3; r++) {
    const m = o + r * 4
    box[r] = f[m]! * cx + f[m + 1]! * cy + f[m + 2]! * cz + f[m + 3]!
    box[3 + r] = Math.abs(f[m]!) * ex + Math.abs(f[m + 1]!) * ey + Math.abs(f[m + 2]!) * ez
  }
}

/**
 * Whether the line of sight of point `k` reaches `box` grown by the radius: the ray from the point
 * (moved toward the camera by the margin) back toward the camera, against the grown box's slabs.
 * Conservative: the grown box holds every point within radius of the box.
 */
function reaches(d: Float32Array, k: number, radius: number, margin: number): boolean {
  const o = k * 4
  let t0 = 0
  let t1 = Number.POSITIVE_INFINITY
  for (let a = 0; a < 3; a++) {
    // Toward the camera: against the line of sight.
    const dir = -d[DIRS + o + a]!
    const start = d[o + a]! + dir * margin
    const lo = box[a]! - box[3 + a]! - radius
    const hi = box[a]! + box[3 + a]! + radius
    if (Math.abs(dir) < 1e-9) {
      if (start < lo || start > hi) return false
      continue
    }
    let near = (lo - start) / dir
    let far = (hi - start) / dir
    if (near > far) {
      const t = near
      near = far
      far = t
    }
    if (near > t0) t0 = near
    if (far < t1) t1 = far
    if (t0 > t1) return false
  }
  return true
}

/**
 * Marks the batches a camera's points can cut: those with a Cutaway instance whose world box,
 * grown by the radius, a line of sight reaches in front of its point. Structure draws a chunk per
 * batch, so only chunks near the lines of sight take the cutaway variant; a discard elsewhere
 * would cost every wall its early depth test (on a tiled GPU, its hidden-surface removal).
 */
function markCuts(c: CutawayCamera, store: InstanceStore): void {
  const batches = store.batches
  if (c.cuts.length < batches.length) c.cuts = new Uint8Array(batches.length * 2)
  const cuts = c.cuts
  const d = c.data
  const n = d[PARAMS + 3]!
  const radius = d[PARAMS]!
  const margin = d[PARAMS + 1]!
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!
    cuts[b] = 0
    if (batch.cutaway === 0) continue
    // LOD slots aren't members: such a batch can't be told apart, so it may always cut.
    if (batch.memberCount < batch.count) {
      cuts[b] = 1
      continue
    }
    for (let m = 0; m < batch.memberCount && cuts[b] === 0; m++) {
      const slot = batch.members[m]!
      const flags = store.flags[slot]!
      if ((flags & InstanceFlags.Cutaway) === 0) continue
      // A skinned pose may leave the mesh's bounds.
      if (flags & InstanceFlags.Skinned) {
        cuts[b] = 1
        break
      }
      slotBox(store.f32, slot * INSTANCE_FLOATS, batch.mesh.bounds)
      for (let k = 0; k < n; k++) {
        if (reaches(d, k, radius, margin)) {
          cuts[b] = 1
          break
        }
      }
    }
  }
}

/** What forward asks for: the group 3 layout, and a camera's bind group while it has points. */
function support(world: World): CutawaySupport {
  const state = world.resource(CutawayCameras)
  const layout = (gpu: GpuContext): GPUBindGroupLayout => {
    if (!state.layout || state.layout.generation !== gpu.generation) {
      state.layout = {
        layout: gpu.layouts.bindGroupLayout({
          label: 'cutaway',
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          ],
        }),
        generation: gpu.generation,
      }
    }
    return state.layout.layout
  }
  return {
    layout,
    cuts(camera: Entity, batch: number): boolean {
      const c = state.cameras.get(camera)
      return c !== undefined && c.frame === state.frame && c.count > 0 && c.cuts[batch] === 1
    },
    bindGroup(gpu: GpuContext, camera: Entity): GPUBindGroup | undefined {
      const c = state.cameras.get(camera)
      if (!c || c.frame !== state.frame || c.count <= 0 || !c.buffer) return undefined
      const buffer = c.buffer
      // Reading .buffer first: after a device loss it makes a new buffer, bumping its version.
      const gpuBuffer = buffer.buffer
      if (
        !c.bindGroup ||
        c.boundGeneration !== gpu.generation ||
        c.boundVersion !== buffer.version
      ) {
        c.bindGroup = gpu.device.createBindGroup({
          label: 'cutaway',
          layout: layout(gpu),
          entries: [{ binding: 0, resource: { buffer: gpuBuffer } }],
        })
        c.boundGeneration = gpu.generation
        c.boundVersion = buffer.version
      }
      return c.bindGroup
    },
  }
}

/** render.describe's cutaways section: per camera, its reveal points, radius, margin and edge. */
export function describeCutaways(world: World) {
  const out: Record<string, unknown> = {}
  world.query({ with: [Camera3d, CutawayView] }).each((camera, row, table) => {
    const points = (table.column(CutawayView, 'points')[row] ?? []) as ArrayLike<number>[]
    out[`camera:${camera}`] = {
      points: Array.from(points.slice(0, MAX_REVEAL_POINTS), (p) => [p[0], p[1], p[2]]),
      ignored: Math.max(0, points.length - MAX_REVEAL_POINTS),
      radius: table.column(CutawayView, 'radius')[row],
      margin: table.column(CutawayView, 'margin')[row],
      edge: table.column(CutawayView, 'edge')[row],
    }
  })
  return out
}

/**
 * Cutaways (0070): Cutaway renderables open around a camera's CutawayView points, in every camera
 * pass and no shadow pass. Cameras without reveal points draw the plain variants.
 */
export const cutawayPlugin = definePlugin({
  name: 'render/cutaway',
  dependencies: ['render/forward'],
  provides: [CutawayCameras],
  build(app) {
    app.world.initResource(CutawayCameras)
    app.insertResource(CutawayPath, support(app.world))
    app.addSystems(Last, extractCutaways.inSet(RenderSet.Prepare).after(prepareInstances))
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), CUTAWAY_SHADERS)
    app.world.initResource(RenderDescribers).set('cutaways', describeCutaways)
    addRenderFeatures(app.world, {
      name: 'render/cutaway',
      description: "Cutaway surfaces opened around cameras' reveal points.",
      nodes: [],
      baseline: { strategy: 'The same discard; points in a uniform block' },
    })
  },
})
