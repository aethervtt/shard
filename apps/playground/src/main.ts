import { ShardError } from '@shard/core'
import { createGpuContext } from '@shard/gpu'
import { createWebPlatform } from '@shard/platform-web'
import triangleWgsl from './triangle.wgsl?raw'

const status = document.getElementById('status') as HTMLDivElement
const canvas = document.getElementById('viewport') as HTMLCanvasElement

async function main() {
  const platform = createWebPlatform()
  const gpu = await createGpuContext({ canvas })
  const { device, context, format } = gpu

  const uniforms = new Float32Array(4)
  const uniformBuffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const module = device.createShaderModule({ code: triangleWgsl })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })

  const info = gpu.adapter.info
  status.textContent = `WebGPU · ${info.vendor || 'unknown vendor'} ${info.architecture || ''} · ${platform.name}`

  const start = platform.clock.now()
  const frame = () => {
    gpu.resize()
    uniforms[0] = (platform.clock.now() - start) / 1000
    device.queue.writeBuffer(uniformBuffer, 0, uniforms)

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.043, g: 0.051, b: 0.07, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

main().catch((err: unknown) => {
  status.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  console.error(err)
})
