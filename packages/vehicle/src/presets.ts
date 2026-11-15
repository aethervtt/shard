import type { ASSIST_PRESETS } from './components'

type AssistFields = {
  abs: number
  tcs: number
  esc: number
  counterSteer: number
  driftGrip: number
  driftHold: number
  downforce: number
  airControl: [number, number, number]
  selfRight: boolean
  antiFlip: number
}

/** What `VehicleAssists.preset` writes (0118). `understeer` is the car's, so presets leave it. */
export const ASSIST_PRESET_VALUES: Record<
  Exclude<(typeof ASSIST_PRESETS)[number], 'custom'>,
  AssistFields
> = {
  sim: {
    abs: 1,
    tcs: 0.5,
    esc: 0,
    counterSteer: 0,
    driftGrip: 1,
    driftHold: 0,
    downforce: 0,
    airControl: [0, 0, 0],
    selfRight: false,
    antiFlip: 0,
  },
  arcade: {
    abs: 1,
    tcs: 1,
    esc: 0.6,
    counterSteer: 0.5,
    driftGrip: 0.6,
    driftHold: 0.5,
    downforce: 2,
    airControl: [1500, 1500, 800],
    selfRight: true,
    antiFlip: 0.5,
  },
}
