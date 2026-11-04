import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  registerEngineShaders,
  ShaderGlobals,
  ShaderGlobalsData,
  Shaders,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { ShaderLibrary } from '@aethervtt/shard-shader'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { windPlugin } from './plugin'
import { Wind, windAt, windSample } from './wind'
import { WindField, WindZone } from './zones'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu?.destroy())

const COUNT = 1000

/** `wind_at` at each point (xyz), through the module the plugin registered and the globals it wrote. */
async function gpuWind(library: ShaderLibrary, globals: Float32Array, points: Float32Array) {
  library.register(
    'wind::parity::main',
    `import shard::wind::{ wind_at, wind_time };
@group(0) @binding(0) var<storage, read> points: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&points)) { return; }
  out[i] = wind_at(points[i].xyz, wind_time());
}`,
  )
  const linked = await library.link({ root: 'wind::parity::main' })
  const device = gpu.device
  device.pushErrorScope('validation')
  const module = device.createShaderModule({ code: linked.code })
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((m) => m.type === 'error')
  if (errors.length) throw new Error(errors.map((e) => `${e.lineNum}: ${e.message}`).join('\n'))
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const buffer = (data: Float32Array, usage: number) => {
    const b = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(b, 0, data as BufferSource)
    return b
  }
  const pointBuf = buffer(points, GPUBufferUsage.STORAGE)
  const globalsBuf = buffer(globals, GPUBufferUsage.UNIFORM)
  const outBuf = device.createBuffer({
    size: points.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const read = device.createBuffer({
    size: points.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: pointBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 14, resource: { buffer: globalsBuf } },
    ],
  })
  const enc = device.createCommandEncoder()
  const pass = enc.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bind)
  pass.dispatchWorkgroups(Math.ceil(points.length / 4 / 64))
  pass.end()
  enc.copyBufferToBuffer(outBuf, 0, read, 0, points.byteLength)
  device.queue.submit([enc.finish()])
  const scope = await device.popErrorScope()
  if (scope) throw new Error(scope.message)
  await read.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(read.getMappedRange().slice(0))
  read.unmap()
  for (const b of [pointBuf, globalsBuf, outBuf, read]) b.destroy()
  return result
}

describe('shard::wind on the GPU (0096)', () => {
  it('wind_at matches windAt within 1e-4 m/s at 1 000 points, zones and gusts included', async () => {
    const library = new ShaderLibrary()
    registerEngineShaders(library)
    const app = new App().addPlugin(TransformPlugin, windPlugin)
    app.world.insertResource(ShaderGlobals, new ShaderGlobalsData())
    app.world.insertResource(Shaders, library)
    await app.init()
    const w = app.world
    Object.assign(w.resource(Wind), {
      direction: [0.3, 0.1, 1],
      speed: 11,
      gustiness: 0.45,
      gustScale: 0.07,
    })
    // A tilted sheltering box, a storm cell over it, and a hard-edged calm sphere.
    w.spawn(
      [WindZone, { shape: 'box', size: [30, 12, 18], falloff: 6, speedScale: 0.2 }],
      [Transform, { translation: [-10, 0, 5], rotation: [0, 0.3826834, 0, 0.9238795] }],
    )
    w.spawn(
      [
        WindZone,
        {
          shape: 'sphere',
          size: [50, 0, 0],
          falloff: 10,
          override: true,
          direction: [-1, 0, 0.2],
          speed: 24,
          speedScale: 1.2,
          priority: 2,
        },
      ],
      [Transform, { translation: [25, 5, -20] }],
    )
    w.spawn(
      [WindZone, { shape: 'sphere', size: [16, 0, 0], falloff: 0, speedScale: 0, priority: 3 }],
      [Transform, { translation: [30, 0, -25] }],
    )
    for (let i = 0; i < 90; i++) app.update(1 / 60)
    expect(w.resource(WindField).uploaded).toBe(3)
    const globals = w.resource(ShaderGlobals)
    const block = 4 + w.resource(WindField).slot * 4
    const time = globals.values[block + 9]!
    expect(time).toBeGreaterThan(1)

    // Points across the zones and around them; a seeded LCG.
    let s = 7
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    const points = new Float32Array(COUNT * 4)
    for (let i = 0; i < COUNT; i++) {
      points[i * 4] = -60 + rand() * 120
      points[i * 4 + 1] = -5 + rand() * 25
      points[i * 4 + 2] = -60 + rand() * 120
    }
    const out = await gpuWind(library, globals.values, points)

    const sample = windSample()
    let worst = 0
    let exact = 0
    let inside = 0
    for (let i = 0; i < COUNT; i++) {
      windAt(w, points.subarray(i * 4, i * 4 + 3), sample, time)
      const cpu = [
        sample.direction[0] * sample.speed,
        sample.direction[1] * sample.speed,
        sample.direction[2] * sample.speed,
        sample.gust,
      ]
      if (Math.abs(sample.speed - 11) > 1e-3) inside++
      let same = true
      for (let k = 0; k < 4; k++) {
        const g = out[i * 4 + k]!
        worst = Math.max(worst, Math.abs(cpu[k]! - g))
        if (Math.fround(cpu[k]!) !== g) same = false
      }
      if (same) exact++
    }
    console.log(
      `wind_at vs windAt at ${COUNT} points (${inside} in or near a zone): worst ${worst.toExponential(2)} m/s; ${exact} bit-identical as f32`,
    )
    expect(inside).toBeGreaterThan(100)
    expect(worst).toBeLessThan(1e-4)
    await app.dispose()
  })
})
