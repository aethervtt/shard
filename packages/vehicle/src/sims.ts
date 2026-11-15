import { defineResource, type Entity, type World } from '@aethervtt/shard-core'
import type { VehicleSim } from './sim'

/** Every vehicle's simulation, by chassis entity. */
export class VehicleSims {
  readonly sims = new Map<Entity, VehicleSim>()
  /** Chassis whose wheels or settings changed: rebuild at the next step. */
  readonly dirty = new Set<Entity>()
  /** Last `vehicle/step` time per vehicle in ms, summed. */
  stepMs = 0
  steps = 0
  /** Vehicles simulated (not asleep) at the last step. */
  active = 0
  /**
   * Whether this app simulates a vehicle or only presents it (another machine simulates it and
   * its pose arrives by replication). Networking sets it (`@aethervtt/shard-vehicle/net`); alone,
   * every vehicle with a dynamic body is simulated.
   */
  simulates: (world: World, vehicle: Entity) => boolean = () => true
}

export const VehicleSimsResource = defineResource<VehicleSims>('vehicle/Sims', {
  description: 'Vehicle simulations by chassis (0118). Internal.',
  init: () => new VehicleSims(),
})
