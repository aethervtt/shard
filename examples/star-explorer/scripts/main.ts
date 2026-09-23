import { defineSystem, FixedUpdate, quat, t, vec3 } from '@shard/core'
import { addActions, defineActions } from '@shard/input'
import { defineProject } from '@shard/project'
import { FixedTime } from '@shard/runtime'
import { Transform } from '@shard/transform'

/** Flight controls. Bindings are data: an agent (or player) can remap them without code changes. */
export const Controls = defineActions('star-explorer/Controls', {
  thrust: { kind: 'button', bindings: ['Key:KeyW', 'Key:Space', 'Gamepad:RightTrigger'] },
  steer: {
    kind: 'axis2d',
    bindings: [{ composite: 'arrows' }, 'Gamepad:LeftStick'],
    deadZone: 0.15,
  },
})

const project = defineProject({
  name: 'star-explorer',
  build(app) {
    addActions(app.world, Controls)
    app.addSystems(FixedUpdate, fly)
  },
})

export const Ship = project.component(
  'Ship',
  {
    speed: t.f32({ min: 0, unit: 'm/s', description: 'Current forward speed.' }),
    maxSpeed: t.f32({ default: 40, min: 0, unit: 'm/s', description: 'Speed cap.' }),
    acceleration: t.f32({ default: 15, min: 0, unit: 'm/s²', description: 'Thrust acceleration.' }),
    drag: t.f32({
      default: 0.4,
      min: 0,
      description: 'Fraction of speed lost per second without thrust.',
    }),
    turnRate: t.f32({ default: 1.2, min: 0, unit: 'rad/s', description: 'Steering speed.' }),
  },
  { description: 'A ship the player flies: steer with arrows or the left stick, thrust with W.' },
)

const spin = quat.create()
const forward = vec3.create()

/** Steers and moves every ship along its -Z axis. */
const fly = defineSystem({
  name: 'star-explorer/fly',
  setup: (world) => ({ ships: world.query({ with: [Ship, Transform] }) }),
  run: ({ ships }, world) => {
    const dt = world.resource(FixedTime).step
    const controls = world.resource(Controls.resource)
    const [yaw, pitch] = controls.axis2d('steer')
    const thrust = controls.pressed('thrust')
    for (const table of ships.tables) {
      const speed = table.column(Ship, 'speed')
      const maxSpeed = table.column(Ship, 'maxSpeed')
      const acceleration = table.column(Ship, 'acceleration')
      const drag = table.column(Ship, 'drag')
      const turnRate = table.column(Ship, 'turnRate')
      const translation = table.column(Transform, 'translation')
      const rotation = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        const s = thrust
          ? Math.min(maxSpeed[i]!, speed[i]! + acceleration[i]! * dt)
          : speed[i]! * Math.max(0, 1 - drag[i]! * dt)
        speed[i] = s
        const r = rotation.subarray(i * 4, i * 4 + 4)
        quat.fromEuler(spin, pitch * turnRate[i]! * dt, -yaw * turnRate[i]! * dt, 0)
        quat.normalize(r, quat.multiply(r, r, spin))
        vec3.transformQuat(forward, [0, 0, -1], r)
        translation[i * 3] = translation[i * 3]! + forward[0]! * s * dt
        translation[i * 3 + 1] = translation[i * 3 + 1]! + forward[1]! * s * dt
        translation[i * 3 + 2] = translation[i * 3 + 2]! + forward[2]! * s * dt
      }
      table.markChanged(Ship)
      table.markChanged(Transform)
    }
  },
})

export default project
