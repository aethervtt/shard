import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineComponent, type ShardError, t, World } from '@aethervtt/shard-core'
import type { Platform } from '@aethervtt/shard-platform'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AssetServer,
  AssetServerResource,
  allAssetSchemas,
  defineDataAsset,
  defineDataType,
  defineImporter,
  findDataType,
  loadAll,
  validateDataAssets,
} from './index'

const Weapon = defineDataType(
  'test-data/Weapon',
  {
    damage: t.f32({ default: 10, min: 0, unit: 'hp' }),
    fireRate: t.f32({ default: 4 }),
    recoil: t.struct({ kick: t.f32({ default: 1 }), recover: t.f32({ default: 0.2 }) }),
    tags: t.list(t.string),
    upgradesTo: t.handle('test-data/Weapon'),
    shield: t.handle('test-data/Shield'),
  },
  { extension: 'weapon', description: 'A ship weapon.' },
)

const Shield = defineDataType(
  'test-data/Shield',
  { strength: t.f32({ default: 50 }) },
  {
    extension: 'shield',
  },
)

const Armed = defineComponent('test-data/Armed', { weapon: t.handle('test-data/Weapon') })

let root: string
let platform: Platform

function write(path: string, content: unknown) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

/** Rewrites a file so its size or mtime changes for stat-based change detection. */
async function touch(path: string, content: unknown) {
  await new Promise((r) => setTimeout(r, 5))
  write(path, content)
}

function server(): AssetServer {
  const world = new World()
  const s = new AssetServer(world).configure({ platform })
  world.insertResource(AssetServerResource, s)
  return s
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shard-data-'))
  platform = createNodePlatform({ root, logTo: () => {} })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('data types', () => {
  it('imports files, fills defaults, and rejects a bad field with a pointer into the file', async () => {
    write('data/weapons/laser.weapon.json', { $schema: 'x', damage: 12 })
    write('data/weapons/broken.weapon.json', { damage: -3 })
    write('data/weapons/typo.weapon.json', { recoil: { kik: 2 } })
    const s = server()
    const report = await s.scan()
    expect(report.imported).toEqual(['data/weapons/laser.weapon.json'])
    expect(report.failed.map((f) => [f.path, f.error.code, f.error.path])).toEqual([
      ['data/weapons/broken.weapon.json', 'assets/import-failed', '/damage'],
      ['data/weapons/typo.weapon.json', 'assets/import-failed', '/recoil/kik'],
    ])

    await s.load('data/weapons/laser.weapon.json')
    const laser = s.world.resource(Weapon.store).get(s.resolve('data/weapons/laser.weapon.json'))
    expect(laser).toEqual({
      damage: 12,
      fireRate: 4,
      recoil: { kick: 1, recover: 0.2 },
      tags: [],
      upgradesTo: null,
      shield: null,
    })
    expect(s.entry('data/weapons/laser.weapon.json')?.type).toBe('test-data/Weapon')
  })

  it('returns the schema, asset type, store, and importer, and publishes a file schema', () => {
    expect(Weapon.name).toBe('test-data/Weapon')
    expect(Weapon.type.name).toBe('test-data/Weapon')
    expect(Weapon.importer.extensions).toEqual(['.weapon.json'])
    expect(Weapon.store.name).toBe('test-data/WeaponAssets')
    expect(findDataType('test-data/Weapon')).toBe(Weapon)
    expect(Weapon.defaults().damage).toBe(10)
    const schema = allAssetSchemas().find(([f]) => f === 'weapon.schema.json')![1]() as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(schema.properties)).toEqual([
      '$schema',
      '$extends',
      'damage',
      'fireRate',
      'recoil',
      'tags',
      'upgradesTo',
      'shield',
    ])
  })

  it('rejects an extension another importer already has', () => {
    const attempt = (fn: () => unknown) => {
      try {
        fn()
      } catch (err) {
        return (err as ShardError).code
      }
      return 'no error'
    }
    expect(attempt(() => defineDataAsset('test-data/Other', Shield, { extension: 'weapon' }))).toBe(
      'assets/duplicate-extension',
    )
    expect(
      attempt(() =>
        defineImporter({
          ...Weapon.importer,
          name: 'test-data/copycat',
          extensions: ['.shield.json'],
        }),
      ),
    ).toBe('assets/duplicate-extension')
  })

  it('updates the stored object in place when its file changes', async () => {
    write('data/weapons/laser.weapon.json', { damage: 12 })
    const s = server()
    await s.scan()
    const ref = s.resolve('data/weapons/laser.weapon.json')!
    await s.load(ref)
    const store = s.world.resource(Weapon.store)
    const before = store.get(ref)!
    const version = s.entry(ref)!.version
    await touch('data/weapons/laser.weapon.json', { damage: 30, tags: ['hot'] })
    await s.scan()
    expect(store.get(ref)).toBe(before)
    expect(before.damage).toBe(30)
    expect(before.tags).toEqual(['hot'])
    expect(s.entry(ref)!.version).toBe(version + 1)

    // A broken edit keeps the last good value.
    await touch('data/weapons/laser.weapon.json', { damage: 'lots' })
    const failed = await s.scan()
    expect(failed.failed[0]?.error.path).toBe('/damage')
    expect(store.get(ref)!.damage).toBe(30)
  })

  it('loadAll resolves to every file of a type', async () => {
    write('data/weapons/a.weapon.json', { damage: 1 })
    write('data/weapons/b.weapon.json', { damage: 2 })
    write('data/weapons/elite/c.weapon.json', { damage: 3 })
    write('data/shields/s.shield.json', {})
    const s = server()
    await s.scan()
    const all = await loadAll(s.world, Weapon)
    expect(all.map((w) => w.damage)).toEqual([1, 2, 3])
    const byName = await loadAll(s.world, 'test-data/Weapon', { prefix: 'data/weapons/elite/' })
    expect(byName).toEqual([all[2]])
    expect(s.all(Shield).map((e) => e.path)).toEqual(['data/shields/s.shield.json'])
  })
})

