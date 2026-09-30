import { Last, PostUpdate, Update } from '@aethervtt/shard-core'
import {
  addRenderFeatures,
  Gpu,
  Graph,
  Picking,
  RenderDescribers,
  RenderSet,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import * as atlasModule from './atlas'
import { TextureAtlases } from './atlas'
import * as clipModule from './clip'
import { animateSprites, SpriteClips } from './clip'
import * as groundModule from './ground'
import {
  GROUND_TILE_SHADERS,
  GroundTiles,
  observeGroundTiles,
  syncGroundTiles,
  tileDetail,
} from './ground'
import * as lightingModule from './lighting'
import * as lights2dModule from './lights2d'
import { lights2dNode, prepareLights2d } from './lights2d'
import { tilemapMethods } from './methods'
import * as renderModule from './render'
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
import * as spriteModule from './sprite'
import { Sprite2dSettings } from './sprite'
import * as tilemapModule from './tilemap'
import { TilemapDatas } from './tilemap'

/**
 * Sprites, atlases, frame animation, and tilemaps, drawn in the render graph: world sprites after
 * opaque 3D (so 2D gets HDR and post-processing), screen sprites over the finished image. Cameras
 * with Lighting2d light them with 2D lights and shadows. A tilemap with a GroundLayer draws on the
 * ground instead, as chunk meshes among the tabletop's bands (0059).
 */
export const spritePlugin = definePlugin({
  name: 'sprite',
  provides: [
    atlasModule,
    clipModule,
    groundModule,
    lightingModule,
    lights2dModule,
    renderModule,
    spriteModule,
    tilemapModule,
  ],
  dependencies: ['render/forward'],
  build(app) {
    const w = app.world
    w.initResource(TextureAtlases)
    w.initResource(SpriteClips)
    w.initResource(TilemapDatas)
    w.initResource(Sprite2dSettings)
    w.initResource(Tilemaps)
    w.initResource(GroundTiles)
    observeSpriteRemovals(w)
    observeGroundTiles(w)
    app
      .addSystems(Update, animateSprites)
      .addSystems(PostUpdate, syncGroundTiles.before(TransformSystems))
    app
      .addMethod(...tilemapMethods)
      .addSystems(Last, prepareSprites.inSet(RenderSet.Prepare))
      .addSystems(Last, prepareLights2d.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const world = app.world
    app.insertResource(Sprites, new SpriteStore(world.resource(Gpu)))
    const shaders = world.resource(Shaders)
    for (const [path, source] of Object.entries({ ...SPRITE_SHADERS, ...GROUND_TILE_SHADERS })) {
      shaders.register(path, source, `engine:${path}`)
    }
    const graph = world.resource(Graph)
    addRenderFeatures(world, {
      name: 'sprite/lights2d',
      description: '2D lighting: light tiles, occluder shadows, soft-shadow coarse maps.',
      nodes: ['sprites/lights2d'],
      baseline: { strategy: 'Light binning and shadow rows on the CPU, uploaded as data textures' },
    })
    addRenderFeatures(world, {
      name: 'sprite',
      description: 'Sprites and tilemaps, in the scene and in the overlay.',
      nodes: ['sprites', 'sprites/overlay'],
      baseline: { strategy: 'Sprite, tile and chunk records in data textures' },
    })
    graph.addNode('sprites/lights2d', lights2dNode(world))
    graph.addNode('sprites', spriteNode(world))
    graph.addNode('sprites/overlay', overlayNode(world))
    world.initResource(RenderDescribers).set('sprites', (w) => describeSprites(w))
    const picking = world.initResource(Picking)
    picking.drawers.set('sprites', drawSpritePicks)
    picking.detailers.set('tiles', tileDetail)
  },
})
