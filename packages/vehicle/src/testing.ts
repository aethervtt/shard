/** Headless vehicle fixtures (0118): an app with physics and vehicles, ground, and a sedan. */
import type { Entity, World } from '@aethervtt/shard-core'
import { box, cylinder, type Mesh } from '@aethervtt/shard-mesh'
import { physics3dPlugin } from '@aethervtt/shard-physics'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { NO_GEAR, VehicleInput } from './components'
import { groundTiles } from './ground'
import { vehiclePlugin } from './plugin'
import { type SpawnedVehicle, type SpawnVehicleOptions, spawnVehicle } from './spawn'

export const DT = 1 / 60

/** An app with transforms, deterministic physics and vehicles, initialized. */
export async function vehicleApp(plugins: Plugin[] = []): Promise<App> {
  const app = new App().addPlugin(
    TransformPlugin,
    physics3dPlugin({ deterministic: true }),
    vehiclePlugin(),
    ...plugins,
  )
  await app.init()
  return app
}

export function frames(app: App, n: number): void {
  for (let i = 0; i < n; i++) app.update(DT)
}

/** Flat ground of 250 m tiles (see groundTiles). */
export const ground = groundTiles

export type CarOptions = SpawnVehicleOptions

export type Car = SpawnedVehicle

/** A sedan (or `options.class`) from spawnVehicle, at ride height on y = 0 ground. */
export function spawnCar(world: World, options: CarOptions = {}): Car {
  return spawnVehicle(world, options)
}

/** Sets the vehicle's input: fields not given are released (gear: no request). */
export function drive(world: World, car: Entity, input: Record<string, number>): void {
  world.set(car, VehicleInput, {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: 0,
    clutch: 0,
    shift: 0,
    gear: NO_GEAR,
    ...input,
  })
}

/**
 * A fixture car model (0118): a body and four wheels as baked meshes (every node at the model's
 * origin, like many exported models), sedan-sized, facing −Z. For `shard vehicle gen` tests.
 */
export function fixtureCarMeshes(): { name: string; mesh: Mesh }[] {
  const out: { name: string; mesh: Mesh }[] = []
  const bodyMesh = box({ x: 1.78, y: 0.9, z: 4.5 })
  translate(bodyMesh, 0, 0.85, 0)
  out.push({ name: 'Body', mesh: bodyMesh })
  for (const [name, x, z] of [
    ['wheel_fl', -0.78, -1.35],
    ['wheel_fr', 0.78, -1.35],
    ['wheel_rl', -0.78, 1.35],
    ['wheel_rr', 0.78, 1.35],
  ] as const) {
    const w = cylinder({ radius: 0.33, height: 0.22, segments: 24 })
    // Axis Y → X: (x, y, z) → (y, −x, z).
    const p = w.positions
    for (let i = 0; i < p.length; i += 3) {
      const px = p[i]!
      p[i] = p[i + 1]!
      p[i + 1] = -px
    }
    translate(w, x, 0.33, z)
    out.push({ name, mesh: w })
  }
  return out
}

function translate(mesh: Mesh, x: number, y: number, z: number): void {
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    p[i] = p[i]! + x
    p[i + 1] = p[i + 1]! + y
    p[i + 2] = p[i + 2]! + z
  }
}
