import { assetServer } from '@aethervtt/shard-assets'
import {
  AudioClips,
  AudioListener,
  AudioPreviewPlan,
  type AudioPreviewPlanValue,
  AudioTransport,
  acquireAudioSnapshot,
  audioEvents,
  audioEventsPlugin,
  audioMixerPlugin,
  audioMusicPlugin,
  audioPlugin,
  audioState,
  configureAudioMixer,
  describeAudioEvents,
  describeMusic,
  pauseMusic,
  playAudioEvent,
  playMusicStinger,
  prepareAudio,
  prepareMusic,
  prepareMusicSection,
  releaseAudioSnapshot,
  requestMusicSection,
  resumeMusic,
  seekMusic,
  setAudioParameter,
  setAudioSnapshotWeight,
  setBus,
  setMusicParameter,
  startMusic,
  stopAudioEvent,
  stopMusic,
  updateMusic,
  validateAudioPreview,
} from '@aethervtt/shard-audio'
import { type Entity, ShardError } from '@aethervtt/shard-core'
import {
  audioBufferWav,
  createWebAudioBackend,
  measureAudioBuffer,
} from '@aethervtt/shard-platform-web'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'

interface Bundle {
  plan: AudioPreviewPlanValue
  assets: { guid: string; path: string; type: string; value: unknown }[]
}
function hydrate(serialized: { value: unknown; bytes: string[] }): Bundle {
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
  return decode(serialized.value) as Bundle
}

