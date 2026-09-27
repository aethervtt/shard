import {
  defineComponent,
  defineResource,
  defineSystem,
  FixedUpdate,
  Last,
  ProfilerResource,
  Startup,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer } from '@aethervtt/shard-gpu'
import { Gpu, Graph, RenderSet, VIEW_TARGET, Window } from '@aethervtt/shard-render'
import { definePlugin, FixedTime, Time } from '@aethervtt/shard-runtime'
import galaxyWgsl from './galaxy.wgsl?raw'

// --- data --------------------------------------------------------------------

export const Position = defineComponent('galaxy/Position', { value: t.vec3 })
export const Velocity = defineComponent('galaxy/Velocity', { value: t.vec3 })

/** How many stars the population system steers toward. The HUD buttons change it. */
export const Population = defineResource<{ target: number }>('galaxy/Population', {
  description: 'Target star count.',
})

/** Seeded so every run starts from the same galaxy. */
const Rng = defineResource<{ next(): number }>('galaxy/Rng')

const G = 0.35
const SOFTENING = 0.02
const MAX_CHANGE_PER_FRAME = 10_000

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let r = Math.imul(a ^ (a >>> 15), 1 | a)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** A star on a roughly circular orbit, in one of two spiral arms. */
function starInit(world: World) {
  const rand = world.resource(Rng).next
  const r = 0.08 + 0.92 * rand() ** 0.8
  const arm = rand() < 0.5 ? 0 : Math.PI
  const angle = arm + r * 5 + (rand() - 0.5) * 1.1
  const x = Math.cos(angle) * r
  const y = Math.sin(angle) * r
  const z = (rand() - 0.5) * 0.06 * (1.2 - r)
  const r2 = r * r + SOFTENING
  const speed = Math.sqrt((G * r * r) / (r2 * Math.sqrt(r2))) * (0.95 + rand() * 0.1)
  return [
    [Position, { value: [x, y, z] }],
    [Velocity, { value: [(-y / r) * speed, (x / r) * speed, 0] }],
  ] as const
}

// --- systems -----------------------------------------------------------------

const seed = defineSystem({
  name: 'galaxy/seed',
  description: 'Spawns the initial stars.',
  run: (_, world) => {
    const target = world.resource(Population).target
    for (let i = 0; i < target; i++) world.spawn(...starInit(world))
  },
})

/** Grows or shrinks the galaxy toward the target through commands, a batch per frame. */
const population = defineSystem({
  name: 'galaxy/population',
  description: 'Spawns or despawns stars to reach Population.target.',
  setup: (world) => ({ stars: world.query({ with: [Position, Velocity] }) }),
  run: ({ stars }, world, ctx) => {
    const diff = world.resource(Population).target - stars.count()
    if (diff > 0) {
      for (let i = 0; i < Math.min(diff, MAX_CHANGE_PER_FRAME); i++) {
        ctx.commands.spawn(...starInit(world))
      }
    } else if (diff < 0) {
      let remaining = Math.min(-diff, MAX_CHANGE_PER_FRAME)
      for (const table of stars.tables) {
        for (let row = table.count - 1; row >= 0 && remaining > 0; row--, remaining--) {
          ctx.commands.despawn(table.entities[row]!)
        }
      }
    }
  },
})

/** Gravity toward the core, semi-implicit Euler. The hot loop: no allocation. */
const gravity = defineSystem({
  name: 'galaxy/gravity',
  description: 'Integrates every star around the galactic core.',
  setup: (world) => ({ stars: world.query({ with: [Position, Velocity] }) }),
  run: ({ stars }, world) => {
    const dt = world.resource(FixedTime).step
    const tables = stars.tables
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t]!
      const pos = table.column(Position, 'value')
      const vel = table.column(Velocity, 'value')
      for (let i = 0, n = table.count * 3; i < n; i += 3) {
        const x = pos[i]!
        const y = pos[i + 1]!
        const z = pos[i + 2]!
        const r2 = x * x + y * y + z * z + SOFTENING
        const k = (G * dt) / (r2 * Math.sqrt(r2))
        const vx = vel[i]! - x * k
        const vy = vel[i + 1]! - y * k
        const vz = vel[i + 2]! - z * k
        vel[i] = vx
        vel[i + 1] = vy
        vel[i + 2] = vz
        pos[i] = x + vx * dt
        pos[i + 1] = y + vy * dt
        pos[i + 2] = z + vz * dt
      }
      table.markChanged(Position)
      table.markChanged(Velocity)
    }
  },
})

// --- rendering ---------------------------------------------------------------

interface GalaxyGpu {
  positions: GpuBuffer
  velocities: GpuBuffer
  uniforms: GpuBuffer
  uniformData: Float32Array
  module: GPUShaderModule
  count: number
  bindGroup: GPUBindGroup | undefined
  /** Buffer versions the bind group was built against. */
  bound: string
}

const GalaxyGpuResource = defineResource<GalaxyGpu>('galaxy/Gpu')

