import { Last, Update } from '@shard/core'
import { Gpu, Graph, Picking, RenderDescribers, RenderSet, Shaders } from '@shard/render'
import { definePlugin } from '@shard/runtime'
import { TextureAtlases } from './atlas'
import { animateSprites, SpriteClips } from './clip'
import {
  describeSprites,
  drawSpritePicks,
  observeSpriteRemovals,
  overlayNode,
  prepareSprites,
  SpriteStore,
  Sprites,
  spriteNode,
  Tilemaps,
} from './render'
import { SPRITE_SHADERS } from './shaders'
import { Sprite2dSettings } from './sprite'
import { TilemapDatas } from './tilemap'

/**
 * Sprites, atlases, frame animation, and tilemaps, drawn in the render graph: world sprites after
 * opaque 3D (so 2D gets HDR and post-processing), screen sprites over the finished image.
 */
export const spritePlugin = definePlugin({
  name: 'sprite',
  dependencies: ['render/forward'],
  build(app) {
    const w = app.world
    w.initResource(TextureAtlases)
    w.initResource(SpriteClips)
    w.initResource(TilemapDatas)
    w.initResource(Sprite2dSettings)
    w.initResource(Tilemaps)
    observeSpriteRemovals(w)
    app.addSystems(Update, animateSprites).addSystems(Last, prepareSprites.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const world = app.world
    app.insertResource(Sprites, new SpriteStore(world.resource(Gpu)))
    const shaders = world.resource(Shaders)
    for (const [path, source] of Object.entries(SPRITE_SHADERS)) {
      shaders.register(path, source, `engine:${path}`)
    }
    const graph = world.resource(Graph)
    graph.addNode('sprites', spriteNode(world))
    graph.addNode('sprites/overlay', overlayNode(world))
    world.initResource(RenderDescribers).set('sprites', (w) => describeSprites(w))
    world.initResource(Picking).drawers.set('sprites', drawSpritePicks)
  },
})
