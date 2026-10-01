import { describe, expect, it } from 'vitest'
import { defineComponent } from '../schema/component'
import { t } from '../schema/field'
import { ChildOf } from './hierarchy'
import { OwnedBy, Owner, OwnerReleased } from './owners'
import { World } from './world'

const Health = defineComponent('owners-test/Health', { value: t.f32({ default: 10 }) })

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

describe('owners (0061)', () => {
  it('spawns owned entities, counts them, and releases them with their descendants', () => {
    const world = new World()
    const scene = world.owners.create('scene:abc')
    const root = world.owners.spawn(scene, Health)
    const child = world.spawn(Health, [ChildOf, { parent: root }])
    const grandchild = world.spawn([ChildOf, { parent: child }])
    const app = world.spawn(Health)
    expect(world.owners.nameOf(root)).toBe('scene:abc')
    expect(world.owners.nameOf(grandchild)).toBe('scene:abc')
    expect(world.get(child, OwnedBy).inherited).toBe(true)
    expect(world.owners.nameOf(app)).toBeUndefined()
    expect(world.owners.describe(scene).usage.entities).toBe(3)

    const released = world.reader(OwnerReleased)
    world.owners.release(scene)
    expect(world.isAlive(root)).toBe(false)
    expect(world.isAlive(child)).toBe(false)
    expect(world.isAlive(grandchild)).toBe(false)
    expect(world.isAlive(app)).toBe(true)
    expect([...released.read()]).toEqual([{ name: 'scene:abc', entities: 3 }])
    expect(codeOf(() => world.owners.spawn(scene, Health))).toBe('core/owner-released')
    expect(world.owners.describe(scene).released).toBe(true)
  })

  it('releases child owners with their parent, and keeps entities another owner holds', () => {
    const world = new World()
    const scene = world.owners.create('scene')
    const mod = world.owners.create('mod:lanterns', { parent: scene })
    const other = world.owners.create('other')
    const a = world.owners.spawn(scene, Health)
    const b = world.owners.spawn(mod, Health)
    const c = world.owners.spawn(other, Health)
    expect(world.owners.describe(scene).usage.entities).toBe(2)
    expect(world.owners.describe(scene).children).toEqual(['mod:lanterns'])
    world.owners.release(scene)
    expect(world.isAlive(a)).toBe(false)
    expect(world.isAlive(b)).toBe(false)
    expect(world.isAlive(c)).toBe(true)
    expect(world.owners.isReleased(mod)).toBe(true)
  })

  it('refuses OwnedBy from anyone without a grant', () => {
    const world = new World()
    const owner = world.owners.create('host')
    const owned = world.owners.spawn(owner, Health)
    const plain = world.spawn(Health)
    const value = { owner: owner.id, inherited: false }
    expect(codeOf(() => world.spawn([OwnedBy, value]))).toBe('core/owner-not-authorable')
    expect(codeOf(() => world.add(plain, OwnedBy, value))).toBe('core/owner-not-authorable')
    expect(codeOf(() => world.set(owned, OwnedBy, value))).toBe('core/owner-not-authorable')
    expect(codeOf(() => world.remove(owned, OwnedBy))).toBe('core/owner-not-authorable')
    expect(world.has(plain, OwnedBy)).toBe(false)
    expect(world.entityCount).toBe(2)
    expect(OwnedBy.serializable).toBe(false)
  })

  it('accepts only owners it issued', () => {
    const world = new World()
    const other = new World().owners.create('elsewhere')
    expect(codeOf(() => world.owners.spawn(other, Health))).toBe('core/owner-invalid')
    const forged = Object.create(Owner.prototype) as Owner
    expect(codeOf(() => world.owners.spawn(forged, Health))).toBe('core/owner-invalid')
    expect(
      codeOf(() => new (Owner as never as new (...a: unknown[]) => Owner)(Symbol('owner'), 1, 'x')),
    ).toBe('core/owner-invalid')
  })

  it('fails a spawn past the entities limit and leaves counts unchanged; parents count children', () => {
    const world = new World()
    const scene = world.owners.create('scene', { limits: { entities: 3 } })
    const mod = world.owners.create('mod', { parent: scene, limits: { entities: 10 } })
    world.owners.spawn(scene, Health)
    world.owners.spawn(mod, Health)
    world.owners.spawn(mod, Health)
    const before = world.entityCount
    expect(codeOf(() => world.owners.spawn(mod, Health))).toBe('core/owner-quota')
    expect(world.entityCount).toBe(before)
    expect(world.owners.describe(mod).usage.entities).toBe(2)
    expect(world.owners.describe(scene).usage.entities).toBe(3)
    // Charges for other quotas work the same way, through the ancestors.
    const capped = world.owners.create('capped', { limits: { triangles: 1000 } })
    const inner = world.owners.create('inner', { parent: capped })
    world.owners.charge(inner, 'triangles', 800)
    expect(codeOf(() => world.owners.charge(inner, 'triangles', 300))).toBe('core/owner-quota')
    expect(world.owners.describe(capped).usage.triangles).toBe(800)
    world.owners.refund(inner, 'triangles', 800)
    expect(world.owners.describe(capped).usage.triangles).toBe(0)
  })

  it('adopts an existing entity and its unowned descendants', () => {
    const world = new World()
    const owner = world.owners.create('host')
    const root = world.spawn(Health)
    const child = world.spawn([ChildOf, { parent: root }])
    world.owners.adopt(owner, root)
    expect(world.owners.nameOf(root)).toBe('host')
    expect(world.owners.nameOf(child)).toBe('host')
    expect(world.owners.describe(owner).usage.entities).toBe(2)
    world.despawn(root)
    expect(world.owners.describe(owner).usage.entities).toBe(0)
  })

  it('runs release hooks and describers', () => {
    const world = new World()
    const owner = world.owners.create('host')
    const seen: string[] = []
    world.owners.onRelease((o) => seen.push(o.name))
    world.owners.addDescriber('leases', () => 3)
    expect(world.owners.describe(owner).leases).toBe(3)
    world.owners.release(owner)
    expect(seen).toEqual(['host'])
  })
})
