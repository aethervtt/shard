import { type AudioRenderBundle, renderAudioBundle } from '@aethervtt/shard-audio-preview'

function hydrate(serialized: { value: unknown; bytes: string[] }): AudioRenderBundle {
  const buffers = serialized.bytes.map((base64) => {
    const binary = atob(base64),
      bytes = new Uint8Array(binary.length)
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  })
  function decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decode)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    if (typeof object.$audioBytes === 'number') return buffers[object.$audioBytes]
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decode(item)]))
  }
  return decode(serialized.value) as AudioRenderBundle
}

async function previewAudio(serialized: Parameters<typeof hydrate>[0]) {
  const result = await renderAudioBundle(hydrate(serialized), {
    progress: (value) => Object.assign(globalThis, { audioPreviewProgress: value }),
  })
  let binary = ''
  for (let start = 0; start < result.wav.length; start += 16384)
    binary += String.fromCharCode(...result.wav.subarray(start, start + 16384))
  return { ...result, wav: btoa(binary) }
}
Object.assign(globalThis, { previewAudio })
