import { ShardError } from '@aethervtt/shard-core'

/** What an audio file's headers say, without decoding it. */
export interface AudioInfo {
  codec: AudioCodec
  /** Seconds. */
  duration: number
  channels: number
  /** Samples per second of the decoded audio. */
  sampleRate: number
  /** Largest absolute sample (0 to 1), when it's known without a decoder (PCM WAV). */
  peak?: number
}

export const AUDIO_CODECS = ['wav', 'vorbis', 'opus', 'mp3', 'flac'] as const
export type AudioCodec = (typeof AUDIO_CODECS)[number]

const ascii = (b: Uint8Array, at: number, n: number) => {
  let s = ''
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!)
  return s
}

function unsupported(path: string, why: string): ShardError {
  return new ShardError('audio/unsupported-format', `${path}: ${why}`, {
    hint: 'Audio clips are WAV (PCM or float), Ogg Vorbis, Ogg Opus, MP3, or FLAC.',
    path,
  })
}

/** Reads codec, duration, channels, and sample rate from a file's headers. */
export function probeAudio(bytes: Uint8Array, path = 'audio'): AudioInfo {
  const magic = ascii(bytes, 0, 4)
  if (magic === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return probeWav(bytes, path)
  if (magic === 'OggS') return probeOgg(bytes, path)
  const start = skipId3(bytes)
  if (ascii(bytes, start, 4) === 'fLaC') return probeFlac(bytes, start, path)
  if (findMp3Frame(bytes, start) !== -1) return probeMp3(bytes, start, path)
  throw unsupported(path, 'not a WAV, Ogg, MP3, or FLAC file')
}

// --- WAV -----------------------------------------------------------------------------------------

function probeWav(b: Uint8Array, path: string): AudioInfo {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let format = -1
  let channels = 0
  let sampleRate = 0
  let blockAlign = 0
  let bits = 0
  let dataAt = -1
  let dataSize = 0
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, 4)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ') {
      format = view.getUint16(at + 8, true)
      channels = view.getUint16(at + 10, true)
      sampleRate = view.getUint32(at + 12, true)
      blockAlign = view.getUint16(at + 20, true)
      bits = view.getUint16(at + 22, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 26) format = view.getUint16(at + 32, true)
    } else if (id === 'data') {
      dataAt = at + 8
      // Streams written before their length is known say 0 or 0xffffffff: take the rest.
      dataSize = size === 0 || size === 0xffffffff ? b.length - dataAt : size
      dataSize = Math.min(dataSize, b.length - dataAt)
    }
    at += 8 + size + (size & 1)
  }
  if (format === -1) throw unsupported(path, 'WAV without a fmt chunk')
  if (dataAt === -1) throw unsupported(path, 'WAV without a data chunk')
  if (format !== 1 && format !== 3) {
    throw unsupported(path, `WAV format ${format} (only PCM and IEEE float)`)
  }
  if (channels === 0 || sampleRate === 0 || blockAlign === 0) {
    throw unsupported(path, 'WAV header with no channels or sample rate')
  }
  const frames = Math.floor(dataSize / blockAlign)
  return {
    codec: 'wav',
    duration: frames / sampleRate,
    channels,
    sampleRate,
    peak: wavPeak(view, dataAt, frames * blockAlign, format, bits),
  }
}

function wavPeak(
  view: DataView,
  at: number,
  size: number,
  format: number,
  bits: number,
): number | undefined {
  let peak = 0
  const end = at + size
  if (format === 3 && bits === 32) {
    for (let i = at; i + 4 <= end; i += 4) peak = Math.max(peak, Math.abs(view.getFloat32(i, true)))
  } else if (format === 1 && bits === 16) {
    for (let i = at; i + 2 <= end; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)))
    peak /= 32768
  } else if (format === 1 && bits === 8) {
    for (let i = at; i < end; i++) peak = Math.max(peak, Math.abs(view.getUint8(i) - 128))
    peak /= 128
  } else if (format === 1 && bits === 24) {
    for (let i = at; i + 3 <= end; i += 3) {
      const v = (view.getUint8(i) | (view.getUint8(i + 1) << 8) | (view.getInt8(i + 2) << 16)) >> 0
      peak = Math.max(peak, Math.abs(v))
    }
    peak /= 8388608
  } else if (format === 1 && bits === 32) {
    for (let i = at; i + 4 <= end; i += 4) peak = Math.max(peak, Math.abs(view.getInt32(i, true)))
    peak /= 2147483648
  } else return undefined
  return Math.min(1, peak)
}

