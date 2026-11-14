import type { World } from '@aethervtt/shard-core'
import { Physics } from '@aethervtt/shard-physics'
import { defineOverlay } from '@aethervtt/shard-render'
import { qrotate } from './math'
import { RagdollSimResource } from './sim'

const a = new Float32Array(3)
const b = new Float32Array(3)
const pose = new Float64Array(7)
const v = new Float64Array(3)
const color = [0, 0, 0, 1]

/**
 * Simulated ragdoll bodies: each body's long axis and its joint, coloured by blend weight (blue
 * animated, red physical). The `ragdoll` overlay.
 */
export const ragdollOverlay = defineOverlay({
  name: 'ragdoll',
  description:
    'Simulated ragdoll bodies (0117): each body’s axis from its joint, blue at weight 0 (animated) to red at 1 (physical).',
  draw(world: World, g) {
    const sim = world.tryResource(RagdollSimResource)
    const p = world.tryResource(Physics)
    if (!sim || !p) return
    for (const act of sim.actives.values()) {
      const s = act.slot
      if (!s || act.pending) continue
      for (let i = 0; i < act.binding.count; i++) {
        const rec = p.bodies.get(s.bodies[i]!)
        if (!rec) continue
        const t = rec.body.translation()
        const r = rec.body.rotation()
        pose[0] = t.x
        pose[1] = t.y
        pose[2] = t.z
        pose[3] = r.x
        pose[4] = r.y
        pose[5] = r.z
        pose[6] = r.w
        const shape = act.asset.bodies[i]!.shape
        const w = act.weight[i]!
        color[0] = w
        color[1] = 0.25
        color[2] = 1 - w
        if (shape.kind === 'capsule') {
          qrotate(v, 0, pose, 3, shape.from, 0)
          a[0] = pose[0]! + v[0]!
          a[1] = pose[1]! + v[1]!
          a[2] = pose[2]! + v[2]!
          qrotate(v, 0, pose, 3, shape.to, 0)
          b[0] = pose[0]! + v[0]!
          b[1] = pose[1]! + v[1]!
          b[2] = pose[2]! + v[2]!
          g.line(a, b, color)
        } else {
          a[0] = pose[0]!
          a[1] = pose[1]! - 0.05
          a[2] = pose[2]!
          b[0] = pose[0]!
          b[1] = pose[1]! + 0.05
          b[2] = pose[2]!
          g.line(a, b, color)
        }
      }
    }
  },
})
