import { ProfilerResource } from '@aethervtt/shard-core'
import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { VehicleSimsResource } from './sims'
import { drive, frames, ground, spawnCar, vehicleApp } from './testing'

// Only timing comes out of these: they run under `pnpm bench` (AGENTS.md).
describe.runIf(timingMode === 'bench')('vehicle step cost', () => {
  it('steps 32 driven vehicles within vehicle/step-32', async () => {
    const app = await vehicleApp()
    const world = app.world
    ground(world)
    const cars = []
    for (let i = 0; i < 32; i++) {
      const car = spawnCar(world, { at: [(i % 8) * 6 - 21, 0.34, Math.floor(i / 8) * 9 - 14] })
      cars.push(car.chassis)
    }
    frames(app, 60)
    for (const [i, car] of cars.entries())
      drive(world, car, { throttle: 0.6, steer: Math.sin(i) * 0.5 })
    frames(app, 60)
    const profiler = world.resource(ProfilerResource)
    frames(app, 240)
    const ms = profiler.timing('vehicle/step')!.avg
    console.log(`32 vehicles: vehicle/step ${ms.toFixed(3)} ms`)
    expect(world.resource(VehicleSimsResource).active).toBe(32)
    expect(ms).toBeLessThan(budget('vehicle/step-32'))
  })

  it('1,000 parked vehicles cost a query walk', async () => {
    const app = await vehicleApp()
    const world = app.world
    ground(world)
    for (let i = 0; i < 1000; i++) {
      spawnCar(world, { at: [(i % 40) * 6 - 120, 0.34, Math.floor(i / 40) * 8 - 100] })
    }
    // Settle and fall asleep.
    frames(app, 300)
    expect(world.resource(VehicleSimsResource).active).toBe(0)
    const profiler = world.resource(ProfilerResource)
    frames(app, 120)
    const ms = profiler.timing('vehicle/step')!.avg
    console.log(`1,000 parked vehicles: vehicle/step ${ms.toFixed(3)} ms`)
    expect(ms).toBeLessThan(budget('vehicle/parked-1000'))
  }, 120_000)
})
