/**
 * Vehicle classes (0118): starting values for `shard vehicle gen` and the test fixtures. A class
 * is a plausible car of its kind; gen keeps the model's measured wheel positions and sizes.
 */
import type { AxleValue } from './components'
import type { TirePreset } from './tire'

export const VEHICLE_CLASSES = [
  'sedan',
  'sports',
  'pickup',
  'offroad',
  'van',
  'truck',
  'bus',
] as const
export type VehicleClass = (typeof VEHICLE_CLASSES)[number]

export interface VehicleClassValue {
  mass: number
  /** Center of mass above the axles (m). */
  comHeight: number
  /** Typical geometry, for fixtures without a model. */
  track: number
  wheelbase: number
  radius: number
  width: number
  wheelMass: number
  frequency: number
  damping: [number, number]
  travel: [number, number]
  tire: TirePreset
  /** Body box half extents (fixtures), and its center above the axles. */
  body: [number, number, number]
  bodyY: number
  aeroDrag: number
  /** Front axle, rear axle. Extra rear axles copy the rear. */
  axles: [AxleValue, AxleValue]
  centerDiff: 'open' | 'limited-slip' | 'locked'
  maxSteer: number
  engine: {
    torque: [number, number][]
    idleRpm: number
    maxRpm: number
    inertia: number
    braking: number
  }
  gearbox: {
    gears: number[]
    reverse: number
    finalDrive: number
    clutchTorque: number
    upshift: number
    downshift: number
  }
}

const axle = (
  steer: number,
  drive: number,
  brakeTorque: number,
  antiRoll: number,
  extra: Partial<AxleValue> = {},
): AxleValue => ({
  steer,
  drive,
  differential: 'open',
  torqueBias: 3,
  preload: 50,
  antiRoll,
  brakeTorque,
  handbrakeTorque: 0,
  ...extra,
})

