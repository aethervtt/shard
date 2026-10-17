import { defineSchema, type Infer, ShardError, t } from '@aethervtt/shard-core'

/** Portable, deterministic signal probe plan. Asset IDs are local to the plan. */
export const AudioPreviewPlan = defineSchema('audio/PreviewPlan', {
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
  if (plan.duration + plan.tailSeconds > 60 || plan.voices.length > 4096 || plan.clips.length > 256)
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
