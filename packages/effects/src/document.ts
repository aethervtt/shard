import { defineDataType } from '@aethervtt/shard-assets'
import { type Infer, ShardError, t } from '@aethervtt/shard-core'

export function effectError(message: string, path = '', code = 'invalid-sequence'): never {
  throw new ShardError(`effects/${code}`, message, { path })
}

export const EffectTrack = t.struct({
  id: t.string({ required: true }),
  kind: t.enum(['property', 'animation', 'particles', 'audio', 'marker']),
  target: t.string(),
  path: t.string(),
  start: t.f64({ min: 0 }),
  duration: t.f64({ min: 0 }),
  component: t.string(),
  field: t.string(),
  from: t.list(t.f64()),
  to: t.list(t.f64()),
  easing: t.enum(['linear', 'smoothstep']),
  parameter: t.string(),
  animation: t.handle('AnimationClip'),
  particles: t.handle('ParticleEffect'),
  audio: t.handle('audio/AudioEvent'),
  marker: t.string(),
})

export const EffectSequence = defineDataType(
  'effects/EffectSequence',
  {
    duration: t.f64({ required: true, min: 0.000001, max: 3600 }),
    parameters: t.list(
      t.struct({
        id: t.string({ required: true }),
        value: t.f64({ default: 1 }),
        min: t.f64({ default: -1e6 }),
        max: t.f64({ default: 1e6 }),
      }),
    ),
    targets: t.list(t.struct({ id: t.string({ required: true }), prefab: t.handle('Prefab') })),
    tracks: t.list(EffectTrack),
  },
  {
    extension: 'effect-sequence',
    description: 'Coordinated presentation with host-bound targets and owned prefab lifetimes.',
    lazyDependencies: true,
    validate: (v) => validateEffect(v as EffectDocument),
  },
)

export type EffectDocument = Infer<typeof EffectSequence>
export type EffectTrackValue = EffectDocument['tracks'][number]

function names(items: { id: string }[], path: string, max: number): Set<string> {
  if (items.length > max) effectError(`At most ${max} entries`, path)
  const ids = new Set<string>()
  items.forEach((item, i) => {
    if (!/^[A-Za-z][\w-]*$/.test(item.id) || ids.has(item.id))
      effectError('IDs must be unique identifiers beginning with a letter', `${path}/${i}/id`)
    ids.add(item.id)
  })
  return ids
}

export function validateEffect(v: EffectDocument): void {
  const targets = names(v.targets, '/targets', 128)
  const parameters = names(v.parameters, '/parameters', 64)
  names(v.tracks, '/tracks', 512)
  for (let i = 0; i < v.parameters.length; i++) {
    const p = v.parameters[i]!
    if (p.min > p.max || p.value < p.min || p.value > p.max)
      effectError('Parameter default must be within min/max', `/parameters/${i}`)
  }
  for (let i = 0; i < v.tracks.length; i++) {
    const a = v.tracks[i]!,
      path = `/tracks/${i}`
    if (
      a.start + a.duration > v.duration + 1e-9 ||
      (a.kind === 'marker' ? a.duration !== 0 : a.duration <= 0)
    )
      effectError('Track must fit inside the sequence; only markers have zero duration', path)
    if (a.kind === 'marker') {
      if (!a.marker) effectError('Marker needs a name', `${path}/marker`)
      continue
    }
    if (!targets.has(a.target)) effectError('Unknown target', `${path}/target`)
    if (a.path.split('/').some((p) => p === '..' || p === '.'))
      effectError('Use a relative child path', `${path}/path`)
    if (a.kind === 'property') {
      if (
        !a.component ||
        !a.field ||
        !a.from.length ||
        a.from.length > 4 ||
        a.from.length !== a.to.length
      )
        effectError(
          'Property needs component/field and matching numeric endpoints (1–4 values)',
          path,
        )
      if (a.parameter && !parameters.has(a.parameter))
        effectError('Unknown parameter', `${path}/parameter`)
    } else if (!a[a.kind]) effectError(`Missing ${a.kind} asset`, `${path}/${a.kind}`)
    if (
      (a.kind === 'animation' || a.kind === 'particles') &&
      !v.targets.find((t) => t.id === a.target)!.prefab
    )
      effectError('Animation and particles require an owned prefab target', `${path}/target`)
    for (let j = 0; j < i; j++) {
      const b = v.tracks[j]!
      if (
        a.target !== b.target ||
        a.path !== b.path ||
        a.start >= b.start + b.duration - 1e-9 ||
        b.start >= a.start + a.duration - 1e-9
      )
        continue
      if (
        (a.kind === b.kind && (a.kind === 'animation' || a.kind === 'particles')) ||
        (a.kind === 'property' &&
          b.kind === 'property' &&
          a.component === b.component &&
          a.field === b.field)
      )
        effectError(`Overlaps track ${b.id}`, path)
    }
  }
}

export function parseEffect(value: unknown): EffectDocument {
  const errors = EffectSequence.validate(value)
  if (errors.length)
    throw new ShardError('effects/invalid-sequence', errors[0]!.message, {
      path: errors[0]!.path,
      details: errors,
    })
  const document = EffectSequence.deserialize(value)
  validateEffect(document)
  return document
}
