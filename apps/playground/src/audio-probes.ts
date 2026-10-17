import type {
  AudioClipSource,
  AudioEffectDesc,
  AudioMixerGraph,
  AudioScheduledVoice,
} from '@aethervtt/shard-platform'
import { createWebAudioBackend, renderAudioPreview } from '@aethervtt/shard-platform-web'

function clip(
  kind: 'constant' | 'impulse' | 'sine',
  frequency = 100,
  seconds = 1,
): AudioClipSource {
  const sampleRate = 48000,
    frames = Math.round(seconds * sampleRate),
    bytes = new Uint8Array(44 + frames * 2),
    view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(
        32767 *
          (kind === 'constant'
            ? 0.5
            : kind === 'impulse'
              ? Number(i === 0) * 0.5
              : Math.sin((2 * Math.PI * i * frequency) / sampleRate) * 0.5),
      ),
      true,
    )
  return {
    id: `${kind}-${frequency}`,
    bytes,
    codec: 'wav',
    duration: seconds,
    stream: false,
    normalize: false,
    loopStart: 0,
    loopEnd: seconds,
    sampleRate,
    channels: 1,
  }
}
function voice(source: AudioClipSource, bus = 'sfx', when = 0.05): AudioScheduledVoice {
  return {
    clip: source,
    bus,
    when,
    offset: 0,
    loop: false,
    gain: 1,
    pitch: 1,
    spatial: null,
    x: 0,
    y: 0,
    z: 0,
  }
}
function effect(
  kind: AudioEffectDesc['kind'],
  overrides: Partial<AudioEffectDesc> = {},
): AudioEffectDesc {
  return {
    id: kind,
    kind,
    frequency: 800,
    q: Math.SQRT1_2,
    gainDb: 0,
    threshold: -24,
    ratio: 4,
    attack: 0.003,
    release: 0.25,
    seconds: 0.2,
    feedback: 0,
    tailSeconds: 1,
    ...overrides,
  }
}
function graph(gain = 1, effects: AudioEffectDesc[] = []): AudioMixerGraph {
  return {
    maxNodes: 2048,
    buses: [
      { id: 'master', parent: '', gain: 1, userGain: 1, effects: [], sends: [], return: false },
      { id: 'sfx', parent: 'master', gain, userGain: 1, effects, sends: [], return: false },
    ],
  }
}
function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i++) sum += samples[i]! ** 2
  return Math.sqrt(sum / (end - start))
}

export async function audioProbes() {
  const source = clip('constant'),
    hierarchy = graph(0.5)
  hierarchy.buses = [
    ...hierarchy.buses,
    { id: 'steps', parent: 'sfx', gain: 0.5, userGain: 1, effects: [], sends: [], return: false },
  ]
  const parent = await renderAudioPreview({
    duration: 0.5,
    voices: [voice(source, 'steps')],
    mixer: hierarchy,
  })
  const low = await renderAudioPreview({
    duration: 1,
    voices: [voice(clip('sine', 100))],
    mixer: graph(1, [effect('lowpass')]),
  })
  const high = await renderAudioPreview({
    duration: 1,
    voices: [voice(clip('sine', 10000))],
    mixer: graph(1, [effect('lowpass')]),
  })
  const delayGraph = graph(0)
  delayGraph.buses[1]!.sends = [{ target: 'echo', pre: true, gain: 1 }]
  delayGraph.buses = [
    ...delayGraph.buses,
    {
      id: 'echo',
      parent: 'master',
      return: true,
      gain: 1,
      userGain: 1,
      effects: [effect('delay')],
      sends: [],
    },
  ]
  const delayed = await renderAudioPreview({
    duration: 0.5,
    voices: [voice(clip('impulse'))],
    mixer: delayGraph,
  })
  const delayedSamples = delayed.buffer.getChannelData(0)
  let impulse = -1
  for (let i = 0; i < delayedSamples.length; i++)
    if (Math.abs(delayedSamples[i]!) > 0.1) {
      impulse = i
      break
    }
  const stems = await renderAudioPreview({
    duration: 0.5,
    voices: Array.from({ length: 4 }, () => voice(clip('impulse'))),
  })
  const stemSamples = stems.buffer.getChannelData(0)
  let stemIndex = -1,
    stemPeak = 0
  for (let i = 0; i < stemSamples.length; i++)
    if (Math.abs(stemSamples[i]!) > stemPeak) {
      stemPeak = Math.abs(stemSamples[i]!)
      stemIndex = i
    }
  const fade = await renderAudioPreview({
    duration: 0.5,
    voices: [voice(source, 'sfx', 0)],
    automation: [
      {
        voice: 0,
        command: { property: 'gain', at: 0.1, value: 0, duration: 0.2, curve: 'equal-power-out' },
      },
    ],
  })
  const context = new OfflineAudioContext(1, 4800, 48000),
    host = createWebAudioBackend({ context, fixedListener: true })
  const a = host.createSession!(),
    b = host.createSession!()
  const leaseA = await a.runtime!.prepare(source),
    leaseB = await b.runtime!.prepare(source)
  const sharedBytes = host.runtime.memory().decodedBytes
  leaseA.release()
  a.dispose?.()
  const survivingBytes = b.runtime!.memory().decodedBytes
  leaseB.release()
  b.dispose?.()
  host.runtime.collect()
  const collectedBytes = host.runtime.memory().decodedBytes
  host.dispose?.()
  return {
    hierarchy: parent.buffer.getChannelData(0)[12000],
    attenuationDb: 20 * Math.log10(high.measured.rms / low.measured.rms),
    delaySample: impulse,
    stemIndex,
    stemPeak,
    fadeMiddle: fade.buffer.getChannelData(0)[9600],
    fadeEnd: rms(fade.buffer.getChannelData(0), 16800, 21600),
    sharedBytes,
    survivingBytes,
    collectedBytes,
    measured: parent.measured,
    backend: parent.backend,
    capabilities: parent.capabilities,
  }
}

Object.assign(globalThis, { audioProbes })
