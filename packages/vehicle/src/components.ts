import {
  defineComponent,
  defineEvent,
  defineResource,
  type Entity,
  type FieldValue,
  t,
} from '@aethervtt/shard-core'

export const DIFFERENTIALS = ['open', 'limited-slip', 'locked'] as const
export type Differential = (typeof DIFFERENTIALS)[number]
export const PROBES = ['ray', 'cylinder'] as const
export const SIDES = ['left', 'right', 'center'] as const
export const TRANSMISSION_MODES = ['automatic', 'manual'] as const
export const CLUTCH_MODES = ['auto', 'pedal'] as const
export const ASSIST_PRESETS = ['custom', 'sim', 'arcade'] as const
export const SEAT_ROLES = ['driver', 'passenger'] as const

/** `VehicleInput.gear` when no gear is asked for. */
export const NO_GEAR = 127

const axle = t.struct({
  steer: t.f32({
    description: 'Share of steering: 1 front, −0.3 rear steer (turns against the front), 0 none.',
  }),
  drive: t.f32({
    min: 0,
    max: 1,
    description: 'Share of engine torque after the center split (driven axles’ shares sum to 1).',
  }),
  differential: t.enum(DIFFERENTIALS, {
    description:
      'open: equal torque to both sides (a lifted wheel spins). limited-slip: open plus a locking torque toward the slower side. locked: both sides turn as one.',
  }),
  torqueBias: t.f32({
    default: 3,
    min: 1,
    description:
      'limited-slip: the most torque one side gets over the other (a torque ratio, not Jolt’s or PhysX’s wheel-speed ratio).',
  }),
  preload: t.f32({
    default: 50,
    min: 0,
    unit: 'N·m',
    description:
      'limited-slip: locking torque with no input torque; drives a car with one wheel in the air or a ditch.',
  }),
  antiRoll: t.f32({
    min: 0,
    unit: 'N/m',
    description: 'Anti-roll bar: force per metre of compression difference between the sides.',
  }),
  brakeTorque: t.f32({ default: 1500, min: 0, unit: 'N·m', description: 'Per wheel, full brake.' }),
  handbrakeTorque: t.f32({ min: 0, unit: 'N·m', description: 'Per wheel, full handbrake.' }),
})

export type AxleValue = FieldValue<typeof axle>

export const DEFAULT_AXLES: AxleValue[] = [
  {
    steer: 1,
    drive: 0,
    differential: 'open',
    torqueBias: 3,
    preload: 50,
    antiRoll: 0,
    brakeTorque: 1800,
    handbrakeTorque: 0,
  },
  {
    steer: 0,
    drive: 1,
    differential: 'open',
    torqueBias: 3,
    preload: 50,
    antiRoll: 0,
    brakeTorque: 1200,
    handbrakeTorque: 2500,
  },
]