describe('$extends', () => {
  it('merges a variant over its base: structs field by field, lists and handles replace', async () => {
    write('data/weapons/laser.weapon.json', {
      damage: 12,
      recoil: { kick: 2, recover: 0.5 },
      tags: ['energy', 'basic'],
    })
    write('data/weapons/heavy.weapon.json', {
      $extends: { path: 'data/weapons/laser.weapon.json' },
      damage: 18,
      recoil: { kick: 4 },
      tags: ['energy'],
      upgradesTo: { path: 'data/weapons/laser.weapon.json' },
    })
    // A variant of a variant, with a path relative to its own folder.
    write('data/weapons/elite/heavy-mk2.weapon.json', {
      $extends: { path: '../heavy.weapon.json' },
      fireRate: 6,
    })
    const s = server()
    const report = await s.scan()
    expect(report.failed).toEqual([])
    await s.load('data/weapons/elite/heavy-mk2.weapon.json')
    const store = s.world.resource(Weapon.store)
    const mk2 = store.get(s.resolve('data/weapons/elite/heavy-mk2.weapon.json'))!
    expect(mk2).toMatchObject({
      damage: 18,
      fireRate: 6,
      recoil: { kick: 4, recover: 0.5 },
      tags: ['energy'],
    })
    // Handles resolve to guids on load, so stores can look them up.
    expect(mk2.upgradesTo?.guid).toBe(s.resolve('data/weapons/laser.weapon.json')?.guid)
    // Handles are load dependencies: the laser loaded along with it.
    expect(s.state('data/weapons/laser.weapon.json')).toBe('loaded')

    const info = s.info('data/weapons/elite/heavy-mk2.weapon.json').info!
    expect(info.extends).toEqual([
      'data/weapons/heavy.weapon.json',
      'data/weapons/laser.weapon.json',
    ])
    expect(info.setBy).toEqual({
      '/damage': 'data/weapons/heavy.weapon.json',
      '/fireRate': 'data/weapons/elite/heavy-mk2.weapon.json',
      '/recoil': 'data/weapons/laser.weapon.json',
      '/recoil/kick': 'data/weapons/heavy.weapon.json',
      '/tags': 'data/weapons/heavy.weapon.json',
      '/upgradesTo': 'data/weapons/heavy.weapon.json',
    })
  })

  it('editing the base re-imports its variants and updates them while loaded', async () => {
    write('data/weapons/laser.weapon.json', { damage: 12, fireRate: 3 })
    write('data/weapons/heavy.weapon.json', {
      $extends: { path: 'data/weapons/laser.weapon.json' },
      damage: 18,
    })
    const s = server()
    await s.scan()
    await s.load('data/weapons/heavy.weapon.json')
    const heavy = s.world.resource(Weapon.store).get(s.resolve('data/weapons/heavy.weapon.json'))!
    expect(heavy.fireRate).toBe(3)
    await touch('data/weapons/laser.weapon.json', { damage: 12, fireRate: 9 })
    const report = await s.scan()
    expect(report.imported).toEqual([
      'data/weapons/heavy.weapon.json',
      'data/weapons/laser.weapon.json',
    ])
    expect(heavy.fireRate).toBe(9)
    expect(heavy.damage).toBe(18)
  })

  it('fails on cycles, bases of another type, and missing bases; blames the file that set a bad field', async () => {
    write('data/weapons/a.weapon.json', { $extends: { path: 'data/weapons/b.weapon.json' } })
    write('data/weapons/b.weapon.json', { $extends: { path: 'data/weapons/a.weapon.json' } })
    write('data/weapons/self.weapon.json', { $extends: { path: 'self.weapon.json' } })
    write('data/shields/s.shield.json', {})
    write('data/weapons/odd.weapon.json', { $extends: { path: 'data/shields/s.shield.json' } })
    write('data/weapons/orphan.weapon.json', {
      $extends: { path: 'data/weapons/nope.weapon.json' },
    })
    write('data/weapons/bad-base.weapon.json', { fireRate: 'fast' })
    write('data/weapons/child.weapon.json', {
      $extends: { path: 'data/weapons/bad-base.weapon.json' },
    })
    write('data/weapons/shape.weapon.json', { $extends: 'data/weapons/a.weapon.json' })
    const s = server()
    const report = await s.scan()
    const failures = Object.fromEntries(report.failed.map((f) => [f.path, f.error]))
    expect(failures['data/weapons/a.weapon.json']).toMatchObject({
      code: 'data/extends-cycle',
      path: '/$extends',
    })
    expect(failures['data/weapons/a.weapon.json']!.message).toContain(
      'data/weapons/a.weapon.json → data/weapons/b.weapon.json → data/weapons/a.weapon.json',
    )
    expect(failures['data/weapons/b.weapon.json']?.code).toBe('data/extends-cycle')
    expect(failures['data/weapons/self.weapon.json']?.code).toBe('data/extends-cycle')
    expect(failures['data/weapons/odd.weapon.json']?.code).toBe('data/extends-type-mismatch')
    expect(failures['data/weapons/orphan.weapon.json']?.code).toBe('assets/not-found')
    expect(failures['data/weapons/child.weapon.json']).toMatchObject({ path: '/fireRate' })
    expect(failures['data/weapons/child.weapon.json']!.message).toContain(
      'data/weapons/bad-base.weapon.json (a base of data/weapons/child.weapon.json)',
    )
    expect(failures['data/weapons/shape.weapon.json']?.code).toBe('schema/type-mismatch')
  })
})

