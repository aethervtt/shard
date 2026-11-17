import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Entity,
  mat4,
  ProfilerResource,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  type CameraData,
  ComputedVisibility,
  cameraOf,
  clearUnsupported,
  DataStore,
  dataEntry,
  depthReadEntry,
  drivingView,
  ForwardStateResource,
  Gpu,
  GpuAssetsResource,
  Meshes,
  type NodeContext,
  type NodeDescriptor,
  RenderPhase,
  reportUnsupported,
  Shaders,
} from '@aethervtt/shard-render'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { type Texture, Textures } from '@aethervtt/shard-texture'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { ParticleEmitterOverrides, ParticleSystem } from './components'
import {
  type EmitterDef,
  type ParticleEffect,
  type ParticleEffectStore,
  ParticleEffects,
} from './effect'
import { type CpuParticle, MODULES } from './modules'
import {
  BURST_BYTES,
  DRAW_BYTES,
  emitterKey,
  PARTICLE_FLOATS,
  renderShader,
  SIM_BYTES,
  SORT_SHADER,
  simulationShader,
} from './shaders'
import { pcg, rand } from './values'

const PARTICLE_BYTES = PARTICLE_FLOATS * 4
/** Alpha emitters up to this capacity sort by depth; larger ones draw unsorted. */
export const MAX_SORTED = 65536

/** One emitter of a running system: its particles, spawn schedule, and GPU objects. */
export interface EmitterState {
  def: EmitterDef
  key: string
  capacity: number
  /** Storage on the full tier, a data texture on baseline (0064). */
  particles: DataStore
  /** CPU backend: the particles, uploaded whole each frame. */
  cpu: Float32Array | undefined
  /** `cpu` as u32 (seeds). */
  cpuBits: Uint32Array | undefined
  /** CPU backend, sorted emitters: order-preserving key bits and slot, packed per particle. */
  cpuSort: Float64Array | undefined
  sim: GpuBuffer
  draw: GpuBuffer
  counter: GPUBuffer
  readbacks: { buffer: GPUBuffer; busy: boolean }[]
  /** Spawns so far: the next particle's slot is spawned % capacity. */
  spawned: number
  carry: number
  /** Bursts fired so far, per burst. */
  fired: number[]
  spawnCount: number
  /** Spawns waiting for a dispatch (the GPU skipped a frame while compiling). */
  backlog: number
  /** Alive particles from the last readback (a frame or two late). */
  alive: number
  /** System time of the last spawn: its particles live until lifetime max after it. */
  lastSpawn: number
  /** Sorting (alpha, small enough): keys, order, and per-step uniforms. */
  sort:
    | { keys: GPUBuffer; order: DataStore; steps: GPUBuffer; count: number; n: number }
    | undefined
  /** Simulated this frame (culled emitters may pause or step less often). */
  simulate: boolean
  dt: number
  visible: boolean
  /**
   * Floating-origin offset (spec 0040) the GPU hasn't applied yet: world-space particles move by it
   * in the next update dispatch. Accumulates while the emitter isn't simulated.
   */
  originShift: Float64Array
  /** An effect's bursts (0128): what spawns this frame instead of the rate. */
  bursts: BurstQueue | undefined
}

/** Floats per queued burst. */
const BURST_FLOATS = BURST_BYTES / 4

/**
 * One-off bursts of one emitter waiting for a dispatch (0128), `BURST_FLOATS` each: the origin and
 * seed, the shape's x axis and first spawn index, its y axis (the direction) and count. The `Burst`
 * struct in WGSL reads the same bytes. Grows by doubling, never shrinks.
 */
export interface BurstQueue {
  data: Float32Array
  bits: Uint32Array
  /** Bursts queued. */
  count: number
  /** Their particles. */
  total: number
  /** The bursts prepare spawns this frame; ones emitted after it wait for the next. */
  sent: number
  /** The queue on the GPU (full tier only). */
  buffer: GPUBuffer | undefined
  /** The compute pipelines' cache key: the emitter's, for its burst variant. */
  key: string
}

export interface SystemState {
  /** Undefined for an effect's bursts (0128), which no entity runs. */
  entity: Entity | undefined
  /** Names its cached bind groups: the entity, or the effect's bursts. */
  slot: string
  effect: ParticleEffect
  version: number
  emitters: EmitterState[]
  time: number
  seed: number
  local: boolean
  cpu: boolean
  /** The CPU backend because the device runs the baseline tier (0064), not by choice. */
  forced: boolean
  model: Float32Array
  /** Bounding sphere (world) of the system, for culling. */
  center: Float32Array
  radius: number
  frame: number
  seen: number
  /** An effect's bursts (0128): the effect, and bursts emitted so far (default seeds). */
  pool: { guid: string; path: string | undefined; emitted: number } | undefined
}

/** Running particle systems by entity. */
export class ParticleStore {
  readonly systems = new Map<Entity, SystemState>()
  /** Each effect's one-off bursts (0128), by effect guid: one simulation per effect and backend. */
  readonly bursts = new Map<string, SystemState>()
  readonly cpuBursts = new Map<string, SystemState>()
  frame = 0
  /** The view whose camera simulation uses (depth collision, culling, sorting). */
  primary: string | undefined
  primaryCamera: CameraData | undefined
}

export const Particles = defineResource<ParticleStore>('particles/Particles', {
  description: 'Running particle systems: GPU buffers, spawn schedules, alive counts.',
  init: () => new ParticleStore(),
})

// --- spawning ------------------------------------------------------------------------------

/** How many particles an emitter spawns this step (rate × dt carried over, plus bursts). */
function spawnCount(e: EmitterState, time: number, dt: number, rate: number): number {
  e.carry += rate * dt
  let n = Math.floor(e.carry)
  e.carry -= n
  e.def.spawn.bursts.forEach((b, i) => {
    const fired = e.fired[i] ?? 0
    if (b.cycles > 0 && fired >= b.cycles) return
    const at = b.time + fired * b.interval
    if (time >= at && (fired === 0 || b.interval > 0)) {
      n += b.count
      e.fired[i] = fired + 1
    }
  })
  return Math.min(n, e.capacity)
}

// --- the CPU backend -----------------------------------------------------------------------

const cpuParticle: CpuParticle = {
  pos: new Float32Array(3),
  vel: new Float32Array(3),
  age: 0,
  life: 0,
  rot: 0,
  rotSpeed: 0,
  seed: 0,
}

/** A random unit direction from the seed's streams k0 and k0 + 1, into `out`. */
function randomDirection(seed: number, k0: number, out: Float32Array): void {
  const z = rand(seed, k0) * 2 - 1
  const phi = 6.2831853 * rand(seed, k0 + 1)
  const r = Math.sqrt(Math.max(1 - z * z, 0))
  out[0] = r * Math.cos(phi)
  out[1] = z
  out[2] = r * Math.sin(phi)
}

function mixRange(r: [number, number], t: number): number {
  return r[0] + (r[1] - r[0]) * t
}

const spawnDirection = new Float32Array(3)

/** The CPU versions of an emitter's update modules, resolved once a frame (not per particle). */
const cpuSteps: NonNullable<(typeof MODULES)[string]['cpu']>[] = []
const cpuStepParams: Record<string, unknown>[] = []

const burstModel = new Float32Array(16)

