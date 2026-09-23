import { defineComponent, defineResource, t } from '@shard/core'
import { Transform } from '@shard/transform'
import { LightPresets } from './camera'

export const DirectionalLight = defineComponent(
  'render/DirectionalLight',
  {
    color: t.color({ default: [1, 1, 1, 1], description: 'Light color (linear).' }),
    illuminance: t.f32({
      default: LightPresets.daylight,
      min: 0,
      unit: 'lux',
      presets: LightPresets,
      description:
        'Presets: direct-sun 100000, daylight 10000, overcast 1000, indoor 400, twilight 10.',
    }),
  },
  {
    description: 'Sun-like light shining along its -Z axis. The first one found is used.',
    requires: [Transform],
  },
)

export interface AmbientLightValue {
  /** Linear color. */
  color: [number, number, number]
  /** Sky luminance in cd/m². A useful fill is roughly illuminance / 10 of the main light. */
  brightness: number
}

export const AmbientLight = defineResource<AmbientLightValue>('render/AmbientLight', {
  description: 'Uniform fill light, in cd/m².',
  init: () => ({ color: [1, 1, 1], brightness: 0 }),
})