// --- Ogg (Vorbis, Opus) ---------------------------------------------------------------------------

interface OggPage {
  granule: number
  serial: number
  /** Where the page's body starts, and its length. */
  body: number
  size: number
}

function oggPage(b: Uint8Array, at: number): OggPage | undefined {
  if (at + 27 > b.length || ascii(b, at, 4) !== 'OggS') return undefined
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const segments = b[at + 26]!
  if (at + 27 + segments > b.length) return undefined
  let size = 0
  for (let i = 0; i < segments; i++) size += b[at + 27 + i]!
  const lo = view.getUint32(at + 6, true)
  const hi = view.getInt32(at + 10, true)
  return {
    granule: hi * 2 ** 32 + lo,
    serial: view.getUint32(at + 14, true),
    body: at + 27 + segments,
    size,
  }
}

function probeOgg(b: Uint8Array, path: string): AudioInfo {
  const first = oggPage(b, 0)
  if (!first) throw unsupported(path, 'truncated Ogg page')
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const head = first.body
  let codec: AudioCodec
  let channels: number
  let sampleRate: number
  let preSkip = 0
  if (b[head] === 1 && ascii(b, head + 1, 6) === 'vorbis') {
    codec = 'vorbis'
    channels = b[head + 11]!
    sampleRate = view.getUint32(head + 12, true)
  } else if (ascii(b, head, 8) === 'OpusHead') {
    codec = 'opus'
    channels = b[head + 9]!
    preSkip = view.getUint16(head + 10, true)
    // Opus always decodes at 48 kHz; granule positions count 48 kHz samples.
    sampleRate = 48000
  } else {
    throw unsupported(path, `Ogg stream of an unsupported codec ("${ascii(b, head, 8)}")`)
  }
  // The last page of the first stream holds the total sample count.
  let granule = -1
  for (let at = b.length - 27; at >= 0; at--) {
    if (b[at] !== 0x4f || ascii(b, at, 4) !== 'OggS') continue
    const page = oggPage(b, at)
    if (page && page.serial === first.serial && page.granule >= 0) {
      granule = page.granule
      break
    }
  }
  if (granule < 0 || sampleRate === 0) throw unsupported(path, 'Ogg stream without a length')
  return { codec, duration: Math.max(0, granule - preSkip) / sampleRate, channels, sampleRate }
}

// --- FLAC ------------------------------------------------------------------------------------------

function probeFlac(b: Uint8Array, start: number, path: string): AudioInfo {
  // The first metadata block is always STREAMINFO.
  const info = start + 8
  if ((b[start + 4]! & 0x7f) !== 0 || info + 18 > b.length) {
    throw unsupported(path, 'FLAC without STREAMINFO')
  }
  const sampleRate = (b[info + 10]! << 12) | (b[info + 11]! << 4) | (b[info + 12]! >> 4)
  const channels = ((b[info + 12]! >> 1) & 7) + 1
  const total =
    (b[info + 13]! & 0x0f) * 2 ** 32 +
    ((b[info + 14]! << 24) >>> 0) +
    (b[info + 15]! << 16) +
    (b[info + 16]! << 8) +
    b[info + 17]!
  if (sampleRate === 0) throw unsupported(path, 'FLAC with a sample rate of 0')
  return { codec: 'flac', duration: total / sampleRate, channels, sampleRate }
}

// --- MP3 -------------------------------------------------------------------------------------------