export const Vehicle = defineComponent(
  'vehicle/Vehicle',
  {
    axles: t.list(axle, {
      default: DEFAULT_AXLES,
      description:
        'Axles, front to back by convention; wheels name theirs by index. Default: front steers, rear drives and has the handbrake.',
    }),
    centerDiff: t.enum(DIFFERENTIALS, {
      description: 'Between driven axles (AWD): open, limited-slip or locked.',
    }),
    centerTorqueBias: t.f32({
      default: 3,
      min: 1,
      description: 'limited-slip center: the most torque one axle gets over the other.',
    }),
    steer: t.struct(
      {
        maxAngle: t.f32({ default: 35, min: 0, max: 80, unit: 'deg' }),
        ackermann: t.f32({
          default: 1,
          description:
            '1: inner wheel turns more, so both roll around one center (Ackermann). 0: both turn alike. Negative: anti-Ackermann.',
        }),
        speed: t.f32({ default: 180, min: 0, unit: 'deg/s', description: 'Turning the wheel.' }),
        returnSpeed: t.f32({
          default: 360,
          min: 0,
          unit: 'deg/s',
          description: 'Back toward center.',
        }),
        atSpeed: t.list(t.vec2, {
          default: [
            [0, 1],
            [30, 0.35],
          ],
          description:
            'Steering range by speed: (m/s, share of maxAngle), linear between points. Less lock at speed.',
        }),
      },
      { description: 'Steering geometry and rate.' },
    ),
    aeroDrag: t.f32({
      default: 0.4,
      min: 0,
      unit: 'N·s²/m²',
      description:
        'Air drag per (m/s)², ½ ρ Cd A: a sedan 0.4, a truck 1.2. Sets top speed with the engine.',
    }),
    substeps: t.u8({
      default: 4,
      min: 1,
      max: 16,
      description: 'Drivetrain and tire integration per physics step.',
    }),
    iterations: t.u8({
      default: 3,
      min: 1,
      max: 16,
      description: 'Solver passes over the wheels and drivetrain per substep.',
    }),
    probe: t.enum(PROBES, {
      default: 'cylinder',
      description:
        'How wheels find the ground: cylinder rides up curbs and steps; ray is cheaper and sees only the point under the hub.',
    }),
    mask: t.u16({ default: 0xffff, description: 'Layers the wheels stand on.' }),
  },
  {
    description:
      'A wheeled vehicle’s chassis (0118): on a dynamic RigidBody with colliders and Mass; wheels are child entities with VehicleWheel.',
  },
)

export const VehicleWheel = defineComponent(
  'vehicle/VehicleWheel',
  {
    axle: t.u8({ description: 'Index into Vehicle.axles.' }),
    side: t.enum(SIDES, { description: 'Which side of its axle.' }),
    radius: t.f32({ default: 0.33, min: 0.01, unit: 'm' }),
    width: t.f32({ default: 0.22, min: 0.01, unit: 'm' }),
    mass: t.f32({
      default: 20,
      min: 0.1,
      unit: 'kg',
      description: 'Wheel and tire; spin inertia is ½ m r².',
    }),
    tire: t.handle('vehicle/Tire', {
      description: 'The tire (*.tire.json, or vehicle/road|sport|offroad|winter.tire.json).',
    }),
    frequency: t.f32({
      default: 1.6,
      min: 0.1,
      unit: 'Hz',
      description: 'Suspension natural frequency: 1–1.5 soft, 2–3 sporty.',
    }),
    damping: t.vec2({
      default: [0.4, 0.6],
      min: 0,
      description: 'Damping ratio in bump (compressing) and rebound (extending).',
    }),
    travel: t.vec2({
      default: [0.12, 0.15],
      min: 0,
      unit: 'm',
      description: 'Suspension travel up and down from ride height.',
    }),
    camber: t.f32({ unit: 'deg', description: 'Static camber, for the visual.' }),
    forceHeight: t.f32({
      default: 0.3,
      min: 0,
      max: 1,
      description:
        'Where tire forces push: 0 at the contact (real, rolls more), 1 at the center of mass height.',
    }),
    gripScale: t.f32({ default: 1, min: 0, description: 'Games: a flat tire, damage.' }),
    visual: t.entity({
      description: 'The entity drawn as this wheel: it spins, steers and follows the suspension.',
    }),
    visualName: t.string({
      description:
        'Without visual: the model node drawn as this wheel, found by name under the chassis once its model spawns (vehicle gen writes it).',
    }),
  },
  {
    description:
      'A wheel (0118) on a child of a Vehicle. Its position is the wheel center at ride height.',
  },
)

