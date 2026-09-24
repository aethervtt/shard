import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import { ShardError, World } from '@shard/core'
import { createNodePlatform } from '@shard/platform-node'
import { afterAll, describe, expect, it } from 'vitest'
import { AudioClips } from './clip'
import { probeAudio } from './formats'
import { sineWav } from './testing-utils'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const read = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** An Ogg page (CRC left 0: the probe doesn't check it). */
function oggPage(serial: number, granule: number, body: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(27 + 1 + body.length)
  const view = new DataView(out.buffer)
  out.set([0x4f, 0x67, 0x67, 0x53], 0)
  out[5] = flags
  view.setUint32(6, granule % 2 ** 32, true)
  view.setUint32(10, Math.floor(granule / 2 ** 32), true)
  view.setUint32(14, serial, true)
  out[26] = 1
  out[27] = body.length
  out.set(body, 28)
  return out
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('probeAudio', () => {
  it('reads the WAV, Ogg Vorbis, and MP3 fixtures', () => {
    expect(probeAudio(read('tone-44k-mono.wav'))).toMatchObject({
      codec: 'wav',
      duration: 0.5,
      channels: 1,
      sampleRate: 44100,
    })
    expect(probeAudio(read('tone-48k-stereo.ogg'))).toEqual({
      codec: 'vorbis',
      duration: 1.25,
      channels: 2,
      sampleRate: 48000,
    })
    // Raw LAME frames (no Xing header): the length counts whole frames, so it includes the
    // encoder delay and the last frame's padding (under two frames).
    const mp3 = probeAudio(read('tone-44k-stereo.mp3'))
    expect(mp3).toMatchObject({ codec: 'mp3', channels: 2, sampleRate: 44100 })
    expect(mp3.duration).toBeGreaterThanOrEqual(1)
    expect(mp3.duration).toBeLessThan(1 + (2 * 1152) / 44100)
    expect((mp3.duration * 44100) / 1152).toBeCloseTo(Math.round((mp3.duration * 44100) / 1152), 6)
    // MPEG-2 layer III: 576 samples a frame.
    const low = probeAudio(read('tone-22k-mono.mp3'))
    expect(low).toMatchObject({ codec: 'mp3', channels: 1, sampleRate: 22050 })
    expect(low.duration).toBeGreaterThanOrEqual(0.75)
    expect(low.duration).toBeLessThan(0.75 + (3 * 576) / 22050)
  })

  it('finds the peak of PCM WAVs', () => {
    expect(probeAudio(sineWav(0.1, { amplitude: 0.25 })).peak).toBeCloseTo(0.25, 3)
    expect(probeAudio(sineWav(0.2, { rate: 22050, channels: 2 }))).toMatchObject({
      duration: 0.2,
      channels: 2,
      sampleRate: 22050,
    })
  })

  it('reads Ogg Opus (48 kHz, minus pre-skip) and FLAC STREAMINFO', () => {
    const head = new Uint8Array(19)
    head.set(new TextEncoder().encode('OpusHead'))
    head[8] = 1
    head[9] = 2
    new DataView(head.buffer).setUint16(10, 312, true)
    new DataView(head.buffer).setUint32(12, 44100, true)
    const opus = concat(
      oggPage(7, 0, head, 2),
      oggPage(7, 0, new TextEncoder().encode('OpusTags')),
      oggPage(7, 312 + 96000, new Uint8Array(10), 4),
    )
    expect(probeAudio(opus)).toEqual({ codec: 'opus', duration: 2, channels: 2, sampleRate: 48000 })

    const flac = new Uint8Array(8 + 34)
    flac.set(new TextEncoder().encode('fLaC'))
    flac[4] = 0x80 // last block, type 0 (STREAMINFO)
    flac[7] = 34
    // 96000 Hz, 2 channels, 24 bits, 288000 samples (3 s).
    const rate = 96000
    const total = 288000
    flac[8 + 10] = (rate >> 12) & 0xff
    flac[8 + 11] = (rate >> 4) & 0xff
    flac[8 + 12] = ((rate & 0x0f) << 4) | ((2 - 1) << 1) | ((24 - 1) >> 4)
    flac[8 + 13] = (((24 - 1) & 0x0f) << 4) | 0
    new DataView(flac.buffer).setUint32(8 + 14, total, false)
    expect(probeAudio(flac)).toEqual({ codec: 'flac', duration: 3, channels: 2, sampleRate: 96000 })
  })

  it('uses a Xing frame count and the LAME delay and padding', () => {
    // MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo: 417-byte frames.
    const frame = () => {
      const f = new Uint8Array(417)
      f.set([0xff, 0xfb, 0x90, 0x00])
      return f
    }
    const info = frame()
    const x = 4 + 32
    info.set(new TextEncoder().encode('Info'), x)
    new DataView(info.buffer).setUint32(x + 4, 1, false) // frames only
    new DataView(info.buffer).setUint32(x + 8, 100, false)
    const lame = x + 12
    info.set(new TextEncoder().encode('LAME3.100'), lame)
    // Delay 576, padding 1000.
    info[lame + 21] = 576 >> 4
    info[lame + 22] = ((576 & 0x0f) << 4) | (1000 >> 8)
    info[lame + 23] = 1000 & 0xff
    const file = concat(info, frame(), frame(), frame())
    expect(probeAudio(file)).toEqual({
      codec: 'mp3',
      duration: (100 * 1152 - 576 - 1000) / 44100,
      channels: 2,
      sampleRate: 44100,
    })
  })

  it('skips an ID3v2 tag', () => {
    const tag = new Uint8Array(10 + 20)
    tag.set(new TextEncoder().encode('ID3'))
    tag[3] = 4
    tag[9] = 20
    const mp3 = read('tone-22k-mono.mp3')
    expect(probeAudio(concat(tag, mp3)).duration).toBe(probeAudio(mp3).duration)
  })

  it('rejects files that are not audio', () => {
    const err = (() => {
      try {
        probeAudio(new TextEncoder().encode('definitely not a sound file'), 'assets/x.mp3')
      } catch (e) {
        return e
      }
    })() as ShardError
    expect(err).toBeInstanceOf(ShardError)
    expect(err.code).toBe('audio/unsupported-format')
    expect(err.path).toBe('assets/x.mp3')
  })
})

describe('audio importer', () => {
  it('imports the fixtures with duration, channels, and sample rate for asset.get', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-audio-'))
    roots.push(root)
    mkdirSync(join(root, 'assets/sfx'), { recursive: true })
    mkdirSync(join(root, 'assets/music'), { recursive: true })
    copyFileSync(join(fixtures, 'tone-44k-mono.wav'), join(root, 'assets/sfx/tone.wav'))
    copyFileSync(join(fixtures, 'tone-48k-stereo.ogg'), join(root, 'assets/music/theme.ogg'))
    copyFileSync(join(fixtures, 'tone-44k-stereo.mp3'), join(root, 'assets/sfx/tone.mp3'))
    writeFileSync(join(root, 'assets/sfx/broken.ogg'), 'OggS but not really')
    const world = new World()
    const assets = assetServer(world).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
      roots: ['assets'],
    })
    const report = await assets.scan()
    expect(report.failed.map((f) => [f.path, f.error.code])).toEqual([
      ['assets/sfx/broken.ogg', 'audio/unsupported-format'],
    ])
    expect(assets.info('assets/sfx/tone.wav').info).toMatchObject({
      codec: 'wav',
      duration: 0.5,
      channels: 1,
      sampleRate: 44100,
      mode: 'decoded',
      peak: 0.5,
    })
    // Under music/: streamed by default.
    expect(assets.info('assets/music/theme.ogg').info).toMatchObject({
      codec: 'vorbis',
      duration: 1.25,
      channels: 2,
      sampleRate: 48000,
      mode: 'stream',
    })
    expect(assets.info('assets/sfx/tone.mp3').info).toMatchObject({
      codec: 'mp3',
      channels: 2,
      sampleRate: 44100,
    })

    await assets.load('assets/music/theme.ogg')
    const clip = world.resource(AudioClips).get(assets.resolve('assets/music/theme.ogg'))!
    expect(clip).toMatchObject({ codec: 'vorbis', duration: 1.25, stream: true, normalize: false })
    // Kept compressed: the artifact is the file.
    expect(clip.bytes).toEqual(read('tone-48k-stereo.ogg'))
  })
})
