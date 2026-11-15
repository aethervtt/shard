/**
 * Vehicle effects (0118), `@aethervtt/shard-vehicle/effects`: per wheel, a particle emitter for the
 * ground it's on (dust, snow, mud spray) driven by its rolling speed and slip, tire smoke where it
 * slides on ground without its own particles, and a trail for skid marks and for tracks on loose
 * ground. Needs particlesPlugin and the forward renderer's ribbons (0082).
 */
import {
  type AssetRef,
  defineComponent,
  defineSystem,
  type Entity,
  PostUpdate,
  t,
  type World,
} from '@aethervtt/shard-core'
import { ParticleEmitterOverrides, ParticleSystem } from '@aethervtt/shard-particles'
import { Surfaces } from '@aethervtt/shard-physics'
import { Trail, Visibility } from '@aethervtt/shard-render'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { Transform, TransformSystems } from '@aethervtt/shard-transform'
import type { WheelSim } from './sim'
import { VehicleSimsResource } from './sims'

export const VehicleEffects = defineComponent(
  'vehicle/VehicleEffects',
  {
    surfaces: t.list(
      t.struct({
        surface: t.string({ description: 'Surface name: gravel, sand, snow, mud…' }),
        particles: t.handle('ParticleEffect', {
          description: 'Thrown up by the wheels on it, more with speed and slip.',
        }),
        tracks: t.bool({ description: 'Wheels leave tracks on it whether or not they slide.' }),
      }),
      { description: 'Per surface: what the wheels throw up, and whether they leave tracks.' },
    ),
    smoke: t.handle('ParticleEffect', {
      description: 'Tire smoke, where wheels slide on a surface without its own particles.',
    }),
    skidMarks: t.bool({ default: true, description: 'Trails where wheels slide.' }),
    skid: t.f32({
      default: 0.3,
      min: 0,
      max: 1,
      description: 'WheelState.skid above which a wheel smokes and marks.',
    }),
    track: t.struct(
      {
        lifetime: t.f32({ default: 15, min: 0.1, unit: 's' }),
        color: t.color({ default: [0.05, 0.05, 0.05, 0.75] }),
        width: t.f32({ default: 0, min: 0, unit: 'm', description: '0: the wheel’s width.' }),
      },
      { description: 'How tracks and skid marks look.' },
    ),
  },
  { description: 'Wheel effects for a vehicle (0118): dust, smoke and tracks by surface.' },
)

interface WheelFx {
  particles: Entity
  particlesFor: string | undefined
  smoke: Entity
  trail: Entity
}

const spawned = (world: World, e: Entity) => e >= 0 && world.isAlive(e)

/** The ParticleEffect asset key, to tell when a wheel needs another emitter. */
const key = (ref: AssetRef | null): string | undefined => (ref ? (ref.guid ?? ref.path) : undefined)

function emitter(world: World, ref: AssetRef, at: ArrayLike<number>): Entity {
  return world.spawn(
    [Transform, { translation: [at[0]!, at[1]!, at[2]!] }],
    Visibility,
    [ParticleSystem, { effect: ref as AssetRef<'ParticleEffect'>, space: 'world' }],
    [ParticleEmitterOverrides, { spawnScale: 0 }],
  )
}

function place(world: World, e: Entity, wh: WheelSim, lift: number): void {
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  const tr = table.column(Transform, 'translation')
  tr[row * 3] = wh.px + wh.nx * lift
  tr[row * 3 + 1] = wh.py + wh.ny * lift
  tr[row * 3 + 2] = wh.pz + wh.nz * lift
  table.markChanged(Transform, row)
}

function scale(world: World, e: Entity, value: number): void {
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  const col = table.column(ParticleEmitterOverrides, 'spawnScale')
  if (col[row] === value) return
  col[row] = value
  table.markChanged(ParticleEmitterOverrides, row)
}

