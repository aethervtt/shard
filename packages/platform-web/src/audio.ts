import { ShardError } from '@aethervtt/shard-core'
import type {
  AudioBackend,
  AudioClipSource,
  AudioContextState,
  AudioVoiceDesc,
  AudioVoiceParams,
} from '@aethervtt/shard-platform'

interface Decoded {
  buffer: AudioBuffer
  /** 1 / peak when the clip normalizes, else 1. */
  norm: number
}

interface WebVoice {
  desc: AudioVoiceDesc
  params: AudioVoiceParams
  gain: GainNode
  panner: PannerNode | null
  source: AudioBufferSourceNode | null
  element: HTMLAudioElement | null
  norm: number
  /** performance.now() when the plugin asked for it, to start in step after a wait. */
  requestedAt: number
  started: boolean
  stopped: boolean
}

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const
/** Time constant for parameter changes: smooth enough not to click, quick enough to follow. */
const SMOOTH = 0.015
/** Shortest stop fade, so stopping never clicks. */
const MIN_FADE = 0.008

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  vorbis: 'audio/ogg; codecs="vorbis"',
  opus: 'audio/ogg; codecs="opus"',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
}

/** Web Audio in a browser or webview: one context, a gain node per bus, a PannerNode per spatial voice. */
export interface WebAudioBackend extends AudioBackend {
  readonly context: AudioContext
  /** Everything mixed (before the destination), for meters. */
  readonly output: GainNode
  /** A bus's gain node (after its gain), for meters. */
  busNode(name: string): GainNode
  /** Resumes the context (browsers need a user gesture first). */
  resume(): Promise<void>
}

/**
 * The Web Audio backend. The context starts suspended in most browsers; it resumes on the first
 * pointer, key, or touch, and voices asked for before then start in step at that moment.
 */