export const VehicleEngine = defineComponent(
  'vehicle/VehicleEngine',
  {
    torque: t.list(t.vec2, {
      default: [
        [800, 160],
        [2000, 210],
        [4000, 250],
        [5500, 230],
        [6500, 190],
      ],
      description: 'Torque curve: (rpm, N·m) points, rpm increasing, linear between.',
    }),
    idleRpm: t.f32({ default: 800, min: 0, unit: 'rpm' }),
    maxRpm: t.f32({ default: 6500, min: 1, unit: 'rpm', description: 'The limiter.' }),
    stallRpm: t.f32({ default: 500, min: 0, unit: 'rpm' }),
    stall: t.bool({
      description: 'Manual: the engine stops when the clutch drags it under stallRpm.',
    }),
    inertia: t.f32({ default: 0.2, min: 0.01, unit: 'kg·m²' }),
    braking: t.f32({
      default: 60,
      min: 0,
      unit: 'N·m',
      description: 'Engine braking (friction) at maxRpm, proportional to rpm.',
    }),
    running: t.bool({ default: true, description: 'Games: keys, fuel. Off gives no torque.' }),
    torqueScale: t.f32({ default: 1, min: 0, description: 'Games: damage, fuel starvation.' }),
  },
  { description: 'An engine (0118) on a Vehicle.' },
)

export const VehicleTransmission = defineComponent(
  'vehicle/VehicleTransmission',
  {
    mode: t.enum(TRANSMISSION_MODES, {
      description: 'automatic shifts by rpm; manual takes VehicleInput.shift and gear.',
    }),
    clutch: t.enum(CLUTCH_MODES, {
      description: 'auto engages with rpm (launches, stops); pedal reads VehicleInput.clutch.',
    }),
    gears: t.list(t.f32, {
      default: [3.6, 2.1, 1.4, 1.0, 0.8],
      description: 'Forward ratios, first to top, descending.',
    }),
    reverse: t.f32({ default: 3.4, min: 0, description: 'Reverse ratio (positive).' }),
    finalDrive: t.f32({ default: 3.9, min: 0.1 }),
    efficiency: t.f32({ default: 0.9, min: 0, max: 1 }),
    shiftTime: t.f32({ default: 0.25, min: 0, unit: 's', description: 'In neutral per shift.' }),
    clutchTorque: t.f32({
      default: 400,
      min: 0,
      unit: 'N·m',
      description: 'Most torque the clutch passes before it slips.',
    }),
    upshift: t.f32({
      default: 0.85,
      min: 0,
      max: 1,
      description: 'Automatic: upshift above this share of maxRpm at full throttle.',
    }),
    downshift: t.f32({
      default: 0.4,
      min: 0,
      max: 1,
      description: 'Automatic: downshift below this share of maxRpm at full throttle.',
    }),
    reverseOnBrake: t.bool({
      default: true,
      description: 'Automatic: holding brake at a stop selects reverse (and throttle, first).',
    }),
  },
  { description: 'A gearbox and clutch (0118) on a Vehicle with an engine.' },
)

export const VehicleAssists = defineComponent(
  'vehicle/VehicleAssists',
  {
    preset: t.enum(ASSIST_PRESETS, {
      description:
        'sim or arcade writes the fields below once, then reads custom. sim: ABS, half TCS. arcade: everything on.',
    }),
    abs: t.f32({ min: 0, max: 1, description: 'Anti-lock brakes.' }),
    tcs: t.f32({
      min: 0,
      max: 1,
      description: 'Traction control: cuts throttle, and brakes a wheel spinning past its partner.',
    }),
    esc: t.f32({
      min: 0,
      max: 1,
      description: 'Stability control: brakes one wheel and cuts throttle against spins.',
    }),
    understeer: t.f32({
      default: 0.0015,
      min: 0,
      unit: 's²/m',
      description:
        'ESC’s yaw reference v·δ / (L (1 + K v²)): the car’s understeer. vehicle test measures it.',
    }),
    counterSteer: t.f32({ min: 0, max: 1, description: 'Steers into a slide.' }),
    driftGrip: t.f32({
      default: 1,
      min: 0,
      description: 'Rear lateral grip scale while the handbrake is held (arcade drifts: 0.6).',
    }),
    driftHold: t.f32({
      min: 0,
      max: 1,
      description: 'Damps spins past 45° and keeps speed through a drift.',
    }),
    downforce: t.f32({ min: 0, unit: 'N·s²/m²', description: 'Down force per (m/s)².' }),
    airControl: t.vec3({
      min: 0,
      unit: 'N·m',
      description: 'Torque in the air: pitch (throttle − brake), yaw (steer), roll (steer).',
    }),
    selfRight: t.bool({ description: 'Turns an upside-down, slow car upright after 2 s.' }),
    antiFlip: t.f32({ min: 0, max: 1, description: 'Damps roll while wheels lift on one side.' }),
  },
  { description: 'Driving aids (0118) on a Vehicle. All off by default.' },
)

