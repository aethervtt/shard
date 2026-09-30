import { defineResource } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { createProtocolServer, type ProtocolServer } from './server'

// Ownership and the protocol (0061): no write can name an owner, owners are described and released
// by name, and a host can limit a server to the methods it allows.

const Secret = defineResource<{ value: number }>('owners-test/Secret', {
  hostOnly: true,
  init: () => ({ value: 1 }),
})

let id = 1
async function call(server: ProtocolServer, method: string, params?: unknown) {
  return (await server.handle({ jsonrpc: '2.0', id: id++, method, params }))!
}
const code = (r: { error?: { data?: unknown } }) => (r.error?.data as { code?: string })?.code

async function app() {
  const a = new App().addPlugin(TransformPlugin)
  await a.init()
  return a
}

describe('ownership through the protocol (0061)', () => {
  it('refuses core/OwnedBy in entity.spawn and entity.patch, changing nothing', async () => {
    const a = await app()
    const server = createProtocolServer(a)
    const owner = a.world.owners.create('mod')
    const before = a.world.entityCount
    const owned = { 'core/OwnedBy': { owner: owner.id, inherited: false } }
    expect(code(await call(server, 'entity.spawn', { components: owned }))).toBe(
      'core/owner-not-authorable',
    )
    expect(a.world.entityCount).toBe(before)
    const e = a.world.spawn(Transform)
    const patch = await call(server, 'entity.patch', {
      entity: e,
      components: { 'core/Transform': { translation: [1, 2, 3] }, ...owned },
    })
    expect(code(patch)).toBe('core/owner-not-authorable')
    expect([...a.world.get(e, Transform).translation]).toEqual([0, 0, 0])
    const mine = a.world.owners.spawn(owner, Transform)
    const remove = await call(server, 'entity.patch', {
      entity: mine,
      components: { 'core/OwnedBy': null },
    })
    expect(code(remove)).toBe('core/owner-not-authorable')
    expect(a.world.owners.nameOf(mine)).toBe('mod')
    a.world.initResource(Secret)
    expect(
      code(await call(server, 'resource.set', { name: 'owners-test/Secret', value: { value: 2 } })),
    ).toBe('core/owner-not-authorable')
    expect(a.world.resource(Secret).value).toBe(1)
  })

  it('describes and releases owners by name', async () => {
    const a = await app()
    const server = createProtocolServer(a)
    const scene = a.world.owners.create('scene:abc')
    a.world.owners.create('mod:lanterns', { parent: scene })
    for (let i = 0; i < 3; i++) a.world.owners.spawn(scene, Transform)
    const all = (await call(server, 'owners.describe')).result as { owners: { name: string }[] }
    expect(all.owners.map((o) => o.name)).toEqual(['scene:abc', 'mod:lanterns'])
    const one = (await call(server, 'owners.describe', { name: 'scene:abc' })).result as {
      usage: { entities: number }
      children: string[]
    }
    expect(one.usage.entities).toBe(3)
    expect(one.children).toEqual(['mod:lanterns'])
    expect((await call(server, 'owners.release', { name: 'scene:abc' })).result).toEqual({
      released: 'scene:abc',
      entities: 3,
    })
    expect(a.world.entityCount).toBe(0)
    expect(code(await call(server, 'owners.release', { name: 'mod:lanterns' }))).toBe(
      'protocol/unknown-owner',
    )
  })

  it('rejects every method outside an allowlist with protocol/method-not-allowed', async () => {
    const a = await app()
    const server = createProtocolServer(a, { allow: ['entity.get', 'schema.list'] })
    expect(server.methods.map((m) => m.name).sort()).toEqual(['entity.get', 'schema.list'])
    expect((await call(server, 'schema.list')).error).toBeUndefined()
    for (const method of ['entity.spawn', 'owners.release', 'subscribe', 'no.such.method']) {
      expect(code(await call(server, method, {})), method).toBe('protocol/method-not-allowed')
    }
  })
})
