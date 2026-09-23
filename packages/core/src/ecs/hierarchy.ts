import { defineComponent } from '../schema/component'
import { t } from '../schema/field'

export const ChildOf = defineComponent(
  'core/ChildOf',
  { parent: t.entity({ description: 'The parent entity.' }) },
  { description: 'Makes this entity a child of another. Despawning the parent despawns it.' },
)

export const Children = defineComponent(
  'core/Children',
  {
    entities: t.list(t.entity, {
      readonly: true,
      description: 'Maintained automatically from ChildOf. Do not write.',
    }),
  },
  {
    description: 'The direct children of this entity, in insertion order. Derived from ChildOf.',
    serialize: false,
  },
)
