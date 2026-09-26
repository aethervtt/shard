import { defineComponent, type Infer, t } from '@shard/core'

export const GlobalTransform = defineComponent(
  'core/GlobalTransform',
  {
    matrix: t.affine3x4({
      readonly: true,
      description:
        'World matrix (top three rows, row by row), relative to the floating origin. Computed from Transform each frame.',
    }),
  },
  {
    description:
      'World-space transform relative to the floating origin (the world origin when there is none). Computed by core/transform-propagate; do not write.',
    serialize: false,
  },
)

export const Transform = defineComponent(
  'core/Transform',
  {
    translation: t.vec3({ unit: 'm', description: 'Position relative to the parent (or world).' }),
    rotation: t.quat({ description: 'Rotation relative to the parent, as a unit quaternion.' }),
    scale: t.vec3({ default: [1, 1, 1], description: 'Scale along local axes.' }),
  },
  {
    description:
      'Local transform. Y is up, -Z is forward. In 2D, translation.z orders layers and rotation is around Z.',
    requires: [GlobalTransform],
  },
)

export type TransformValue = Infer<typeof Transform>
