import { ShardError } from '@aethervtt/shard-core'
import type {
  AudioAutomation,
  AudioBackend,
  AudioClipSource,
  AudioClock,
  AudioMixerGraph,
  AudioPreparation,
  AudioPresentation,
  AudioRuntimeExtension,
  AudioScheduledVoice,
  AudioSessionOptions,
  AudioVoiceDesc,
  AudioVoiceParams,
} from '@aethervtt/shard-platform'
import { validateAudioAutomation } from '@aethervtt/shard-platform'
import { AudioCache, type PreparedAudio } from './audio-cache'
import { WebAudioGraph } from './audio-graph'

interface AutomationTrack {
  depth: number
  command: AudioAutomation
  start: number
  previous: AutomationTrack | null
}
function automatedValue(track: AutomationTrack, at: number): number {
  if (at < track.command.at)
    return track.previous ? automatedValue(track.previous, at) : track.start
  const command = track.command,
    start = track.start
  const t =
    command.duration > 0 ? Math.max(0, Math.min(1, (at - command.at) / command.duration)) : 1
  if (command.curve === 'equal-power-in')
    return start + (command.value - start) * Math.sin((t * Math.PI) / 2)
  if (command.curve === 'equal-power-out')
    return command.value + (start - command.value) * Math.cos((t * Math.PI) / 2)
  if (command.curve === 'exponential' && start > 0 && command.value > 0)
    return start * (command.value / start) ** t
  return start + (command.value - start) * t
}

interface Voice {
  group: number
  id: number
  desc: AudioScheduledVoice
  params: AudioVoiceParams
  gain: GainNode
  envelope: GainNode
  lowpass: BiquadFilterNode
  highpass: BiquadFilterNode
  sends: Map<string, GainNode>
  panner: PannerNode | null
  source: AudioBufferSourceNode | null
  media: HTMLAudioElement | null
  mediaNode: MediaElementAudioSourceNode | null
  lease: AudioPreparation | null
  presentation: AudioPresentation
  loading: boolean
  started: boolean
  finished: boolean
  requestedAt: number
  norm: number
  timer: ReturnType<typeof setTimeout> | null
  automation: AudioAutomation[]
  tracks: Map<string, AutomationTrack>
}

interface Host {
  context: BaseAudioContext
  cache: AudioCache
  output: GainNode
  sessions: Set<WebSession>
  ownsContext: boolean
  fixedListener: boolean
  offline: boolean
  maxVoices: number
  voices: number
  reserved: number
  nextSession: number
}

export interface WebAudioBackend extends AudioBackend {
  readonly context: BaseAudioContext
  readonly output: GainNode
  readonly runtime: AudioRuntimeExtension
  busNode(name: string): GainNode
  resume(): Promise<void>
}

const gestures = ['pointerdown', 'keydown', 'touchend'] as const
const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])

/** Every application owns a session. Only the host owns a context and the shared decode cache. */
class WebSession implements WebAudioBackend, AudioRuntimeExtension {
  readonly kind = 'web'
  readonly runtime = this
  readonly context: BaseAudioContext
  readonly output: GainNode
  readonly clock: AudioClock
  readonly capabilities
  readonly host: Host
  readonly root: boolean
  onError?: AudioBackend['onError']
  private disposed = false
  private nextId = 1
  private readonly voices = new Map<number, Voice>()
  private readonly statuses = new Map<number, AudioPresentation>()
  private readonly buses = new Map<string, GainNode>()
  private readonly busGains = new Map<string, number>()
  private readonly leases = new Set<AudioPreparation>()
  private readonly wakes = new Set<ReturnType<typeof setInterval>>()
  private readonly retired = new Map<WebAudioGraph, number>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly listener = identity.slice()
  private readonly meters = new Map<
    string,
    {
      node: AnalyserNode
      data: Float32Array<ArrayBuffer>
      value: ReturnType<WebSession['emptyMeter']>
    }
  >()
  private graph: WebAudioGraph | null = null
  private graphRevision = 0
  private reserved = 0
  private group = 0
  private readonly ordinal: number
  private readonly priority: number
  private maxVoices: number
  private budgetBytes: number
  private readonly pendingStarts = new Set<Promise<void>>()
  private ownPreparedBytes = 0
  private readonly preparationPins = new Map<PreparedAudio, { count: number; bytes: number }>()

