import type { World } from '@aethervtt/shard-core'
import { defineOverlay } from '@aethervtt/shard-render'
import { hardpoint } from './sim'
import { VehicleSimsResource } from './sims'

const hp = new Float64Array(6)
const a = new Float32Array(3)
const b = new Float32Array(3)
const color = [0, 0, 0, 1]
/** Metres drawn per newton of tire force. */
const FORCE = 1 / 4000

/**
 * Vehicles (0118): each wheel's probe from the top of its travel to the contact (green relaxed to
 * red at the bump stop), its contact normal (white), tire forces (blue along, orange across),
 * pinned wheels (yellow), and the center of mass. The `vehicles` overlay.
 */
export const vehicleOverlay = defineOverlay({
  name: 'vehicles',
  description:
    'Vehicles (0118): wheel probes coloured by compression (green to red), contact normals, tire forces along (blue) and across (orange), wheels pinned by brakes or ABS (yellow), center of mass.',
  draw(world: World, g) {
    const sims = world.tryResource(VehicleSimsResource)
    if (!sims) return
    for (const sim of sims.sims.values()) {
      if (!sim.ok) continue
      for (const wh of sim.wheels) {
        hardpoint(sim, wh, hp)
        a[0] = hp[3]!
        a[1] = hp[4]!
        a[2] = hp[5]!
        const travel = wh.travelUp + wh.travelDown
        const c = Math.max(0, Math.min(1, (wh.x + wh.travelDown) / Math.max(1e-6, travel)))
        color[0] = c
        color[1] = 1 - c
        color[2] = 0.2
        if (wh.grounded) {
          b[0] = wh.px
          b[1] = wh.py
          b[2] = wh.pz
        } else {
          b[0] = hp[0]! - sim.up[0]! * (wh.travelDown + wh.radius)
          b[1] = hp[1]! - sim.up[1]! * (wh.travelDown + wh.radius)
          b[2] = hp[2]! - sim.up[2]! * (wh.travelDown + wh.radius)
          color[0] = color[1] = color[2] = 0.4
        }
        g.line(a, b, color)
        if (!wh.grounded) continue
        // Normal.
        a[0] = wh.px + wh.nx * 0.4
        a[1] = wh.py + wh.ny * 0.4
        a[2] = wh.pz + wh.nz * 0.4
        b[0] = wh.px
        b[1] = wh.py
        b[2] = wh.pz
        color[0] = color[1] = color[2] = 1
        if (wh.pin !== 0) {
          color[2] = 0
        }
        g.line(b, a, color)
        // Tire forces from the last substep's impulses.
        const h = sim.substeps > 0 ? 1 / (1 / 60 / sim.substeps) : 240
        const fx = wh.accX * h * FORCE
        const fy = wh.accY * h * FORCE
        a[0] = wh.px + wh.fx * fx
        a[1] = wh.py + wh.fy * fx
        a[2] = wh.pz + wh.fz * fx
        color[0] = 0.2
        color[1] = 0.5
        color[2] = 1
        g.line(b, a, color)
        a[0] = wh.px + wh.sx * fy
        a[1] = wh.py + wh.sy * fy
        a[2] = wh.pz + wh.sz * fy
        color[0] = 1
        color[1] = 0.55
        color[2] = 0.1
        g.line(b, a, color)
      }
      // Center of mass: a small cross.
      color[0] = 1
      color[1] = 0.2
      color[2] = 1
      for (let k = 0; k < 3; k++) {
        a[0] = sim.com[0]!
        a[1] = sim.com[1]!
        a[2] = sim.com[2]!
        b[0] = sim.com[0]!
        b[1] = sim.com[1]!
        b[2] = sim.com[2]!
        a[k] = a[k]! - 0.15
        b[k] = b[k]! + 0.15
        g.line(a, b, color)
      }
    }
  },
})