export const VehicleInput = defineComponent(
  'vehicle/VehicleInput',
  {
    throttle: t.f32({ min: 0, max: 1 }),
    brake: t.f32({ min: 0, max: 1 }),
    steer: t.f32({ min: -1, max: 1, description: '−1 full left, 1 full right.' }),
    handbrake: t.f32({ min: 0, max: 1 }),
    clutch: t.f32({ min: 0, max: 1, description: 'Pedal mode: 1 fully pressed (disengaged).' }),
    shift: t.i8({
      min: -1,
      max: 1,
      description: 'Manual: −1 down, +1 up. Cleared when taken.',
    }),
    gear: t.i8({
      default: NO_GEAR,
      description: `Manual: select this gear (−1 R, 0 N, 1…). ${NO_GEAR}: none. Cleared when taken.`,
    }),
  },
  { description: 'What a vehicle’s driver does (0118): games, input maps, AI or a net input.' },
)

export const VehicleState = defineComponent(
  'vehicle/VehicleState',
  {
    speed: t.f32({ readonly: true, unit: 'm/s', description: 'Forward speed (negative backing).' }),
    rpm: t.f32({ readonly: true, unit: 'rpm' }),
    gear: t.i8({ readonly: true, description: '−1 reverse, 0 neutral, 1… forward.' }),
    shifting: t.bool({ readonly: true }),
    clutch: t.f32({ readonly: true, description: 'Engagement, 0 open … 1 locked.' }),
    throttle: t.f32({ readonly: true, description: 'Throttle after traction control.' }),
    load: t.f32({
      readonly: true,
      description: 'Engine load: −1 engine braking … 1 full power (audio crossfades on it).',
    }),
    grounded: t.u8({ readonly: true, description: 'Wheels on the ground.' }),
    airTime: t.f32({ readonly: true, unit: 's' }),
    driftAngle: t.f32({
      readonly: true,
      unit: 'rad',
      description: 'Between heading and travel, positive sliding left.',
    }),
    steer: t.f32({ readonly: true, unit: 'rad', description: 'Front steer angle now.' }),
    assists: t.u8({ readonly: true, description: 'Assists acting: 1 ABS, 2 TCS, 4 ESC.' }),
    understeer: t.f32({
      readonly: true,
      unit: 's²/m',
      description: 'Measured understeer gradient (vehicle test fills it).',
    }),
  },
  { description: 'What a vehicle did at the last step (0118). Read-only.' },
)

