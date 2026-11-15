import type { AssetRef } from '@aethervtt/shard-core'
import { ParticleEmitterOverrides, ParticleSystem } from '@aethervtt/shard-particles'
import { Trail } from '@aethervtt/shard-render'
import { describe, expect, it } from 'vitest'
import { VehicleEffects, vehicleEffectsPlugin } from './effects'
import { drive, frames, ground, spawnCar, vehicleApp } from './testing'

const dust = {
  type: 'ParticleEffect',
  guid: 'test:dust',
  path: 'test/dust.particles.json',
} as AssetRef<'ParticleEffect'>
const smoke = {
  type: 'ParticleEffect',
  guid: 'test:smoke',
  path: 'test/smoke.particles.json',
} as AssetRef<'ParticleEffect'>

function emitters(world: import('@aethervtt/shard-core').World, ref: AssetRef) {
  const out: { scale: number }[] = []
  for (const table of world.query({ with: [ParticleSystem, ParticleEmitterOverrides] }).tables) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]!
      if (world.get(e, ParticleSystem).effect?.guid !== ref.guid) continue
      out.push({ scale: world.get(e, ParticleEmitterOverrides).spawnScale })
    }
  }
  return out
}

function trails(world: import('@aethervtt/shard-core').World) {
  const out: boolean[] = []
  for (const table of world.query({ with: [Trail] }).tables)
    for (let row = 0; row < table.count; row++)
      out.push(world.get(table.entities[row]!, Trail).playing)
  return out
}

describe('vehicle effects', () => {
  it('throws up dust and leaves tracks on gravel', async () => {
    const app = await vehicleApp([vehicleEffectsPlugin()])
    const world = app.world
    ground(world, { surface: 'gravel' })
    const car = spawnCar(world)
    world.add(car.chassis, VehicleEffects, {
      surfaces: [{ surface: 'gravel', particles: dust, tracks: true }],
      smoke,
    })
    frames(app, 30)
    drive(world, car.chassis, { throttle: 0.6 })
    frames(app, 120)
    const d = emitters(world, dust)
    expect(d).toHaveLength(4)
    expect(d.every((e) => e.scale > 0)).toBe(true)
    expect(trails(world).filter(Boolean)).toHaveLength(4)
    // No smoke on ground with its own particles.
    expect(emitters(world, smoke).every((e) => e.scale === 0)).toBe(true)
  })

  it('smokes and marks where locked wheels slide on asphalt', async () => {
    const app = await vehicleApp([vehicleEffectsPlugin()])
    const world = app.world
    ground(world)
    const car = spawnCar(world)
    world.add(car.chassis, VehicleEffects, { surfaces: [], smoke })
    frames(app, 30)
    drive(world, car.chassis, { throttle: 1 })
    frames(app, 240)
    expect(trails(world).filter(Boolean)).toHaveLength(0)
    drive(world, car.chassis, { brake: 1 })
    frames(app, 10)
    expect(emitters(world, smoke).some((e) => e.scale > 0)).toBe(true)
    expect(trails(world).filter(Boolean).length).toBeGreaterThan(0)
  })
})
