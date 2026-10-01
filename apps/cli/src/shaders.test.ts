import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGpuContext } from '@aethervtt/shard-gpu'
import {
  type BakedTranslations,
  NAGA_VERSION,
  SHIM_VERSION,
  translationKey,
} from '@aethervtt/shard-gpu-webgl2'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { listScenes, openProject } from '@aethervtt/shard-node'
import { Shaders } from '@aethervtt/shard-render'
import { describe, expect, it } from 'vitest'
import { bakeShaders } from './shaders'

// `shard shaders bake` (0064): the scenes' pipeline stages, translated for both clip modes, and a
// WebGL2 session that then never loads naga.

const here = dirname(fileURLToPath(import.meta.url))
const mazeChase = resolve(here, '../../../examples/maze-chase')

describe('shard shaders bake (0064)', () => {
  it('bakes every stage the scenes make, and a WebGL2 session with the bake never loads naga', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shard-bake-'))
    try {
      const out = relative(mazeChase, join(dir, 'webgl2.json'))
      const report = await bakeShaders(mazeChase, await listScenes(mazeChase), { out })
      expect(report.failed).toEqual([])
      expect(report.scenes).toEqual(['scenes/main.scene.json'])
      expect(report.stages).toBeGreaterThan(4)
      // Every stage, with and without EXT_clip_control.
      expect(report.translations).toBe(report.stages * 2)
      const set = JSON.parse(await readFile(join(mazeChase, out), 'utf8')) as BakedTranslations
      expect(set).toMatchObject({
        format: 'shard-webgl2-glsl',
        naga: NAGA_VERSION,
        shim: SHIM_VERSION,
      })
      expect(Object.keys(set.entries)).toHaveLength(report.translations)
      expect(Object.values(set.entries).every((t) => t.glsl.startsWith('#version 300 es'))).toBe(
        true,
      )
      expect(report.bytes).toBe(Buffer.byteLength(JSON.stringify(set)))

      // The same project on WebGL2, with the bake: every translation comes from it.
      const fake = new FakeGl()
      const gpu = await createGpuContext({
        backend: 'webgl2',
        webgl2: { context: fake.context, shaders: set, persist: false },
      })
      const p = await openProject({ root: mazeChase, gpu, generatorWorkers: false, code: 'source' })
      try {
        for (let i = 0; i < 30; i++) {
          p.app.update(1 / p.app.fixedHz)
          await p.app.world.resource(Shaders).whenIdle()
          await gpu.pipelines.whenIdle()
        }
        const cache = gpu.shaderCache()!
        expect(cache.misses).toEqual([])
        expect(cache.nagaLoadMs).toBeUndefined()
        expect(cache.hits.baked).toBeGreaterThan(4)
        expect(fake.draws.length).toBeGreaterThan(0)
        expect(gpu.errors).toEqual([])
      } finally {
        p.close()
        gpu.destroy()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('keys what it bakes as the runtime looks it up', () => {
    // The runtime looks translations up by these exact keys (see the translator's tests).
    const a = translationKey(
      '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }',
      'vs',
      'vertex',
      true,
    )
    expect(a).toMatch(/^[0-9a-f]{28}$/)
  })
})