/** Spawn and update in TypeScript, with the same formulas and random streams as the shaders. */
function simulateCpu(e: EmitterState, sys: SystemState, dt: number): void {
  const d = e.cpu!
  if (!e.cpuBits || e.cpuBits.buffer !== d.buffer) e.cpuBits = new Uint32Array(d.buffer)
  const u = e.cpuBits
  const q = e.bursts
  if (q) {
    // Each burst in its own frame, its i-th particle seeded pcg(seed ^ pcg(i)), as the shader does.
    const m = burstModel
    const f = q.data
    for (let b = 0; b < q.count; b++) {
      const o = b * BURST_FLOATS
      m[0] = f[o + 4]!
      m[1] = f[o + 5]!
      m[2] = f[o + 6]!
      m[4] = f[o + 8]!
      m[5] = f[o + 9]!
      m[6] = f[o + 10]!
      // z = x × y
      m[8] = m[1]! * m[6]! - m[2]! * m[5]!
      m[9] = m[2]! * m[4]! - m[0]! * m[6]!
      m[10] = m[0]! * m[5]! - m[1]! * m[4]!
      m[12] = f[o]!
      m[13] = f[o + 1]!
      m[14] = f[o + 2]!
      const seed = q.bits[o + 3]!
      const base = q.bits[o + 7]!
      const count = Math.min(q.bits[o + 11]!, e.spawnCount - base)
      for (let i = 0; i < count; i++) {
        const slot = (e.spawned + base + i) % e.capacity
        spawnCpu(e, d, u, slot, pcg((seed ^ pcg(i)) >>> 0), m)
      }
    }
  } else {
    const model = sys.local ? undefined : sys.model
    for (let i = 0; i < e.spawnCount; i++) {
      const k = e.spawned + i
      spawnCpu(e, d, u, k % e.capacity, pcg((sys.seed ^ pcg(k)) >>> 0), model)
    }
  }
  updateCpu(e, d, u, sys, dt)
}

/** One new particle at `slot`: the shape in the emitter's space, then through `g` (a mat4) if any. */
function spawnCpu(
  e: EmitterState,
  d: Float32Array,
  u: Uint32Array,
  slot: number,
  seed: number,
  g: Float32Array | undefined,
): void {
  const def = e.def
  const s = def.shape
  const init = def.init
  let px = 0
  let py = 0
  let pz = 0
  let dx = 0
  let dy = 1
  let dz = 0
  if (s.type === 'point' || s.type === 'sphere') {
    randomDirection(seed, 6, spawnDirection)
    dx = spawnDirection[0]!
    dy = spawnDirection[1]!
    dz = spawnDirection[2]!
  }
  if (s.type === 'point') {
    // The direction alone.
  } else if (s.type === 'sphere') {
    const r = s.radius * rand(seed, 9) ** 0.3333333
    px = dx * r
    py = dy * r
    pz = dz * r
  } else if (s.type === 'cone') {
    const a = ((s.angle * Math.PI) / 180) * Math.sqrt(rand(seed, 6))
    const phi = 6.2831853 * rand(seed, 7)
    dx = Math.sin(a) * Math.cos(phi)
    dy = Math.cos(a)
    dz = Math.sin(a) * Math.sin(phi)
    const r = s.radius * Math.sqrt(rand(seed, 8))
    px = Math.cos(phi) * r
    pz = Math.sin(phi) * r
  } else {
    px = (rand(seed, 6) - 0.5) * s.size[0]
    py = (rand(seed, 7) - 0.5) * s.size[1]
    pz = (rand(seed, 8) - 0.5) * s.size[2]
  }
  const speed = mixRange(init.speed, rand(seed, 1))
  const p = cpuParticle
  p.pos[0] = px
  p.pos[1] = py
  p.pos[2] = pz
  p.vel[0] = dx * speed
  p.vel[1] = dy * speed
  p.vel[2] = dz * speed
  p.life = Math.max(mixRange(init.lifetime, rand(seed, 2)), 1e-3)
  p.seed = seed
  p.rotSpeed = 0
  for (const m of def.update) MODULES[m.module as string]!.cpuInit?.(m, p)
  if (g) {
    const x = p.pos[0]!
    const y = p.pos[1]!
    const z = p.pos[2]!
    for (let a = 0; a < 3; a++) {
      p.pos[a] = g[a]! * x + g[4 + a]! * y + g[8 + a]! * z + g[12 + a]!
    }
    const vx = p.vel[0]!
    const vy = p.vel[1]!
    const vz = p.vel[2]!
    for (let a = 0; a < 3; a++) p.vel[a] = g[a]! * vx + g[4 + a]! * vy + g[8 + a]! * vz
  }
  const o = slot * PARTICLE_FLOATS
  d.set(p.pos, o)
  d[o + 3] = 0
  d.set(p.vel, o + 4)
  d[o + 7] = p.life
  d[o + 8] = mixRange(init.size, rand(seed, 3))
  d[o + 9] = (mixRange(init.rotation, rand(seed, 4)) * Math.PI) / 180
  d[o + 10] = p.rotSpeed
  u[o + 11] = seed
  const c = rand(seed, 5)
  for (let a = 0; a < 4; a++)
    d[o + 12 + a] = init.color[0][a]! + (init.color[1][a]! - init.color[0][a]!) * c
}

/** Ages every living particle, runs the modules on it, and moves it. */
function updateCpu(
  e: EmitterState,
  d: Float32Array,
  u: Uint32Array,
  sys: SystemState,
  dt: number,
): void {
  const def = e.def
  let steps = 0
  for (const m of def.update) {
    const step = MODULES[m.module as string]!.cpu
    if (!step) continue
    cpuSteps[steps] = step
    cpuStepParams[steps] = m
    steps++
  }
  const time = sys.time
  let alive = 0
  for (let i = 0; i < e.capacity; i++) {
    const o = i * PARTICLE_FLOATS
    const life = d[o + 7]!
    let age = d[o + 3]!
    if (!(life > 0 && age < life)) continue
    const p = cpuParticle
    p.pos[0] = d[o]!
    p.pos[1] = d[o + 1]!
    p.pos[2] = d[o + 2]!
    p.vel[0] = d[o + 4]!
    p.vel[1] = d[o + 5]!
    p.vel[2] = d[o + 6]!
    age += dt
    p.age = age
    p.life = life
    p.rot = d[o + 9]!
    p.rotSpeed = d[o + 10]!
    p.seed = u[o + 11]!
    for (let k = 0; k < steps; k++) cpuSteps[k]!(cpuStepParams[k]!, p, dt, time)
    const vel = p.vel
    const pos = p.pos
    d[o] = pos[0]! + vel[0]! * dt
    d[o + 1] = pos[1]! + vel[1]! * dt
    d[o + 2] = pos[2]! + vel[2]! * dt
    d[o + 3] = p.age
    d[o + 4] = vel[0]!
    d[o + 5] = vel[1]!
    d[o + 6] = vel[2]!
    d[o + 9] = p.rot
    if (p.age < life) alive++
  }
  e.alive = alive
}

// --- preparing -----------------------------------------------------------------------------

const simScratch = new Float32Array(SIM_BYTES / 4)
const simU32 = new Uint32Array(simScratch.buffer)
const drawScratch = new Float32Array(DRAW_BYTES / 4)
const drawU32 = new Uint32Array(drawScratch.buffer)
const identity = mat4.create()
const zeros = new Uint32Array(4)
const BLEND_INDEX = { additive: 0, alpha: 1, premultiplied: 2 } as const

