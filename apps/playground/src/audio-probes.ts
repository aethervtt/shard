import {
  AudioClips,
  AudioEvent,
  AudioMixer,
  AudioMixState,
  audioClip,
  audioEventsPlugin,
  audioMixerPlugin,
  audioMusicPlugin,
  audioPlugin,
  audioState,
  configureAudioMixer,
  MusicProgram,
  pauseMusic,
  playMusicStinger,
  prepareMusic,
  prepareMusicSection,
  requestMusicSection,
  setMusicParameter,
  startMusic,
  updateMusic,
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
import { diceAudioProbe } from './dice-audio-probes'

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

async function domainTailProbe() {
  const context = new OfflineAudioContext(1, 72000, 48000)
  const host = createWebAudioBackend({ context, fixedListener: true })
  const mixer = graph(0)
  mixer.buses[1]!.sends = [{ target: 'echo', gain: 0, pre: true }]
  mixer.buses = [
    ...mixer.buses,
    {
      id: 'music',
      parent: 'master',
      return: false,
      gain: 0,
      userGain: 1,
      effects: [],
      sends: [{ target: 'echo', gain: 1, pre: true }],
    },
    {
      id: 'echo',
      parent: 'master',
      return: true,
      gain: 1,
      userGain: 1,
      sends: [],
      effects: [effect('delay', { seconds: 0.2, feedback: 0.5, tailSeconds: 0.8 })],
    },
  ]
  await host.runtime.configureMixer(mixer)
  const sustained = host.runtime.play({
    ...voice(clip('constant', 100, 2), 'sfx', 0.05),
    loop: true,
    sends: [{ target: 'echo', gain: 1 }],
  })
  host.runtime.play(voice(clip('impulse', 100, 0.01), 'music', 0.1))
  await host.runtime.flush()
  const stop1 = context.suspend(0.3)
  const rendering = context.startRendering()
  await stop1
  host.runtime.setMixerValue('sfx', 'userGain', 0, 0)
  mixer.buses[1]!.userGain = 0
  await host.runtime.configureMixer(mixer)
  const overlap = host.runtime.memory().nodes
  host.runtime.play(voice(clip('impulse', 100, 0.01), 'music', 0.6))
  await host.runtime.flush()
  const stop2 = context.suspend(1.3)
  await context.resume()
  await stop2
  host.runtime.cancel(sustained)
  host.runtime.collect()
  const retired = host.runtime.memory().nodes
  await context.resume()
  const samples = (await rendering).getChannelData(0)
  const result = {
    muted: rms(samples, 21000, 23000),
    unrelatedOldTail: samples[24000]!,
    newMusic: samples[38400]!,
    overlap,
    retired,
  }
  host.dispose?.()
  return result
}

async function musicTransitionProbe(curve: 'linear' | 'equal-power') {
  const context = new OfflineAudioContext(1, 4 * 48000, 48000)
  const host = createWebAudioBackend({ context, fixedListener: true })
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend: host }),
    audioEventsPlugin(),
    audioMusicPlugin(),
  )
  await app.init()
  const world = app.world,
    runtime = audioState(world).backend.runtime!
  try {
    const source = world.resource(AudioClips).add(audioClip(clip('constant', 100, 2).bytes))
    const impulse = world.resource(AudioClips).add(audioClip(clip('impulse', 100, 0.01).bytes))
    const stinger = world.resource(AudioEvent.store).add(
      AudioEvent.deserialize({
        layers: [
          { id: 'hit', choices: [{ clip: { guid: impulse.guid } }], delay: 0.1, release: 0 },
        ],
      }),
    )
    const program = await prepareMusic(
      world,
      MusicProgram.deserialize({
        bpm: 120,
        entry: 'a',
        parameters: [{ name: 'level' }],
        sections: [
          {
            id: 'a',
            bars: 1,
            markers: [{ id: 'cue', tick: 3840 - 1 }],
            stems: [{ id: 'a', clip: { guid: source.guid }, endSample: 96000 }],
          },
          {
            id: 'b',
            bars: 1,
            stems: [
              {
                id: 'b',
                clip: { guid: source.guid },
                endSample: 96000,
                curves: [
                  {
                    parameter: 'level',
                    property: 'gainDb',
                    points: [
                      [0, 0],
                      [1, -6.020599913279624],
                    ],
                  },
                ],
              },
            ],
          },
        ],
        stingers: [{ id: 'hit', event: { guid: stinger.guid } }],
      }),
    )
    await prepareMusicSection(world, program, 'b')
    const id = startMusic(world, program, { at: 0.05 })
    const request = requestMusicSection(world, id, 'b', { quantize: 'bar', fadeBeats: 2, curve })
    const hit = await playMusicStinger(world, id, 'hit', { quantize: 'beat' })
    await runtime.flush()
    const suspend1 = context.suspend(1.96)
    const rendering = context.startRendering()
    await suspend1
    updateMusic(world)
    await runtime.flush()
    const suspend2 = context.suspend(2.8)
    await context.resume()
    await suspend2
    setMusicParameter(world, id, 'level', 1)
    updateMusic(world)
    const suspend3 = context.suspend(3.5)
    await context.resume()
    await suspend3
    pauseMusic(world, id)
    await context.resume()
    const samples = (await rendering).getChannelData(0)
    const result = {
      at: request.at,
      middle: samples[Math.round((request.at + 0.5) * 48000)]!,
      after: samples[Math.round((request.at + 1.3) * 48000)]!,
      stinger: samples[Math.round((hit.at + 0.1) * 48000)]!,
      paused: rms(samples, 175000, 185000),
    }
    program.release()
    return result
  } finally {
    await app.dispose()
    host.dispose?.()
  }
}

