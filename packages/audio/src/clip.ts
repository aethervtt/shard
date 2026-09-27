import { AssetStore, defineAssetType, defineImporter } from '@aethervtt/shard-assets'
import { defineResource, defineSchema, type JsonValue, ShardError, t } from '@aethervtt/shard-core'
import type { AudioClipSource } from '@aethervtt/shard-platform'
import { type AudioCodec, probeAudio } from './formats'

export const AudioImportSettings = defineSchema(
  'audio/ImportSettings',
  {
    mode: t.enum(['decoded', 'stream'], {
      description:
        'decoded: decoded into memory on first play; sample-accurate, for effects. stream: played through a media element as it loads; for music and long ambience.',
    }),
    normalize: t.bool({ description: 'Scale the clip so its loudest sample is at full level.' }),
    loopStart: t.f32({ min: 0, unit: 's', description: 'Where a looping source jumps back to.' }),
    loopEnd: t.f32({
      min: 0,
      unit: 's',
      description: 'Where a looping source jumps back from. 0: the end of the clip.',
    }),
  },
  { description: 'Import settings for audio clips (WAV, Ogg Vorbis, Ogg Opus, MP3, FLAC).' },
)

/** A sound file, kept compressed: the backend decodes (or streams) it. */
export interface AudioClipAsset extends AudioClipSource {
  codec: AudioCodec
  bytes: Uint8Array
  duration: number
  channels: number
  sampleRate: number
  stream: boolean
  normalize: boolean
  loopStart: number
  loopEnd: number
}

export const AudioClips = defineResource<AssetStore<AudioClipAsset, 'AudioClip'>>(
  'audio/AudioClips',
  { description: 'Audio clips by guid.', init: () => new AssetStore('AudioClip') },
)

interface ClipJson {
  codec: AudioCodec
  duration: number
  channels: number
  sampleRate: number
  mode: 'decoded' | 'stream'
  normalize: boolean
  loopStart: number
  loopEnd: number
}

export const AudioClipAssetType = defineAssetType<AudioClipAsset>('AudioClip', {
  store: AudioClips,
  load: (artifact, ctx) => {
    const json = artifact.json as unknown as ClipJson
    if (!artifact.bytes) {
      throw new ShardError('audio/decode-failed', `${ctx.path}: the artifact has no audio bytes`, {
        hint: 'Re-import the file (shard import --json).',
        path: ctx.path,
      })
    }
    return {
      id: ctx.guid,
      codec: json.codec,
      bytes: artifact.bytes,
      duration: json.duration,
      channels: json.channels,
      sampleRate: json.sampleRate,
      stream: json.mode === 'stream',
      normalize: json.normalize,
      loopStart: json.loopStart,
      loopEnd: json.loopEnd,
    }
  },
  update: (existing, next) => {
    Object.assign(existing, next)
  },
})

/** Makes a clip in code (tests, generated sounds): probes the bytes like the importer does. */
export function audioClip(
  bytes: Uint8Array,
  options: {
    id?: string
    mode?: 'decoded' | 'stream'
    normalize?: boolean
    loopStart?: number
    loopEnd?: number
  } = {},
): AudioClipAsset {
  const info = probeAudio(bytes, options.id)
  return {
    id: options.id ?? 'mem:audioclip',
    codec: info.codec,
    bytes,
    duration: info.duration,
    channels: info.channels,
    sampleRate: info.sampleRate,
    stream: options.mode === 'stream',
    normalize: options.normalize ?? false,
    loopStart: options.loopStart ?? 0,
    loopEnd: options.loopEnd ?? 0,
  }
}

/** New clips under a `music/` folder stream; everything else decodes. */
function defaultMode(path: string): 'decoded' | 'stream' {
  return /(^|\/)(music|ambience|ambient)\//i.test(path) ? 'stream' : 'decoded'
}

export const AudioImporter = defineImporter({
  name: 'audio',
  version: 1,
  extensions: ['.wav', '.ogg', '.oga', '.opus', '.mp3', '.flac'],
  settings: AudioImportSettings,
  defaults: (path) => ({ mode: defaultMode(path) }),
  async import(source, ctx) {
    const settings = ctx.settings as {
      mode: 'decoded' | 'stream'
      normalize: boolean
      loopStart: number
      loopEnd: number
    }
    const info = probeAudio(source.bytes, source.path)
    if (info.codec === 'opus') {
      ctx.warn(
        "Opus doesn't decode in Safari before 18.4 (macOS and iOS); use Ogg Vorbis or MP3 if the game targets them.",
      )
    }
    if (settings.loopEnd > info.duration + 1e-3) {
      ctx.warn(
        `loopEnd ${settings.loopEnd} s is past the end of the clip (${info.duration.toFixed(3)} s).`,
        '/loopEnd',
      )
    }
    if (settings.loopEnd > 0 && settings.loopStart >= settings.loopEnd) {
      ctx.warn('loopStart must be before loopEnd; the whole clip loops.', '/loopStart')
    }
    if (settings.mode === 'stream' && (settings.loopStart > 0 || settings.loopEnd > 0)) {
      ctx.warn('Streamed clips loop the whole file; loopStart and loopEnd need mode "decoded".')
    }
    if (settings.normalize && info.peak === 0)
      ctx.warn('The clip is silent; normalize does nothing.')
    const json: ClipJson = {
      codec: info.codec,
      duration: info.duration,
      channels: info.channels,
      sampleRate: info.sampleRate,
      mode: settings.mode,
      normalize: settings.normalize,
      loopStart: settings.loopStart,
      loopEnd: settings.loopEnd,
    }
    const facts: Record<string, JsonValue> = {
      codec: info.codec,
      duration: Math.round(info.duration * 1e6) / 1e6,
      channels: info.channels,
      sampleRate: info.sampleRate,
      mode: settings.mode,
      bytes: source.bytes.byteLength,
    }
    if (info.peak !== undefined) facts.peak = Math.round(info.peak * 1e4) / 1e4
    return {
      assets: [
        {
          label: '',
          type: 'AudioClip',
          bytes: source.bytes,
          json: json as unknown as JsonValue,
          info: facts,
        },
      ],
    }
  },
})
