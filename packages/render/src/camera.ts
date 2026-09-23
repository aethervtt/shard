import { defineComponent, defineSystem, type Infer, t } from '@shard/core'
import { Transform } from '@shard/transform'

/** Light presets in lux, paired with the exposure presets below. */
export const LightPresets = {
  'direct-sun': 100_000,
  daylight: 10_000,
  overcast: 1_000,
  indoor: 400,
  twilight: 10,
  moonlight: 0.3,
} as const

export type LightPreset = keyof typeof LightPresets

/** EV100 from scene illuminance (incident-light meter, ISO 100): EV100 = log2(lux / 2.5). */
export function ev100FromIlluminance(lux: number): number {
  return Math.log2(lux / 2.5)
}

/** Exposure presets in EV100, matched to the light presets. */
export const ExposurePresets = {
  sunny: ev100FromIlluminance(LightPresets['direct-sun']),
  daylight: ev100FromIlluminance(LightPresets.daylight),
  overcast: ev100FromIlluminance(LightPresets.overcast),
  indoor: ev100FromIlluminance(LightPresets.indoor),
  twilight: ev100FromIlluminance(LightPresets.twilight),
} as const

export type ExposurePreset = keyof typeof ExposurePresets

/** Illuminance for a preset name or a number (lux). */
export const lux = (value: LightPreset | number): number =>
  typeof value === 'number' ? value : LightPresets[value]

/** EV100 for a preset name or a number. */
export const ev100 = (value: ExposurePreset | number): number =>
  typeof value === 'number' ? value : ExposurePresets[value]

/** The multiplier from scene luminance to display, for an EV100 (Lagarde & de Rousiers, 2014). */
export function exposureScale(ev: number): number {
  return 1 / (1.2 * 2 ** ev)
}

/** EV100 from photographic settings: log2(N² / t · 100 / S). */
export function ev100FromCamera(aperture: number, shutterSpeed: number, iso: number): number {
  return Math.log2(((aperture * aperture) / shutterSpeed) * (100 / iso))
}

export const Exposure = defineComponent(
  'render/Exposure',
  {
    ev100: t.f32({
      default: ExposurePresets.daylight,
      presets: ExposurePresets,
      description: 'How bright the scene may be. Match it to the light: EV100 = log2(lux / 2.5).',
    }),
  },
  {
    description:
      'Camera exposure in EV100. Presets: sunny 15.3, daylight 12, overcast 8.6, indoor 7.3, twilight 2.',
  },
)

export const Camera3d = defineComponent(
  'render/Camera3d',
  {
    projection: t.enum(['perspective', 'orthographic']),
    fovY: t.f32({
      default: 60,
      min: 1,
      max: 179,
      unit: 'deg',
      description: 'Vertical field of view.',
    }),
    near: t.f32({
      default: 0.1,
      min: 0.0001,
      unit: 'm',
      description: 'Near plane. Far is infinite.',
    }),
    orthoHeight: t.f32({
      default: 10,
      min: 0.0001,
      unit: 'm',
      description: 'View height for orthographic.',
    }),
    far: t.f32({
      default: 1000,
      min: 0.001,
      unit: 'm',
      description: 'Far plane, orthographic only.',
    }),
    order: t.i32({ description: 'Lower renders first.' }),
    clearColor: t.color({
      default: [0.0056, 0.0065, 0.0091, 1],
      description: 'Background (linear).',
    }),
    target: t.handle('RenderTarget', { description: 'Offscreen target, or null for the window.' }),
  },
  {
    description: 'Renders the scene from this entity, looking down its -Z axis.',
    requires: [Transform, Exposure],
  },
)

export type Camera3dValue = Infer<typeof Camera3d>

export const PhysicalCamera = defineComponent(
  'render/PhysicalCamera',
  {
    aperture: t.f32({ default: 4, min: 0.5, description: 'f-stop.' }),
    shutterSpeed: t.f32({
      default: 1 / 125,
      min: 0.00001,
      unit: 's',
      description: 'Exposure time.',
    }),
    iso: t.f32({ default: 100, min: 1, description: 'Sensor sensitivity.' }),
    sensorHeight: t.f32({
      default: 24,
      min: 1,
      unit: 'mm',
      description: 'Sensor height (35mm film: 24).',
    }),
    focalLength: t.f32({
      min: 0,
      unit: 'mm',
      description: 'Lens focal length. When > 0, sets Camera3d.fovY from the sensor height.',
    }),
  },
  {
    description: 'Photographic camera settings. When present, they set Exposure (and fovY).',
    requires: [Camera3d],
  },
)

/** A 2D camera: orthographic, looking down -Z. Use as `world.spawn(...camera2d({ height: 20 }))`. */
export function camera2d(
  options: { height?: number; order?: number; clearColor?: [number, number, number, number] } = {},
) {
  return [
    [
      Camera3d,
      {
        projection: 'orthographic' as const,
        orthoHeight: options.height ?? 10,
        order: options.order ?? 0,
        ...(options.clearColor ? { clearColor: options.clearColor } : {}),
      },
    ],
    [Transform, { translation: [0, 0, 100] as [number, number, number] }],
  ] as const
}

/** PhysicalCamera → Exposure (and fovY when a focal length is set). */
export const applyPhysicalCameras = defineSystem({
  name: 'render/physical-camera',
  description: 'Sets Exposure and fovY from PhysicalCamera settings.',
  setup: (world) => ({ q: world.query({ with: [PhysicalCamera, Camera3d, Exposure] }) }),
  run: ({ q }) => {
    for (const table of q.tables) {
      const aperture = table.column(PhysicalCamera, 'aperture')
      const shutter = table.column(PhysicalCamera, 'shutterSpeed')
      const iso = table.column(PhysicalCamera, 'iso')
      const sensor = table.column(PhysicalCamera, 'sensorHeight')
      const focal = table.column(PhysicalCamera, 'focalLength')
      const ev = table.column(Exposure, 'ev100')
      const fov = table.column(Camera3d, 'fovY')
      for (let i = 0; i < table.count; i++) {
        ev[i] = ev100FromCamera(aperture[i]!, shutter[i]!, iso[i]!)
        if (focal[i]! > 0) fov[i] = (2 * Math.atan(sensor[i]! / (2 * focal[i]!)) * 180) / Math.PI
      }
      table.markChanged(Exposure)
    }
  },
})