function createEmitter(
  gpu: GpuContext,
  slot: string,
  def: EmitterDef,
  cpu: boolean,
  previous: EmitterState | undefined,
  bursts = false,
): EmitterState {
  const keep = previous && previous.capacity === def.capacity
  const sortable = def.render.blend !== 'additive' && def.capacity <= MAX_SORTED
  const n = sortable ? 2 ** Math.ceil(Math.log2(Math.max(2, def.capacity))) : 0
  const steps = sortable ? (Math.log2(n) * (Math.log2(n) + 1)) / 2 : 0
  const label = `particles/${slot}/${def.name}`
  const state: EmitterState = {
    def,
    key: emitterKey(def),
    capacity: def.capacity,
    particles: keep
      ? previous.particles
      : new DataStore(gpu, {
          label,
          usage: GPUBufferUsage.COPY_SRC,
          size: def.capacity * PARTICLE_BYTES,
        }),
    cpu: cpu
      ? keep && previous.cpu
        ? previous.cpu
        : new Float32Array(def.capacity * PARTICLE_FLOATS)
      : undefined,
    cpuBits: undefined,
    cpuSort: cpu && sortable ? new Float64Array(def.capacity) : undefined,
    sim:
      previous?.sim ??
      new GpuBuffer(gpu, { label: `${label}/sim`, usage: GPUBufferUsage.UNIFORM, size: SIM_BYTES }),
    draw:
      previous?.draw ??
      new GpuBuffer(gpu, {
        label: `${label}/draw`,
        usage: GPUBufferUsage.UNIFORM,
        size: DRAW_BYTES,
      }),
    counter:
      previous?.counter ??
      gpu.device.createBuffer({
        label: `${label}/alive`,
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
    readbacks:
      previous?.readbacks ??
      [0, 1, 2].map(() => ({
        buffer: gpu.device.createBuffer({
          label: `${label}/alive-readback`,
          size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
      })),
    spawned: keep ? previous.spawned : 0,
    carry: keep ? previous.carry : 0,
    fired: keep ? previous.fired : [],
    spawnCount: 0,
    backlog: 0,
    alive: keep ? previous.alive : 0,
    lastSpawn: keep ? previous.lastSpawn : Number.NEGATIVE_INFINITY,
    sort: sortable
      ? {
          keys: gpu.device.createBuffer({
            label: `${label}/keys`,
            size: n * 4,
            usage: GPUBufferUsage.STORAGE,
          }),
          order: new DataStore(gpu, { label: `${label}/order`, size: n * 4 }),
          steps: gpu.device.createBuffer({
            label: `${label}/steps`,
            size: (steps + 1) * 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          }),
          count: steps,
          n,
        }
      : undefined,
    simulate: true,
    dt: 0,
    visible: true,
    originShift: keep ? previous.originShift : new Float64Array(3),
    bursts: bursts
      ? burstQueue(keep ? previous.bursts : undefined, `${emitterKey(def)}/bursts`)
      : undefined,
  }
  if (state.sort) writeSortSteps(gpu, state.sort, def.capacity)
  return state
}

/** An emitter's burst queue: the previous one's (its bursts still to come), or a new one. */
function burstQueue(previous: BurstQueue | undefined, key: string): BurstQueue {
  if (previous) {
    previous.key = key
    return previous
  }
  const data = new Float32Array(16 * BURST_FLOATS)
  return {
    data,
    bits: new Uint32Array(data.buffer),
    count: 0,
    total: 0,
    sent: 0,
    buffer: undefined,
    key,
  }
}

/** Bitonic step uniforms (j, k, n, capacity per 256-byte slot; slot 0 for the key pass). */
function writeSortSteps(
  gpu: GpuContext,
  s: NonNullable<EmitterState['sort']>,
  capacity: number,
): void {
  const data = new Uint32Array((s.count + 1) * 64)
  data[2] = s.n
  data[3] = capacity
  let slot = 1
  for (let k = 2; k <= s.n; k *= 2) {
    for (let j = k / 2; j >= 1; j = Math.floor(j / 2)) {
      data[slot * 64] = j
      data[slot * 64 + 1] = k
      data[slot * 64 + 2] = s.n
      data[slot * 64 + 3] = capacity
      slot++
    }
  }
  gpu.device.queue.writeBuffer(s.steps, 0, data)
}

/** The system's reach: shape radius plus how far its fastest particle can travel. */
function reach(effect: ParticleEffect): number {
  let r = 0
  for (const e of effect.emitters) {
    if (e.bounds > 0) {
      r = Math.max(r, e.bounds)
      continue
    }
    const size = Math.max(...e.shape.size)
    r = Math.max(
      r,
      e.shape.radius + size + e.init.speed[1] * e.init.lifetime[1] * 1.5 + e.init.size[1],
    )
  }
  return r
}

/**
 * Advances every ParticleSystem: spawn counts, uniforms, culling against the driving camera
 * (`viewCamera`), and the CPU backend. The GPU work runs in the `particles/simulate` node.
 */
export const prepareParticles = defineSystem({
  name: 'particles/prepare',
  description: 'Schedules spawns, writes particle uniforms, and runs the CPU backend.',
  setup: (world) => ({
    q: world.query({ with: [ParticleSystem, GlobalTransform, ComputedVisibility] }),
    cameras: world.query({ with: [Camera3d] }),
  }),
  run: ({ q, cameras }, world) => {
    const store = world.resource(Particles)
    const gpu = world.resource(Gpu)
    const effects = world.resource(ParticleEffects)
    const time = world.resource(Time)
    store.frame++
    // The primary camera: the one that drives view-dependent work (any layer; systems have none).
    const primary = drivingView(world, cameras, 0xffff)
    store.primary = primary?.name
    store.primaryCamera = primary ? cameraOf(primary) : undefined
    const cam = store.primaryCamera
    /** Systems with particles in the air or still to come: on-demand apps keep rendering (0052). */
    let live = false
    for (const table of q.tables) {
      const effectRefs = table.column(ParticleSystem, 'effect')
      const playing = table.column(ParticleSystem, 'playing')
      const seeds = table.column(ParticleSystem, 'seed')
      const scales = table.column(ParticleSystem, 'timeScale')
      const spaces = table.column(ParticleSystem, 'space')
      const backends = table.column(ParticleSystem, 'backend')
      const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
      const vis = table.column(ComputedVisibility, 'visible')
      const overrides = table.has(ParticleEmitterOverrides)
      for (let i = 0; i < table.count; i++) {
        const entity = table.entities[i]!
        const effect = effects.get(effectRefs[i] as AssetRef<'ParticleEffect'>)
        if (!effect || !vis[i]) continue
        // Baseline has no compute (0064): its systems run the CPU backend whatever they ask for.
        const forced = gpu.tier === 'baseline' && backends[i] !== 1
        const cpu = backends[i] === 1 || forced
        let sys = store.systems.get(entity)
        if (!sys || sys.effect !== effect || sys.version !== effect.version || sys.cpu !== cpu) {
          const old = sys
          const slot = `${entity}`
          sys = {
            entity,
            slot,
            effect,
            version: effect.version,
            emitters: effect.emitters.map((def, k) => {
              const prev = old?.effect === effect ? old.emitters[k] : undefined
              return createEmitter(
                gpu,
                slot,
                def,
                cpu,
                prev && prev.def.name === def.name ? prev : undefined,
              )
            }),
            time: old?.effect === effect ? old.time : 0,
            seed: seeds[i]!,
            local: spaces[i] === 1,
            cpu,
            forced,
            model: new Float32Array(16),
            center: new Float32Array(3),
            radius: reach(effect),
            frame: 0,
            seen: 0,
            pool: undefined,
          }
          store.systems.set(entity, sys)
        }
        sys.seen = store.frame
        sys.seed = seeds[i]!
        sys.local = spaces[i] === 1
        // The transform as a mat4 (columns).
        const o = i * 12
        const m = sys.model
        m[0] = g[o]!
        m[1] = g[o + 4]!
        m[2] = g[o + 8]!
        m[3] = 0
        m[4] = g[o + 1]!
        m[5] = g[o + 5]!
        m[6] = g[o + 9]!
        m[7] = 0
        m[8] = g[o + 2]!
        m[9] = g[o + 6]!
        m[10] = g[o + 10]!
        m[11] = 0
        m[12] = g[o + 3]!
        m[13] = g[o + 7]!
        m[14] = g[o + 11]!
        m[15] = 1
        sys.center[0] = m[12]!
        sys.center[1] = m[13]!
        sys.center[2] = m[14]!
        const visible = !cam || sphereVisible(cam.frustum, sys.center, sys.radius)
        const dt = playing[i] ? time.delta * scales[i]! : 0
        sys.frame++
        if (dt > 0) sys.time += dt
        for (const e of sys.emitters) {
          e.visible = visible
          // Off screen: keep simulating, pause, or step every fourth frame.
          const mode = e.def.offscreen
          e.simulate = visible || mode === 'simulate' || (mode === 'reduced' && sys.frame % 4 === 0)
          e.dt = visible || mode === 'simulate' ? dt : mode === 'reduced' ? dt * 4 : 0
          if (!e.simulate) e.dt = 0
          let rate = e.def.spawn.rate
          if (overrides) {
            const name = table.column(ParticleEmitterOverrides, 'emitter')[i]
            if (!name || name === e.def.name) {
              const r = table.column(ParticleEmitterOverrides, 'spawnRate')[i]!
              if (r >= 0) rate = r
              rate *= table.column(ParticleEmitterOverrides, 'spawnScale')[i]!
            }
          }
          // Spawns the GPU couldn't dispatch last frame (pipelines compiling) carry over.
          e.spawnCount = Math.min(
            e.capacity,
            e.backlog + (e.dt > 0 ? spawnCount(e, sys.time, e.dt, rate) : 0),
          )
          e.backlog = e.spawnCount
          if (e.spawnCount > 0) e.lastSpawn = sys.time
          if (
            dt > 0 &&
            (rate > 0 || burstPending(e) || sys.time - e.lastSpawn <= e.def.init.lifetime[1])
          )
            live = true
          writeUniforms(e, sys, cam)
          if (sys.cpu && e.cpu) {
            simulateCpu(e, sys, e.dt)
            e.particles.write(e.cpu)
            e.spawned += e.spawnCount
            e.backlog = 0
            if (e.sort && e.cpuSort && cam) sortCpu(e, sys, cam.view)
          }
        }
      }
    }
    for (const [entity, sys] of store.systems) {
      if (sys.seen !== store.frame) store.systems.delete(entity)
    }
    if (prepareBursts(store.bursts, effects, gpu, cam, time.delta)) live = true
    if (prepareBursts(store.cpuBursts, effects, gpu, cam, time.delta)) live = true
    world.tryResource(FrameDemand)?.set('particles', live)
    if (gpu.tier === 'baseline') reportCpuOnly(world, store)
  },
})

// --- one-off bursts (0128) --------------------------------------------------------------------

/** A one-off burst of an effect (`emitParticles`). */
export interface ParticleBurst {
  /** Where (world). */
  position: ArrayLike<number>
  /**
   * Where the emitter's shape points (its +y: a cone's axis), in world space. Any length; default
   * up, which spawns as a ParticleSystem with no rotation would.
   */
  direction?: ArrayLike<number>
  /** Particles from each emitter (fewer if its capacity is full this frame). */
  count: number
  /** The same seed spawns the same particles. Default: one per burst of the effect, in call order. */
  seed?: number
  /** The emitter to spawn from (empty: every emitter of the effect). */
  emitter?: string
  /** As ParticleSystem.backend: 'cpu' simulates this effect's bursts in TypeScript. */
  backend?: 'gpu' | 'cpu'
}

const burstAxes = new Float32Array(6)

/**
 * Spawns `count` particles of each of an effect's emitters at `position` this frame, the emitter's
 * shape turned to point along `direction`, in world space (0128). No entity: every burst of an
 * effect shares one simulation per backend, and a frame's bursts spawn in one dispatch per emitter.
 * The effect's own rate and authored bursts don't run there. Returns the particles queued: 0 while
 * the effect isn't loaded.
 */
export function emitParticles(
  world: World,
  effect: { readonly guid: string | undefined; readonly path?: string },
  burst: ParticleBurst,
): number {
  const guid = effect.guid
  if (guid === undefined) return 0
  const store = world.resource(Particles)
  const gpu = world.resource(Gpu)
  // Baseline has no compute (0064): bursts run the CPU backend there too.
  const forced = gpu.tier === 'baseline' && burst.backend !== 'cpu'
  const cpu = burst.backend === 'cpu' || forced
  const pools = cpu ? store.cpuBursts : store.bursts
  let sys = pools.get(guid)
  if (!sys) {
    const asset = world.resource(ParticleEffects).byGuid(guid)
    if (!asset) return 0
    sys = createPool(gpu, guid, effect.path, asset, cpu, forced)
    pools.set(guid, sys)
  }
  const pool = sys.pool!
  const seed = burst.seed === undefined ? pcg(pool.emitted) : burst.seed >>> 0
  pool.emitted++
  turnUp(burst.direction, burstAxes)
  const at = burst.position
  let queued = 0
  for (const e of sys.emitters) {
    if (burst.emitter && burst.emitter !== e.def.name) continue
    queued += queueBurst(e, at[0]!, at[1]!, at[2]!, seed, burst.count)
  }
  return queued
}

/**
 * The rotation that turns +y onto `direction` by the shortest arc, as its x and y axes into
 * `out` (z is x × y). Up, or no direction, is the identity.
 */
function turnUp(direction: ArrayLike<number> | undefined, out: Float32Array): void {
  let dx = 0
  let dy = 1
  let dz = 0
  if (direction) {
    const l = Math.sqrt(direction[0]! ** 2 + direction[1]! ** 2 + direction[2]! ** 2)
    if (l > 0) {
      dx = direction[0]! / l
      dy = direction[1]! / l
      dz = direction[2]! / l
    }
  }
  if (dy < -0.99999) {
    // Straight down: half a turn about x.
    out[0] = 1
    out[1] = out[2] = 0
  } else {
    // Rodrigues' formula for the arc from +y to d: R = I + [v]× + [v]×² / (1 + d.y), v = y × d.
    const k = 1 / (1 + dy)
    out[0] = 1 - k * dx * dx
    out[1] = -dx
    out[2] = -k * dx * dz
  }
  out[3] = dx
  out[4] = dy
  out[5] = dz
}

/** Queues one burst on an emitter, as many particles as its capacity has room for this frame. */
function queueBurst(
  e: EmitterState,
  x: number,
  y: number,
  z: number,
  seed: number,
  count: number,
): number {
  const q = e.bursts!
  const n = Math.min(Math.floor(count), e.capacity - q.total)
  if (!(n > 0)) return 0
  if ((q.count + 1) * BURST_FLOATS > q.data.length) {
    const data = new Float32Array(q.data.length * 2)
    data.set(q.data)
    q.data = data
    q.bits = new Uint32Array(data.buffer)
  }
  const f = q.data
  const o = q.count * BURST_FLOATS
  const a = burstAxes
  f[o] = x
  f[o + 1] = y
  f[o + 2] = z
  q.bits[o + 3] = seed
  f[o + 4] = a[0]!
  f[o + 5] = a[1]!
  f[o + 6] = a[2]!
  q.bits[o + 7] = q.total
  f[o + 8] = a[3]!
  f[o + 9] = a[4]!
  f[o + 10] = a[5]!
  q.bits[o + 11] = n
  q.count++
  q.total += n
  return n
}

/** An effect's bursts: a system no entity runs, in world space, with a burst queue per emitter. */
function createPool(
  gpu: GpuContext,
  guid: string,
  path: string | undefined,
  effect: ParticleEffect,
  cpu: boolean,
  forced: boolean,
): SystemState {
  const slot = `bursts/${cpu ? 'cpu' : 'gpu'}/${guid}`
  return {
    entity: undefined,
    slot,
    effect,
    version: effect.version,
    emitters: effect.emitters.map((def) => createEmitter(gpu, slot, def, cpu, undefined, true)),
    time: 0,
    seed: 0,
    local: false,
    cpu,
    forced,
    model: mat4.create(),
    center: new Float32Array(3),
    // Bursts go anywhere: never culled as a whole.
    radius: Number.POSITIVE_INFINITY,
    frame: 0,
    seen: 0,
    pool: { guid, path, emitted: 0 },
  }
}

/**
 * Each effect's bursts for this frame: the spawn count is what was queued, and an emitter whose
 * particles have all died neither simulates nor draws. Returns whether any is live (0052).
 */
function prepareBursts(
  pools: Map<string, SystemState>,
  effects: ParticleEffectStore,
  gpu: GpuContext,
  cam: CameraData | undefined,
  delta: number,
): boolean {
  let live = false
  for (const sys of pools.values()) {
    const effect = effects.byGuid(sys.pool!.guid)
    if (!effect) {
      pools.delete(sys.pool!.guid)
      continue
    }
    if (effect !== sys.effect || effect.version !== sys.version) {
      // Hot reload: emitters that kept their name and capacity keep their particles and queue.
      const old = sys.emitters
      sys.emitters = effect.emitters.map((def, k) => {
        const prev = sys.effect === effect ? old[k] : undefined
        return createEmitter(
          gpu,
          sys.slot,
          def,
          sys.cpu,
          prev && prev.def.name === def.name ? prev : undefined,
          true,
        )
      })
      sys.effect = effect
      sys.version = effect.version
    }
    sys.frame++
    if (delta > 0) sys.time += delta
    for (const e of sys.emitters) {
      const q = e.bursts!
      e.spawnCount = Math.min(e.capacity, q.total)
      q.sent = q.count
      if (e.spawnCount > 0) e.lastSpawn = sys.time
      const active = e.spawnCount > 0 || sys.time - e.lastSpawn <= e.def.init.lifetime[1]
      e.simulate = e.visible = active
      e.dt = active ? delta : 0
      if (!active) continue
      if (delta > 0) live = true
      writeUniforms(e, sys, cam)
      if (sys.cpu && e.cpu) {
        simulateCpu(e, sys, e.dt)
        e.particles.write(e.cpu)
        e.spawned += e.spawnCount
        takeBursts(q, e.spawnCount)
        if (e.sort && e.cpuSort && cam) sortCpu(e, sys, cam.view)
      } else if (q.count > 0) {
        // Kept until a dispatch takes them: a frame the pipelines were compiling uploads them again.
        gpu.device.queue.writeBuffer(burstBuffer(gpu, q), 0, q.data, 0, q.count * BURST_FLOATS)
      }
    }
  }
  return live
}

/**
 * Drops the bursts this frame spawned (`sent`, `spawned` particles). Any emitted after prepare move
 * to the front, for the next frame.
 */
function takeBursts(q: BurstQueue, spawned: number): void {
  const rest = q.count - q.sent
  if (rest > 0) {
    q.data.copyWithin(0, q.sent * BURST_FLOATS, q.count * BURST_FLOATS)
    for (let b = 0; b < rest; b++) q.bits[b * BURST_FLOATS + 7]! -= spawned
  }
  q.count = rest
  q.total -= spawned
  q.sent = 0
}

/** The queue's GPU buffer, as large as its CPU side. */
function burstBuffer(gpu: GpuContext, q: BurstQueue): GPUBuffer {
  if (!q.buffer || q.buffer.size < q.data.byteLength) {
    q.buffer = gpu.device.createBuffer({
      label: 'particles/bursts',
      size: q.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
  }
  return q.buffer
}

const keyFloat = new Float32Array(1)
const keyBits = new Uint32Array(keyFloat.buffer)

/**
 * The CPU backend's depth sort, as the GPU's: by view-space z, far first, dead slots last. Each
 * slot packs its key's order-preserving bits above its index into one float64, so a plain numeric
 * sort orders them: no comparator, nothing allocated.
 */
function sortCpu(e: EmitterState, sys: SystemState, view: Float32Array): void {
  const d = e.cpu!
  const packed = e.cpuSort!
  const m = sys.model
  for (let i = 0; i < e.capacity; i++) {
    const o = i * PARTICLE_FLOATS
    let key = 3.0e38
    if (d[o + 7]! > 0 && d[o + 3]! < d[o + 7]!) {
      let x = d[o]!
      let y = d[o + 1]!
      let z = d[o + 2]!
      // Local-space particles sort in world, as the GPU's key pass puts them.
      if (sys.local) {
        const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
        x = wx
        y = wy
        z = wz
      }
      key = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!
    }
    keyFloat[0] = key
    const bits = keyBits[0]!
    // Negative floats sort reversed as bits: flip them all; positive ones get the top bit.
    const ordered = bits & 0x80000000 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0
    packed[i] = ordered * 65536 + i
  }
  packed.sort()
  const order = sortScratch(e.capacity)
  for (let i = 0; i < e.capacity; i++) order[i] = packed[i]! % 65536
  e.sort!.order.write(order, 0, 0, e.capacity)
}

let orderScratch = new Uint32Array(1024)
function sortScratch(n: number): Uint32Array {
  if (orderScratch.length < n) orderScratch = new Uint32Array(n)
  return orderScratch
}

const reportedModules = new WeakMap<World, Set<string>>()
const usedModules = new Set<string>()

/**
 * On the baseline tier (0064) systems run the CPU backend, which skips update modules that only
 * the GPU runs (depth collision): each one in use is reported as `render/feature-unsupported`,
 * and cleared once nothing uses it. Reports change only when that does. Render modules (color and
 * size over life) run in the draw's shader on either backend.
 */
function reportCpuOnly(world: World, store: ParticleStore): void {
  let reported = reportedModules.get(world)
  if (!reported) {
    reported = new Set()
    reportedModules.set(world, reported)
  }
  usedModules.clear()
  for (const sys of store.systems.values()) {
    if (!sys.forced) continue
    for (const e of sys.emitters) {
      for (const m of e.def.update) {
        const def = MODULES[m.module as string]!
        if (def.update && !def.cpu) usedModules.add(m.module as string)
      }
    }
  }
  for (const name of usedModules) {
    if (reported.has(name)) continue
    reported.add(name)
    reportUnsupported(
      world,
      `particles/${name}`,
      `The particle module "${name}" runs on the GPU backend only; the baseline tier runs particles on the CPU, without it`,
    )
  }
  for (const name of reported) {
    if (usedModules.has(name)) continue
    reported.delete(name)
    clearUnsupported(world, `particles/${name}`)
  }
}

/** Whether a burst will still fire: one with cycles left, or repeating forever. */
function burstPending(e: EmitterState): boolean {
  const bursts = e.def.spawn.bursts
  for (let i = 0; i < bursts.length; i++) {
    const b = bursts[i]!
    const fired = e.fired[i] ?? 0
    // As spawnCount fires them: the first time, then again only with an interval.
    if ((fired === 0 || b.interval > 0) && (b.cycles === 0 || fired < b.cycles)) return true
  }
  return false
}

function sphereVisible(planes: Float32Array, c: Float32Array, r: number): boolean {
  for (let p = 0; p < 6; p++) {
    const d =
      planes[p * 4]! * c[0]! +
      planes[p * 4 + 1]! * c[1]! +
      planes[p * 4 + 2]! * c[2]! +
      planes[p * 4 + 3]!
    if (d < -r) return false
  }
  return true
}

function writeUniforms(e: EmitterState, sys: SystemState, cam: CameraData | undefined): void {
  const s = simScratch
  s.set(sys.model, 0)
  s.set(sys.local ? identity : sys.model, 16)
  s.set(cam?.viewProj ?? identity, 32)
  s.set(cam?.invViewProj ?? identity, 48)
  if (cam) s.set(cam.position, 64)
  s[68] = cam?.width ?? 1
  s[69] = cam?.height ?? 1
  s[72] = e.dt
  s[73] = sys.time
  simU32[74] = e.capacity
  simU32[75] = e.spawned >>> 0
  simU32[76] = e.spawnCount
  simU32[77] = sys.seed
  simU32[78] = sys.local ? 1 : 0
  // The simulate node binds the primary camera's depth whenever there is one.
  simU32[79] = cam ? 1 : 0
  s[80] = e.originShift[0]!
  s[81] = e.originShift[1]!
  s[82] = e.originShift[2]!
  simU32[83] = e.bursts ? e.bursts.sent : 0
  e.sim.write(s)
  const d = drawScratch
  d.set(sys.model, 0)
  d[16] = e.def.render.emissive
  d[17] = e.def.render.softness
  d[18] = e.def.render.stretch
  d[19] = sys.local ? 1 : 0
  d[20] = Math.max(1, e.def.render.flipbook.columns)
  d[21] = Math.max(1, e.def.render.flipbook.rows)
  d[22] = e.def.render.flipbook.fps
  d[23] = 0
  drawU32[24] = BLEND_INDEX[e.def.render.blend]
  drawU32[25] = e.sort ? 1 : 0
  drawU32[26] = drawU32[27] = 0
  e.draw.write(d)
}

// --- GPU objects -----------------------------------------------------------------------------

interface Caches {
  generation: number
  layouts?: {
    sim: GPUBindGroupLayout
    simBursts: GPUBindGroupLayout
    sort: GPUBindGroupLayout
    data: GPUBindGroupLayout
    texture: GPUBindGroupLayout
    view: GPUBindGroupLayout
  }
  compute: Map<string, { spawn: GPUComputePipeline; update: GPUComputePipeline }>
  render: Map<string, GPURenderPipeline>
  sort?: { keys: GPUComputePipeline; sort: GPUComputePipeline }
  groups: Map<string, { key: string; group: GPUBindGroup }>
  white?: GPUTexture
  noDepth?: GPUTexture
  noOrder?: DataStore
  sampler?: GPUSampler
}

export const ParticleCaches = defineResource<Caches>('particles/Caches', {
  description: 'Pipelines and bind groups of the particle passes.',
  init: () => ({ generation: -1, compute: new Map(), render: new Map(), groups: new Map() }),
})

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

function caches(world: World, gpu: GpuContext): Caches {
  const c = world.initResource(ParticleCaches)
  if (c.generation !== gpu.generation) {
    c.generation = gpu.generation
    c.layouts = undefined
    c.compute.clear()
    c.render.clear()
    c.sort = undefined
    c.groups.clear()
    c.white = c.noDepth = undefined
    c.noOrder = undefined
    c.sampler = undefined
  }
  if (!c.layouts) {
    const C = GPUShaderStage.COMPUTE
    const V = GPUShaderStage.VERTEX
    const F = GPUShaderStage.FRAGMENT
    c.layouts = {
      sim: gpu.layouts.bindGroupLayout({
        label: 'particles/sim',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'storage' } },
          { binding: 1, visibility: C, buffer: { type: 'uniform' } },
          { binding: 2, visibility: C, texture: { sampleType: 'depth' } },
          { binding: 3, visibility: C, buffer: { type: 'storage' } },
        ],
      }),
      simBursts: gpu.layouts.bindGroupLayout({
        label: 'particles/sim-bursts',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'storage' } },
          { binding: 1, visibility: C, buffer: { type: 'uniform' } },
          { binding: 2, visibility: C, texture: { sampleType: 'depth' } },
          { binding: 3, visibility: C, buffer: { type: 'storage' } },
          { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } },
        ],
      }),
      sort: gpu.layouts.bindGroupLayout({
        label: 'particles/sort',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          { binding: 10, visibility: C, buffer: { type: 'read-only-storage' } },
          { binding: 11, visibility: C, buffer: { type: 'storage' } },
          { binding: 12, visibility: C, buffer: { type: 'storage' } },
          { binding: 13, visibility: C, buffer: { type: 'uniform' } },
          { binding: 14, visibility: C, buffer: { type: 'uniform' } },
        ],
      }),
      data: gpu.layouts.bindGroupLayout({
        label: 'particles/data',
        entries: [
          dataEntry(gpu, 0, V),
          { binding: 1, visibility: V | F, buffer: { type: 'uniform' } },
          dataEntry(gpu, 2, V),
        ],
      }),
      texture: gpu.layouts.bindGroupLayout({
        label: 'particles/texture',
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, sampler: { type: 'filtering' } },
          depthReadEntry(gpu, 2, F),
        ],
      }),
      view: gpu.layouts.bindGroupLayout({
        label: 'particles/view',
        entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }],
      }),
    }
  }
  if (!c.white) {
    c.white = gpu.device.createTexture({
      label: 'particles/white',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    gpu.device.queue.writeTexture(
      { texture: c.white },
      new Uint8Array([255, 255, 255, 255]),
      {},
      [1, 1],
    )
    c.noDepth = gpu.device.createTexture({
      label: 'particles/no-depth',
      size: [1, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    })
    c.noOrder = new DataStore(gpu, { label: 'particles/no-order', size: 16 })
    c.sampler = gpu.device.createSampler({
      label: 'particles',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    })
  }
  return c
}

function group(
  gpu: GpuContext,
  c: Caches,
  slot: string,
  key: string,
  layout: GPUBindGroupLayout,
  entries: () => GPUBindGroupEntry[],
) {
  let g = c.groups.get(slot)
  if (!g || g.key !== key) {
    g = { key, group: gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
    c.groups.set(slot, g)
  }
  return g.group
}

function computePipelines(ctx: NodeContext, c: Caches, e: EmitterState) {
  const bursts = e.bursts !== undefined
  const key = bursts ? e.bursts!.key : e.key
  const cached = c.compute.get(key)
  if (cached) return cached
  const gpu = ctx.gpu
  const shaders = ctx.world.resource(Shaders)
  const path = `particles::${bursts ? 'bursts' : 'sim'}::e${idOf(e.def)}`
  // Registering again would relink it.
  if (!shaders.has(path))
    shaders.register(path, simulationShader(e.def, bursts), `particles:${e.def.name}`)
  const module = shaders.module(gpu, { root: path })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const layout = gpu.layouts.pipelineLayout({
    label: bursts ? 'particles/sim-bursts' : 'particles/sim',
    bindGroupLayouts: [bursts ? c.layouts!.simBursts : c.layouts!.sim],
  })
  const spawn = gpu.pipelines.compute({
    label: `${path}/spawn`,
    layout,
    compute: { module, entryPoint: 'spawn' },
  })
  const update = gpu.pipelines.compute({
    label: `${path}/update`,
    layout,
    compute: { module, entryPoint: 'update' },
  })
  if (!spawn || !update) return undefined
  const p = { spawn, update }
  c.compute.set(key, p)
  return p
}

function sortPipelines(ctx: NodeContext, c: Caches) {
  if (c.sort) return c.sort
  const gpu = ctx.gpu
  const shaders = ctx.world.resource(Shaders)
  // Registering again would relink it.
  if (!shaders.has('particles::sort'))
    shaders.register('particles::sort', SORT_SHADER, 'particles:sort')
  const module = shaders.module(gpu, { root: 'particles::sort' })
  if (!module) return undefined
  const layout = gpu.layouts.pipelineLayout({
    label: 'particles/sort',
    bindGroupLayouts: [c.layouts!.sort],
  })
  const keys = gpu.pipelines.compute({
    label: 'particles/sort-keys',
    layout,
    compute: { module, entryPoint: 'keys_pass' },
  })
  const sort = gpu.pipelines.compute({
    label: 'particles/sort',
    layout,
    compute: { module, entryPoint: 'sort_pass' },
  })
  if (!keys || !sort) return undefined
  c.sort = { keys, sort }
  return c.sort
}

/** Spawn, update, and (alpha emitters) depth sort, for the primary camera's view. */
export function simulateNode(world: World): NodeDescriptor {
  return {
    kind: 'raw',
    phase: RenderPhase.Resolve + 10,
    // Compute is the full tier's: on baseline every system runs the CPU backend in prepare.
    enabled: (view) => cameraOf(view) !== undefined && world.resource(Gpu).tier === 'full',
    reads: ['depth'],
    sideEffects: true,
    run: (ctx) => {
      const store = ctx.world.resource(Particles)
      if (ctx.view.name !== store.primary || (store.systems.size === 0 && store.bursts.size === 0))
        return
      const c = caches(ctx.world, ctx.gpu)
      const depth = ctx.texture('depth')
      const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
      const pass = ctx.encoder.beginComputePass({
        label: 'particles/simulate',
        timestampWrites: ctx.timestamps('particles/simulate'),
      })
      for (const sys of store.systems.values()) simulateSystem(ctx, c, pass, depth, pv, sys)
      for (const sys of store.bursts.values()) simulateSystem(ctx, c, pass, depth, pv, sys)
      pass.end()
      // Alive counts come back asynchronously, for describe.
      for (const sys of store.systems.values()) readAlive(ctx, sys)
      for (const sys of store.bursts.values()) readAlive(ctx, sys)
    },
  }
}

function simulateSystem(
  ctx: NodeContext,
  c: Caches,
  pass: GPUComputePassEncoder,
  depth: GPUTexture,
  pv: { uniform: { buffer: GPUBuffer } } | undefined,
  sys: SystemState,
): void {
  const gpu = ctx.gpu
  for (const e of sys.emitters) {
    if (!sys.cpu && e.simulate) {
      const p = computePipelines(ctx, c, e)
      if (!p) continue
      gpu.device.queue.writeBuffer(e.counter, 0, zeros)
      const q = e.bursts
      const g = q
        ? group(
            gpu,
            c,
            `sim/${sys.slot}/${e.def.name}`,
            `${idOf(e.particles.gpuBuffer)}/${idOf(e.sim.buffer)}/${idOf(depth)}/${idOf(burstBuffer(gpu, q))}`,
            c.layouts!.simBursts,
            () => [
              { binding: 0, resource: { buffer: e.particles.gpuBuffer } },
              { binding: 1, resource: { buffer: e.sim.buffer } },
              { binding: 2, resource: depth.createView() },
              { binding: 3, resource: { buffer: e.counter } },
              { binding: 4, resource: { buffer: q.buffer! } },
            ],
          )
        : group(
            gpu,
            c,
            `sim/${sys.slot}/${e.def.name}`,
            `${idOf(e.particles.gpuBuffer)}/${idOf(e.sim.buffer)}/${idOf(depth)}`,
            c.layouts!.sim,
            () => [
              { binding: 0, resource: { buffer: e.particles.gpuBuffer } },
              { binding: 1, resource: { buffer: e.sim.buffer } },
              { binding: 2, resource: depth.createView() },
              { binding: 3, resource: { buffer: e.counter } },
            ],
          )
      pass.setBindGroup(0, g)
      if (e.spawnCount > 0) {
        pass.setPipeline(p.spawn)
        pass.dispatchWorkgroups(Math.ceil(e.spawnCount / 64))
      }
      pass.setPipeline(p.update)
      pass.dispatchWorkgroups(Math.ceil(e.capacity / 64))
      e.originShift[0] = e.originShift[1] = e.originShift[2] = 0
      e.spawned += e.spawnCount
      e.backlog = 0
      if (q) takeBursts(q, e.spawnCount)
    }
    if (e.sort && pv && (!sys.pool || e.visible))
      sortEmitter(ctx, c, pass, sys, e, pv.uniform.buffer)
  }
}

function readAlive(ctx: NodeContext, sys: SystemState): void {
  if (sys.cpu) return
  for (const e of sys.emitters) {
    const rb = e.readbacks.find((r) => !r.busy)
    if (!rb) continue
    ctx.encoder.copyBufferToBuffer(e.counter, 0, rb.buffer, 0, 16)
    rb.busy = true
    ctx.afterSubmit(() => {
      rb.buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          e.alive = new Uint32Array(rb.buffer.getMappedRange())[0]!
          rb.buffer.unmap()
          rb.busy = false
        },
        () => {
          rb.busy = false
        },
      )
    })
  }
}

function sortEmitter(
  ctx: NodeContext,
  c: Caches,
  pass: GPUComputePassEncoder,
  sys: SystemState,
  e: EmitterState,
  viewBuffer: GPUBuffer,
): void {
  const gpu = ctx.gpu
  const p = sortPipelines(ctx, c)
  const s = e.sort!
  if (!p) return
  const modelBuffer = e.draw.buffer
  const groupFor = (i: number) =>
    group(
      gpu,
      c,
      `sort/${sys.slot}/${e.def.name}/${i}`,
      `${idOf(e.particles.gpuBuffer)}/${idOf(viewBuffer)}/${idOf(s.keys)}`,
      c.layouts!.sort,
      () => [
        { binding: 0, resource: { buffer: viewBuffer } },
        { binding: 10, resource: { buffer: e.particles.gpuBuffer } },
        { binding: 11, resource: { buffer: s.keys } },
        { binding: 12, resource: { buffer: s.order.gpuBuffer } },
        { binding: 13, resource: { buffer: s.steps, offset: i * 256, size: 16 } },
        // The draw uniform starts with the model matrix: particles in local space sort in world.
        {
          binding: 14,
          resource: { buffer: sys.local ? modelBuffer : identityBuffer(gpu, c), size: 64 },
        },
      ],
    )
  pass.setPipeline(p.keys)
  pass.setBindGroup(0, groupFor(0))
  pass.dispatchWorkgroups(Math.ceil(s.n / 64))
  pass.setPipeline(p.sort)
  for (let i = 1; i <= s.count; i++) {
    pass.setBindGroup(0, groupFor(i))
    pass.dispatchWorkgroups(Math.ceil(s.n / 64))
  }
}

/** One per device, shared by every app on it (0052); made again after a device loss. */
function identityBuffer(gpu: GpuContext, _c: Caches): GPUBuffer {
  return gpu.shared('particles/identity', (device) => {
    const buffer = device.createBuffer({
      label: 'particles/identity',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buffer, 0, identity as Float32Array<ArrayBuffer>)
    return buffer
  })
}

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
}
const OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

function renderPipeline(
  ctx: NodeContext,
  c: Caches,
  e: EmitterState,
): GPURenderPipeline | undefined {
  const key = `${e.key}/${e.def.render.blend}`
  const cached = c.render.get(key)
  if (cached) return cached
  const gpu = ctx.gpu
  const shaders = ctx.world.resource(Shaders)
  const path = `particles::draw::e${idOf(e.def)}`
  // Registering again would relink it.
  if (!shaders.has(path)) shaders.register(path, renderShader(e.def), `particles:${e.def.name}`)
  const module = shaders.module(gpu, { root: path })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const l = c.layouts!
  const mesh = e.def.render.mode === 'mesh'
  const p = gpu.pipelines.render({
    label: `${path}/${e.def.render.blend}`,
    layout: gpu.layouts.pipelineLayout({
      label: 'particles/draw',
      bindGroupLayouts: [l.view, l.data, l.texture],
    }),
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: mesh
        ? [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }]
        : [],
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        { format: 'rgba16float', blend: e.def.render.blend === 'additive' ? ADDITIVE : OVER },
      ],
    },
    primitive: { topology: 'triangle-list' },
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'greater-equal',
    },
  })
  if (p) c.render.set(key, p)
  return p
}