/** Vehicle effects: emitters and trails follow each wheel's contact. PostUpdate. */
export const vehicleEffectsSystem = defineSystem({
  name: 'vehicle/effects',
  description: 'Places wheel dust, smoke and track trails at each contact and sets their rates.',
  setup: () => ({ fx: new Map<WheelSim, WheelFx>(), owners: new Map<WheelSim, Entity>() }),
  run: (s, world) => {
    const sims = world.tryResource(VehicleSimsResource)?.sims
    if (!sims) return
    const names = world.tryResource(Surfaces)?.names ?? []
    // Wheels whose vehicle is gone or lost its effects: their entities go too.
    for (const [wh, fx] of s.fx) {
      const owner = s.owners.get(wh)!
      const sim = sims.get(owner)
      if (sim?.wheels.includes(wh) && world.isAlive(owner) && world.has(owner, VehicleEffects))
        continue
      for (const e of [fx.particles, fx.smoke, fx.trail]) if (spawned(world, e)) world.despawn(e)
      s.fx.delete(wh)
      s.owners.delete(wh)
    }
    for (const sim of sims.values()) {
      if (!sim.ok || !world.isAlive(sim.entity) || !world.has(sim.entity, VehicleEffects)) continue
      const cfg = world.get(sim.entity, VehicleEffects)
      for (const wh of sim.wheels) {
        let fx = s.fx.get(wh)
        if (!fx) {
          fx = {
            particles: -1 as Entity,
            particlesFor: undefined,
            smoke: -1 as Entity,
            trail: -1 as Entity,
          }
          s.fx.set(wh, fx)
          s.owners.set(wh, sim.entity)
        }
        const surface = names[wh.surface] ?? 'asphalt'
        const entry = cfg.surfaces.find((e) => e.surface === surface)
        const roll = Math.abs(wh.omega * wh.radius)
        const sliding = wh.grounded && wh.skid > cfg.skid
        // Ground particles: this surface's, with speed and slip.
        const want = wh.grounded && entry?.particles ? entry.particles : null
        if (key(want) !== fx.particlesFor) {
          if (spawned(world, fx.particles)) world.despawn(fx.particles)
          fx.particles = want ? emitter(world, want, [wh.px, wh.py, wh.pz]) : (-1 as Entity)
          fx.particlesFor = key(want)
        }
        if (spawned(world, fx.particles)) {
          place(world, fx.particles, wh, 0.05)
          scale(world, fx.particles, Math.min(1, roll / 8) * (0.3 + wh.skid + wh.loose * 0.5))
        }
        // Smoke where it slides on ground without its own particles.
        if (cfg.smoke && !spawned(world, fx.smoke))
          fx.smoke = emitter(world, cfg.smoke, [wh.px, wh.py, wh.pz])
        if (spawned(world, fx.smoke)) {
          place(world, fx.smoke, wh, 0.1)
          const smoke = sliding && !entry?.particles ? Math.min(1, (wh.skid - cfg.skid) * 2) : 0
          scale(world, fx.smoke, smoke)
        }
        // Tracks and skid marks.
        const marking = (sliding && cfg.skidMarks) || (wh.grounded && entry?.tracks === true)
        if (!spawned(world, fx.trail) && marking) {
          fx.trail = world.spawn(
            [Transform, { translation: [wh.px, wh.py + 0.02, wh.pz] }],
            Visibility,
            [
              Trail,
              {
                width: cfg.track.width > 0 ? cfg.track.width : wh.width * 0.9,
                lifetime: cfg.track.lifetime,
                color: cfg.track.color,
                endColor: [cfg.track.color[0], cfg.track.color[1], cfg.track.color[2], 0],
                capacity: 256,
                minDistance: 0.4,
                breakDistance: 2,
              },
            ],
          )
        }
        if (spawned(world, fx.trail)) {
          place(world, fx.trail, wh, 0.02)
          const table = world.entityTable(fx.trail)
          const row = world.entityRow(fx.trail)
          const col = table.column(Trail, 'playing')
          const on = marking ? 1 : 0
          if (col[row] !== on) {
            col[row] = on
            table.markChanged(Trail, row)
          }
        }
      }
    }
  },
})

/** Vehicle effects (0118): VehicleEffects and its system. Needs vehiclePlugin and particles. */
export function vehicleEffectsPlugin(): Plugin {
  return definePlugin({
    name: 'vehicle/effects',
    provides: [{ VehicleEffects }],
    dependencies: ['vehicle'],
    build(app) {
      app.addSystems(PostUpdate, vehicleEffectsSystem.before(TransformSystems))
    },
  })
}
