import {
  AudioClips,
  audioClip,
  audioEventsPlugin,
  audioMusicPlugin,
  audioPlugin,
  MusicProgram,
  prepareMusic,
  startMusic,
} from '@aethervtt/shard-audio'
import type {
  AudioClipSource,
  AudioEffectDesc,
  AudioMixerGraph,
  AudioScheduledVoice,
} from '@aethervtt/shard-platform'
import { createWebAudioBackend, renderAudioPreview } from '@aethervtt/shard-platform-web'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'

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

async function musicLoopProbe() {
  const bpm = 123,
    period = (4 * 60) / bpm,
    rate = 48000
  const context = new OfflineAudioContext(1, 60 * rate, rate)
  const host = createWebAudioBackend({ context, fixedListener: true })
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend: host }),
    audioEventsPlugin(),
    audioMusicPlugin(),
  )
  await app.init()
  const source = clip('impulse', 100, period)
  const ref = app.world.resource(AudioClips).add(audioClip(source.bytes))
  const definition = MusicProgram.deserialize({
    bpm,
    entry: 'explore',
    sections: [
      {
        id: 'explore',
        bars: 1,
        stems: Array.from({ length: 4 }, (_, i) => ({
          id: `stem${i}`,
          clip: { guid: ref.guid },
          endSample: Math.round(period * rate),
          rateConform: true,
        })),
      },
    ],
  })
  const program = await prepareMusic(app.world, definition)
  startMusic(app.world, program, { at: 0.05 })
  // Flush the app-owned child session, then render the actual native looping sources.
  await app.world
    .resource((await import('@aethervtt/shard-audio')).AudioState)
    .backend.runtime!.flush()
  const buffer = await context.startRendering(),
    data = buffer.getChannelData(0),
    peaks: number[] = [],
    amplitudes: number[] = []
  for (let loop = 0; 0.05 + loop * period < 60; loop++) {
    const target = Math.round((0.05 + loop * period) * rate)
    let peak = target - 3
    for (let i = target - 2; i <= target + 3; i++)
      if (Math.abs(data[i]!) > Math.abs(data[peak]!)) peak = i
    peaks.push(peak)
    amplitudes.push(Math.abs(data[peak]!))
  }
  await app.dispose()
  program.release()
  host.dispose?.()
  let unexpected = 0
  for (let i = 0; i < data.length; i++)
    if (Math.abs(data[i]!) > 0.001 && !peaks.some((peak) => Math.abs(i - peak) <= 4)) unexpected++
  return {
    duration: 60,
    amplitudes,
    unexpected,
    peaks,
    expected: peaks.map((_, i) => Math.round((0.05 + i * period) * rate)),
  }
}

async function sessionProbe() {
  const context = new OfflineAudioContext(2, 24000, 48000),
    host = createWebAudioBackend({ context, fixedListener: true })
  const source = clip('impulse', 100, 0.02),
    a = host.createSession!(),
    b = host.createSession!()
  const leftPose = new Float64Array([1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0])
  b.setListener(leftPose)
  const spatial = {
    panning: 'equal-power' as const,
    distanceModel: 'inverse' as const,
    refDistance: 1,
    maxDistance: 100,
    rolloffFactor: 1,
  }
  a.play({ ...voice(source, 'sfx', 0.05), spatial, x: 10 })
  b.play({ ...voice(source, 'sfx', 0.15), spatial, x: 10 })
  await Promise.all([a.runtime!.flush(), b.runtime!.flush()])
  const rendered = await context.startRendering()
  const result = {
    aLeft: rendered.getChannelData(0)[2400]!,
    aRight: rendered.getChannelData(1)[2400]!,
    bLeft: rendered.getChannelData(0)[7200]!,
    bRight: rendered.getChannelData(1)[7200]!,
  }
  a.dispose!()
  b.dispose!()
  for (let i = 0; i < 100; i++) {
    const session = host.createSession!()
    const lease = await session.runtime!.prepare(source)
    session.play(voice(source))
    await session.runtime!.flush()
    lease.release()
    session.dispose!()
  }
  host.runtime.collect()
  const memory = host.runtime.memory()
  host.dispose?.()
  return { ...result, memory }
}

async function instanceSendProbe() {
  const context = new OfflineAudioContext(1, 24000, 48000)
  const host = createWebAudioBackend({ context, fixedListener: true })
  const mixer = graph(0)
  mixer.buses[1]!.sends = [{ target: 'echo', gain: 0, pre: true }]
  mixer.buses = [
    ...mixer.buses,
    {
      id: 'echo',
      parent: 'master',
      return: true,
      gain: 1,
      userGain: 1,
      sends: [],
      effects: [effect('delay', { seconds: 0.2, tailSeconds: 0.3 })],
    },
  ]
  await host.runtime.configureMixer(mixer)
  const source = clip('impulse', 100, 0.01)
  host.runtime.play({ ...voice(source, 'sfx', 0.05), sends: [{ target: 'echo', gain: 0.25 }] })
  const b = host.runtime.play({
    ...voice(source, 'sfx', 0.15),
    sends: [{ target: 'echo', gain: 0.75 }],
  })
  await host.runtime.flush()
  const suspended = context.suspend(0.1)
  const rendered = context.startRendering()
  await suspended
  host.runtime.setVoiceSend(b, 'echo', 0.5, 0)
  await context.resume()
  const samples = (await rendered).getChannelData(0)
  const result = { first: samples[12000]!, second: samples[16800]! }
  host.dispose?.()
  return result
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
  const capped = await renderAudioPreview({
    duration: 0.8,
    voices: [voice(clip('impulse', 100, 0.01))],
    mixer: graph(1, [effect('delay', { feedback: 0.9, seconds: 0.1, tailSeconds: 0.35 })]),
  })
  const reverb = await renderAudioPreview({
    duration: 0.8,
    voices: [voice(clip('impulse', 100, 0.01))],
    mixer: graph(1, [effect('reverb', { ir: clip('constant', 100, 0.7), tailSeconds: 0.3 })]),
  })
  const postGraph = graph(0)
  postGraph.buses = delayGraph.buses.map((bus) => ({
    ...bus,
    sends: bus.sends.map((send) => ({ ...send, pre: false })),
  }))
  const post = await renderAudioPreview({
    duration: 0.5,
    voices: [voice(clip('impulse'))],
    mixer: postGraph,
  })
  const musicLoops = await musicLoopProbe(),
    session = await sessionProbe()
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
    instanceSends: await instanceSendProbe(),
    musicLoops,
    session,
    delayBeforeCap: rms(capped.buffer.getChannelData(0), 14000, 18000),
    delayAfterCap: rms(capped.buffer.getChannelData(0), 20000, 35000),
    reverbBeforeCap: rms(reverb.buffer.getChannelData(0), 8000, 12000),
    reverbAfterCap: rms(reverb.buffer.getChannelData(0), 20000, 35000),
    postFaderSilent: post.measured.peak,
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
