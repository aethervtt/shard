import { defineComponent, defineResource, type Infer, t } from '@aethervtt/shard-core'
import { Camera3d } from '@aethervtt/shard-render'

const BUTTONS = ['left', 'middle', 'right'] as const

/**
 * Orbit, pan and dolly around a target, on a perspective camera (0060). The fields are where the
 * camera is going: input changes them, a host may write them (to restore a saved view), and with
 * `smoothing` the camera eases toward them.
 */
export const OrbitControls = defineComponent(
  'controls/OrbitControls',
  {
    target: t.vec3({ unit: 'm', description: 'The point the camera orbits and looks at.' }),
    distance: t.f32({ default: 10, min: 0.0001, unit: 'm', description: 'From the target.' }),
    yaw: t.f32({
      unit: 'deg',
      description: 'Turn about +Y: 0 looks from +Z toward -Z, 90 from +X.',
    }),
    pitch: t.f32({
      default: 45,
      unit: 'deg',
      description: 'Height above the horizon: 90 looks straight down.',
    }),
    minPitch: t.f32({ default: 15, min: -89, max: 89, unit: 'deg' }),
    maxPitch: t.f32({ default: 89, min: -89, max: 89, unit: 'deg' }),
    minDistance: t.f32({ default: 1, min: 0.0001, unit: 'm' }),
    maxDistance: t.f32({ default: 100, min: 0.0001, unit: 'm' }),
    orbitButton: t.enum(BUTTONS, {
      default: 'right',
      description: 'Drags with it orbit; with Shift held they pan (trackpads have no middle).',
    }),
    panButton: t.enum(BUTTONS, { default: 'middle', description: 'Drags with it pan.' }),
    leftDrag: t.enum(['orbit', 'pan', 'none'], {
      default: 'orbit',
      description:
        "What a left or one-finger drag nothing else claimed does: the host's drags (tokens) come first.",
    }),
    rotateSpeed: t.f32({ default: 0.3, min: 0, unit: 'deg', description: 'Orbit per CSS pixel.' }),
    zoomSpeed: t.f32({ default: 1, min: 0, description: 'Wheel zoom rate multiplier.' }),
    autoRotate: t.f32({
      unit: 'deg',
      description: 'Yaw per second while nothing drags the camera (a turntable). 0: still.',
    }),
    smoothing: t.f32({
      min: 0,
      unit: 's',
      description:
        'Time constant the camera eases toward the fields with. 0 (and reduced motion): at once.',
    }),
    enabled: t.bool({ default: true, description: 'Takes input. The camera must be active too.' }),
  },
  {
    description:
      'Orbit (right drag), pan (middle drag, Shift+right), dolly to the cursor (wheel), and pinch, two-finger pan and twist on touch, on a perspective camera.',
    requires: [Camera3d],
  },
)

export type OrbitControlsValue = Infer<typeof OrbitControls>

/**
 * Pan and zoom-to-cursor on an orthographic camera over a floor (0060): the Map view, looking
 * down (or tilted by `pitch`), or a 2D world on the xy plane. The fields are where the camera is
 * going, as for `OrbitControls`.
 */
export const MapControls = defineComponent(
  'controls/MapControls',
  {
    target: t.vec3({ unit: 'm', description: 'The floor point at the center of the view.' }),
    zoom: t.f32({ default: 1, min: 0.0001, description: 'The view is `height / zoom` tall.' }),
    minZoom: t.f32({ default: 0.1, min: 0.0001 }),
    maxZoom: t.f32({ default: 8, min: 0.0001 }),
    height: t.f32({
      default: 20,
      min: 0.0001,
      unit: 'm',
      description: "The view's height at zoom 1 (Camera3d.orthoHeight = height / zoom).",
    }),
    elevation: t.f32({
      default: 50,
      min: 0.0001,
      unit: 'm',
      description:
        'How far from the target the camera sits, along its view: keep it inside near..far.',
    }),
    pitch: t.f32({
      default: 90,
      min: 1,
      max: 90,
      unit: 'deg',
      description:
        'Tilt on the xz floor: 90 looks straight down (screen-up -Z); less looks from the south, so wall faces show.',
    }),
    plane: t.enum(['xz', 'xy'], {
      default: 'xz',
      description:
        'The ground it pans over: the xz floor (3D), or the xy plane of a 2D world, seen along -Z.',
    }),
    bounded: t.bool({
      description: 'Keep the target within boundsMin..boundsMax (x, z; x, y on the xy plane).',
    }),
    boundsMin: t.vec2({ unit: 'm' }),
    boundsMax: t.vec2({ unit: 'm' }),
    panButton: t.enum(BUTTONS, { default: 'middle', description: 'Drags with it pan.' }),
    leftDrag: t.enum(['pan', 'none'], {
      default: 'pan',
      description:
        "What a left or one-finger drag nothing else claimed does: the host's drags (tokens) come first.",
    }),
    zoomSpeed: t.f32({ default: 1, min: 0, description: 'Wheel zoom rate multiplier.' }),
    smoothing: t.f32({
      min: 0,
      unit: 's',
      description:
        'Time constant the camera eases toward the fields with. 0 (and reduced motion): at once.',
    }),
    enabled: t.bool({ default: true, description: 'Takes input. The camera must be active too.' }),
  },
  {
    description:
      'Pan (middle drag, or left drag on empty floor) and zoom to the cursor (wheel, pinch) on an orthographic camera over a floor, or a 2D world.',
    requires: [Camera3d],
  },
)

export type MapControlsValue = Infer<typeof MapControls>

export interface ControlsSettingsValue {
  /** Snap instead of easing, whatever a control's `smoothing` (the host's reduced-motion setting). */
  reducedMotion: boolean
  /**
   * The view size in CSS pixels for cameras that haven't rendered yet (headless runs): rendered
   * cameras use their target's size.
   */
  viewport: [number, number]
}

export const ControlsSettings = defineResource<ControlsSettingsValue>('controls/Settings', {
  description: 'Camera controls settings: reduced motion, and the headless view size.',
  init: () => ({ reducedMotion: false, viewport: [1280, 720] }),
})