  constructor(host: Host, root: boolean, options: AudioSessionOptions = {}) {
    this.host = host
    this.ordinal = host.nextSession++
    this.priority = options.priority ?? 0
    if (!Number.isFinite(this.priority))
      throw new ShardError('audio/invalid-range', 'Session priority must be finite')
    this.root = root
    this.context = host.context
    this.output = host.context.createGain()
    this.output.connect(host.output)
    this.maxVoices = options.maxVoices ?? 64
    this.budgetBytes = options.decodedBudgetBytes ?? host.cache.budgetBytes
    this.capabilities = {
      scheduled: true,
      automation: true,
      mixer: true,
      media: !host.offline,
      meters: !host.offline,
      offline: host.offline,
      sessions: root && host.fixedListener,
    }
    this.clock = {
      now: () => this.context.currentTime,
      wallNow: () => performance.now() / 1000,
      wake: (callback, seconds) => {
        if (host.offline || this.disposed) return () => {}
        const handle = setInterval(callback, Math.max(1, seconds * 1000))
        this.wakes.add(handle)
        return () => {
          clearInterval(handle)
          this.wakes.delete(handle)
        }
      },
    }
    if (!host.offline) this.wakes.add(setInterval(this.maintainGraphs, 20))
    host.sessions.add(this)
    this.context.addEventListener('statechange', this.stateChanged)
    if (!host.offline)
      for (const gesture of gestures)
        window.addEventListener(gesture, this.unlock, { capture: true })
  }

  get activeVoices(): number {
    return this.voices.size
  }

  get state(): 'running' | 'suspended' | 'closed' {
    if (this.disposed || this.context.state === 'closed') return 'closed'
    return this.host.offline || this.context.state === 'running' ? 'running' : 'suspended'
  }

  createSession(options?: AudioSessionOptions): WebAudioBackend {
    if (!this.root || !this.host.fixedListener || this.disposed)
      throw new ShardError(
        'audio/unsupported-capability',
        'Independent sessions require a managed fixed listener',
        { hint: 'Use a Shard-owned context or grant fixedListener ownership.' },
      )
    return new WebSession(this.host, false, options)
  }

  private unlock = (): void => {
    void this.resume().catch(this.report)
  }
  private report = (error: unknown): void => {
    this.onError?.(
      error instanceof ShardError
        ? error
        : new ShardError('audio/prepare-failed', 'Audio operation failed', { cause: error }),
    )
  }
  private stateChanged = (): void => {
    this.maintainGraphs()
    if (this.state === 'running')
      for (const voice of this.voices.values()) {
        if (!voice.started && !voice.loading) this.start(voice)
        else if (voice.started && voice.presentation.state === 'blocked')
          voice.presentation.state =
            voice.presentation.scheduledAt > this.context.currentTime ? 'scheduled' : 'rendering'
      }
    else
      for (const voice of this.voices.values())
        if (voice.presentation.state === 'rendering' || voice.presentation.state === 'scheduled')
          voice.presentation.state = 'blocked'
  }

  async resume(): Promise<void> {
    if (this.host.offline || this.state === 'running') return
    if (this.state === 'closed') throw new ShardError('audio/prepare-failed', 'Audio is closed')
    await (this.context as AudioContext).resume()
  }

  busNode(name: string): GainNode {
    const output = this.graph?.outputs.get(name)
    if (output) return output
    let node = this.buses.get(name)
    if (!node) {
      node = this.context.createGain()
      node.gain.value = this.busGains.get(name) ?? 1
      node.connect(this.output)
      this.buses.set(name, node)
    }
    return node
  }

  private input(name: string): AudioNode {
    if (!this.graph) return this.busNode(name)
    const input = this.graph.inputs.get(name)
    if (!input) throw new ShardError('audio/unknown-bus', `No ordinary mixer input ${name}`)
    return input
  }

  private place(voice: Voice): void {
    const panner = voice.panner
    if (!panner) return
    let x = voice.params.x,
      y = voice.params.y,
      z = voice.params.z
    if (this.host.fixedListener) {
      const m = this.listener
      const dx = x - m[3]!,
        dy = y - m[7]!,
        dz = z - m[11]!
      const sx = Math.sqrt(m[0]! ** 2 + m[4]! ** 2 + m[8]! ** 2) || 1
      const sy = Math.sqrt(m[1]! ** 2 + m[5]! ** 2 + m[9]! ** 2) || 1
      const sz = Math.sqrt(m[2]! ** 2 + m[6]! ** 2 + m[10]! ** 2) || 1
      x = (dx * m[0]! + dy * m[4]! + dz * m[8]!) / sx
      y = (dx * m[1]! + dy * m[5]! + dz * m[9]!) / sy
      z = (dx * m[2]! + dy * m[6]! + dz * m[10]!) / sz
    }
    const at = this.context.currentTime
    panner.positionX.setValueAtTime(x, at)
    panner.positionY.setValueAtTime(y, at)
    panner.positionZ.setValueAtTime(z, at)
  }