/** Particles over the resolved HDR image, depth-tested against the scene without writing depth. */
export function drawNode(): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Resolve + 20,
    enabled: (view) => cameraOf(view) !== undefined,
    after: ['particles/simulate'],
    reads: ['depth'],
    writes: ['hdr'],
    color: [{ resource: 'hdr' }],
    depth: { resource: 'depth', readOnly: true },
    run: (ctx) => {
      const store = ctx.world.resource(Particles)
      if (store.systems.size === 0 && store.bursts.size === 0 && store.cpuBursts.size === 0) return
      const gpu = ctx.gpu
      const c = caches(ctx.world, gpu)
      const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
      if (!pv) return
      const pass = ctx.renderPass!
      const depth = ctx.texture('depth')
      const cam = cameraOf(ctx.view)!
      pass.setBindGroup(
        0,
        group(
          gpu,
          c,
          `view/${ctx.view.name}`,
          `${idOf(pv.uniform.buffer)}`,
          c.layouts!.view,
          () => [{ binding: 0, resource: { buffer: pv.uniform.buffer } }],
        ),
      )
      for (const sys of store.systems.values()) drawSystem(ctx, c, cam, pass, depth, sys)
      for (const sys of store.bursts.values()) drawSystem(ctx, c, cam, pass, depth, sys)
      for (const sys of store.cpuBursts.values()) drawSystem(ctx, c, cam, pass, depth, sys)
    },
  }
}

