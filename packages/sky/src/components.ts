import { defineComponent, defineEvent, defineResource, t } from '@aethervtt/shard-core'

/** Sky modes this package draws (0130, 0131). Others can be registered with `registerSkyMode`. */
export const SKY_MODES = ['none', '2d', 'volumetric'] as const

export const Sky = defineComponent(
  'sky/Sky',
  {
    mode: t.string({
      default: 'volumetric',
      description: 'A registered sky mode: none, 2d (panning layers), volumetric (raymarched).',
    }),
    sun: t.entity({ description: 'The sun DirectionalLight; spawned when unset.' }),
    moon: t.entity({ description: 'The moon DirectionalLight; spawned when unset.' }),
    sunIlluminance: t.f32({
      default: 100000,
      min: 0,
      unit: 'lux',
      description: 'The sun at the top of the atmosphere (the atmosphere dims and reddens it).',
    }),
    moonIlluminance: t.f32({
      default: 0.3,
      min: 0,
      unit: 'lux',
      description: 'Full-moon light, scaled by the illuminated fraction.',
    }),
    nightBrightness: t.f32({
      default: 12,
      min: 0,
      description:
        'Multiplies moonlight and the night sky (stars, Milky Way, aurora). 1 is physical; 10–30 is a playable game night.',
    }),
    moonDisk: t.f32({
      default: 1,
      min: 0,
      description: 'Brightness of the moon disk drawn in the sky, against its default.',
    }),
    moonSize: t.f32({
      default: 2.5,
      min: 0.1,
      description: 'Moon disk size as a multiple of the real 0.52°.',
    }),
    path: t.enum(['simple', 'real'], {
      description:
        'simple: the sun rises at dawn on azimuth yaw and peaks at 90 − tilt; real: positions from latitude, longitude and date.',
    }),
    yaw: t.f32({
      default: 0,
      unit: 'deg',
      description: 'Simple path: turns the whole sky about up.',
    }),
    tilt: t.f32({
      default: 35,
      min: 0,
      max: 89,
      unit: 'deg',
      description: "Simple path: the arc's tilt from overhead, toward the south (+Z).",
    }),
    latitude: t.f32({ default: 45, min: -90, max: 90, unit: 'deg' }),
    longitude: t.f32({ default: 0, min: -180, max: 180, unit: 'deg' }),
    timeZone: t.f32({
      default: 0,
      min: -12,
      max: 14,
      unit: 'h',
      description: 'Real path: UTC offset.',
    }),
    stars: t.f32({ default: 1, min: 0, description: 'Star brightness.' }),
    twinkle: t.f32({
      default: 1,
      min: 0,
      description: 'Scintillation, strongest near the horizon.',
    }),
    milkyWay: t.f32({ default: 1, min: 0 }),
    aurora: t.f32({
      default: 0,
      min: 0,
      description: 'Aurora curtains toward the pole, at night.',
    }),
  },
  {
    description:
      'A drop-in outdoor sky (0130): a clock (TimeOfDay), sun and moon lights with shadows handed over at twilight, stars, the moon and aurora, and a sky mode that draws the clouds (0131).',
  },
)

export const Clouds = defineComponent(
  'sky/Clouds',
  {
    bottom: t.f32({
      default: 1500,
      min: 0,
      unit: 'm',
      description: 'Cloud base above the ground.',
    }),
    thickness: t.f32({ default: 3000, min: 1, unit: 'm' }),
    coverage: t.f32({ default: 0.45, min: 0, max: 1, description: '0 clear … 1 overcast.' }),
    type: t.f32({
      default: 0.5,
      min: 0,
      max: 1,
      description: '0 stratus, 0.5 cumulus, 1 cumulonimbus: how tall clouds grow.',
    }),
    density: t.f32({
      default: 0.04,
      min: 0,
      unit: '1/m',
      description: 'Extinction at full density.',
    }),
    shapeScale: t.f32({
      default: 1 / 9000,
      min: 0,
      unit: '1/m',
      description: 'Frequency of the cloud shapes: smaller is bigger clouds.',
    }),
    detailScale: t.f32({ default: 1 / 1200, min: 0, unit: '1/m', description: 'Erosion detail.' }),
    mapScale: t.f32({
      default: 1 / 22000,
      min: 0,
      unit: '1/m',
      description: 'Frequency of the coverage pattern (where clouds gather).',
    }),
    windInfluence: t.f32({
      default: 1,
      min: 0,
      description: 'How much wind/Wind moves the clouds (× its speed); 0 uses speed and direction.',
    }),
    speed: t.f32({
      default: 10,
      min: 0,
      unit: 'm/s',
      description: 'Used when windInfluence is 0.',
    }),
    direction: t.vec3({ default: [1, 0, 0.35] }),
    windScale: t.f32({
      default: 3,
      min: 0,
      description: 'Wind aloft is faster than at the ground: multiplies the wind speed for clouds.',
    }),
    evolution: t.f32({ default: 0.02, min: 0, description: 'How fast shapes change, per second.' }),
    phase: t.f32({ default: 0, description: 'Added to the advection, metres: scrub or loop.' }),
    albedo: t.f32({ default: 0.95, min: 0, max: 1 }),
    shadows: t.bool({ default: true, description: 'Cloud shadows on sun- and moonlit surfaces.' }),
    shadowStrength: t.f32({ default: 0.85, min: 0, max: 1 }),
    bands: t.u32({
      default: 0,
      description: 'Toon bands for cloud light (0: smooth).',
    }),
    quality: t.enum(['low', 'medium', 'high'], { default: 'medium' }),
  },
  {
    description:
      'The cloud field (0131) every sky mode draws: a layer between bottom and bottom + thickness, its coverage, type and density, moved by the wind.',
  },
)

/** The clock (0130). Read it anywhere; change it with setTimeOfDay / transitionTimeOfDay. */
export interface TimeOfDayValue {
  /** Game hours, 0 ≤ hours < 24. */
  hours: number
  /** Whole days since the clock started. */
  day: number
  /** Real date of day 0, for the real path and seasons. */
  startDate: { year: number; month: number; day: number }
  /** Game hour the sun rises and sets on the simple path; day and night lengths split there. */
  dawn: number
  dusk: number
  /** Real seconds from dawn to dusk, and from dusk to dawn. */
  dayLength: number
  nightLength: number
  paused: boolean
  /** Multiplies the clock's rate (1 normal). */
  speed: number
}

export const TimeOfDay = defineResource<TimeOfDayValue>('sky/TimeOfDay', {
  description:
    'The game clock (0130): hours and day, derived from fixed ticks, with separate day and night lengths.',
  init: () => ({
    hours: 9,
    day: 0,
    startDate: { year: 2026, month: 6, day: 21 },
    dawn: 6,
    dusk: 18,
    dayLength: 1200,
    nightLength: 600,
    paused: false,
    speed: 1,
  }),
})

export const Sunrise = defineEvent<{ day: number }>('sky/Sunrise')
export const Sunset = defineEvent<{ day: number }>('sky/Sunset')
export const HourChanged = defineEvent<{ hour: number; day: number }>('sky/HourChanged')
