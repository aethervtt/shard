import { Last } from '@aethervtt/shard-core'
import { Gpu, Graph, RenderDescribers, RenderSet, Shaders } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Fonts } from './importer'
import { installLocalization } from './locale'
import {
  describeText,
  prepareTexts,
  screenTextNode,
  TextRenderer,
  TextStore,
  textNode,
} from './render'
import { TEXT_SHADERS } from './shaders'
import './preview'

/** Text and ScreenText: MSDF glyphs in the world (after transparent 3D) and over the image. */
export const textPlugin = definePlugin({
  name: 'text',
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
    graph.addNode('text', textNode(world))
    graph.addNode('text/screen', screenTextNode(world))
    world.initResource(RenderDescribers).set('text', (w) => describeText(w))
  },
})