async function reservationProbe() {
  const context = new OfflineAudioContext(1, 48000, 48000)
  const host = createWebAudioBackend({ context, fixedListener: true, maxHostVoices: 4 })
  const low = host.createSession!({ priority: 1 }),
    high = host.createSession!({ priority: 2 })
  const source = clip('constant')
  await low.runtime!.prepare(source)
  await high.runtime!.prepare(source)
  const release = low.runtime!.reserveVoices(4)
  try {
    for (let i = 0; i < 4; i++) low.play({ ...voice(source), loop: true })
  } finally {
    release()
  }
  let rejected = false
  try {
    high.runtime!.reserveVoices(5)
  } catch {
    rejected = true
  }
  const preserved = low.runtime!.activeVoices
  const reserveHigh = high.runtime!.reserveVoices(2)
  try {
    high.play(voice(source))
    high.play(voice(source))
  } finally {
    reserveHigh()
  }
  const result = {
    rejected,
    preserved,
    low: low.runtime!.activeVoices,
    high: high.runtime!.activeVoices,
  }
  low.dispose?.()
  high.dispose?.()
  host.dispose?.()
  return result
}

async function compressorProbe() {
  const mixer = graph(1, [effect('compressor', { threshold: -24, ratio: 8 })])
  mixer.buses = [
    ...mixer.buses,
    { id: 'child', parent: 'sfx', gain: 1, userGain: 1, return: false, sends: [], effects: [] },
  ]
  const source = clip('constant')
  const sum = await renderAudioPreview({
    duration: 1,
    mixer,
    voices: [voice(source, 'child'), voice(source, 'child')],
  })
  const reference = await renderAudioPreview({
    duration: 1,
    mixer,
    voices: [{ ...voice(source), gain: 2 }],
  })
  return {
    sum: rms(sum.buffer.getChannelData(0), 24000, 40000),
    reference: rms(reference.buffer.getChannelData(0), 24000, 40000),
  }
}

