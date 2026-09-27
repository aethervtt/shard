import { defineComponent, t } from '@aethervtt/shard-core'
import { Visibility } from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'

const lightFields = {
  color: t.color({ default: [1, 1, 1, 1], description: 'Light color (linear).' }),
  intensity: t.f32({
    default: 1,
    min: 0,
    description:
      'Sprite units: 1 shows a sprite it fully lights at its texture color. Above 1 overbrightens (and blooms).',
  }),
  radius: t.f32({
    default: 5,
    min: 0,
    unit: 'm',
    description: 'World units: the light reaches zero here.',
  }),
  falloff: t.f32({
    default: 2,
    min: 0,
    description: 'Exponent of the smooth window (1 − (d/radius)²)^falloff: higher is tighter.',
  }),
  height: t.f32({
    default: 1,
    min: 0,
    unit: 'm',
    description:
      'Height above the sprite plane, for normal maps: low grazes the surface, high lights it flat.',
  }),
  shadows: t.bool({ description: 'Cast shadows from LightOccluder2d shapes and occluding tiles.' }),
  softness: t.f32({
    default: 0.1,
    min: 0,
    unit: 'm',
    description:
      'Emitter size in world units: penumbras widen with distance from the occluder. 0: hard shadows.',
  }),
  layers: t.u32({
    default: 0xffffffff,
    description:
      'Which sprite layers it lights: bit k covers layers k×64 − 1024 to k×64 − 961. All bits: every layer.',
  }),
}

export const PointLight2d = defineComponent('sprite/PointLight2d', lightFields, {
  description:
    'A 2D light at the entity: lights sprites and tiles under a Lighting2d camera, with optional shadows.',
  requires: [Transform, Visibility],
})

export const SpotLight2d = defineComponent(
  'sprite/SpotLight2d',
  {
    ...lightFields,
    innerAngle: t.f32({
      default: 30,
      min: 0,
      max: 180,
      unit: 'deg',
      description: 'Half-angle of full brightness, from the entity’s +X.',
    }),
    outerAngle: t.f32({
      default: 45,
      min: 0,
      max: 180,
      unit: 'deg',
      description: 'Half-angle where the cone fades to zero.',
    }),
  },
  {
    description:
      'A 2D cone light pointing along the entity’s +X (rotate the entity to aim it), like a flashlight.',
    requires: [Transform, Visibility],
  },
)

export const Lighting2d = defineComponent(
  'sprite/Lighting2d',
  {
    ambient: t.color({
      default: [0.08, 0.08, 0.1, 1],
      description: 'Light every lit sprite gets without any light (linear).',
    }),
    ambientIntensity: t.f32({ default: 1, min: 0, description: 'Multiplies ambient.' }),
    maxLights: t.u16({ default: 256, min: 1, max: 1024, description: 'Visible lights per view.' }),
    maxShadowed: t.u16({
      default: 64,
      max: 64,
      description: 'Shadowed lights per view: the ones nearest the view center win.',
    }),
  },
  {
    description:
      'On a camera: lights the 2D world it sees with PointLight2d and SpotLight2d. Without it, sprites draw unlit.',
  },
)

export const SpriteLighting = defineComponent(
  'sprite/SpriteLighting',
  {
    normal: t.handle('Texture', {
      description:
        'Normal map for a plain texture sprite (atlas sprites use TextureAtlas.normals). Tangent space, +Y up.',
    }),
    emissive: t.f32({
      min: 0,
      description: 'Glow: × the sprite color, added after lighting (eyes, screens, embers).',
    }),
    normalStrength: t.f32({
      default: 1,
      min: 0,
      description: 'Scales the normal map’s tilt: 0 lights it flat.',
    }),
  },
  { description: 'Per-sprite lighting options: a normal map, emissive glow, normal strength.' },
)

export const OCCLUDER_SHAPES = ['box', 'circle', 'polygon', 'sprite', 'collider'] as const
export type OccluderShape = (typeof OCCLUDER_SHAPES)[number]

export const LightOccluder2d = defineComponent(
  'sprite/LightOccluder2d',
  {
    shape: t.enum(OCCLUDER_SHAPES, {
      description:
        "box: size. circle: size[0] is the radius. polygon: points. sprite: the sprite's alpha outline (atlas with outlines: true), else its rectangle. collider: the entity's physics/Collider (cuboid, ball, capsule, convex).",
    }),
    size: t.vec2({
      default: [1, 1],
      min: 0,
      unit: 'm',
      description: 'box: full size. circle: size[0] is the radius.',
    }),
    points: t.list(t.vec2, {
      description: 'polygon: local-space points, closed (the last joins the first).',
    }),
    lightPenetration: t.f32({
      default: 0.05,
      min: 0,
      unit: 'm',
      description:
        'How far light reaches into the occluder, so its own face toward the light stays lit.',
    }),
    layers: t.u32({
      default: 0xffffffff,
      description: 'Which lights it blocks, matching PointLight2d.layers.',
    }),
  },
  {
    description: 'Blocks 2D light: shadowed lights (shadows: true) cast shadows from its shape.',
    requires: [Transform],
  },
)

/** The light-layer bit of a sprite layer: bands of 64 layers from −1024. */
export function layerBit(layer: number): number {
  const band = Math.min(31, Math.max(0, (layer + 1024) >> 6))
  return (1 << band) >>> 0
}
