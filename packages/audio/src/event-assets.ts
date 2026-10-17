import { defineDataType } from '@aethervtt/shard-assets'
import { type Infer, ShardError, t } from '@aethervtt/shard-core'
import {
  AudioCurveFields,
  AudioParameterFields,
  validateCurve,
  validateParameters,
} from './parameters'

export const AudioEventFields = {
  mode: t.enum(['oneshot', 'sustain']),
  parameters: t.list(t.struct(AudioParameterFields)),
  globals: t.handle('audio/AudioParameters'),
  bus: t.string({ default: 'sfx' }),
  maxInstances: t.u32({ default: 64, min: 1, max: 256 }),
  group: t.string(),
  scope: t.enum(['session', 'emitter']),
  policy: t.enum(['reject-new', 'steal-oldest', 'steal-quietest']),
  cooldown: t.f64({ min: 0 }),
  priority: t.u8({ default: 128 }),
  maxAge: t.f64({ default: 0.25, min: 0 }),
  blocked: t.enum(['drop', 'wait', 'restart']),
  layers: t.list(
    t.struct({
      id: t.string({ required: true }),
      selector: t.enum(['single', 'random', 'no-repeat', 'sequence', 'switch']),
      choices: t.list(
        t.struct({
          clip: t.handle('AudioClip', { required: true }),
          weight: t.f64({ default: 1, min: 0 }),
          label: t.string(),
          value: t.f64(),
        }),
      ),
      selectParameter: t.string(),
      defaultChoice: t.u32(),
      noRepeat: t.u32({ default: 1 }),
      trigger: t.enum(['start', 'while']),
      condition: t.struct({
        parameter: t.string(),
        min: t.f64({ default: -1e30 }),
        max: t.f64({ default: 1e30 }),
        label: t.string(),
      }),
      bus: t.string(),
      gainDb: t.f64({ default: 0, min: -120, max: 24 }),
      pitchSemitones: t.f64({ default: 0, min: -48, max: 48 }),
      pitchRandom: t.vec2({ default: [0, 0] }),
      gainRandom: t.vec2({ default: [0, 0] }),
      loop: t.bool(),
      loopPolicy: t.enum(['resume', 'restart']),
      delay: t.f64({ min: 0 }),
      duration: t.f64({ min: 0 }),
      attack: t.f64({ min: 0 }),
      release: t.f64({ default: 0.02, min: 0 }),
      spatial: t.bool(),
      minDistance: t.f64({ default: 1, min: 0.00001 }),
      maxDistance: t.f64({ default: 100, min: 0.00001 }),
      rolloff: t.enum(['inverse', 'linear', 'exponential']),
      rolloffFactor: t.f64({ default: 1, min: 0 }),
      panning: t.enum(['equal-power', 'hrtf']),
      curves: t.list(t.struct(AudioCurveFields)),
    }),
  ),
}

export const AudioEvent = defineDataType('audio/AudioEvent', AudioEventFields, {
  extension: 'audio-event',
  lazyDependencies: true,
  validate: (value) => validateAudioEvent(value as AudioEventDefinition),
})
export type AudioEventDefinition = Infer<typeof AudioEvent>
export type AudioEventLayer = AudioEventDefinition['layers'][number]

export function validateAudioEvent(event: AudioEventDefinition): void {
  validateParameters(event.parameters)
  if (!event.layers.length || event.layers.length > 16)
    throw new ShardError('audio/invalid-event', 'Events require 1–16 layers', { path: '/layers' })
  const names = new Set<string>()
  const local = new Set(event.parameters.map((parameter) => parameter.name))
  for (let i = 0; i < event.layers.length; i++) {
    const layer = event.layers[i]!,
      path = `/layers/${i}`
    if (!layer.id || names.has(layer.id))
      throw new ShardError('audio/invalid-event', 'Layer IDs must be unique and nonempty', { path })
    names.add(layer.id)
    if (
      !layer.choices.length ||
      layer.choices.some((choice) => !choice.clip) ||
      layer.choices.length > 128 ||
      !layer.choices.some((choice) => choice.weight > 0)
    ) {
      throw new ShardError(
        'audio/invalid-event',
        'Selectors require 1–128 choices with positive total weight',
        { path },
      )
    }
    if (layer.selector === 'no-repeat' && layer.noRepeat >= layer.choices.length)
      throw new ShardError(
        'audio/invalid-event',
        'No-repeat window must be smaller than the choice pool',
        { path },
      )
    if (layer.defaultChoice >= layer.choices.length)
      throw new ShardError(
        'audio/invalid-event',
        'Switch default must reference an existing choice',
        { path },
      )
    if (layer.selector === 'switch' && !layer.selectParameter)
      throw new ShardError('audio/unknown-parameter', 'Switch needs selectParameter', { path })
    if (layer.loop && event.mode === 'oneshot' && !layer.duration)
      throw new ShardError(
        'audio/invalid-event',
        'One-shot looping layers require a finite duration',
        { path },
      )
    if (
      layer.maxDistance < layer.minDistance ||
      layer.pitchRandom[0] > layer.pitchRandom[1] ||
      layer.gainRandom[0] > layer.gainRandom[1] ||
      layer.condition.max < layer.condition.min
    )
      throw new ShardError('audio/invalid-range', 'Range endpoints must be ordered', { path })
    for (const curve of layer.curves) {
      validateCurve(curve.points, `${path}/curves`)
      if (
        !local.has(curve.parameter) &&
        !event.globals &&
        !['distance', 'speed'].includes(curve.parameter)
      ) {
        throw new ShardError(
          'audio/unknown-parameter',
          `Unknown curve parameter ${curve.parameter}`,
          { path },
        )
      }
    }
  }
}

export const AudioCollection = defineDataType(
  'audio/AudioCollection',
  {
    events: t.list(t.handle('audio/AudioEvent')),
    clips: t.list(t.handle('AudioClip')),
  },
  {
    extension: 'audio-collection',
    lazyDependencies: true,
    validate(value) {
      const entries = [...(value.events as unknown[]), ...(value.clips as unknown[])]
      if (entries.some((entry) => !entry))
        throw new ShardError('audio/invalid-collection', 'Collection references cannot be null')
    },
  },
)