function drawSystem(
  ctx: NodeContext,
  c: Caches,
  cam: CameraData,
  pass: GPURenderPassEncoder,
  depth: GPUTexture,
  sys: SystemState,
): void {
  if (!sphereVisible(cam.frustum, sys.center, sys.radius)) return
  const gpu = ctx.gpu
  const assets = ctx.world.resource(GpuAssetsResource)
  const textures = ctx.world.resource(Textures)
  const meshes = ctx.world.resource(Meshes)
  for (const e of sys.emitters) {
    // An effect's bursts with nothing alive draw nothing.
    if (sys.pool && !e.visible) continue
    const p = renderPipeline(ctx, c, e)
    if (!p) continue
    const texture = e.def.render.texture
      ? textures.get(e.def.render.texture as AssetRef<'Texture'>)
      : undefined
    const gt = texture ? assets.texture(texture as Texture) : undefined
    const view = gt ? (texture!.usage === 'color' ? gt.srgb : gt.linear) : c.white!.createView()
    const order = e.sort?.order ?? c.noOrder!
    pass.setPipeline(p)
    pass.setBindGroup(
      1,
      group(
        gpu,
        c,
        `data/${sys.slot}/${e.def.name}`,
        `${idOf(e.particles)}:${e.particles.version}/${idOf(e.draw.buffer)}/${idOf(order)}:${order.version}`,
        c.layouts!.data,
        () => [
          { binding: 0, resource: e.particles.resource() },
          { binding: 1, resource: { buffer: e.draw.buffer } },
          { binding: 2, resource: order.resource() },
        ],
      ),
    )
    pass.setBindGroup(
      2,
      group(
        gpu,
        c,
        `tex/${ctx.view.name}/${sys.slot}/${e.def.name}`,
        `${gt ? idOf(gt.texture) : 0}/${idOf(depth)}`,
        c.layouts!.texture,
        () => [
          { binding: 0, resource: view },
          { binding: 1, resource: c.sampler! },
          { binding: 2, resource: depth.createView() },
        ],
      ),
    )
    if (e.def.render.mode === 'mesh') {
      const mesh = e.def.render.mesh ? meshes.get(e.def.render.mesh as AssetRef<'Mesh'>) : undefined
      if (!mesh) continue
      const gm = assets.mesh(mesh as Mesh)
      pass.setVertexBuffer(0, gm.positions)
      if (gm.indices) {
        pass.setIndexBuffer(gm.indices, gm.indexFormat)
        pass.drawIndexed(gm.count, e.capacity, gm.firstIndex, gm.baseVertex)
      } else pass.draw(gm.count, e.capacity)
    } else {
      pass.draw(6, e.capacity)
    }
  }
}

