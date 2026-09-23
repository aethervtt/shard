import { ParticleEffect, ParticleEffects, ParticleSystem } from '@shard/particles'
import { Camera3d, Exposure } from '@shard/render'
import { definePlugin } from '@shard/runtime'
import { lookAt, Transform } from '@shard/transform'

const HUES = ['#ff7a2a', '#4aa3ff', '#9dff6a', '#ff5ad2']

/**
 * 4 fountains of additive billboards, 250k alive each (1M total). `?count=` sets the particles
 * per fountain. Every particle is simulated and drawn on the GPU every frame.
 */
export const particlesDemoPlugin = definePlugin({
  name: 'particles-demo',
  dependencies: ['particles'],
  build() {},
  ready(app) {
    const world = app.world
    const count = Number(new URLSearchParams(location.search).get('count') ?? 250_000)
    const lifetime = 2
    world.spawn(
      [Camera3d, { clearColor: [0.01, 0.01, 0.02, 1] }],
      [Exposure, { ev100: 9 }],
      [Transform, { translation: [0, 6, 22], rotation: lookAt([0, 6, 22], [0, 4, 0]) }],
    )
    const effects = world.resource(ParticleEffects)
    HUES.forEach((hue, i) => {
      const effect = ParticleEffect.fromJson({
        emitters: [
          {
            name: 'fountain',
            capacity: count,
            spawn: { rate: count / lifetime },
            shape: { type: 'cone', angle: 18, radius: 0.3 },
            init: { lifetime, speed: [7, 10], size: [0.03, 0.06], color: hue },
            update: [
              { module: 'gravity', acceleration: [0, -6, 0] },
              { module: 'curl-noise', strength: 1.5, frequency: 0.4 },
              {
                module: 'color-over-life',
                gradient: [
                  [0, '#ffffff', 1],
                  [0.3, hue, 1],
                  [1, hue, 0],
                ],
              },
            ],
            render: { blend: 'additive', emissive: 150 },
          },
        ],
      })
      world.spawn(
        [ParticleSystem, { effect: effects.add(effect) as never, seed: i + 1 }],
        [Transform, { translation: [(i - 1.5) * 6, 0, 0] }],
      )
    })
  },
})