/** Past an ID3v2 tag, if the file starts with one. */
function skipId3(b: Uint8Array): number {
  if (ascii(b, 0, 3) !== 'ID3' || b.length < 10) return 0
  const size =
    ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f)
  const footer = b[5]! & 0x10 ? 10 : 0
  return 10 + size + footer
}

const MP3_BITRATES = {
  // [version 1, version 2/2.5] by layer, kbit/s, index 1..14.
  v1: [
    [],
    [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  v2: [
    [],
    [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
}
const MP3_RATES = [44100, 48000, 32000]

interface Mp3Frame {
  /** 1, 2, or 2.5. */
  version: number
  layer: number
  sampleRate: number
  channels: number
  samples: number
  length: number
}

function mp3Frame(b: Uint8Array, at: number): Mp3Frame | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return undefined
  const v = (b[at + 1]! >> 3) & 3
  const l = (b[at + 1]! >> 1) & 3
  const bi = b[at + 2]! >> 4
  const ri = (b[at + 2]! >> 2) & 3
  if (v === 1 || l === 0 || bi === 0 || bi === 15 || ri === 3) return undefined
  const version = v === 3 ? 1 : v === 2 ? 2 : 2.5
  const layer = 4 - l
  const bitrate = (version === 1 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[layer]![bi - 1]! * 1000
  const sampleRate = MP3_RATES[ri]! / (version === 1 ? 1 : version === 2 ? 2 : 4)
  const padding = (b[at + 2]! >> 1) & 1
  const channels = b[at + 3]! >> 6 === 3 ? 1 : 2
  let samples: number
  let length: number
  if (layer === 1) {
    samples = 384
    length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
  } else {
    samples = layer === 3 && version !== 1 ? 576 : 1152
    length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding
  }
  return { version, layer, sampleRate, channels, samples, length }
}

/** The first offset at or after `from` where two frames in a row parse. */
function findMp3Frame(b: Uint8Array, from: number): number {
  const limit = Math.min(b.length, from + 64 * 1024)
  for (let at = from; at < limit; at++) {
    const f = mp3Frame(b, at)
    if (f && (at + f.length === b.length || mp3Frame(b, at + f.length))) return at
  }
  return -1
}

function probeMp3(b: Uint8Array, start: number, path: string): AudioInfo {
  const at = findMp3Frame(b, start)
  const first = mp3Frame(b, at)
  if (!first) throw unsupported(path, 'no MPEG audio frames')
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  // A Xing/Info (LAME) or VBRI header in the first frame gives the frame count, and LAME's the
  // encoder delay and padding, so the length is exact. Otherwise count frames.
  const side =
    first.version === 1 ? (first.channels === 1 ? 17 : 32) : first.channels === 1 ? 9 : 17
  const xing = at + 4 + side
  const tag = ascii(b, xing, 4)
  let frames = -1
  let trim = 0
  if ((tag === 'Xing' || tag === 'Info') && xing + 8 <= b.length) {
    const flags = view.getUint32(xing + 4, false)
    let off = xing + 8
    if (flags & 1) {
      frames = view.getUint32(off, false)
      off += 4
    }
    if (flags & 2) off += 4
    if (flags & 4) off += 100
    if (flags & 8) off += 4
    if (frames >= 0 && ascii(b, off, 4) === 'LAME' && off + 24 <= b.length) {
      const delay = (b[off + 21]! << 4) | (b[off + 22]! >> 4)
      const padding = ((b[off + 22]! & 0x0f) << 8) | b[off + 23]!
      trim = delay + padding
    }
  } else if (ascii(b, at + 36, 4) === 'VBRI' && at + 50 <= b.length) {
    frames = view.getUint32(at + 36 + 14, false)
  }
  if (frames < 0) {
    frames = 0
    let pos = at
    for (;;) {
      const f = mp3Frame(b, pos)
      if (!f || f.length <= 0) break
      frames++
      pos += f.length
      if (pos >= b.length) break
    }
  }
  const samples = Math.max(0, frames * first.samples - trim)
  return {
    codec: 'mp3',
    duration: samples / first.sampleRate,
    channels: first.channels,
    sampleRate: first.sampleRate,
  }
}