  private validateRoutes(desc: AudioVoiceDesc): void {
    if (
      (desc.sends?.length ?? 0) > 8 ||
      new Set(desc.sends?.map((send) => send.target)).size !== (desc.sends?.length ?? 0)
    )
      throw new ShardError('audio/capacity', 'At most eight voice sends')
    for (const send of desc.sends ?? []) {
      if (
        !Number.isFinite(send.gain) ||
        send.gain < 0 ||
        send.gain > 16 ||
        !this.graph?.sendInputs.get(desc.bus)?.has(send.target)
      )
        throw new ShardError('audio/unknown-bus', `Invalid voice send ${desc.bus}/${send.target}`)
    }
  }

  private route(voice: Voice): void {
    voice.highpass.disconnect()
    voice.panner?.disconnect()
    for (const [target, node] of voice.sends)
      if (!voice.desc.sends?.some((send) => send.target === target)) {
        node.disconnect()
        voice.sends.delete(target)
      }
    const spatial = voice.desc.spatial
    if (spatial) {
      const node = voice.panner ?? this.context.createPanner()
      voice.panner = node
      node.panningModel = spatial.panning === 'hrtf' ? 'HRTF' : 'equalpower'
      node.distanceModel = spatial.distanceModel
      node.refDistance = Math.max(0.00001, spatial.refDistance)
      node.maxDistance = Math.max(spatial.maxDistance, node.refDistance + 0.00001)
      node.rolloffFactor = spatial.rolloffFactor
      this.place(voice)
      voice.highpass.connect(node).connect(this.input(voice.desc.bus))
    } else {
      voice.panner = null
      voice.highpass.connect(this.input(voice.desc.bus))
    }
    for (const send of voice.desc.sends ?? []) {
      let node = voice.sends.get(send.target)
      if (!node) {
        node = this.context.createGain()
        node.gain.value = send.gain
        voice.sends.set(send.target, node)
      } else {
        node.disconnect()
        node.gain.cancelAndHoldAtTime(this.context.currentTime)
        node.gain.setValueAtTime(send.gain, this.context.currentTime)
      }
      const input = this.graph?.sendInputs.get(voice.desc.bus)?.get(send.target)
      if (!input) throw new ShardError('audio/unknown-bus', `Missing voice send ${send.target}`)
      ;(voice.panner ?? voice.highpass).connect(node).connect(input)
    }
  }

  setVoiceSend(id: number, target: string, gain: number, seconds: number): void {
    if (!Number.isFinite(gain) || gain < 0 || gain > 16 || !Number.isFinite(seconds) || seconds < 0)
      throw new ShardError('audio/invalid-range', 'Invalid voice send automation')
    const node = this.voices.get(id)?.sends.get(target)
    if (!node) throw new ShardError('audio/unknown-bus', `Missing voice send ${target}`)
    const at = this.context.currentTime
    node.gain.cancelAndHoldAtTime(at)
    if (seconds) node.gain.linearRampToValueAtTime(gain, at + seconds)
    else node.gain.setValueAtTime(gain, at)
  }

