import { Last } from '@aethervtt/shard-core'
import {
  addRenderFeatures,
  Gpu,
  Graph,
  RenderDescribers,
  RenderSet,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import * as componentsModule from './components'
import * as importerModule from './importer'
import { Fonts } from './importer'
import * as localeModule from './locale'
import { installLocalization } from './locale'
import * as previewModule from './preview'
import * as renderModule from './render'
import {
  describeText,
  prepareTexts,
  screenTextNode,
  TextRenderer,
  TextStore,
  textNode,
} from './render'
import { TEXT_SHADERS } from './shaders'

/** Text and ScreenText: MSDF glyphs in the world (after transparent 3D) and over the image. */
export const textPlugin = definePlugin({
  name: 'text',
  provides: [componentsModule, importerModule, localeModule, previewModule, renderModule],
  dependencies: ['render/forward'],
  build(app) {
    app.world.initResource(Fonts)
    installLocalization(app)
    app.addSystems(Last, prepareTexts.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const world = app.world
    app.insertResource(TextRenderer, new TextStore(world.resource(Gpu)))
    const shaders = world.resource(Shaders)
    for (const [path, source] of Object.entries(TEXT_SHADERS))
      shaders.register(path, source, `engine:${path}`)
    const graph = world.resource(Graph)
    addRenderFeatures(world, {
      name: 'text',
      description: 'MSDF text in the world and on screen.',
      nodes: ['text', 'text/screen'],
      baseline: { strategy: 'Glyph and text records in data textures' },
    })
    graph.addNode('text', textNode(world))
    graph.addNode('text/screen', screenTextNode(world))
    world.initResource(RenderDescribers).set('text', (w) => describeText(w))
  },
})
