import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer } from '@shard/assets'
import { t } from '@shard/core'
import { createNodePlatform } from '@shard/platform-node'
import { App } from '@shard/runtime'
import { findEntityByPath, loadScene, ScenePlugin, whenSceneReady } from '@shard/scene'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineProject } from './define'
import { generateDocs, renderAssetCatalog } from './docs'
import type { ManifestValue } from './manifest'
import { createProjectReloader } from './reload'

const NS = 'data-proj'

/** A stand-in for the project bundle; `variant` picks the code version. */
function bundle(variant: { range?: boolean; maxDamage?: number } = {}) {
  return async () => {
    const project = defineProject({ name: NS })
    const Weapon = project.dataAsset(
      'Weapon',
      {
        damage: t.f32({ default: 10, min: 0, max: variant.maxDamage, unit: 'hp' }),
        fireRate: t.f32({ default: 4, unit: 'shots/s', description: 'Shots per second.' }),
        ...(variant.range ? { range: t.f32({ default: 250, unit: 'm' }) } : {}),
        upgradesTo: t.handle(`${NS}/Weapon`),
      },
      { extension: 'gun', description: 'A ship weapon.' },
    )
    const Armed = project.component('Armed', { weapon: t.handle(`${NS}/Weapon`) })
    return { default: project, Weapon, Armed }
  }
}

let root: string

function write(path: string, json: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), JSON.stringify(json))
}

async function touch(path: string, json: unknown) {
  await new Promise((r) => setTimeout(r, 5))
  write(path, json)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shard-data-proj-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('project data types', () => {
  it('load with the scene that references them, update in place, and re-import on script reload', async () => {
    write('data/guns/laser.gun.json', { damage: 12 })
    write('data/guns/heavy.gun.json', {
      $extends: { path: 'data/guns/laser.gun.json' },
      damage: 18,
    })
    const first = await bundle()()
    const app = new App().addPlugin(ScenePlugin).addPlugin(first.default)
    await app.init()
    const assets = assetServer(app.world).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    expect((await assets.scan()).failed).toEqual([])
    const w = app.world
    loadScene(w, {
      version: 1,
      entities: [
        {
          name: 'ship',
          components: { [`${NS}/Armed`]: { weapon: { path: 'data/guns/heavy.gun.json' } } },
        },
      ],
    })
    await whenSceneReady(w, 'main')

    // The weapon loaded with the scene; the store reads it by the component's handle.
    const store = w.resource(first.Weapon.store)
    const armed = w.get(findEntityByPath(w, 'ship')!, first.Armed)
    const heavy = store.get(armed.weapon)!
    expect(heavy).toMatchObject({ damage: 18, fireRate: 4 })

    // Editing the base while running: the variant's value changes within two frames, same object.
    await touch('data/guns/laser.gun.json', { damage: 12, fireRate: 7 })
    await assets.scan()
    app.update(1 / 60)
    app.update(1 / 60)
    expect(store.get(armed.weapon)).toBe(heavy)
    expect(heavy.fireRate).toBe(7)

    // Adding a field in a script and reloading re-imports every file; the new field has its default.
    const reloader = createProjectReloader(app, { namespace: NS, current: first.default })
    const report = await reloader.reload(bundle({ range: true }))
    expect(report.error).toBeUndefined()
    expect(report.assets.imported).toEqual(['data/guns/heavy.gun.json', 'data/guns/laser.gun.json'])
    expect(store.get(armed.weapon)).toBe(heavy)
    expect((heavy as Record<string, unknown>).range).toBe(250)

    // A schema change that a file no longer satisfies fails that file; it keeps its last value.
    const strict = await reloader.reload(bundle({ range: true, maxDamage: 15 }))
    expect(strict.ok).toBe(true)
    expect(strict.assets.failed).toEqual(['data/guns/heavy.gun.json'])
    expect(heavy.damage).toBe(18)
  })

  it('shard docs lists the type in .agents/assets.md and writes its schema', async () => {
    await bundle()()
    const manifest = {
      name: NS,
      assetRoots: ['assets', 'data'],
      plugins: [],
      startScene: 'scenes/main.scene.json',
      seed: 1,
    } as unknown as ManifestValue
    const files = generateDocs(manifest, [])
    const catalog = files['.agents/assets.md']!
    expect(catalog).toContain('# Project data types')
    expect(catalog).toContain(`## \`${NS}/Weapon\``)
    expect(catalog).toContain('Files: `*.gun.json`')
    expect(catalog).toContain('| `fireRate` | number | `4` | shots/s | Shots per second. |')
    expect(catalog).toContain(`| \`upgradesTo\` | null or ${NS}/Weapon ref |`)
    // The project's importer is described with its type, not in the engine importer list.
    expect(renderAssetCatalog().includes('## `data/gun`')).toBe(true)
    expect(catalog.includes('## `data/gun`')).toBe(false)
    const schema = JSON.parse(files['.shard/schemas/gun.schema.json']!)
    expect(schema.title).toBe(`${NS}/Weapon`)
    expect(Object.keys(schema.properties)).toContain('$extends')
    expect(files['.agents/skills/make-a-data-asset.md']).toContain(`t.handle('${NS}/Weapon')`)
  })
})