  setDecodedBudget(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < this.ownPreparedBytes)
      throw new ShardError('audio/memory-budget', 'Budget is invalid or below pinned PCM')
    this.budgetBytes = bytes
  }

  reserveVoices(count: number): () => void {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      this.voices.size + this.reserved + count > this.maxVoices
    )
      throw new ShardError('audio/capacity', 'Physical voice reservation cannot fit')
    const needed = Math.max(0, this.host.voices + this.host.reserved + count - this.host.maxVoices)
    if (needed) {
      const candidates: { session: WebSession; voice: Voice }[] = []
      for (const session of this.host.sessions) {
        if (
          session === this ||
          session.priority > this.priority ||
          (session.priority === this.priority && session.ordinal < this.ordinal)
        )
          continue
        for (const voice of session.voices.values()) candidates.push({ session, voice })
      }
      candidates.sort(
        (a, b) =>
          a.session.priority - b.session.priority ||
          b.session.ordinal - a.session.ordinal ||
          b.voice.id - a.voice.id,
      )
      if (candidates.length < needed)
        throw new ShardError('audio/capacity', 'Higher-ranked sessions own the host voice budget')
      let freed = 0
      for (let i = 0; i < candidates.length && freed < needed; i++) {
        const victim = candidates[i]!
        if (victim.voice.finished) continue
        // A reserved stem/stinger group is indivisible, including when another session wins.
        for (const voice of victim.session.voices.values())
          if (voice.group === victim.voice.group) {
            voice.presentation.error = 'audio/host-stolen'
            victim.session.finish(voice)
            freed++
          }
      }
    }
    const previous = this.reserved
    this.group++
    this.reserved += count
    this.host.reserved += count
    let released = false
    return () => {
      if (released) return
      released = true
      const unused = Math.max(0, this.reserved - previous)
      this.reserved -= unused
      this.host.reserved -= unused
    }
  }

  play(desc: AudioScheduledVoice): number {
    if (this.disposed) throw new ShardError('audio/prepare-failed', 'Audio session is disposed')
    if (this.voices.size >= this.maxVoices)
      throw new ShardError('audio/capacity', 'Physical audio voice budget is exhausted', {
        hint: 'Release a voice or increase the session/host voice budget.',
      })
    if (this.host.offline && desc.clip.stream)
      throw new ShardError('audio/unsupported-capability', 'Offline rendering needs decoded clips')
    this.input(desc.bus)
    this.validateRoutes(desc)
    if (!this.reserved) this.reserveVoices(1)
    this.reserved--
    this.host.reserved--
    const id = this.nextId++
    const gain = this.context.createGain()
    gain.gain.value = desc.gain
    const lowpass = this.context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = desc.lowpass ?? this.context.sampleRate / 2
    const highpass = this.context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = desc.highpass ?? 0
    const envelope = this.context.createGain()
    gain.connect(envelope).connect(lowpass).connect(highpass)
    const presentation: AudioPresentation = {
      state: 'preparing',
      scheduledAt: desc.when ?? this.context.currentTime,
      endedAt: -1,
      error: null,
    }
    const voice: Voice = {
      group: this.group,
      id,
      desc: { ...desc },
      params: { gain: desc.gain, pitch: desc.pitch, x: desc.x, y: desc.y, z: desc.z },
      gain,
      envelope,
      lowpass,
      highpass,
      sends: new Map(),
      panner: null,
      source: null,
      media: null,
      mediaNode: null,
      lease: null,
      presentation,
      loading: false,
      started: false,
      finished: false,
      norm: 1,
      requestedAt: performance.now(),
      timer: null,
      automation: [],
      tracks: new Map(),
    }
    this.voices.set(id, voice)
    this.statuses.set(id, presentation)
    this.host.voices++
    try {
      this.route(voice)
      this.start(voice)
    } catch (error) {
      this.finish(voice)
      throw error
    }
    return id
  }

  private start(voice: Voice): void {
    if (voice.finished || voice.started || voice.loading) return
    if (this.state !== 'running') {
      voice.presentation.state = 'blocked'
      return
    }
    const ready = this.host.cache.acquireReady(voice.desc.clip)
    if (ready) {
      this.startPrepared(voice, this.ownLease(ready))
      return
    }
    voice.loading = true
    const pending = this.acquireOwned(voice.desc.clip)
      .then((lease) => this.startPrepared(voice, lease))
      .catch((error) => this.fail(voice, error))
      .finally(() => this.pendingStarts.delete(pending))
    this.pendingStarts.add(pending)
  }

  private startPrepared(voice: Voice, lease: AudioPreparation & { value: PreparedAudio }): void {
    voice.loading = false
    if (voice.finished || this.disposed) {
      lease.release()
      return
    }
    voice.lease = lease
    const desc = voice.desc,
      now = this.context.currentTime
    let offset = desc.offset
    if (desc.when === undefined && !this.host.offline)
      offset += ((performance.now() - voice.requestedAt) / 1000) * voice.params.pitch
    const end = desc.clip.loopEnd || desc.clip.duration,
      start = desc.clip.loopStart
    if (desc.loop && offset >= end) offset = start + ((offset - start) % (end - start))
    if (!desc.loop && offset >= desc.clip.duration) {
      this.finish(voice)
      return
    }
    if (this.state !== 'running') {
      voice.lease.release()
      voice.lease = null
      voice.presentation.state = 'blocked'
      return
    }
    if (desc.clip.stream) {
      const media = new Audio(lease.value.url!)
      voice.media = media
      media.loop = desc.loop
      media.preservesPitch = false
      media.playbackRate = voice.params.pitch
      media.currentTime = offset
      voice.mediaNode = (this.context as AudioContext).createMediaElementSource(media)
      voice.mediaNode.connect(voice.gain)
      media.onended = () => this.finish(voice)
      media.onerror = () =>
        this.fail(voice, new ShardError('audio/decode-failed', `Cannot play ${desc.clip.id}`))
      voice.started = true
      void media.play().then(
        () => {
          if (!voice.finished) voice.presentation.state = 'rendering'
        },
        (error) => this.fail(voice, error),
      )
    } else {
      const source = this.context.createBufferSource()
      voice.source = source
      source.buffer = lease.value.buffer
      source.loop = desc.loop
      source.loopStart = start
      source.loopEnd = end
      source.playbackRate.value = voice.params.pitch
      voice.norm = desc.clip.normalize && lease.value.peak > 0 ? 1 / lease.value.peak : 1
      voice.gain.gain.value = voice.params.gain * voice.norm
      source.connect(voice.gain)
      source.onended = () => this.finish(voice)
      if (desc.when !== undefined && desc.when < now)
        throw new ShardError('audio/music-late', 'Prepared source missed its scheduled start')
      const when = desc.when ?? now
      voice.presentation.scheduledAt = when
      voice.presentation.state = when > now ? 'scheduled' : 'rendering'
      voice.started = true
      for (const command of voice.automation) this.automate(voice.id, command)
      voice.automation.length = 0
      source.start(when, offset)
      if (desc.duration !== undefined) source.stop(when + desc.duration)
    }
  }

  private fail(voice: Voice, error: unknown): void {
    if (voice.finished) return
    voice.presentation.error = error instanceof ShardError ? error.code : 'audio/decode-failed'
    this.finish(voice, true)
    this.report(error)
  }

  private finish(voice: Voice, failed = false): void {
    if (voice.finished) return
    voice.finished = true
    if (voice.timer !== null) clearTimeout(voice.timer)
    if (voice.source) {
      voice.source.onended = null
      try {
        voice.source.stop()
      } catch {
        /* Already ended. */
      }
      voice.source.disconnect()
    }
    if (voice.media) {
      voice.media.onended = null
      voice.media.onerror = null
      voice.media.pause()
      voice.media.removeAttribute('src')
      voice.media.load()
    }
    voice.mediaNode?.disconnect()
    voice.gain.disconnect()
    voice.envelope.disconnect()
    voice.lowpass.disconnect()
    voice.highpass.disconnect()
    voice.panner?.disconnect()
    for (const node of voice.sends.values()) node.disconnect()
    voice.sends.clear()
    voice.lease?.release()
    voice.lease = null
    this.voices.delete(voice.id)
    this.host.voices--
    voice.presentation.state = failed ? 'failed' : 'ended'
    voice.presentation.endedAt = this.context.currentTime
    if (this.statuses.size > 4096)
      for (const [id, status] of this.statuses) {
        if (status.state === 'ended' || status.state === 'failed') this.statuses.delete(id)
        if (this.statuses.size <= 4096) break
      }
  }

  stop(id: number, fade = 0): void {
    const voice = this.voices.get(id)
    if (!voice || voice.finished) return
    if (fade <= 0 || !voice.started || this.state !== 'running') {
      this.finish(voice)
      return
    }
    voice.presentation.state = 'stopping'
    const at = this.context.currentTime
    voice.gain.gain.cancelAndHoldAtTime(at)
    voice.gain.gain.linearRampToValueAtTime(0, at + fade)
    if (voice.source) voice.source.stop(at + fade)
    if (voice.media && !this.host.offline) {
      if (voice.timer !== null) clearTimeout(voice.timer)
      const finishAt = at + fade
      const poll = () => {
        if (this.context.currentTime >= finishAt) this.finish(voice)
        else voice.timer = setTimeout(poll, 25)
      }
      voice.timer = setTimeout(poll, 25)
    }
  }

  cancel(id: number): 'cancelled' | 'already-started' | 'ended' {
    const voice = this.voices.get(id)
    if (!voice) return 'ended'
    const started = voice.started && this.context.currentTime >= voice.presentation.scheduledAt
    this.stop(id, started ? 0.01 : 0)
    return started ? 'already-started' : 'cancelled'
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingStarts)
    for (const status of this.statuses.values())
      if (status.state === 'failed')
        throw new ShardError(
          status.error ?? 'audio/prepare-failed',
          'Audio source preparation failed',
        )
  }

  presentation(id: number): Readonly<AudioPresentation> | undefined {
    const status = this.statuses.get(id)
    if (status && this.state !== 'running' && this.voices.has(id)) {
      if (status.state === 'rendering' || status.state === 'scheduled') status.state = 'blocked'
    } else if (status?.state === 'scheduled' && this.context.currentTime >= status.scheduledAt)
      status.state = 'rendering'
    return status
  }

  update(id: number, params: AudioVoiceParams): void {
    const voice = this.voices.get(id)
    if (!voice) return
    const at = this.context.currentTime
    if (voice.params.gain !== params.gain)
      voice.gain.gain.setTargetAtTime(params.gain * voice.norm, at, 0.015)
    if (voice.params.pitch !== params.pitch) {
      voice.source?.playbackRate.setValueAtTime(params.pitch, at)
      if (voice.media) voice.media.playbackRate = params.pitch
    }
    voice.params.gain = params.gain
    voice.params.pitch = params.pitch
    voice.params.x = params.x
    voice.params.y = params.y
    voice.params.z = params.z
    this.place(voice)
  }

  reconfigure(id: number, desc: AudioVoiceDesc): boolean {
    const voice = this.voices.get(id)
    if (!voice || voice.desc.clip.bytes !== desc.clip.bytes) return false
    this.input(desc.bus)
    this.validateRoutes(desc)
    voice.desc = { ...voice.desc, ...desc }
    if (voice.source) {
      voice.source.loop = desc.loop
      voice.source.loopStart = desc.clip.loopStart
      voice.source.loopEnd = desc.clip.loopEnd || desc.clip.duration
    }
    if (voice.media) voice.media.loop = desc.loop
    this.route(voice)
    this.update(id, desc)
    return true
  }

  automate(id: number, command: AudioAutomation): void {
    validateAudioAutomation(command)
    const voice = this.voices.get(id)
    if (!voice) return
    if (!voice.source && !voice.media) {
      if (voice.automation.length >= 128)
        throw new ShardError('audio/capacity', 'Voice automation queue is full')
      voice.automation.push({ ...command })
      return
    }
    const param =
      command.property === 'envelope'
        ? voice.envelope.gain
        : command.property === 'gain'
          ? voice.gain.gain
          : command.property === 'pitch'
            ? voice.source?.playbackRate
            : command.property === 'lowpass'
              ? voice.lowpass.frequency
              : voice.highpass.frequency
    if (!param)
      throw new ShardError(
        'audio/unsupported-capability',
        'Pitch automation needs a prepared decoded source',
      )
    const value = command.value * (command.property === 'gain' ? voice.norm : 1)
    const previous = voice.tracks.get(command.property)
    if (previous && this.context.currentTime >= previous.command.at) {
      previous.previous = null
      previous.depth = 1
    }
    const depth = command.at > this.context.currentTime ? (previous?.depth ?? 0) + 1 : 1
    if (depth > 128)
      throw new ShardError('audio/capacity', 'Voice future automation capacity reached')
    const initial =
      command.property === 'envelope'
        ? 1
        : command.property === 'gain'
          ? voice.params.gain * voice.norm
          : command.property === 'pitch'
            ? voice.params.pitch
            : command.property === 'lowpass'
              ? (voice.desc.lowpass ?? this.context.sampleRate / 2)
              : (voice.desc.highpass ?? 0)
    const start = previous ? automatedValue(previous, command.at) : initial
    voice.tracks.set(command.property, {
      depth,
      command: { ...command, value },
      start,
      previous: command.at > this.context.currentTime ? (previous ?? null) : null,
    })
    param.cancelAndHoldAtTime(command.at)
    param.setValueAtTime(start, command.at)
    if (command.duration <= 0) param.setValueAtTime(value, command.at)
    else if (command.curve === 'exponential')
      param.exponentialRampToValueAtTime(Math.max(value, 0.000001), command.at + command.duration)
    else if (command.curve === 'equal-power-in' || command.curve === 'equal-power-out') {
      const samples = new Float32Array(129)
      for (let i = 0; i < samples.length; i++) {
        const phase = ((i / (samples.length - 1)) * Math.PI) / 2
        samples[i] =
          command.curve === 'equal-power-in'
            ? start + (value - start) * Math.sin(phase)
            : value + (start - value) * Math.cos(phase)
      }
      param.setValueCurveAtTime(samples, command.at, command.duration)
    } else param.linearRampToValueAtTime(value, command.at + command.duration)
  }

  setListener(matrix: ArrayLike<number>): void {
    for (let i = 0; i < 12; i++) this.listener[i] = matrix[i]!
    if (this.host.fixedListener) for (const voice of this.voices.values()) this.place(voice)
    else {
      const listener = this.context.listener
      listener.positionX.value = matrix[3]!
      listener.positionY.value = matrix[7]!
      listener.positionZ.value = matrix[11]!
      listener.forwardX.value = -matrix[2]!
      listener.forwardY.value = -matrix[6]!
      listener.forwardZ.value = -matrix[10]!
      listener.upX.value = matrix[1]!
      listener.upY.value = matrix[5]!
      listener.upZ.value = matrix[9]!
    }
  }

  setBus(name: string, gain: number): void {
    this.busGains.set(name, gain)
    if (!this.graph) this.busNode(name).gain.setTargetAtTime(gain, this.context.currentTime, 0.015)
  }

  preload(clip: AudioClipSource): void {
    void this.prepare(clip)
      .then((lease) => lease.release())
      .catch(this.report)
  }

  async prepare(clip: AudioClipSource): Promise<AudioPreparation> {
    return this.acquireOwned(clip)
  }

  private async acquireOwned(
    clip: AudioClipSource,
  ): Promise<AudioPreparation & { value: PreparedAudio }> {
    if (this.disposed) throw new ShardError('audio/prepare-failed', 'Session is disposed')
    return this.ownLease(await this.host.cache.acquire(clip))
  }

  private ownLease(
    lease: AudioPreparation & { value: PreparedAudio },
  ): AudioPreparation & { value: PreparedAudio } {
    const clip = lease.clip
    const pinned = this.preparationPins.get(lease.value)
    if (
      this.disposed ||
      this.ownPreparedBytes + (pinned ? 0 : lease.decodedBytes) > this.budgetBytes
    ) {
      lease.release()
      throw new ShardError(
        this.disposed ? 'audio/prepare-failed' : 'audio/memory-budget',
        'Session cannot retain preparation',
      )
    }
    const pin = pinned ?? { count: 0, bytes: lease.decodedBytes }
    if (!pinned) {
      this.preparationPins.set(lease.value, pin)
      this.ownPreparedBytes += pin.bytes
    }
    pin.count++
    let released = false
    const owned: AudioPreparation & { value: PreparedAudio } = {
      clip,
      value: lease.value,
      decodedBytes: lease.decodedBytes,
      encodedBytes: lease.encodedBytes,
      sampleRate: lease.sampleRate,
      samples: lease.samples,
      channels: lease.channels,
      get released() {
        return released
      },
      release: () => {
        if (released) return
        released = true
        if (--pin.count === 0) {
          this.preparationPins.delete(lease.value)
          this.ownPreparedBytes -= pin.bytes
        }
        this.leases.delete(owned)
        lease.release()
      },
    }
    this.leases.add(owned)
    return owned
  }

  collect(): void {
    this.maintainGraphs()
    this.host.cache.collect()
  }

  memory() {
    let nodes = 1 + this.buses.size + this.meters.size
    for (const voice of this.voices.values())
      nodes +=
        4 + voice.sends.size + Number(!!voice.panner) + Number(!!voice.source || !!voice.mediaNode)
    nodes += this.graph ? this.graph.nodes.length + 1 : 0
    for (const graph of this.retired.keys()) nodes += graph.nodes.length + 1
    let effectBytes = this.graph?.generatedBytes ?? 0
    for (const graph of this.retired.keys()) effectBytes += graph.generatedBytes
    return { ...this.host.cache.memory(), effectBytes, voices: this.voices.size, nodes }
  }

  async configureMixer(graph: AudioMixerGraph): Promise<void> {
    const revision = ++this.graphRevision,
      output = this.context.createGain()
    output.gain.value = 0
    output.connect(this.output)
    let next: WebAudioGraph
    try {
      next = await WebAudioGraph.build(this.context, graph, output, {
        acquire: (clip) => this.acquireOwned(clip),
      })
    } catch (error) {
      output.disconnect()
      throw error
    }
    if (
      this.disposed ||
      revision !== this.graphRevision ||
      next.nodes.length +
        (this.graph?.nodes.length ?? 0) +
        [...this.retired.keys()].reduce((sum, graph) => sum + graph.nodes.length, 0) >
        graph.maxNodes ||
      next.generatedBytes +
        (this.graph?.generatedBytes ?? 0) +
        [...this.retired.keys()].reduce((sum, old) => sum + old.generatedBytes, 0) >
        64 * 1024 * 1024
    ) {
      next.dispose()
      output.disconnect()
      throw new ShardError(
        'audio/mixer-capacity',
        'Graph replacement cancelled or exceeds overlap budget',
      )
    }
    for (const voice of this.voices.values())
      if (
        !next.inputs.has(voice.desc.bus) ||
        [...voice.sends.keys()].some((target) => !next.sendInputs.get(voice.desc.bus)?.has(target))
      ) {
        next.dispose()
        output.disconnect()
        throw new ShardError('audio/unknown-bus', `Graph removes active route ${voice.desc.bus}`)
      }
    const old = this.graph
    this.graph = next
    for (const voice of this.voices.values()) {
      const input = next.inputs.get(voice.desc.bus)
      if (input) (voice.panner ?? voice.highpass).connect(input)
      for (const [target, node] of voice.sends)
        node.connect(next.sendInputs.get(voice.desc.bus)!.get(target)!)
    }
    const at = this.context.currentTime,
      fade = old ? 0.02 : 0
    output.gain.setValueAtTime(fade ? 0 : 1, at)
    if (fade) output.gain.linearRampToValueAtTime(1, at + fade)
    for (const node of this.buses.values()) node.disconnect()
    this.buses.clear()
    for (const meter of this.meters.values()) meter.node.disconnect()
    this.meters.clear()
    if (old) {
      const tailEnd = at + fade + old.tailSeconds
      this.retired.set(old, tailEnd + 0.02)
      for (const input of old.inputs.values()) {
        input.gain.cancelAndHoldAtTime(at)
        input.gain.linearRampToValueAtTime(0, at + fade)
      }
      for (const routes of old.sendInputs.values())
        for (const input of routes.values()) {
          input.gain.cancelAndHoldAtTime(at)
          input.gain.linearRampToValueAtTime(0, at + fade)
        }
      old.output.gain.setValueAtTime(1, tailEnd)
      old.output.gain.linearRampToValueAtTime(0, tailEnd + 0.02)
    }
  }

  private readonly maintainGraphs = (): void => {
    this.graph?.tick()
    this.retired.forEach(this.maintainRetired)
  }
  private readonly maintainRetired = (deadline: number, old: WebAudioGraph): void => {
    if (this.context.currentTime < deadline) return
    for (const voice of this.voices.values())
      for (const input of old.inputs.values()) {
        try {
          ;(voice.panner ?? voice.highpass).disconnect(input)
        } catch {
          /* Not connected. */
        }
      }
    for (const voice of this.voices.values())
      for (const [target, node] of voice.sends) {
        const input = old.sendInputs.get(voice.desc.bus)?.get(target)
        if (input)
          try {
            node.disconnect(input)
          } catch {
            /* Already rerouted. */
          }
      }
    old.dispose()
    old.output.disconnect()
    this.retired.delete(old)
  }

  setMixerValue(bus: string, field: string, value: number, rampSeconds = 0.01): void {
    if (!this.graph) throw new ShardError('audio/unsupported-capability', 'No mixer is installed')
    this.graph.set(bus, field, value, rampSeconds)
    if (field === 'userGain')
      for (const old of this.retired.keys())
        if (old.hasBus(bus)) old.set(bus, field, value, rampSeconds)
  }

  private emptyMeter() {
    return {
      available: !this.host.offline,
      peak: 0,
      rms: 0,
      samples: 0,
      sampleRate: this.context.sampleRate,
      at: -1,
    }
  }

  meter(bus: string) {
    if (this.host.offline) return this.emptyMeter()
    let meter = this.meters.get(bus)
    if (!meter) {
      const node = this.context.createAnalyser()
      node.fftSize = 2048
      this.busNode(bus).connect(node)
      meter = { node, data: new Float32Array(2048), value: this.emptyMeter() }
      this.meters.set(bus, meter)
    }
    if (this.context.currentTime - meter.value.at < 0.05) return meter.value
    meter.node.getFloatTimeDomainData(meter.data)
    let peak = 0,
      sum = 0
    for (let i = 0; i < meter.data.length; i++) {
      const v = meter.data[i]!
      peak = Math.max(peak, Math.abs(v))
      sum += v * v
    }
    meter.value.peak = peak
    meter.value.rms = Math.sqrt(sum / meter.data.length)
    meter.value.samples = meter.data.length
    meter.value.at = this.context.currentTime
    return meter.value
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.graphRevision++
    for (const handle of this.wakes) clearInterval(handle)
    for (const handle of this.timers) clearTimeout(handle)
    this.wakes.clear()
    this.timers.clear()
    this.context.removeEventListener('statechange', this.stateChanged)
    if (!this.host.offline)
      for (const gesture of gestures)
        window.removeEventListener(gesture, this.unlock, { capture: true })
    for (const voice of this.voices.values()) this.finish(voice)
    for (const lease of this.leases) lease.release()
    for (const node of this.buses.values()) node.disconnect()
    for (const meter of this.meters.values()) meter.node.disconnect()
    this.buses.clear()
    this.meters.clear()
    this.statuses.clear()
    this.graph?.dispose()
    this.graph?.output.disconnect()
    this.graph = null
    for (const graph of this.retired.keys()) {
      graph.dispose()
      graph.output.disconnect()
    }
    this.retired.clear()
    this.output.disconnect()
    this.host.reserved -= this.reserved
    this.reserved = 0
    this.host.sessions.delete(this)
    if (this.root) {
      for (const session of this.host.sessions) session.dispose()
      this.host.cache.dispose()
      this.host.output.disconnect()
      if (this.host.ownsContext && !this.host.offline) void (this.context as AudioContext).close()
    } else this.host.cache.collect()
  }
}

