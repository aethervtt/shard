import type { AssetRef } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { AudioClips, audioClip } from './clip'
import { AudioListener, AudioSource } from './components'
import { HeadlessAudioBackend } from './headless'
import { updateAudio } from './mixer'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)
const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!

/** Times `audio/update` alone over moving sources, counting GC events. */
async function measure(sources: number) {
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend: new HeadlessAudioBackend() }),
  )
  await app.init()
  const w = app.world
  const clips = w.resource(AudioClips)
  const refs: AssetRef<'AudioClip'>[] = []
  for (let i = 0; i < 16; i++)
    refs.push(clips.add(audioClip(sineWav(2, { rate: 8000 }), { id: `c${i}` })))
  w.spawn(AudioListener, [Transform, {}])
  for (let i = 0; i < sources; i++) {
    const a = (i / sources) * Math.PI * 2
    w.spawn(
      [
        AudioSource,
        { clip: refs[i % refs.length]!, loop: true, priority: i % 256, doppler: i % 2 },
      ],
      [Transform, { translation: [Math.cos(a) * 20, 0, Math.sin(a) * 20] }],
    )
  }
  for (let i = 0; i < 60; i++) app.update(1 / 60)
  const state = updateAudio.setup!(w)
  let tick = 0
  const ctx = {
    get lastRunTick() {
      return tick
    },
  } as never
  const step = (f: number) => {
    // Move every source a little, the way propagation would.
    for (const table of state.sources.tables) {
      const m = table.column(GlobalTransform, 'matrix')
      for (let i = 0; i < table.count; i++) m[i * 12 + 3] = m[i * 12 + 3]! + Math.sin(f + i) * 0.01
    }
    tick = w.incrementTick()
    updateAudio.run(state, w, ctx)
  }
  for (let f = 0; f < 300; f++) step(f)
  ;(globalThis as { gc?: () => void }).gc?.()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const times = new Float64Array(300)
  let collections = 0
  const observer = new PerformanceObserver((list) => {
    collections += list.getEntries().length
  })
  observer.observe({ entryTypes: ['gc'] })
  for (let f = 0; f < times.length; f++) {
    const t0 = performance.now()
    step(f)
    times[f] = performance.now() - t0
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  observer.disconnect()
  return { list: [...times], collections }
}

describe('performance', () => {
  it('48 moving spatial sources: under 0.1 ms a frame, allocating nothing', async () => {
    const { list, collections } = await measure(48)
    console.log(
      `audio/update, 48 sources: ${median(list).toFixed(4)} ms median; GC events: ${collections}`,
    )
    expect(collections).toBe(0)
    expect(median(list)).toBeLessThan(budget(0.1))
  })

  it('512 sources over the 64-voice limit: under 0.5 ms a frame', async () => {
    const { list, collections } = await measure(512)
    console.log(
      `audio/update, 512 sources (64 real): ${median(list).toFixed(4)} ms median; GC events: ${collections}`,
    )
    expect(median(list)).toBeLessThan(budget(0.5))
  })
})
