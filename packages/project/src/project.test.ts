import { defineComponent, t } from '@shard/core'
import { createNodeGpuContext } from '@shard/gpu/node'
import type { Platform } from '@shard/platform'
import { OffscreenTarget } from '@shard/render'
import { findEntityByPath } from '@shard/scene'
import { describe, expect, it } from 'vitest'
import { defineProject } from './define'
import {
  GENERATED_END,
  GENERATED_START,
  generateDocs,
  mergeAgentsMd,
  renderComponentCatalog,
} from './docs'
import { buildApp, startProject } from './host'
import { loadProject, Manifest, manifestJsonSchema, validateManifest } from './manifest'
import { projectTemplate } from './templates'

/** A read-only platform over an in-memory file map. */
function memoryPlatform(files: Record<string, string>): Platform {
  return {
    name: 'memory',
    fs: {
      writable: false,
      readText: async (path) => {
        if (!(path in files)) throw new Error(`missing ${path}`)
        return files[path]!
      },
      readBytes: async () => new Uint8Array(),
      writeText: async () => {},
      writeBytes: async () => {},
      exists: async (path) => path in files,
    },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    clock: { now: () => 0 },
    log: { log: () => {} },
  }
}

describe('manifest', () => {
  it('validates, reporting every error with a path and hint', () => {
    const errors = validateManifest({
      name: 'Star Explorer',
      seed: -1,
      window: { msaa: 2 },
      plugins: ['render/forward', 'physics'],
      extra: true,
    }).map((e) => [e.code, e.path])
    expect(errors).toEqual(
      expect.arrayContaining([
        ['project/invalid-name', '/name'],
        ['schema/out-of-range', '/seed'],
        ['schema/out-of-range', '/window/msaa'],
        ['project/unknown-plugin', '/plugins/1'],
        ['schema/unknown-field', '/extra'],
      ]),
    )
    expect(validateManifest({}).map((e) => e.code)).toContain('schema/missing-field')
  })

  it('fills defaults and has a JSON Schema', () => {
    const m = Manifest.deserialize({ name: 'demo' })
    expect(m).toMatchObject({
      startScene: 'scenes/main.scene.json',
      seed: 1,
      plugins: ['render/forward', 'input'],
    })
    expect(manifestJsonSchema()).toMatchObject({ title: 'shard.json', required: ['name'] })
  })

  it('loadProject explains a missing or broken shard.json', async () => {
    await expect(loadProject(memoryPlatform({}))).rejects.toMatchObject({
      code: 'project/not-found',
    })
    await expect(loadProject(memoryPlatform({ 'shard.json': '{ nope' }))).rejects.toMatchObject({
      code: 'project/invalid-json',
    })
    await expect(
      loadProject(memoryPlatform({ 'shard.json': '{"name":"X Y"}' })),
    ).rejects.toMatchObject({
      code: 'project/invalid-manifest',
      details: [expect.objectContaining({ path: '/name' })],
    })
  })
})

describe('hosting', () => {
  it('builds an app from a template project and loads its start scene', async () => {
    const files = projectTemplate({ name: 'demo', template: 'empty', engineSpec: 'workspace:*' })
    const platform = memoryPlatform(files)
    const { manifest } = await loadProject(platform)
    const gpu = await createNodeGpuContext()
    const target = new OffscreenTarget(gpu, { label: 'project-test', width: 32, height: 32 })
    const app = buildApp({ manifest, gpu, target })
    const scene = await startProject(app, platform, manifest)
    expect(scene.entities.has('cube')).toBe(true)
    expect(findEntityByPath(app.world, 'camera')).toBeDefined()
    expect(app.describe().plugins.map((p) => p.name)).toEqual(
      expect.arrayContaining(['core/transform', 'render', 'render/forward', 'input']),
    )
    app.update(1 / 60)
    gpu.destroy()
  })
})

describe('defineProject', () => {
  it('namespaces project types and rejects foreign namespaces', () => {
    const project = defineProject({ name: 'demo-game' })
    expect(project.component('Fuel', { liters: t.f32 }).name).toBe('demo-game/Fuel')
    expect(project.component('demo-game/Shield', { hp: t.f32 }).name).toBe('demo-game/Shield')
    expect(() => project.component('core/Fuel', { liters: t.f32 })).toThrow(
      expect.objectContaining({ code: 'project/namespace' }),
    )
    expect(project.name).toBe('project:demo-game')
  })
})

describe('agent docs', () => {
  const manifest = Manifest.deserialize({ name: 'demo' })

  it('keeps notes outside the generated block', () => {
    const first = mergeAgentsMd(undefined, manifest)
    expect(first).toContain(GENERATED_START)
    const edited = first.replace(
      'Project-specific notes for agents go here',
      'Always fly carefully',
    )
    const regenerated = mergeAgentsMd(edited, { ...manifest, seed: 42 })
    expect(regenerated).toContain('Always fly carefully')
    expect(regenerated).toContain('seed 42')
    expect(regenerated.indexOf(GENERATED_END)).toBeGreaterThan(0)
  })

  it('catalogs every component with fields and descriptions, including new ones', () => {
    const catalog = renderComponentCatalog()
    expect(catalog).toContain('## `render/Camera3d`')
    expect(catalog).toMatch(
      /\| `fovY` \| number \| `60` \| ≥ 1, ≤ 179, deg \| Vertical field of view\. \|/,
    )
    expect(catalog).toContain('Presets: direct-sun, daylight')
    expect(catalog).toContain('`rotationEuler`')
    expect(catalog).toMatch(
      /## `core\/GlobalTransform`[\s\S]*?_Computed by the engine; never written in scene files\._/,
    )
    defineComponent('demo/Fuel', { liters: t.f32({ description: 'Fuel left.' }) })
    expect(renderComponentCatalog()).toContain('## `demo/Fuel`')
  })

  it('generates schemas and skills', () => {
    const files = generateDocs(manifest, [
      { code: 'scene/invalid', source: 'scene', hint: 'Fix it' },
    ])
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '.agents/components.md',
        '.agents/errors.md',
        '.agents/skills/build-a-scene.md',
        '.shard/schemas/scene.schema.json',
        '.shard/schemas/shard.schema.json',
        '.shard/schemas/components/render.Camera3d.json',
      ]),
    )
    expect(files['.agents/errors.md']).toContain('`scene/invalid`')
    expect(files['.agents/skills/write-a-gameplay-test.md']).toContain('demo/Controls.thrust')
  })
})
