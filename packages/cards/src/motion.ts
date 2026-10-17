import { defineSchema, type Infer, t } from '@aethervtt/shard-core'

export const CardAutomaticMotion = defineSchema('cards/AutomaticMotion', {
  enabled: t.bool(),
  tilt: t.bool(),
  seconds: t.f32({ default: 4, min: 0.25, max: 60 }),
  range: t.f32({ default: 0.85, min: 0, max: 1 }),
  phase: t.f32({ min: 0, max: 1024 }),
})
export type CardAutomaticMotionValue = Infer<typeof CardAutomaticMotion>

/** Same integer waypoint generator and quintic interpolation as CARD_MOTION_WGSL. */
export function sampleCardMotion(
  time: number,
  seconds: number,
  range: number,
  phase: number,
  out: Float32Array,
): void {
  const position = time / seconds + phase
  const step = Math.floor(position)
  const t = position - step
  const ease = t * t * t * (t * (t * 6 - 15) + 10)
  let a = (Math.imul(step & 65535, 25173) + 13849) & 65535
  let b = (Math.imul((step + 1) & 65535, 25173) + 13849) & 65535
  const ax = a / 32767.5 - 1,
    bx = b / 32767.5 - 1
  a = (Math.imul(a, 25173) + 13849) & 65535
  b = (Math.imul(b, 25173) + 13849) & 65535
  out[0] = (ax + (bx - ax) * ease) * range
  out[1] = (a / 32767.5 - 1 + ((b - a) / 32767.5) * ease) * range
}

export const CARD_MOTION_WGSL = `
fn card_motion_point(step: u32) -> vec2f {
  let x = ((step & 65535u) * 25173u + 13849u) & 65535u;
  let y = (x * 25173u + 13849u) & 65535u;
  return vec2f(f32(x), f32(y)) / 32767.5 - vec2f(1.0);
}
fn card_motion(time: f32, seconds: f32, radius: f32, phase: f32) -> vec2f {
  let position = time / max(seconds, 0.25) + phase;
  let step = u32(floor(position));
  let t = fract(position);
  let ease = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  return mix(card_motion_point(step), card_motion_point(step + 1u), ease) * radius;
}
`