export function createWebAudioBackend(options: { context?: AudioContext } = {}): WebAudioBackend {
  const ctx = options.context ?? new AudioContext({ latencyHint: 'interactive' })
  const output = ctx.createGain()
  output.connect(ctx.destination)
  const buses = new Map<string, GainNode>()
  const busGains = new Map<string, number>()
  const voices = new Map<number, WebVoice>()
  const decoded = new WeakMap<Uint8Array, Promise<Decoded>>()
  const urls = new WeakMap<Uint8Array, string>()
  let next = 1

  const report = (err: ShardError) => {
    if (backend.onError) backend.onError(err)
    else console.error(err)
  }

  const resume = async () => {
    if (ctx.state !== 'running' && ctx.state !== 'closed') await ctx.resume().catch(() => {})
  }
  const onGesture = () => void resume()
  for (const g of GESTURES) window.addEventListener(g, onGesture, { capture: true })
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'running') {
      for (const g of GESTURES) window.removeEventListener(g, onGesture, { capture: true })
      for (const voice of voices.values()) if (!voice.started) start(voice)
    }
  })

  function bus(name: string): GainNode {
    let node = buses.get(name)
    if (!node) {
      node = ctx.createGain()
      node.gain.value = busGains.get(name) ?? 1
      node.connect(output)
      buses.set(name, node)
    }
    return node
  }

  function decode(clip: AudioClipSource): Promise<Decoded> {
    let p = decoded.get(clip.bytes)
    if (!p) {
      // decodeAudioData detaches its buffer, so hand it a copy.
      const copy = clip.bytes.slice().buffer
      p = ctx.decodeAudioData(copy).then(
        (buffer) => ({ buffer, norm: clip.normalize ? normalization(buffer) : 1 }),
        (cause: unknown) => {
          throw new ShardError('audio/decode-failed', `Can't decode ${clip.id} (${clip.codec})`, {
            hint:
              clip.codec === 'opus'
                ? "This browser can't decode Opus (Safari before 18.4). Use Ogg Vorbis or MP3."
                : 'The file may be damaged, or this browser lacks the codec. Re-export it as Ogg Vorbis or MP3.',
            cause,
          })
        },
      )
      decoded.set(clip.bytes, p)
    }
    return p
  }

  function mediaUrl(clip: AudioClipSource): string {
    let url = urls.get(clip.bytes)
    if (!url) {
      const blob = new Blob([clip.bytes.slice().buffer], { type: MIME[clip.codec] ?? 'audio/*' })
      url = URL.createObjectURL(blob)
      urls.set(clip.bytes, url)
    }
    return url
  }

  /** Where to start: the offset asked for plus the wait since, wrapped into the loop region. */
  function offsetNow(voice: WebVoice, duration: number): number {
    const d = voice.desc
    let t = d.offset + ((performance.now() - voice.requestedAt) / 1000) * voice.params.pitch
    if (!d.loop) return t
    const end = d.clip.loopEnd > 0 ? Math.min(d.clip.loopEnd, duration) : duration
    const begin = d.clip.loopEnd > 0 && d.clip.loopStart < end ? d.clip.loopStart : 0
    if (t >= end && end > begin) t = begin + ((t - end) % (end - begin))
    return t
  }

  function start(voice: WebVoice): void {
    if (voice.stopped || voice.started || ctx.state !== 'running') return
    const d = voice.desc
    if (d.clip.stream) {
      voice.started = true
      const el = new Audio(mediaUrl(d.clip))
      el.loop = d.loop
      el.preservesPitch = false
      el.playbackRate = voice.params.pitch
      el.currentTime = offsetNow(voice, d.clip.duration) % Math.max(d.clip.duration, 1e-3)
      ctx.createMediaElementSource(el).connect(voice.gain)
      voice.element = el
      el.play().catch((cause: unknown) =>
        report(
          new ShardError('audio/decode-failed', `Can't stream ${d.clip.id} (${d.clip.codec})`, {
            cause,
          }),
        ),
      )
      return
    }
    decode(d.clip).then(
      ({ buffer, norm }) => {
        if (voice.stopped || voice.started || ctx.state !== 'running') return
        const offset = offsetNow(voice, buffer.duration)
        if (!d.loop && offset >= buffer.duration) return
        voice.started = true
        voice.norm = norm
        voice.gain.gain.value = voice.params.gain * norm
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.loop = d.loop
        if (d.loop && d.clip.loopEnd > 0) {
          src.loopStart = d.clip.loopStart
          src.loopEnd = d.clip.loopEnd
        }
        src.playbackRate.value = voice.params.pitch
        src.connect(voice.gain)
        src.start(0, offset)
        voice.source = src
      },
      (err: ShardError) => report(err),
    )
  }

  function place(panner: PannerNode, x: number, y: number, z: number, at: number): void {
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x, at, SMOOTH)
      panner.positionY.setTargetAtTime(y, at, SMOOTH)
      panner.positionZ.setTargetAtTime(z, at, SMOOTH)
    } else panner.setPosition(x, y, z)
  }

  const backend: WebAudioBackend = {
    kind: 'web',
    context: ctx,
    output,
    get state(): AudioContextState {
      const s = ctx.state as string
      return s === 'running' ? 'running' : s === 'closed' ? 'closed' : 'suspended'
    },
    resume,
    busNode: bus,

    play(desc) {
      const id = next++
      const gain = ctx.createGain()
      gain.gain.value = desc.gain
      let panner: PannerNode | null = null
      const s = desc.spatial
      if (s) {
        panner = ctx.createPanner()
        panner.panningModel = s.panning === 'hrtf' ? 'HRTF' : 'equalpower'
        panner.distanceModel = s.distanceModel
        panner.refDistance = s.refDistance
        panner.maxDistance = Math.max(s.maxDistance, s.refDistance + 1e-3)
        panner.rolloffFactor = s.rolloffFactor
        if (panner.positionX) {
          panner.positionX.value = desc.x
          panner.positionY.value = desc.y
          panner.positionZ.value = desc.z
        } else panner.setPosition(desc.x, desc.y, desc.z)
        gain.connect(panner).connect(bus(desc.bus))
      } else gain.connect(bus(desc.bus))
      const voice: WebVoice = {
        desc,
        params: { gain: desc.gain, pitch: desc.pitch, x: desc.x, y: desc.y, z: desc.z },
        gain,
        panner,
        source: null,
        element: null,
        norm: 1,
        requestedAt: performance.now(),
        started: false,
        stopped: false,
      }
      voices.set(id, voice)
      start(voice)
      return id
    },

    preload(clip) {
      // Streamed clips play through a media element: nothing to decode ahead.
      if (!clip.stream) decode(clip).catch((err: ShardError) => backend.onError?.(err))
    },

    update(id, params) {
      const v = voices.get(id)
      if (!v) return
      const now = ctx.currentTime
      const p = v.params
      if (p.gain !== params.gain) v.gain.gain.setTargetAtTime(params.gain * v.norm, now, SMOOTH)
      if (p.pitch !== params.pitch) {
        if (v.source) v.source.playbackRate.setTargetAtTime(params.pitch, now, SMOOTH)
        if (v.element) v.element.playbackRate = params.pitch
      }
      if (v.panner && (p.x !== params.x || p.y !== params.y || p.z !== params.z)) {
        place(v.panner, params.x, params.y, params.z, now)
      }
      p.gain = params.gain
      p.pitch = params.pitch
      p.x = params.x
      p.y = params.y
      p.z = params.z
    },

    stop(id, fade = 0) {
      const v = voices.get(id)
      if (!v) return
      voices.delete(id)
      v.stopped = true
      const now = ctx.currentTime
      const f = Math.max(fade, MIN_FADE)
      v.gain.gain.cancelScheduledValues(now)
      v.gain.gain.setValueAtTime(v.gain.gain.value, now)
      v.gain.gain.linearRampToValueAtTime(0, now + f)
      const release = () => {
        v.gain.disconnect()
        v.panner?.disconnect()
        if (v.element) {
          v.element.pause()
          v.element.removeAttribute('src')
        }
      }
      if (v.source) {
        v.source.onended = release
        v.source.stop(now + f)
      } else setTimeout(release, f * 1000 + 50)
    },

    setListener(m) {
      const l = ctx.listener
      const fl = Math.sqrt(m[2]! * m[2]! + m[6]! * m[6]! + m[10]! * m[10]!) || 1
      const ul = Math.sqrt(m[1]! * m[1]! + m[5]! * m[5]! + m[9]! * m[9]!) || 1
      const fx = -m[2]! / fl
      const fy = -m[6]! / fl
      const fz = -m[10]! / fl
      const ux = m[1]! / ul
      const uy = m[5]! / ul
      const uz = m[9]! / ul
      if (l.positionX) {
        const now = ctx.currentTime
        l.positionX.setTargetAtTime(m[3]!, now, SMOOTH)
        l.positionY.setTargetAtTime(m[7]!, now, SMOOTH)
        l.positionZ.setTargetAtTime(m[11]!, now, SMOOTH)
        l.forwardX.setTargetAtTime(fx, now, SMOOTH)
        l.forwardY.setTargetAtTime(fy, now, SMOOTH)
        l.forwardZ.setTargetAtTime(fz, now, SMOOTH)
        l.upX.setTargetAtTime(ux, now, SMOOTH)
        l.upY.setTargetAtTime(uy, now, SMOOTH)
        l.upZ.setTargetAtTime(uz, now, SMOOTH)
      } else {
        l.setPosition(m[3]!, m[7]!, m[11]!)
        l.setOrientation(fx, fy, fz, ux, uy, uz)
      }
    },

    setBus(name, gain) {
      busGains.set(name, gain)
      bus(name).gain.setTargetAtTime(gain, ctx.currentTime, SMOOTH)
    },

    dispose() {
      for (const g of GESTURES) window.removeEventListener(g, onGesture, { capture: true })
      for (const id of [...voices.keys()]) backend.stop(id)
      void ctx.close()
    },
  }
  return backend
}

function normalization(buffer: AudioBuffer): number {
  let peak = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]!)
      if (a > peak) peak = a
    }
  }
  return peak > 0 ? 1 / peak : 1
}