export const WheelState = defineComponent(
  'vehicle/WheelState',
  {
    grounded: t.bool({ readonly: true }),
    compression: t.f32({
      readonly: true,
      description: '0 fully extended … 1 at the bump stop.',
    }),
    point: t.vec3({ readonly: true, description: 'Contact point, world.' }),
    normal: t.vec3({ readonly: true, default: [0, 1, 0] }),
    ground: t.entity({ readonly: true, description: 'The collider under it.' }),
    surface: t.u16({
      readonly: true,
      description: 'physics/Surfaces index of the ground (0: asphalt).',
    }),
    load: t.f32({ readonly: true, unit: 'N' }),
    slipRatio: t.f32({ readonly: true }),
    slipAngle: t.f32({ readonly: true, unit: 'rad' }),
    skid: t.f32({
      readonly: true,
      description: '0 rolling … 1 fully sliding: drives skid sounds and marks.',
    }),
    spin: t.f32({ readonly: true, unit: 'rad/s' }),
    angle: t.f32({ readonly: true, unit: 'rad', description: 'Accumulated spin, for visuals.' }),
    steer: t.f32({ readonly: true, unit: 'rad' }),
    sinkage: t.f32({ readonly: true, unit: 'm' }),
  },
  { description: 'What a wheel did at the last step (0118). Read-only.' },
)

export const VehicleSeat = defineComponent(
  'vehicle/VehicleSeat',
  {
    role: t.enum(SEAT_ROLES),
    exit: t.vec3({
      default: [-1.2, 0, 0],
      unit: 'm',
      description: 'Where an occupant steps out, in the seat’s frame (mirrored if blocked).',
    }),
    occupant: t.entity({ readonly: true }),
  },
  { description: 'A seat (0118) on a child of a Vehicle.' },
)

export interface VehicleShiftData {
  vehicle: Entity
  from: number
  to: number
}
export const VehicleShiftEvent = defineEvent<VehicleShiftData>('vehicle/Shift', {
  description: 'A gear change started.',
})

export const ENGINE_EVENTS = ['started', 'stopped', 'stalled', 'backfire'] as const
export interface VehicleEngineData {
  vehicle: Entity
  kind: (typeof ENGINE_EVENTS)[number]
}
export const VehicleEngineEvent = defineEvent<VehicleEngineData>('vehicle/Engine', {
  description: 'The engine started, stopped, stalled, or backfired.',
})

export interface VehicleWheelData {
  vehicle: Entity
  wheel: Entity
  kind: 'bottom-out' | 'surface'
  /** bottom-out: compression speed (m/s). */
  speed: number
  /** The physics/Surfaces index now under the wheel. */
  surface: number
}
export const VehicleWheelEvent = defineEvent<VehicleWheelData>('vehicle/Wheel', {
  description: 'A wheel hit its bump stop, or rolled onto another surface.',
})

export interface VehicleLandedData {
  vehicle: Entity
  airTime: number
  /** Downward speed at touchdown (m/s). */
  speed: number
}
export const VehicleLandedEvent = defineEvent<VehicleLandedData>('vehicle/Landed', {
  description: 'Wheels touched down after at least 0.3 s in the air.',
})

export interface VehicleHitData {
  vehicle: Entity
  other: Entity
  point: [number, number, number]
  /** From the vehicle toward the other. */
  normal: [number, number, number]
  /** Closing speed along the normal (m/s). */
  speed: number
  character: boolean
}
export const VehicleHitEvent = defineEvent<VehicleHitData>('vehicle/Hit', {
  description:
    'The vehicle hit a character, which cost it momentum by mass ratio. Hard hits on solid things come from physics/ContactForceEvent on the chassis colliders.',
})

export interface VehicleSeatData {
  vehicle: Entity
  seat: Entity
  character: Entity
  kind: 'entered' | 'exited'
}
export const VehicleSeatEvent = defineEvent<VehicleSeatData>('vehicle/Seat', {
  description: 'A character got into or out of a seat.',
})

export interface VehicleConfigValue {
  /** Mass a hit character counts as (kg). */
  characterMass: number
  /** Seconds before the same character can be hit again by the same vehicle. */
  hitCooldown: number
  /** Closing speed below which touching a character isn't a hit (m/s). */
  hitSpeed: number
}

export const VehicleConfig = defineResource<VehicleConfigValue>('vehicle/Config', {
  description: 'Vehicle-wide settings (0118): character hits.',
  init: () => ({ characterMass: 70, hitCooldown: 0.5, hitSpeed: 1 }),
})
