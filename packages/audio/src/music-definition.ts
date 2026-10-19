import { defineDataType } from '@aethervtt/shard-assets'
import { type Infer, ShardError, t } from '@aethervtt/shard-core'
import {
  AudioCurveFields,
  AudioParameterFields,
  validateCurve,
  validateParameters,
} from './parameters'

export const MUSIC_PPQ = 960
export const MusicProgram = defineDataType(
  'audio/MusicProgram',
  {
    bpm: t.f64({ default: 120, min: 10, max: 400 }),
    numerator: t.u8({ default: 4, min: 1, max: 32 }),
    denominator: t.u8({ default: 4 }),
    entry: t.string({ required: true }),
    parameters: t.list(t.struct(AudioParameterFields)),
    globals: t.handle('audio/AudioParameters'),
    sections: t.list(
      t.struct({
        id: t.string({ required: true }),
        bars: t.u32({ default: 4, min: 1, max: 4096 }),
        markers: t.list(t.struct({ id: t.string({ required: true }), tick: t.u32() })),
        stems: t.list(
          t.struct({
            id: t.string({ required: true }),
            clip: t.handle('AudioClip', { required: true }),
            startSample: t.u32(),
            endSample: t.u32({ required: true }),
            rateConform: t.bool(),
            maxConformCents: t.f64({ default: 1, min: 0, max: 25 }),
            gainDb: t.f64({ min: -120, max: 12 }),
            bus: t.string({ default: 'music' }),
            curves: t.list(t.struct(AudioCurveFields)),
          }),
        ),
      }),
    ),
    transitions: t.list(
      t.struct({
        id: t.string({ required: true }),
        from: t.string({ required: true }),
        to: t.string({ required: true }),
        parameter: t.string(),
        min: t.f64({ default: -1e30 }),
        max: t.f64({ default: 1e30 }),
        priority: t.i32(),
        quantize: t.string({ default: 'bar' }),
        entryMarker: t.string(),
        fadeBeats: t.f64({ default: 1, min: 0, max: 128 }),
        curve: t.enum(['equal-power', 'linear']),
        reenter: t.bool(),
      }),
    ),
    stingers: t.list(
      t.struct({
        id: t.string({ required: true }),
        event: t.handle('audio/AudioEvent', { required: true }),
        cooldown: t.f64({ min: 0 }),
        overlap: t.enum(['reject', 'allow', 'replace']),
      }),
    ),
  },
  {
    extension: 'audio-music',
    lazyDependencies: true,
    validate: (value) => validateMusicProgram(value as MusicProgramDefinition),
  },
)
export type MusicProgramDefinition = Infer<typeof MusicProgram>
type SectionDefinition = MusicProgramDefinition['sections'][number]

export function musicBarTicks(
  program: Pick<MusicProgramDefinition, 'numerator' | 'denominator'>,
): number {
  return (MUSIC_PPQ * program.numerator * 4) / program.denominator
}
export function musicTimeAtTick(
  epoch: number,
  tick: number,
  bpm: number,
  sampleRate: number,
): number {
  return Math.round((epoch + ((tick / MUSIC_PPQ) * 60) / bpm) * sampleRate) / sampleRate
}
export function validateMusicProgram(program: MusicProgramDefinition): void {
  validateParameters(program.parameters)
  if (![1, 2, 4, 8, 16, 32].includes(program.denominator))
    throw new ShardError('audio/music-invalid', 'Unsupported meter denominator', {
      path: '/denominator',
    })
  if (!program.sections.length || program.sections.length > 64)
    throw new ShardError('audio/music-invalid', 'Programs require 1–64 sections')
  if (program.transitions.length > 256 || program.stingers.length > 64)
    throw new ShardError(
      'audio/music-capacity',
      'Programs support 256 transition rules and 64 stingers',
    )
  const sections = new Map<string, SectionDefinition>()
  for (const section of program.sections) {
    if (!section.id || sections.has(section.id))
      throw new ShardError('audio/music-invalid', 'Section IDs must be unique')
    sections.set(section.id, section)
    if (!section.stems.length || section.stems.length > 16)
      throw new ShardError('audio/music-invalid', 'Sections require 1–16 stems')
    const ids = new Set<string>()
    for (const stem of section.stems) {
      if (!stem.id || ids.has(stem.id) || !stem.clip || stem.endSample <= stem.startSample)
        throw new ShardError('audio/music-invalid', 'Invalid stem ID, reference or sample range', {
          path: `/sections/${section.id}/stems/${stem.id}`,
        })
      ids.add(stem.id)
      for (const curve of stem.curves) {
        validateCurve(curve.points, '/curves')
        if (
          curve.property !== 'gainDb' ||
          (!program.globals && !program.parameters.some((p) => p.name === curve.parameter))
        )
          throw new ShardError(
            'audio/music-invalid',
            'Stem curves must map a program parameter to gainDb',
          )
      }
    }
    ids.clear()
    for (const marker of section.markers) {
      if (!marker.id || ids.has(marker.id) || marker.tick >= section.bars * musicBarTicks(program))
        throw new ShardError('audio/music-invalid', 'Invalid marker ID or position')
      ids.add(marker.id)
    }
  }
  if (!sections.has(program.entry))
    throw new ShardError('audio/music-invalid', 'Entry section is missing')
  const ids = new Set<string>()
  for (const transition of program.transitions) {
    const from = sections.get(transition.from),
      to = sections.get(transition.to)
    if (
      !from ||
      !to ||
      !transition.id ||
      ids.has(transition.id) ||
      transition.min > transition.max ||
      (transition.parameter &&
        !program.globals &&
        !program.parameters.some((p) => p.name === transition.parameter)) ||
      (!['immediate', 'beat', 'bar'].includes(transition.quantize) &&
        !from.markers.some((m) => m.id === transition.quantize)) ||
      (transition.entryMarker && !to.markers.some((m) => m.id === transition.entryMarker))
    )
      throw new ShardError('audio/music-invalid', 'Invalid transition', {
        path: `/transitions/${transition.id}`,
      })
    ids.add(transition.id)
  }
  ids.clear()
  for (const stinger of program.stingers) {
    if (!stinger.id || ids.has(stinger.id) || !stinger.event)
      throw new ShardError('audio/music-invalid', 'Invalid stinger')
    ids.add(stinger.id)
  }
}