export const VEHICLE_CLASS_VALUES: Record<VehicleClass, VehicleClassValue> = {
  sedan: {
    mass: 1500,
    comHeight: 0.22,
    track: 1.56,
    wheelbase: 2.7,
    radius: 0.33,
    width: 0.22,
    wheelMass: 20,
    frequency: 1.6,
    damping: [0.4, 0.6],
    travel: [0.12, 0.15],
    tire: 'road',
    body: [0.88, 0.38, 2.25],
    bodyY: 0.5,
    aeroDrag: 0.4,
    axles: [axle(1, 0, 1800, 22000), axle(0, 1, 1200, 12000, { handbrakeTorque: 2500 })],
    centerDiff: 'open',
    maxSteer: 35,
    engine: {
      torque: [
        [800, 160],
        [2000, 210],
        [4000, 250],
        [5500, 230],
        [6500, 190],
      ],
      idleRpm: 800,
      maxRpm: 6500,
      inertia: 0.2,
      braking: 60,
    },
    gearbox: {
      gears: [3.6, 2.1, 1.4, 1.0, 0.8],
      reverse: 3.4,
      finalDrive: 3.9,
      clutchTorque: 400,
      upshift: 0.85,
      downshift: 0.4,
    },
  },
  sports: {
    mass: 1350,
    comHeight: 0.12,
    track: 1.62,
    wheelbase: 2.5,
    radius: 0.34,
    width: 0.26,
    wheelMass: 18,
    frequency: 2.2,
    damping: [0.45, 0.65],
    travel: [0.08, 0.1],
    tire: 'sport',
    body: [0.92, 0.3, 2.2],
    bodyY: 0.38,
    aeroDrag: 0.35,
    axles: [
      axle(1, 0, 2600, 30000),
      axle(0, 1, 1900, 20000, {
        handbrakeTorque: 3000,
        differential: 'limited-slip',
        torqueBias: 2.5,
        preload: 80,
      }),
    ],
    centerDiff: 'open',
    maxSteer: 32,
    engine: {
      torque: [
        [1000, 250],
        [3000, 380],
        [5500, 420],
        [7500, 360],
      ],
      idleRpm: 900,
      maxRpm: 7500,
      inertia: 0.15,
      braking: 70,
    },
    gearbox: {
      gears: [3.2, 2.2, 1.6, 1.25, 1.0, 0.84],
      reverse: 3.2,
      finalDrive: 3.6,
      clutchTorque: 650,
      upshift: 0.9,
      downshift: 0.45,
    },
  },
  pickup: {
    mass: 2100,
    comHeight: 0.38,
    track: 1.7,
    wheelbase: 3.3,
    radius: 0.39,
    width: 0.26,
    wheelMass: 30,
    frequency: 1.4,
    damping: [0.4, 0.6],
    travel: [0.15, 0.18],
    tire: 'road',
    body: [0.98, 0.5, 2.7],
    bodyY: 0.65,
    aeroDrag: 0.6,
    axles: [axle(1, 0, 2600, 18000), axle(0, 1, 1800, 8000, { handbrakeTorque: 3500 })],
    centerDiff: 'open',
    maxSteer: 36,
    engine: {
      torque: [
        [700, 300],
        [2500, 430],
        [4200, 400],
        [5500, 330],
      ],
      idleRpm: 700,
      maxRpm: 5500,
      inertia: 0.3,
      braking: 80,
    },
    gearbox: {
      gears: [3.5, 2.2, 1.5, 1.0, 0.75],
      reverse: 3.3,
      finalDrive: 3.7,
      clutchTorque: 650,
      upshift: 0.85,
      downshift: 0.42,
    },
  },
  offroad: {
    mass: 2000,
    comHeight: 0.38,
    track: 1.62,
    wheelbase: 2.8,
    radius: 0.4,
    width: 0.27,
    wheelMass: 32,
    frequency: 1.3,
    damping: [0.4, 0.6],
    travel: [0.2, 0.24],
    tire: 'offroad',
    body: [0.92, 0.55, 2.3],
    bodyY: 0.7,
    aeroDrag: 0.65,
    axles: [axle(1, 0.4, 2400, 12000), axle(0, 0.6, 1800, 6000, { handbrakeTorque: 3500 })],
    centerDiff: 'limited-slip',
    maxSteer: 36,
    engine: {
      torque: [
        [700, 320],
        [2000, 450],
        [3800, 420],
        [5000, 340],
      ],
      idleRpm: 700,
      maxRpm: 5000,
      inertia: 0.3,
      braking: 80,
    },
    gearbox: {
      gears: [4.2, 2.6, 1.7, 1.2, 0.95],
      reverse: 4.0,
      finalDrive: 4.1,
      clutchTorque: 700,
      upshift: 0.85,
      downshift: 0.45,
    },
  },
  van: {
    mass: 2400,
    comHeight: 0.45,
    track: 1.72,
    wheelbase: 3.4,
    radius: 0.36,
    width: 0.24,
    wheelMass: 26,
    frequency: 1.5,
    damping: [0.4, 0.6],
    travel: [0.13, 0.16],
    tire: 'road',
    body: [0.98, 0.95, 2.6],
    bodyY: 1.0,
    aeroDrag: 0.85,
    axles: [axle(1, 1, 2800, 20000), axle(0, 0, 2000, 10000, { handbrakeTorque: 3500 })],
    centerDiff: 'open',
    maxSteer: 38,
    engine: {
      torque: [
        [800, 260],
        [2000, 340],
        [4000, 310],
        [5000, 270],
      ],
      idleRpm: 750,
      maxRpm: 5000,
      inertia: 0.25,
      braking: 70,
    },
    gearbox: {
      gears: [3.8, 2.2, 1.45, 1.05, 0.8],
      reverse: 3.6,
      finalDrive: 4.0,
      clutchTorque: 550,
      upshift: 0.85,
      downshift: 0.42,
    },
  },
  truck: {
    mass: 7500,
    comHeight: 0.7,
    track: 1.95,
    wheelbase: 4.6,
    radius: 0.5,
    width: 0.3,
    wheelMass: 80,
    frequency: 1.3,
    damping: [0.4, 0.6],
    travel: [0.14, 0.18],
    tire: 'road',
    body: [1.2, 1.4, 3.8],
    bodyY: 1.5,
    aeroDrag: 1.6,
    axles: [axle(1, 0, 7000, 60000), axle(0, 1, 8000, 40000, { handbrakeTorque: 12000 })],
    centerDiff: 'open',
    maxSteer: 40,
    engine: {
      torque: [
        [650, 700],
        [1500, 1100],
        [2400, 950],
        [3000, 750],
      ],
      idleRpm: 650,
      maxRpm: 3000,
      inertia: 1.2,
      braking: 250,
    },
    gearbox: {
      gears: [6.0, 3.8, 2.4, 1.6, 1.15, 0.82],
      reverse: 5.5,
      finalDrive: 4.1,
      clutchTorque: 1800,
      upshift: 0.88,
      downshift: 0.5,
    },
  },
  bus: {
    mass: 12000,
    comHeight: 0.8,
    track: 2.1,
    wheelbase: 6,
    radius: 0.52,
    width: 0.3,
    wheelMass: 90,
    frequency: 1.2,
    damping: [0.4, 0.6],
    travel: [0.12, 0.16],
    tire: 'road',
    body: [1.28, 1.5, 6],
    bodyY: 1.6,
    aeroDrag: 2.2,
    axles: [axle(1, 0, 10000, 80000), axle(0, 1, 12000, 60000, { handbrakeTorque: 20000 })],
    centerDiff: 'open',
    maxSteer: 42,
    engine: {
      torque: [
        [600, 900],
        [1300, 1500],
        [2100, 1300],
        [2600, 1000],
      ],
      idleRpm: 600,
      maxRpm: 2600,
      inertia: 1.8,
      braking: 350,
    },
    gearbox: {
      gears: [5.5, 3.3, 2.1, 1.4, 1.0, 0.8],
      reverse: 5.0,
      finalDrive: 4.9,
      clutchTorque: 2500,
      upshift: 0.88,
      downshift: 0.45,
    },
  },
}
