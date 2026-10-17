import { type AudioRenderPlan, renderAudioPreview } from '@aethervtt/shard-platform-web'

function hydrate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrate)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>,
    output: Record<string, unknown> = {}
  for (const key in object) {
    if (key === 'bytesBase64') {
      const binary = atob(object[key] as string),
        bytes = new Uint8Array(binary.length)
      for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)
      output.bytes = bytes
    } else output[key] = hydrate(object[key])
  }
  return output
}

async function previewAudio(serialized: unknown) {
  const result = await renderAudioPreview(hydrate(serialized) as AudioRenderPlan)
  let binary = ''
  for (let start = 0; start < result.wav.length; start += 16384)
    binary += String.fromCharCode(...result.wav.subarray(start, start + 16384))
  return {
    wav: btoa(binary),
    measured: result.measured,
    trace: result.trace,
    capabilities: result.capabilities,
    backend: result.backend,
  }
}
Object.assign(globalThis, { previewAudio })
