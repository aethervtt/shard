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
} from '@shard/core'
import { createGpuContext, type GpuContext } from '@shard/gpu'
import { definePlugin, FixedTime, Time } from '@shard/runtime'
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

interface Renderer {
  gpu: GpuContext
  pipeline: GPURenderPipeline
  uniforms: Float32Array
  uniformBuffer: GPUBuffer
  capacity: number
  positions: GPUBuffer
  velocities: GPUBuffer
  bindGroup: GPUBindGroup
}

const RendererResource = defineResource<Renderer>('galaxy/Renderer')

function allocateStarBuffers(r: Renderer, capacity: number): void {
  r.positions?.destroy()
  r.velocities?.destroy()
  const size = capacity * 3 * 4
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  r.positions = r.gpu.device.createBuffer({ size, usage })
  r.velocities = r.gpu.device.createBuffer({ size, usage })
  r.bindGroup = r.gpu.device.createBindGroup({
    layout: r.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.uniformBuffer } },
      { binding: 1, resource: { buffer: r.positions } },
      { binding: 2, resource: { buffer: r.velocities } },
    ],
  })
  r.capacity = capacity
}

const render = defineSystem({
  name: 'galaxy/render',
  description: 'Uploads ECS columns to storage buffers and draws one instanced quad per star.',
  setup: (world) => ({ stars: world.query({ with: [Position, Velocity] }) }),
  run: ({ stars }, world) => {
    const r = world.resource(RendererResource)
    const { device, context, canvas } = r.gpu
    r.gpu.resize()

    const count = stars.count()
    if (count > r.capacity) allocateStarBuffers(r, Math.max(count, r.capacity * 2))

    // The columns are already in GPU layout: upload each table's slice as-is.
    let offset = 0
    for (const table of stars.tables) {
      const n = table.count * 3
      device.queue.writeBuffer(r.positions, offset * 4, table.column(Position, 'value'), 0, n)
      device.queue.writeBuffer(r.velocities, offset * 4, table.column(Velocity, 'value'), 0, n)
      offset += n
    }

    const aspect = canvas.width / canvas.height
    const elapsed = world.resource(Time).elapsed
    r.uniforms[0] = Math.min(1, 1 / aspect) * 0.95
    r.uniforms[1] = Math.min(1, aspect) * 0.95
    r.uniforms[2] = elapsed * 0.05
    r.uniforms[3] = 1.0 + Math.sin(elapsed * 0.1) * 0.15
    r.uniforms[4] = 2.2 / Math.min(canvas.width, canvas.height)
    device.queue.writeBuffer(r.uniformBuffer, 0, r.uniforms)

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.01, g: 0.012, b: 0.02, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(r.pipeline)
    pass.setBindGroup(0, r.bindGroup)
    pass.draw(6, count)
    pass.end()
    device.queue.submit([encoder.finish()])
  },
})

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
      .filter(([name]) => name !== 'galaxy/hud')
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

export function galaxyPlugin(options: { canvas: HTMLCanvasElement; stars: number; seed: number }) {
  return definePlugin({
    name: 'galaxy',
    dependencies: ['core/time'],
    build(app) {
      app
        .insertResource(Population, { target: options.stars })
        .insertResource(Rng, { next: mulberry32(options.seed) })
        .addSystems(Startup, seed)
        .addSystems(Update, population)
        .addSystems(FixedUpdate, gravity)
        .addSystems(Last, render, hud.after(render))
    },
    // GPU setup is async, so it happens in ready(), before Startup.
    async ready(app) {
      const gpu = await createGpuContext({ canvas: options.canvas })
      const module = gpu.device.createShaderModule({ code: galaxyWgsl })
      const pipeline = gpu.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [
            {
              format: gpu.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
      })
      const uniforms = new Float32Array(8)
      const renderer = {
        gpu,
        pipeline,
        uniforms,
        uniformBuffer: gpu.device.createBuffer({
          size: uniforms.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        capacity: 0,
      } as Renderer
      allocateStarBuffers(renderer, options.stars)
      app.insertResource(RendererResource, renderer)
    },
  })
}
