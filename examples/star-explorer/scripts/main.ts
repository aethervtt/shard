import { playSound } from '@shard/audio'
import {
  defineSystem,
  type Entity,
  FixedUpdate,
  quat,
  t,
  Update,
  vec3,
  type World,
} from '@shard/core'
import { addActions, defineActions } from '@shard/input'
import { defineProject } from '@shard/project'
import { FixedTime } from '@shard/runtime'
import { findEntityByPath } from '@shard/scene'
import { Transform } from '@shard/transform'
import { UiChanged, UiLayout, UiText, UiToggle } from '@shard/ui'

/** Flight controls. Bindings are data: an agent (or player) can remap them without code changes. */
export const Controls = defineActions('star-explorer/Controls', {
  thrust: { kind: 'button', bindings: ['Key:KeyW', 'Key:Space', 'Gamepad:RightTrigger'] },
  steer: {
    kind: 'axis2d',
    bindings: [{ composite: 'arrows' }, 'Gamepad:LeftStick'],
    deadZone: 0.15,
  },
  fire: { kind: 'button', bindings: ['Key:KeyF', 'Mouse:Left', 'Gamepad:South'] },
})

const project = defineProject({
  name: 'star-explorer',
  build(app) {
    addActions(app.world, Controls)
    app.addSystems(FixedUpdate, fly, fire.after(fly)).addSystems(Update, hud)
  },
})

/** Weapon stats are data: `data/weapons/*.weapon.json`, tuned without touching code. */
export const Weapon = project.dataAsset(
  'Weapon',
  {
    damage: t.f32({ default: 10, min: 0, unit: 'hp', description: 'Damage per hit.' }),
    fireRate: t.f32({ default: 4, min: 0, unit: 'shots/s', description: 'Shots per second.' }),
    energyCost: t.f32({ default: 1, min: 0, description: 'Energy spent per shot.' }),
    color: t.color({ default: [1, 0.3, 0.2, 1], description: 'Bolt color.' }),
    upgradesTo: t.handle('star-explorer/Weapon', { description: 'The next weapon up, if any.' }),
    sound: t.handle('AudioClip', { description: 'Played at the ship on every shot.' }),
  },
  { extension: 'weapon', description: 'A ship weapon.' },
)

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
    weapon: t.handle('star-explorer/Weapon', { description: 'The mounted weapon.' }),
    cooldown: t.f32({ min: 0, unit: 's', description: 'Seconds until the weapon fires again.' }),
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

/** Fires the mounted weapon while fire is held, at its fire rate, with its sound at the ship. */
const fire = defineSystem({
  name: 'star-explorer/fire',
  setup: (world) => ({ ships: world.query({ with: [Ship, Transform] }) }),
  run: ({ ships }, world) => {
    const dt = world.resource(FixedTime).step
    const firing = world.resource(Controls.resource).pressed('fire')
    // Absent until a weapon file loads (screenshots of scenes without ships skip it).
    const weapons = world.tryResource(Weapon.store)
    if (!weapons) return
    for (const table of ships.tables) {
      const cooldown = table.column(Ship, 'cooldown')
      const weapon = table.column(Ship, 'weapon')
      const translation = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        cooldown[i] = Math.max(0, cooldown[i]! - dt)
        const stats = weapons.get(weapon[i])
        if (!firing || cooldown[i]! > 0 || !stats) continue
        cooldown[i] = 1 / Math.max(stats.fireRate, 0.01)
        if (stats.sound) {
          playSound(world, stats.sound, {
            position: translation.subarray(i * 3, i * 3 + 3),
            bus: 'sfx',
          })
        }
      }
      table.markChanged(Ship)
    }
  },
})

/** A HUD entity by scene path, looked up again only when it's gone (a reload respawns it). */
function hudEntity(world: World, cached: Entity | undefined, path: string): Entity | undefined {
  return cached !== undefined && world.isAlive(cached) ? cached : findEntityByPath(world, path)
}

/**
 * The HUD (prefabs/hud.prefab.json): the ship's speed, the distance to the planet marker's target,
 * and the scanner toggle's label. Text is written only when the shown number changes.
 */
const hud = defineSystem({
  name: 'star-explorer/hud',
  setup: (world) => ({
    ships: world.query({ with: [Ship] }),
    speed: undefined as Entity | undefined,
    distance: undefined as Entity | undefined,
    marker: undefined as Entity | undefined,
    scanLabel: undefined as Entity | undefined,
    shownSpeed: -1,
    shownDistance: -1,
  }),
  run: (s, world, ctx) => {
    s.speed = hudEntity(world, s.speed, 'hud/speed/value')
    s.marker = hudEntity(world, s.marker, 'hud/planet-marker')
    s.distance = hudEntity(world, s.distance, 'hud/planet-marker/distance')
    s.scanLabel = hudEntity(world, s.scanLabel, 'hud/scan/label')
    let speed = 0
    for (const table of s.ships.tables) {
      if (table.count > 0) speed = table.column(Ship, 'speed')[0]!
    }
    const shown = Math.round(speed)
    if (s.speed !== undefined && shown !== s.shownSpeed) {
      s.shownSpeed = shown
      world.set(s.speed, UiText, { text: `${shown} m/s` })
    }
    if (s.marker !== undefined && s.distance !== undefined) {
      const d = Math.round(world.get(s.marker, UiLayout).distance)
      if (d !== s.shownDistance) {
        s.shownDistance = d
        world.set(s.distance, UiText, { text: `${d} m` })
      }
    }
    for (const e of ctx.reader(UiChanged).read()) {
      if (s.scanLabel === undefined || !world.has(e.entity, UiToggle)) continue
      const on = world.get(e.entity, UiToggle).on
      world.set(s.scanLabel, UiText, { text: on ? 'Scanning' : 'Scan' })
    }
  },
})
