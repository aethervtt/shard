import { defineComponent, defineResource, onAdd, t, type World } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'
import { warnFeatureMissing } from './features'

const presentation = {
  playing: t.bool({ default: true }),
  paused: t.bool(),
  opacity: t.f32({ default: 1, min: 0, max: 1 }),
  color: t.color({ default: [1, 1, 1, 1] }),
  texture: t.handle('Texture'),
  blend: t.enum(['alpha', 'additive']),
  layers: t.u16({ default: 1 }),
}
const ribbon = {
  ...presentation,
  width: t.f32({ default: 0.1, min: 0, max: 1000 }),
  endColor: t.color({ default: [1, 1, 1, 0] }),
  widthCurve: t.list(
    t.struct({ at: t.f32({ min: 0, max: 1 }), value: t.f32({ min: 0, max: 16 }) }),
  ),
  repeat: t.f32({ default: 1, min: 0.0001, max: 10000 }),
  scroll: t.f32({ min: -10000, max: 10000 }),
}
export const Trail = defineComponent(
  'render/Trail',
  {
    ...ribbon,
    offset: t.vec3(),
    lifetime: t.f32({ default: 0.5, min: 0.001, max: 3600 }),
    capacity: t.u16({ default: 64, min: 2, max: 256 }),
    minDistance: t.f32({ default: 0.01, min: 0.00001, max: 1000 }),
    breakDistance: t.f32({ default: 10, min: 0.001, max: 1e6 }),
  },
  {
    requires: [Transform],
    description:
      'World-space ribbon history of this entity/bone; stops emitting when playing is false and drains by lifetime (0082).',
  },
)
export const Beam = defineComponent(
  'render/Beam',
  {
    ...ribbon,
    start: t.vec3(),
    end: t.vec3({ default: [0, 0, -1] }),
    target: t.entity(),
    points: t.list(t.vec3()),
    segments: t.u16({ default: 16, min: 1, max: 255 }),
    noise: t.f32({ min: 0, max: 1000 }),
    seed: t.u32(),
  },
  {
    requires: [Transform],
    description:
      'Camera-facing beam between transformed endpoints, or along local points; deterministic seeded displacement (0082).',
  },
)
export const Decal = defineComponent(
  'render/Decal',
  {
    ...presentation,
    size: t.vec3({ default: [1, 1, 1] }),
    receiverMask: t.u16({ default: 1 }),
    maxAngle: t.f32({ default: 80, min: 0, max: 89.9 }),
    offset: t.f32({ default: 0.002, min: 0, max: 1 }),
    lifetime: t.f32({ min: 0, max: 86400 }),
    fadeOut: t.f32({ default: 1, min: 0, max: 86400 }),
    maxVertices: t.u32({ default: 12288, min: 3, max: 65535 }),
  },
  {
    requires: [Transform],
    description:
      'Box projection onto DecalReceiver rigid meshes: local XY is UV, projection along -Z. Zero lifetime persists (0083).',
  },
)
export const DecalReceiver = defineComponent(
  'render/DecalReceiver',
  {
    mask: t.u16({ default: 1 }),
  },
  { description: 'Eligible rigid Mesh3d surface for matching decal receiver masks (0083).' },
)
export const RibbonsPath = defineResource('render/RibbonsPath', { init: () => true })
export const DecalsPath = defineResource('render/DecalsPath', { init: () => true })
export function observeVfxWithoutPlugin(world: World): void {
  world.observe(onAdd(Trail), ({ world: w }) => {
    if (!w.hasResource(RibbonsPath))
      warnFeatureMissing(w, 'Trail', 'ribbonsPlugin', 'it draws no ribbon')
  })
  world.observe(onAdd(Beam), ({ world: w }) => {
    if (!w.hasResource(RibbonsPath))
      warnFeatureMissing(w, 'Beam', 'ribbonsPlugin', 'it draws no ribbon')
  })
  world.observe(onAdd(Decal), ({ world: w }) => {
    if (!w.hasResource(DecalsPath))
      warnFeatureMissing(w, 'Decal', 'decalsPlugin', 'it draws no decal')
  })
}