async function scalarMixerProbe() {
  const context = new OfflineAudioContext(1, 24000, 48000)
  const host = createWebAudioBackend({ context, fixedListener: true })
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend: host }),
    audioEventsPlugin(),
    audioMixerPlugin(),
  )
  await app.init()
  try {
    const world = app.world,
      runtime = audioState(world).backend.runtime!
    const mixer = AudioMixer.deserialize({
      buses: [
        { id: 'master', parent: '' },
        {
          id: 'sfx',
          effects: [{ id: 'echo', kind: 'delay', seconds: 0.2, feedback: 0, tailSeconds: 0.3 }],
        },
      ],
    })
    await configureAudioMixer(world, mixer)
    runtime.play(voice(clip('impulse', 100, 0.01), 'sfx', 0.05))
    await runtime.flush()
    const suspended = context.suspend(0.1),
      rendering = context.startRendering()
    await suspended
    const before = runtime.memory().nodes
    world.resource(AudioMixState).maxNodes = before
    mixer.buses[1]!.gainDb = 20 * Math.log10(0.5)
    await configureAudioMixer(world, mixer)
    const after = runtime.memory().nodes
    await context.resume()
    const buffer = await rendering
    return { before, after, tail: buffer.getChannelData(0)[12000]! }
  } finally {
    await app.dispose()
    host.dispose?.()
  }
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
    dice: await diceAudioProbe(),
    reservations: await reservationProbe(),
    compressor: await compressorProbe(),
    scalarMixer: await scalarMixerProbe(),
    instanceSends: await instanceSendProbe(),
    domainTails: await domainTailProbe(),
    musicTransitions: {
      linear: await musicTransitionProbe('linear'),
      equalPower: await musicTransitionProbe('equal-power'),
    },
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

let liveHost: ReturnType<typeof createWebAudioBackend> | undefined
let liveContext: AudioContext | undefined
export async function startLiveAudioProbe() {
  document.body.dataset.audioStage = 'context'
  liveContext = new AudioContext()
  if (liveContext.state === 'running') await liveContext.suspend()
  liveHost = createWebAudioBackend({ context: liveContext, fixedListener: true })
  document.body.dataset.audioStage = 'graph'
  liveHost.output.gain.value = 0
  await liveHost.runtime.configureMixer(
    graph(1, [effect('delay', { seconds: 0.05, tailSeconds: 0.15 })]),
  )
  const streamed = await liveHost.runtime.prepare({ ...clip('constant'), stream: true })
  const ownedUrls = liveHost.runtime.memory().urls
  streamed.release()
  const releasedUrls = liveHost.runtime.memory().urls
  const external = await liveHost.runtime.prepare({
    ...clip('constant'),
    bytes: new Uint8Array(0),
    stream: true,
    url: 'blob:external-owner',
  })
  const externalUrls = liveHost.runtime.memory().urls
  external.release()
  document.body.dataset.audioStage = 'codec'
  let codec = ''
  try {
    await liveHost.runtime.prepare({ ...clip('constant'), bytes: new Uint8Array([1, 2, 3]) })
  } catch (error) {
    codec = (error as { code: string }).code
  }
  document.body.dataset.audioStage = 'blocked-play'
  liveHost.runtime.play({ ...voice(clip('constant'), 'sfx'), when: undefined, loop: true })
  await liveHost.runtime.flush()
  const button = document.createElement('button')
  button.id = 'audio-resume'
  button.textContent = 'Resume audio'
  document.body.append(button)
  return {
    state: liveHost.state,
    codec,
    presentation: liveHost.runtime.presentation(1)?.state,
    ownedUrls,
    releasedUrls,
    externalUrls,
  }
}
export function inspectLiveAudioProbe() {
  liveHost!.runtime.collect()
  return {
    state: liveHost!.state,
    time: liveContext!.currentTime,
    memory: liveHost!.runtime.memory(),
    presentation: liveHost!.runtime.presentation(1)?.state,
  }
}
export async function suspendLiveAudioProbe() {
  await liveContext!.suspend()
  await liveHost!.runtime.configureMixer(graph())
  return inspectLiveAudioProbe()
}
export async function disposeLiveAudioProbe() {
  liveHost!.dispose?.()
  await liveContext!.close()
}
Object.assign(globalThis, {
  startLiveAudioProbe,
  inspectLiveAudioProbe,
  suspendLiveAudioProbe,
  disposeLiveAudioProbe,
})
