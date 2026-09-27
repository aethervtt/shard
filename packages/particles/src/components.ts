import { defineComponent, t } from '@aethervtt/shard-core'
import { Visibility } from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'

export const ParticleSystem = defineComponent(
  'particles/ParticleSystem',
  {
    effect: t.handle('ParticleEffect', { description: 'The effect (*.particles.json) to run.' }),
    playing: t.bool({ default: true, description: 'Spawns and simulates. Off: frozen in place.' }),
    seed: t.u32({ description: 'Random seed: the same seed replays the same particles.' }),
    timeScale: t.f32({ default: 1, min: 0, description: 'Simulation speed.' }),
    space: t.enum(['world', 'local'], {
      description:
        "world: particles stay where they were emitted (a moving ship leaves its exhaust behind). local: they move with the entity (an engine's glow).",
    }),
    backend: t.enum(['gpu', 'cpu'], {
      description:
        'gpu: compute shaders, for any count. cpu: the same effect simulated in TypeScript, for small counts that gameplay reads.',
    }),
  },
  {
    description: "Runs a particle effect at the entity's transform.",
    requires: [Transform, Visibility],
  },
)

export const ParticleEmitterOverrides = defineComponent(
  'particles/ParticleEmitterOverrides',
  {
    emitter: t.string({ description: 'Emitter name to change (empty: every emitter).' }),
    spawnRate: t.f32({
      default: -1,
      description:
        "Particles per second, replacing the effect's rate (negative: the effect's own).",
    }),
    spawnScale: t.f32({
      default: 1,
      min: 0,
      description: 'Multiplies the spawn rate (thrust → exhaust).',
    }),
  },
  {
    description: 'Gameplay control of a ParticleSystem: its spawn rate, read every frame.',
    requires: [ParticleSystem],
  },
)
