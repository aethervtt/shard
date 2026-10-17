import { defineAssetSchema } from '@aethervtt/shard-assets'
import { defineResource, defineSchema, type Infer, ShardError, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'

/** Portable, deterministic signal probe plan. Asset IDs are local to the plan. */
export const AudioPreviewPlan = defineSchema('audio/PreviewPlan', {
  $schema: t.string(),
  duration: t.f64({ default: 5, min: 0.001, max: 60 }),
  tailSeconds: t.f64({ min: 0, max: 10 }),
  sampleRate: t.u32({ default: 48000, min: 8000, max: 96000 }),
  channels: t.u8({ default: 2, min: 1, max: 2 }),
  seed: t.u32({ default: 1 }),
  clips: t.list(
    t.struct({
      id: t.string({ required: true }),
      asset: t.handle('AudioClip', { required: true }),
    }),
  ),
  mixer: t.handle('audio/AudioMixer'),
  events: t.list(
    t.struct({
      id: t.string({ required: true }),
      asset: t.handle('audio/AudioEvent', { required: true }),
      at: t.f64({ min: 0 }),
      position: t.vec3(),
      parameters: t.json({ default: {} }),
      clock: t.enum(['simulation', 'realtime']),
      pitchLinked: t.bool(),
    }),
  ),
  music: t.list(
    t.struct({
      id: t.string({ required: true }),
      asset: t.handle('audio/MusicProgram', { required: true }),
      at: t.f64({ min: 0 }),
      section: t.string(),
      parameters: t.json({ default: {} }),
    }),
  ),
  controls: t.list(
    t.struct({
      at: t.f64({ min: 0 }),
      kind: t.enum([
        'event.parameter',
        'event.stop',
        'event.position',
        'global.parameter',
        'music.parameter',
        'music.section',
        'music.stinger',
        'music.pause',
        'music.resume',
        'music.seek',
        'snapshot.acquire',
        'snapshot.set',
        'snapshot.release',
        'bus.volume',
        'listener.position',
        'transport.pause',
      ]),
      target: t.string(),
      name: t.string(),
      value: t.json(),
      position: t.vec3(),
      options: t.json({ default: {} }),
      asset: t.handle('audio/AudioSnapshot'),
    }),
  ),
  voices: t.list(
    t.struct({
      id: t.string({ required: true }),
      clip: t.string({ required: true }),
      bus: t.string({ default: 'sfx' }),
      at: t.f64({ min: 0 }),
      duration: t.f64({ min: 0 }),
      offset: t.f64({ min: 0 }),
      loop: t.bool(),
      gainDb: t.f64({ min: -120, max: 24 }),
      pitch: t.f64({ default: 1, min: 0.01, max: 16 }),
      position: t.vec3(),
      spatial: t.bool(),
      minDistance: t.f64({ default: 1, min: 0.001 }),
      maxDistance: t.f64({ default: 100, min: 0.001 }),
    }),
  ),
  automation: t.list(
    t.struct({
      voice: t.string({ required: true }),
      property: t.enum(['gain', 'envelope', 'pitch', 'lowpass', 'highpass']),
      at: t.f64({ min: 0 }),
      value: t.f64(),
      duration: t.f64({ min: 0 }),
      curve: t.enum(['linear', 'exponential', 'equal-power-in', 'equal-power-out']),
    }),
  ),
})
export type AudioPreviewPlanValue = Infer<typeof AudioPreviewPlan>
export function validateAudioPreview(plan: AudioPreviewPlanValue): void {
  if (
    plan.duration + plan.tailSeconds > 60 ||
    plan.voices.length > 4096 ||
    plan.clips.length > 256 ||
    plan.events.length > 256 ||
    plan.music.length > 8 ||
    plan.controls.length > 4096
  )
    throw new ShardError('audio/preview-unavailable', 'Preview exceeds duration or resource bounds')
  const clips = new Set<string>(),
    voices = new Set<string>()
  for (const clip of plan.clips) {
    if (!clip.id || !clip.asset || clips.has(clip.id))
      throw new ShardError(
        'audio/preview-unavailable',
        'Clip IDs must be unique and reference assets',
      )
    clips.add(clip.id)
  }
  for (const voice of plan.voices) {
    if (
      !voice.id ||
      voices.has(voice.id) ||
      !clips.has(voice.clip) ||
      voice.maxDistance < voice.minDistance ||
      voice.at >= plan.duration
    )
      throw new ShardError('audio/preview-unavailable', 'Invalid preview voice')
    voices.add(voice.id)
  }
  const ids = new Set<string>()
  for (const item of [...plan.events, ...plan.music]) {
    if (!item.id || !item.asset || ids.has(item.id) || item.at >= plan.duration)
      throw new ShardError(
        'audio/preview-unavailable',
        'Authored preview IDs/references/times are invalid',
      )
    ids.add(item.id)
  }
  for (const control of plan.controls) {
    if (
      control.at >= plan.duration ||
      ((control.kind.startsWith('event.') || control.kind.startsWith('music.')) &&
        !ids.has(control.target))
    )
      throw new ShardError('audio/preview-unavailable', 'Preview control target/time is invalid')
  }
  for (const command of plan.automation)
    if (
      !voices.has(command.voice) ||
      command.at > plan.duration + plan.tailSeconds ||
      ((command.property === 'pitch' || command.property === 'lowpass') && command.value <= 0) ||
      ((command.property === 'gain' ||
        command.property === 'envelope' ||
        command.property === 'highpass') &&
        command.value < 0)
    )
      throw new ShardError('audio/preview-unavailable', 'Invalid preview automation')
}

/** Hosts inject rendering/filesystem access; engine packages remain host-neutral. */
export const AudioPreviewHost =
  defineResource<(plan: AudioPreviewPlanValue, out: string) => Promise<unknown>>(
    'audio/PreviewHost',
  )
export const audioPreviewSchema = defineAssetSchema('audio-preview.schema.json', () =>
  AudioPreviewPlan.jsonSchema(),
)
export const audioPreviewMethods: AppMethod[] = [
  {
    name: 'audio.preview',
    description:
      'Render a bounded offline WAV and measured signal evidence through the host. Requires a preview-capable host; never reports headless gain as measured signal.',
    params: defineSchema('audio/PreviewParams', {
      plan: t.struct(AudioPreviewPlan.fields),
      out: t.string({ default: 'mix.wav' }),
    }),
    handler: ({ world }, params) => {
      const host = world.tryResource(AudioPreviewHost)
      if (!host)
        throw new ShardError(
          'audio/preview-unavailable',
          'This host does not provide offline audio preview',
        )
      const plan = AudioPreviewPlan.deserialize(params.plan)
      validateAudioPreview(plan)
      return host(plan, params.out as string)
    },
  },
]