/** Reads an emitter's particle buffer (tests: determinism, CPU vs GPU). */
export async function readParticles(gpu: GpuContext, e: EmitterState): Promise<Float32Array> {
  // A data texture on baseline (0064): the CPU backend's particles are what it holds.
  if (e.particles.textured) return e.cpu!.slice(0, e.capacity * PARTICLE_FLOATS)
  const size = e.capacity * PARTICLE_BYTES
  const staging = gpu.device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder()
  encoder.copyBufferToBuffer(e.particles.gpuBuffer, 0, staging, 0, size)
  gpu.device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const out = new Float32Array(staging.getMappedRange().slice(0))
  staging.unmap()
  staging.destroy()
  return out
}

/**
 * The floating origin moved by `offset` (spec 0040): world-space particles move with it so trails
 * stay continuous. The CPU backend shifts its particles now; GPU emitters add it in their next
 * update dispatch. Local-space systems move with their entity and need nothing.
 */
export function shiftParticles(store: ParticleStore, x: number, y: number, z: number): void {
  for (const sys of store.systems.values()) shiftSystem(sys, x, y, z)
  for (const sys of store.bursts.values()) shiftSystem(sys, x, y, z)
  for (const sys of store.cpuBursts.values()) shiftSystem(sys, x, y, z)
}