describe('handles', () => {
  it('files whose handles point at each other both load', async () => {
    write('data/weapons/a.weapon.json', { upgradesTo: { path: 'data/weapons/b.weapon.json' } })
    write('data/weapons/b.weapon.json', { upgradesTo: { path: 'data/weapons/a.weapon.json' } })
    const s = server()
    await s.scan()
    await s.load('data/weapons/a.weapon.json')
    await s.load('data/weapons/b.weapon.json')
    const store = s.world.resource(Weapon.store)
    const a = store.get(s.resolve('data/weapons/a.weapon.json'))!
    expect(store.get(a.upgradesTo)?.upgradesTo?.path).toBe('data/weapons/a.weapon.json')
  })

  it('a handle to an asset of another type fails validation with schema/asset-type-mismatch', async () => {
    write('data/shields/s.shield.json', {})
    write('data/weapons/laser.weapon.json', {
      upgradesTo: { path: 'data/shields/s.shield.json' },
      shield: { path: 'data/shields/s.shield.json' },
    })
    const s = server()
    await s.scan()
    const problems = await validateDataAssets(s.world)
    expect(problems.map((p) => [p.source, p.errors.map((e) => [e.code, e.path])])).toEqual([
      ['data/weapons/laser.weapon.json', [['schema/asset-type-mismatch', '/upgradesTo']]],
    ])

    // The same check guards components that reference data assets.
    const resolveAsset = (ref: { guid?: string; path?: string }) => {
      const e = s.entry(ref)
      return e && { guid: e.guid, path: e.path, type: e.type }
    }
    expect(
      Armed.validate({ weapon: { path: 'data/shields/s.shield.json' } }, { resolveAsset }).map(
        (e) => e.code,
      ),
    ).toEqual(['schema/asset-type-mismatch'])
    expect(
      Armed.validate({ weapon: { path: 'data/weapons/laser.weapon.json' } }, { resolveAsset }),
    ).toEqual([])
  })
})

describe('the data type registry (0052)', () => {
  it('treats the same definition twice as one type, and a different one as a conflict', () => {
    const define = (max: number) =>
      defineDataType('test/SharedLoot', { weight: t.f32({ max }) }, { extension: 'shared-loot' })
    const first = define(10)
    expect(define(10)).toBe(first)
    expect(() => define(20)).toThrow(expect.objectContaining({ code: 'assets/registry-conflict' }))
  })
})
