import { defineSystem, ShardError, t, Update } from '@aethervtt/shard-core'
import {
  addRenderFeatures,
  defineMaterial,
  Gpu,
  registerShaders,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin, type Plugin, Time } from '@aethervtt/shard-runtime'
import { Card, CardDefinition, CardInteraction, CardTilt } from './definition'
import { builtinCardFinishes, type CardFinish } from './finishes'
import { cardShader } from './shader'
import { Cards, CardTableState } from './table'
import type { CardTexturePage } from './textures'

export interface CardsPluginOptions {
  art: CardTexturePage
  masks: CardTexturePage
  /** Scene-lit PBR by default; unlit is an explicit presentation mode. */
  lighting?: 'pbr' | 'unlit'
  finishes?: readonly CardFinish[]
  capacity?: number
  textureBudgetMiB?: number
}

const updateCards = defineSystem({
  name: 'cards/update',
  run: (_, world) => {
    const time = world.resource(Time)
    world.resource(Cards).update(time.delta, time.elapsed)
  },
})

export function cardsPlugin(options: CardsPluginOptions): Plugin {
  const finishes = [...builtinCardFinishes(), ...(options.finishes ?? [])]
  if (new Set(finishes.map((f) => f.name)).size !== finishes.length) {
    throw new ShardError(
      'cards/duplicate-finish',
      'Finish names must be unique within a card table',
    )
  }
  const lighting = options.lighting ?? 'pbr'
  let hash = 2166136261
  const signature = JSON.stringify([
    lighting,
    finishes.map((f) => [f.name, f.options.surface, f.options.response, f.keys]),
  ])
  for (let i = 0; i < signature.length; i++)
    hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619)
  const suffix = (hash >>> 0).toString(16)
  const name = `CardSurface${suffix}`
  return definePlugin({
    name: 'cards',
    dependencies: ['render/forward'],
    provides: [Card, CardDefinition, CardInteraction, CardTilt, Cards],
    build(app) {
      app.world.initResource(CardDefinition.store)
      addRenderFeatures(app.world, {
        name: 'cards/finishes',
        description: 'Instanced two-sided cards with independently masked foil finishes.',
        nodes: [],
        baseline: {
          strategy:
            'Texture arrays and texture-backed instance records in the shared forward path.',
        },
      })
      app.addSystems(Update, updateCards)
    },
    ready(app) {
      const baseline = app.world.resource(Gpu).tier === 'baseline'
      const shaderFinishes = baseline
        ? finishes.map((f) =>
            f.options.baseline === 'unsupported'
              ? {
                  ...f,
                  options: { ...f.options, surface: 'return base;', response: 'return current;' },
                }
              : f,
          )
        : finishes
      const type = defineMaterial(`cards/${name}`, {
        extends: lighting === 'pbr' ? 'standard' : 'none',
        // Card art/finish arrays supply the surface; unused standard texture slots cost no bindings.
        standardTextures: false,
        blend: 'opaque',
        shader: `cards::surface_${suffix}`,
        plugin: 'cards',
        fields: {
          art: t.handle('Texture'),
          masks: t.handle('Texture'),
          records: t.handle('Texture'),
          luminance: t.f32({ default: 1.2 }),
          gloss: t.f32({ default: 0.35 }),
          maskView: t.f32(),
          clock: t.f32(),
          automaticClock: t.f32(),
          light: t.vec4({ default: [-0.4, 0.6, 1, 0] }),
        },
        arrays: ['art', 'masks'],
        colors: ['art'],
      })
      registerShaders(app.world.resource(Shaders), {
        [`cards::surface_${suffix}`]: cardShader(shaderFinishes, type.modulePath, name, lighting),
      })
      app.world.insertResource(
        Cards,
        new CardTableState(
          app.world,
          finishes,
          type,
          options.art,
          options.masks,
          options.capacity,
          options.textureBudgetMiB,
        ),
      )
    },
    dispose(app) {
      app.world.tryResource(Cards)?.dispose()
    },
  })
}
