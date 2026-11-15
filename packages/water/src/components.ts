import { defineComponent, t } from '@aethervtt/shard-core'

/** Body kinds: 0097 part 1's oceans and lakes, 0123's rivers; volumes come with 0097 part 2. */
export const WATER_KINDS = ['ocean', 'lake', 'river'] as const
export type WaterKind = (typeof WATER_KINDS)[number]

export const WaterBody = defineComponent(
  'water/WaterBody',
  {
    kind: t.enum(WATER_KINDS, {
      default: 'ocean',
      description:
        'ocean: a level (the entity’s y) everywhere, or inside a closed WaterSpline when it has one. lake: water inside a closed WaterSpline at the entity’s y. river: along an open WaterSpline, each point its surface height (y), width, depth and flow (0123).',
    }),
    optics: t.handle('water/WaterOptics', {
      description:
        'How the water absorbs and scatters light (*.water.json). Presets: water/clear, ocean, coastal, lake, river, murky and pool (.water.json). Without one: clear, and a water/no-optics warning.',
    }),
    priority: t.i32({
      default: 0,
      description:
        'Where bodies overlap, the highest priority is the water there (ties: the later entity).',
    }),
    wind: t.enum(['global', 'own'], {
      default: 'global',
      description:
        'global: ripples follow wind/Wind and its WindZones at the surface. own: windSpeed and windDirection instead (a sheltered pond, a storm on one lake).',
    }),
    windSpeed: t.f32({
      default: 0,
      min: 0,
      unit: 'm/s',
      description: 'With wind: own, the wind over this body at 10 m.',
    }),
    windDirection: t.vec3({
      default: [1, 0, 0],
      description: 'With wind: own, where it blows toward (normalized when used).',
    }),
  },
  {
    description:
      'A body of water (0097): its surface joins the shared water surface, shaded in the water pass with refraction, absorption and reflections, and waterAt reports it.',
  },
)

export const WaterSpline = defineComponent(
  'water/WaterSpline',
  {
    points: t.list(
      t.struct({
        position: t.vec3({
          description:
            'In the entity’s frame (metres). A river’s y is its surface height there; unused for lakes.',
        }),
        width: t.f32({
          default: 0,
          min: 0,
          unit: 'm',
          description: 'Rivers: the water’s width there, bank to bank (unused for lakes).',
        }),
        depth: t.f32({
          default: 0,
          min: 0,
          unit: 'm',
          description:
            'Rivers: the bed below the surface where there’s no terrain under it (unused for lakes).',
        }),
        flow: t.f32({
          default: 0,
          unit: 'm/s',
          description:
            'Rivers: downstream speed there (negative flows upstream); ripples follow it (unused for lakes).',
        }),
      }),
      {
        description:
          'Points a uniform Catmull-Rom spline passes through, in the entity’s frame: a lake’s or a bounded ocean’s shore (at least 3, closed), or a river’s course from source to mouth (at least 2, open).',
      },
    ),
    closed: t.bool({
      default: true,
      description:
        'Lakes and bounded oceans are closed: the outline wraps back to its first point. Rivers are open.',
    }),
  },
  {
    description:
      'The outline of a water body (0097): a lake, the shore that bounds an ocean so it doesn’t flood inland basins, or a river’s course (0123).',
  },
)
