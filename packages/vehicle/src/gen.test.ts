import { ChildOf } from '@aethervtt/shard-core'
import { parseGltf, writeGlb } from '@aethervtt/shard-gltf'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { VehicleWheel } from './components'
import { findWheels, type GltfJson, generateVehicle, modelNodesFromGltf } from './gen'
import { MANEUVERS } from './maneuvers'
import { testTemplate } from './methods'
import { templateFromPrefab } from './template'
import { drive, fixtureCarMeshes, frames, ground, spawnCar, vehicleApp } from './testing'

function fixtureGltf(names?: string[]): GltfJson {
  const meshes = fixtureCarMeshes()
  const glb = writeGlb({
    nodes: meshes.map((m, i) => ({ name: names?.[i] ?? m.name, primitives: [{ mesh: m.mesh }] })),
  })
  return parseGltf(glb).json as GltfJson
}

describe('vehicle gen', () => {
  it('finds four wheels with their radii in a model', () => {
    const wheels = findWheels(modelNodesFromGltf(fixtureGltf()))
    expect(wheels).toHaveLength(4)
    for (const w of wheels) expect(Math.abs(w.radius - 0.33)).toBeLessThan(0.02)
    expect(wheels.map((w) => [w.axle, w.side])).toEqual([
      [0, 'left'],
      [0, 'right'],
      [1, 'left'],
      [1, 'right'],
    ])
    // Unnamed: the lowest round meshes.
    const unnamed = findWheels(modelNodesFromGltf(fixtureGltf(['a', 'b', 'c', 'd', 'e'])))
    expect(unnamed).toHaveLength(4)
  })

  it('makes a prefab that completes every maneuver', async () => {
    const prefab = generateVehicle(modelNodesFromGltf(fixtureGltf()), {
      model: 'assets/car.glb',
      class: 'sedan',
    })
    const report = await testTemplate(templateFromPrefab(prefab as never))
    expect(report.accel!.to100).toBeGreaterThan(5)
    expect(report.accel!.to100).toBeLessThan(20)
    expect(report.brake!.distance).toBeGreaterThan(30)
    expect(report.brake!.distance).toBeLessThan(60)
    expect(report.skidpad!.lateralG).toBeGreaterThan(0.6)
    expect(report.step!.rolled).toBe(false)
    expect(report.climb!.grade).toBeGreaterThan(15)
    expect(report.top!.perGear).toHaveLength(5)
    expect(Object.keys(report).length).toBe(MANEUVERS.length + 1)
  }, 120_000)

  it('turns a wheel visual about its hub wherever its origin is', async () => {
    const app = await vehicleApp()
    const world = app.world
    ground(world)
    const car = spawnCar(world)
    // A visual at the chassis origin with its geometry at the wheel (a baked model node).
    const visual = world.spawn([Transform, {}], [ChildOf, { parent: car.chassis }])
    world.set(car.wheels[0]!, VehicleWheel, { visual })
    frames(app, 30)
    drive(world, car.chassis, { throttle: 0.5, steer: 0.5 })
    frames(app, 90)
    // The hub (the wheel's position at ride height, in the visual's rest frame) stays on the axle
    // line: its world point is the wheel's hardpoint moved along the chassis' up only.
    const m = world.get(visual, GlobalTransform).matrix
    const hub = world.get(car.wheels[0]!, Transform).translation
    const hx = m[0]! * hub[0] + m[1]! * hub[1] + m[2]! * hub[2] + m[3]!
    const hy = m[4]! * hub[0] + m[5]! * hub[1] + m[6]! * hub[2] + m[7]!
    const hz = m[8]! * hub[0] + m[9]! * hub[1] + m[10]! * hub[2] + m[11]!
    const w = world.get(car.wheels[0]!, GlobalTransform).matrix
    // Offset from the hardpoint, in the chassis' frame: only along up (suspension).
    const dx = hx - w[3]!
    const dy = hy - w[7]!
    const dz = hz - w[11]!
    const c = world.get(car.chassis, GlobalTransform).matrix
    const along = dx * c[1]! + dy * c[5]! + dz * c[9]!
    const across = Math.hypot(dx - along * c[1]!, dy - along * c[5]!, dz - along * c[9]!)
    expect(across).toBeLessThan(0.01)
    expect(Math.abs(along)).toBeLessThan(0.2)
  })
})
