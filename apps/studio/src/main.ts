import { ShardError } from '@shard/core'
import { createGpuContext } from '@shard/gpu'
import { createTauriPlatform } from '@shard/platform-tauri'
import { homeDir } from '@tauri-apps/api/path'

const status = document.getElementById('status') as HTMLDivElement
const canvas = document.getElementById('viewport') as HTMLCanvasElement

async function main() {
  // Project selection comes later; until then the platform is rooted at $HOME.
  const platform = createTauriPlatform({ projectRoot: await homeDir() })
  const gpu = await createGpuContext({ canvas })
  const info = gpu.adapter.info
  status.textContent = `Shard Studio · WebGPU · ${info.vendor || 'unknown vendor'} · ${platform.name}`

  const frame = () => {
    gpu.resize()
    const t = platform.clock.now() / 1000
    const encoder = gpu.device.createCommandEncoder()
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: gpu.context.getCurrentTexture().createView(),
            clearValue: { r: 0.05, g: 0.06 + 0.03 * Math.sin(t), b: 0.09, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end()
    gpu.device.queue.submit([encoder.finish()])
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

main().catch((err: unknown) => {
  status.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  console.error(err)
})