function shiftSystem(sys: SystemState, x: number, y: number, z: number): void {
  if (sys.local) return
  for (const e of sys.emitters) {
    if (sys.cpu && e.cpu) {
      const d = e.cpu
      for (let o = 0; o < d.length; o += PARTICLE_FLOATS) {
        d[o] = d[o]! + x
        d[o + 1] = d[o + 1]! + y
        d[o + 2] = d[o + 2]! + z
      }
    } else {
      e.originShift[0] = e.originShift[0]! + x
      e.originShift[1] = e.originShift[1]! + y
      e.originShift[2] = e.originShift[2]! + z
    }
  }
}

/** The particles section of `render.describe`. */
export function describeParticles(world: World) {
  const store = world.tryResource(Particles)
  if (!store) return undefined
  const gpuMs = world.tryResource(ProfilerResource)?.timing('gpu:particles/simulate')?.avg
  const emitters = (sys: SystemState) =>
    sys.emitters.map((e) => ({
      name: e.def.name,
      alive: e.alive,
      capacity: e.capacity,
      sorted: e.sort !== undefined,
      visible: e.visible,
      spawned: e.spawned,
      unsortedAlpha: e.def.render.blend !== 'additive' && !e.sort,
    }))
  const backend = (sys: SystemState) => ({
    backend: sys.cpu ? 'cpu' : 'gpu',
    ...(sys.forced ? { backendReason: 'the baseline tier has no compute' } : {}),
  })
  return {
    gpuMs,
    systems: [...store.systems.values()].map((sys) => ({
      entity: sys.entity,
      ...backend(sys),
      emitters: emitters(sys),
    })),
    // One-off bursts (0128): one simulation per effect and backend.
    bursts: [...store.bursts.values(), ...store.cpuBursts.values()].map((sys) => ({
      effect: sys.pool!.path ?? sys.pool!.guid,
      ...backend(sys),
      emitted: sys.pool!.emitted,
      emitters: emitters(sys),
    })),
  }
}
