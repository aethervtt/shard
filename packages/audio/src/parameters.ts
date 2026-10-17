import { defineDataType } from '@aethervtt/shard-assets'
import { type InferFields, ShardError, t } from '@aethervtt/shard-core'
import { audioNumber } from './validation'

export const AudioParameterFields = {
  name: t.string({ required: true }),
  kind: t.enum(['continuous', 'discrete', 'label']),
  min: t.f64({ default: 0 }),
  max: t.f64({ default: 1 }),
  initial: t.f64({ default: 0 }),
  labels: t.list(t.string()),
  smooth: t.f64({ min: 0 }),
  readonly: t.bool(),
}
export type AudioParameterDefinition = InferFields<typeof AudioParameterFields>

export function validateParameters(parameters: readonly AudioParameterDefinition[]): void {
  if (parameters.length > 64)
    throw new ShardError('audio/capacity', 'At most 64 parameters per scope')
  const names = new Set<string>()
  for (let i = 0; i < parameters.length; i++) {
    const p = parameters[i]!,
      path = `/parameters/${i}`
    if (!p.name || names.has(p.name) || p.name === 'distance' || p.name === 'speed')
      throw new ShardError(
        'audio/unknown-parameter',
        'Parameter names must be unique, nonempty, and not reserved distance/speed inputs',
        { path },
      )
    names.add(p.name)
    audioNumber(p.min, `${path}/min`, -Number.MAX_VALUE)
    audioNumber(p.smooth, `${path}/smooth`)
    if (p.kind === 'discrete' && (!Number.isInteger(p.min) || !Number.isInteger(p.max)))
      throw new ShardError('audio/invalid-range', 'Discrete bounds must be integers', { path })
    audioNumber(p.max, `${path}/max`, p.min)
    if (p.kind === 'label') {
      if (!p.labels.length || new Set(p.labels).size !== p.labels.length)
        throw new ShardError('audio/unknown-parameter', 'Labels must be nonempty and unique', {
          path,
        })
      audioNumber(p.initial, `${path}/initial`, 0, p.labels.length - 1)
    } else audioNumber(p.initial, `${path}/initial`, p.min, p.max)
    if (p.kind !== 'continuous' && (!Number.isInteger(p.initial) || p.smooth !== 0)) {
      throw new ShardError(
        'audio/invalid-range',
        'Discrete/label parameters use integer defaults and no smoothing',
        { path },
      )
    }
  }
}

export const AudioParameters = defineDataType(
  'audio/AudioParameters',
  {
    parameters: t.list(t.struct(AudioParameterFields)),
  },
  {
    extension: 'audio-parameters',
    validate: (value) => validateParameters(value.parameters as AudioParameterDefinition[]),
  },
)

/** Names resolve at preparation/command boundaries. Updates only touch reusable numeric storage. */
export class AudioParameterBank {
  readonly definitions: readonly AudioParameterDefinition[]
  readonly indices = new Map<string, number>()
  readonly values: Float64Array
  readonly targets: Float64Array
  constructor(definitions: readonly AudioParameterDefinition[]) {
    validateParameters(definitions)
    this.definitions = definitions
    this.values = new Float64Array(definitions.length)
    this.targets = new Float64Array(definitions.length)
    for (let i = 0; i < definitions.length; i++) {
      this.indices.set(definitions[i]!.name, i)
      this.values[i] = this.targets[i] = definitions[i]!.initial
    }
  }

  index(name: string): number {
    const index = this.indices.get(name)
    if (index === undefined)
      throw new ShardError('audio/unknown-parameter', `Unknown parameter ${name}`, {
        path: name,
        hint: 'Declare the parameter in the event or its global parameter asset.',
      })
    return index
  }

  encode(index: number, value: number | string): number {
    const def = this.definitions[index]!
    if (def.kind === 'label') {
      const encoded = typeof value === 'string' ? def.labels.indexOf(value) : value
      if (!Number.isInteger(encoded) || encoded < 0 || encoded >= def.labels.length)
        throw new ShardError('audio/unknown-parameter', `Invalid label for ${def.name}`)
      return encoded
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (def.kind === 'discrete' && !Number.isInteger(value))
    ) {
      throw new ShardError('audio/invalid-range', `Invalid value for ${def.name}`)
    }
    return Math.max(def.min, Math.min(def.max, value))
  }

  set(name: string, value: number | string): void {
    const index = this.index(name),
      def = this.definitions[index]!
    if (def.readonly) throw new ShardError('audio/unknown-parameter', `${name} is read-only`)
    this.targets[index] = this.encode(index, value)
    if (def.smooth === 0) this.values[index] = this.targets[index]!
  }

  update(delta: number): void {
    for (let i = 0; i < this.values.length; i++) {
      const tau = this.definitions[i]!.smooth
      this.values[i] =
        tau > 0 && Math.abs(this.targets[i]! - this.values[i]!) > 1e-7
          ? this.values[i]! + (this.targets[i]! - this.values[i]!) * (1 - Math.exp(-delta / tau))
          : this.targets[i]!
    }
  }
}

export const AudioCurveFields = {
  parameter: t.string({ required: true }),
  property: t.enum(['gainDb', 'pitchSemitones', 'lowpass', 'highpass']),
  points: t.list(t.vec2),
}
export type AudioCurve = InferFields<typeof AudioCurveFields>

export function validateCurve(points: readonly (readonly number[])[], path: string): void {
  if (points.length < 1 || points.length > 128)
    throw new ShardError('audio/invalid-event', 'Curves need 1–128 points', { path })
  for (let i = 0; i < points.length; i++) {
    audioNumber(points[i]![0]!, path, -Number.MAX_VALUE)
    audioNumber(points[i]![1]!, path, -Number.MAX_VALUE)
    if (i && points[i]![0]! <= points[i - 1]![0]!)
      throw new ShardError('audio/invalid-event', 'Curve x values must strictly increase', { path })
  }
}

export function sampleAudioCurve(
  points: Float64Array,
  x: number,
  out: Float64Array,
  slot: number,
): void {
  if (x <= points[0]!) {
    out[slot] = points[1]!
    return
  }
  for (let i = 2; i < points.length; i += 2)
    if (x <= points[i]!) {
      const weight = (x - points[i - 2]!) / (points[i]! - points[i - 2]!)
      out[slot] = points[i - 1]! + (points[i + 1]! - points[i - 1]!) * weight
      return
    }
  out[slot] = points[points.length - 1]!
}