async function render(bundle: Bundle) {
  const plan = AudioPreviewPlan.deserialize(bundle.plan)
  validateAudioPreview(plan)
  const frames = Math.ceil((plan.duration + plan.tailSeconds) * plan.sampleRate)
  if (frames * plan.channels * 6 + 44 > 64 * 1024 * 1024)
    throw new ShardError('audio/preview-unavailable', 'Preview output exceeds 64 MiB')
  const context = new OfflineAudioContext(plan.channels, frames, plan.sampleRate)
  const backend = createWebAudioBackend({
    context,
    fixedListener: true,
    maxVoices: 4096,
    maxHostVoices: 4096,
  })
  const app = new App({ seed: plan.seed }).addPlugin(
    TransformPlugin,
    audioPlugin({ backend, maxVoices: 4096 }),
    audioEventsPlugin(),
    audioMixerPlugin(),
    audioMusicPlugin(),
  )
  const world = app.world
  try {
    await app.init()
    const assets = assetServer(world),
      runtime = audioState(world).backend.runtime!
    for (const item of bundle.assets)
      assets.virtual(item.guid, item.path, item.type, () => item.value, { lazy: true })
    for (const item of bundle.assets) await assets.load(item.guid)
    // Decode with this OfflineAudioContext: marker conversion uses actual decoded sample counts.
    const decoded = []
    for (const clip of world.resource(AudioClips).values())
      decoded.push(await runtime.prepare(clip))
    if (plan.mixer) await configureAudioMixer(world, plan.mixer)
    const eventLeases = []
    for (const event of plan.events) eventLeases.push(await prepareAudio(world, event.asset!))
    const programs = new Map<string, Awaited<ReturnType<typeof prepareMusic>>>()
    for (const entry of plan.music) {
      const program = await prepareMusic(world, entry.asset!)
      for (const section of program.definition.sections)
        await prepareMusicSection(world, program, section.id)
      programs.set(entry.id, program)
    }
    const eventIds = new Map<string, number>(),
      musicIds = new Map<string, number>(),
      emitters = new Map<string, Entity>(),
      snapshots = new Map<string, number>()
    for (const entry of plan.music)
      musicIds.set(
        entry.id,
        startMusic(world, programs.get(entry.id)!, {
          section: entry.section || undefined,
          at: entry.at,
          parameters: entry.parameters as Record<string, number | string>,
        }),
      )
    const listener = world.spawn(Transform, AudioListener)
    const voices = plan.voices.map((voice) =>
      runtime.play({
        clip: world
          .resource(AudioClips)
          .require(plan.clips.find((c) => c.id === voice.clip)!.asset),
        bus: voice.bus,
        when: voice.at,
        duration: voice.duration || (voice.loop ? plan.duration - voice.at : undefined),
        offset: voice.offset,
        loop: voice.loop,
        gain: 10 ** (voice.gainDb / 20),
        pitch: voice.pitch,
        x: voice.position[0],
        y: voice.position[1],
        z: voice.position[2],
        spatial: voice.spatial
          ? {
              panning: 'equal-power',
              distanceModel: 'inverse',
              refDistance: voice.minDistance,
              maxDistance: voice.maxDistance,
              rolloffFactor: 1,
            }
          : null,
      }),
    )
    for (const command of plan.automation)
      runtime.automate(voices[plan.voices.findIndex((v) => v.id === command.voice)]!, command)
    const controls = plan.controls
      .map((control, index) => ({ control, index }))
      .sort((a, b) => a.control.at - b.control.at || a.index - b.index)
    const applied: { index: number; requestedAt: number; appliedAt: number }[] = []
    let nextControl = 0,
      last = 0,
      stopped = false
    const target = (map: Map<string, number>, name: string) => {
      const id = map.get(name)
      if (id === undefined)
        throw new ShardError('audio/preview-unavailable', `Preview target ${name} has not started`)
      return id
    }
    async function tick() {
      const now = context.currentTime
      Object.assign(globalThis, { audioPreviewProgress: { stage: 'tick', time: now, nextControl } })
      for (const entry of plan.events)
        if (!eventIds.has(entry.id) && now >= entry.at) {
          const entity = world.spawn(Transform)
          world.set(entity, Transform, { translation: entry.position })
          emitters.set(entry.id, entity)
          eventIds.set(
            entry.id,
            playAudioEvent(world, entry.asset!, {
              entity,
              parameters: entry.parameters as Record<string, number | string>,
              clock: entry.clock,
              pitchLinked: entry.pitchLinked,
            }),
          )
        }
      while (nextControl < controls.length && controls[nextControl]!.control.at <= now) {
        const { control: c, index } = controls[nextControl++]!,
          opts = c.options as Record<string, unknown>
        switch (c.kind) {
          case 'event.parameter':
            setAudioParameter(world, target(eventIds, c.target), c.name, c.value as number | string)
            break
          case 'global.parameter':
            setAudioParameter(world, null, c.name, c.value as number | string)
            break
          case 'event.stop':
            stopAudioEvent(world, target(eventIds, c.target), opts)
            break
          case 'event.position': {
            const entity = emitters.get(c.target)
            if (entity === undefined)
              throw new ShardError('audio/preview-unavailable', 'Emitter has not started')
            world.set(entity, Transform, { translation: c.position })
            break
          }
          case 'listener.position':
            world.set(listener, Transform, { translation: c.position })
            break
          case 'music.parameter':
            setMusicParameter(world, target(musicIds, c.target), c.name, c.value as number | string)
            break
          case 'music.section':
            requestMusicSection(world, target(musicIds, c.target), c.name, opts)
            break
          case 'music.stinger':
            await playMusicStinger(world, target(musicIds, c.target), c.name, opts)
            break
          case 'music.pause':
            pauseMusic(world, target(musicIds, c.target))
            break
          case 'music.resume':
            resumeMusic(world, target(musicIds, c.target))
            break
          case 'music.seek':
            seekMusic(world, target(musicIds, c.target), Number(c.value))
            break
          case 'snapshot.acquire':
            if (snapshots.has(c.target)) releaseAudioSnapshot(world, snapshots.get(c.target)!)
            snapshots.set(
              c.target,
              await acquireAudioSnapshot(world, c.asset!, c.value == null ? 1 : Number(c.value)),
            )
            break
          case 'snapshot.set':
            setAudioSnapshotWeight(world, target(snapshots, c.target), Number(c.value))
            break
          case 'snapshot.release':
            releaseAudioSnapshot(world, target(snapshots, c.target))
            break
          case 'bus.volume':
            setBus(world, c.target, { volume: Number(c.value) })
            break
          case 'transport.pause':
            world.resource(AudioTransport).paused = Boolean(c.value)
            break
        }
        applied.push({ index, requestedAt: c.at, appliedAt: now })
      }
      if (!stopped && now >= plan.duration) {
        stopped = true
        for (const instance of audioEvents(world).instances)
          if (instance) stopAudioEvent(world, instance.id, { release: 0 })
        for (const id of musicIds.values()) stopMusic(world, id)
        for (const id of voices) runtime.cancel(id)
      }
      app.update(now - last)
      updateMusic(world)
      last = now
      await runtime.flush()
    }
    await tick()
    // A deterministic 60-Hz authoring clock, aligned upward to audio render quanta. Native
    // music/voice timestamps remain sample scheduled; controls report their actual application.
    const total = frames / plan.sampleRate
    let rendering: Promise<AudioBuffer> | undefined
    let step = 1
    for (;;) {
      const wanted = Math.min(
        step / 60,
        nextControl < controls.length ? controls[nextControl]!.control.at : Infinity,
        ...plan.events.filter((e) => !eventIds.has(e.id)).map((e) => e.at),
        ...plan.music.filter((e) => !musicIds.has(e.id)).map((e) => e.at),
        stopped ? Infinity : plan.duration,
      )
      const at =
        (Math.max(
          Math.round((last * plan.sampleRate) / 128) + 1,
          Math.ceil((wanted * plan.sampleRate) / 128),
        ) *
          128) /
        plan.sampleRate
      if (at >= total) break
      // A half-sample bias prevents floating-point division from rounding a quantum
      // boundary into the previous (already suspended) quantum.
      Object.assign(globalThis, {
        audioPreviewProgress: { stage: 'suspend', time: context.currentTime, target: at },
      })
      const suspended = context.suspend(at + 0.5 / plan.sampleRate)
      if (!rendering) rendering = context.startRendering()
      else await context.resume()
      await suspended
      await tick()
      step = Math.floor(context.currentTime * 60) + 1
    }
    if (!rendering) rendering = context.startRendering()
    else await context.resume()
    const buffer = await rendering,
      measured = measureAudioBuffer(buffer)
    if (measured.nonfinite)
      throw new ShardError('audio/preview-unavailable', 'Rendered nonfinite samples')
    const trace = {
      events: describeAudioEvents(world).trace,
      music: describeMusic(world).trace,
      controls: applied,
      sources: voices.map((id) => ({ id, presentation: runtime.presentation(id) })),
      controlRate: 60,
      quantumFrames: 128,
    }
    for (const lease of decoded) lease.release()
    for (const lease of eventLeases) lease.release()
    for (const program of programs.values()) program.release()
    return {
      wav: audioBufferWav(buffer),
      measured,
      trace,
      capabilities: runtime.capabilities,
      backend: {
        kind: 'web-audio-offline',
        userAgent: navigator.userAgent,
        sampleRate: context.sampleRate,
      },
    }
  } finally {
    try {
      await app.dispose()
    } finally {
      backend.dispose?.()
    }
  }
}

async function previewAudio(serialized: Parameters<typeof hydrate>[0]) {
  const result = await render(hydrate(serialized))
  let binary = ''
  for (let start = 0; start < result.wav.length; start += 16384)
    binary += String.fromCharCode(...result.wav.subarray(start, start + 16384))
  return { ...result, wav: btoa(binary) }
}
Object.assign(globalThis, { previewAudio })