/** Uploads ECS columns as-is into storage buffers, plus the camera uniforms. */
const prepare = defineSystem({
  name: 'galaxy/prepare',
  description: 'Uploads star columns and camera uniforms to the GPU.',
  setup: (world) => ({ stars: world.query({ with: [Position, Velocity] }) }),
  run: ({ stars }, world) => {
    const g = world.resource(GalaxyGpuResource)
    const window = world.resource(Window)
    let offset = 0
    for (const table of stars.tables) {
      const n = table.count * 3
      g.positions.ensureCapacity((offset + n) * 4)
      g.velocities.ensureCapacity((offset + n) * 4)
      g.positions.write(table.column(Position, 'value'), offset * 4, 0, n)
      g.velocities.write(table.column(Velocity, 'value'), offset * 4, 0, n)
      offset += n
    }
    g.count = offset / 3

    const aspect = window.width / window.height
    const elapsed = world.resource(Time).elapsed
    const u = g.uniformData
    u[0] = Math.min(1, 1 / aspect) * 0.95
    u[1] = Math.min(1, aspect) * 0.95
    u[2] = elapsed * 0.05
    u[3] = 1.0 + Math.sin(elapsed * 0.1) * 0.15
    u[4] = 2.2 / Math.min(window.width, window.height)
    g.uniforms.write(u)
  },
})

function pipelineDescriptor(g: GalaxyGpu, format: GPUTextureFormat): GPURenderPipelineDescriptor {
  return {
    label: 'galaxy/stars',
    layout: 'auto',
    vertex: { module: g.module, entryPoint: 'vs_main' },
    fragment: {
      module: g.module,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
  }
}

// --- HUD ---------------------------------------------------------------------

const hud = defineSystem({
  name: 'galaxy/hud',
  description: 'Writes entity count, frame rate, and system timings to the overlay.',
  setup: () => ({ el: document.getElementById('hud') as HTMLElement, lastUpdate: 0, frames: 0 }),
  run: (state, world) => {
    state.frames++
    const time = world.resource(Time)
    if (time.elapsed - state.lastUpdate < 0.25) return
    const fps = state.frames / (time.elapsed - state.lastUpdate)
    state.lastUpdate = time.elapsed
    state.frames = 0

    const timings = world.resource(ProfilerResource).all()
    const rows = Object.entries(timings)
      .filter(([name]) => name !== 'galaxy/hud' && !name.startsWith('render/'))
      .map(([name, t]) => `${name.padEnd(20)} ${t.avg.toFixed(2).padStart(6)} ms`)
    state.el.textContent = [
      `stars    ${world.entityCount.toLocaleString()}`,
      `target   ${world.resource(Population).target.toLocaleString()}`,
      `fps      ${fps.toFixed(0)}`,
      '',
      ...rows,
    ].join('\n')
  },
})

// --- plugin ------------------------------------------------------------------

export function galaxyPlugin(options: { stars: number; seed: number }) {
  return definePlugin({
    name: 'galaxy',
    dependencies: ['core/time', 'render'],
    build(app) {
      app
        .insertResource(Population, { target: options.stars })
        .insertResource(Rng, { next: mulberry32(options.seed) })
        .addSystems(Startup, seed)
        .addSystems(Update, population)
        .addSystems(FixedUpdate, gravity)
        .addSystems(Last, prepare.inSet(RenderSet.Prepare), hud.after(RenderSet.Graph))
    },
    // Runs after the render plugin's ready(), so the GPU exists.
    ready(app) {
      const gpu = app.world.resource(Gpu)
      const storage = { usage: GPUBufferUsage.STORAGE, size: options.stars * 12 }
      const uniformData = new Float32Array(8)
      const g: GalaxyGpu = {
        positions: new GpuBuffer(gpu, { label: 'galaxy/positions', ...storage }),
        velocities: new GpuBuffer(gpu, { label: 'galaxy/velocities', ...storage }),
        uniforms: new GpuBuffer(gpu, {
          label: 'galaxy/uniforms',
          usage: GPUBufferUsage.UNIFORM,
          size: 32,
        }),
        uniformData,
        module: gpu.device.createShaderModule({ label: 'galaxy', code: galaxyWgsl }),
        count: 0,
        bindGroup: undefined,
        bound: '',
      }
      app.insertResource(GalaxyGpuResource, g)

      app.world.resource(Graph).addNode('galaxy', {
        kind: 'render',
        writes: [VIEW_TARGET],
        color: [{ resource: VIEW_TARGET, clear: { r: 0.01, g: 0.012, b: 0.02, a: 1 } }],
        run: (ctx) => {
          const pipeline = ctx.gpu.pipelines.render(pipelineDescriptor(g, ctx.view.target.format))
          if (!pipeline) return // still compiling: skip this frame
          const versions = `${g.positions.version}/${g.velocities.version}/${g.uniforms.version}/${ctx.gpu.generation}`
          if (!g.bindGroup || g.bound !== versions) {
            g.bindGroup = ctx.gpu.device.createBindGroup({
              label: 'galaxy/bind-group',
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: g.uniforms.buffer } },
                { binding: 1, resource: { buffer: g.positions.buffer } },
                { binding: 2, resource: { buffer: g.velocities.buffer } },
              ],
            })
            g.bound = versions
          }
          const pass = ctx.renderPass!
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, g.bindGroup)
          pass.draw(6, g.count)
        },
      })
    },
  })
}
