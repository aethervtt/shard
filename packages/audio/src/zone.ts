import { defineComponent, t } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'

export const ReverbZone = defineComponent(
  'audio/ReverbZone',
  {
    shape: t.enum(['sphere', 'box']),
    radius: t.f64({ default: 5, min: 0.00001, unit: 'm' }),
    halfExtents: t.vec3({ default: [5, 5, 5], min: 0.00001 }),
    blendDistance: t.f64({ default: 2, min: 0, unit: 'm' }),
    returnBus: t.string({ required: true }),
    wet: t.f64({ default: 1, min: 0, max: 1 }),
    priority: t.i32(),
    indoor: t.bool(),
  },
  {
    requires: [Transform],
    description:
      'Listener-based acoustic zone. Its return is prepared in the mixer; moving between zones never decodes on a frame.',
  },
)
