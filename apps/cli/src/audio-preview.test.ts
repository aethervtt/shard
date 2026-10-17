import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { AudioPreviewPlan } from '@aethervtt/shard-audio'
import { timeout } from '@aethervtt/shard-core/test-env'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import { renderProjectAudio } from './audio-command'

const available =
  existsSync(chromium.executablePath()) || process.env.SHARD_BROWSER_TESTS === 'required'
async function fixture() {
  const dir = await mkdtemp(resolve(import.meta.dirname, '../.audio-fixture-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await cp(resolve(import.meta.dirname, '../../../examples/audio-lab'), dir, {
    recursive: true,
    filter: (path) => !['node_modules', '.shard', 'captures'].includes(basename(path)),
  })
  return dir
}

describe.skipIf(!available)('CLI offline audio evidence', () => {
  it(
    'imports dependencies, renders a measured WAV and writes structured evidence',
    async () => {
      const dir = await fixture()
      await writeFile(
        join(dir, 'data/audio/probe.audio-mixer.json'),
        JSON.stringify({
          buses: [
            { id: 'master', parent: '' },
            { id: 'sfx', gainDb: -6.020599913279624 },
          ],
        }),
      )
      const plan = AudioPreviewPlan.deserialize({
        duration: 0.5,
        channels: 1,
        sampleRate: 12000,
        mixer: { path: 'data/audio/probe.audio-mixer.json' },
        clips: [{ id: 'tone', asset: { path: 'assets/sfx/engine-low.wav' } }],
        voices: [{ id: 'tone', clip: 'tone', gainDb: -6.020599913279624 }],
      })
      const result = await renderProjectAudio(dir, plan, 'captures/probe.wav')
      const wav = await readFile(result.out)
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.readUInt32LE(40)).toBe(6000 * 2)
      expect(result.measured).toMatchObject({
        frames: 6000,
        sampleRate: 12000,
        clipped: 0,
        nonfinite: 0,
      })
      expect((result.measured as { peak: number }).peak).toBeCloseTo(0.03, 3)
      const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'))
      expect(evidence.backend.kind).toBe('web-audio-offline')
      expect(evidence.inputs.assets).toBe(2)
    },
    timeout(60000),
  )

  it(
    'renders the authored showcase with deterministic choices, movement, snapshots and music',
    async () => {
      const dir = await fixture()
      const plan = AudioPreviewPlan.deserialize(
        JSON.parse(await readFile(join(dir, 'plans/showcase.json'), 'utf8')),
      )
      const result = await renderProjectAudio(dir, plan, 'captures/showcase.wav')
      const trace = result.trace as {
        events: { entries: { kind: string; choice: number }[] }
        music: { entries: { kind: string }[] }
        controls: unknown[]
      }
      expect(result.measured).toMatchObject({ frames: 528000, clipped: 0, nonfinite: 0 })
      expect((result.measured as { rms: number }).rms).toBeGreaterThan(0.01)
      expect(
        trace.events.entries.filter((e) => e.kind === 'layer-start').length,
      ).toBeGreaterThanOrEqual(6)
      expect(trace.music.entries.some((e) => e.kind === 'music-transition')).toBe(true)
      expect(trace.music.entries.some((e) => e.kind === 'music-stinger-layer')).toBe(true)
      expect(trace.controls).toHaveLength(plan.controls.length)
      if (process.env.SHARD_AUDIO_EVIDENCE) {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(process.env.SHARD_AUDIO_EVIDENCE, { recursive: true })
        await cp(result.out, join(process.env.SHARD_AUDIO_EVIDENCE, 'showcase.wav'))
        await cp(result.evidencePath, join(process.env.SHARD_AUDIO_EVIDENCE, 'showcase.wav.json'))
      }
    },
    timeout(60000),
  )
})