/** fixedListener:true explicitly grants Shard ownership of an external context's listener. */
export function createWebAudioBackend(
  options: AudioSessionOptions & {
    context?: BaseAudioContext
    fixedListener?: boolean
    maxHostVoices?: number
  } = {},
): WebAudioBackend {
  const context = options.context ?? new AudioContext({ latencyHint: 'interactive' })
  const offline =
    typeof OfflineAudioContext !== 'undefined' && context instanceof OfflineAudioContext
  const output = context.createGain()
  output.connect(context.destination)
  const fixedListener = options.context ? options.fixedListener === true : true
  if (fixedListener) {
    const listener = context.listener
    listener.positionX.value = 0
    listener.positionY.value = 0
    listener.positionZ.value = 0
    listener.forwardX.value = 0
    listener.forwardY.value = 0
    listener.forwardZ.value = -1
    listener.upX.value = 0
    listener.upY.value = 1
    listener.upZ.value = 0
  }
  const host: Host = {
    context,
    output,
    offline,
    fixedListener,
    ownsContext: !options.context,
    cache: new AudioCache(context, options.decodedBudgetBytes, options.maxDecodes),
    sessions: new Set(),
    maxVoices: options.maxHostVoices ?? 256,
    voices: 0,
    reserved: 0,
    nextSession: 0,
  }
  return new WebSession(host, true, options)
}
