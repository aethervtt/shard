import {
  type AssetRef,
  ChildOf,
  type ComponentInit,
  type Entity,
  type Owner,
  type World,
} from '@aethervtt/shard-core'
import { FogLayer, FogRegionsStore, fogPlugin } from '@aethervtt/shard-fog'
import { Grid, gridPlugin } from '@aethervtt/shard-grid'
import { box, cylinder } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  GroundLayer,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  PointLight,
  RenderLayers,
  Tonemapping,
} from '@aethervtt/shard-render'
import type { Plugin } from '@aethervtt/shard-runtime'
import {
  spritePlugin,
  TextureAtlas,
  TextureAtlases,
  Tilemap,
  TilemapData,
  TilemapDatas,
  tilemapOnGround,
} from '@aethervtt/shard-sprite'
import { Floor, Opening, structurePlugin, Wall } from '@aethervtt/shard-structure'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { VectorShape, vectorPlugin } from '@aethervtt/shard-vector'

// The tabletop parity fixture (0057): floor, tiles (0059), grid, drawings, flat tokens, projected
// fog (0058), walls and props on one scene, seen by a Map camera (flat token discs) and a Tabletop
// camera (standees). Node goldens, the playground's pages and 0064's baseline and WebGL2 runs all
// draw this scene.

/** Render layers: 1 is shared; each view adds its own visuals' layer. */
export const PARITY_LAYERS = { shared: 1, map: 2, tabletop: 4 } as const

/** What the fixture adds beyond the renderer (`renderPlugin`, `forwardPlugin`, `TransformPlugin`). */
export function parityPlugins(): Plugin[] {
  return [structurePlugin, gridPlugin, vectorPlugin, fogPlugin, spritePlugin]
}

/**
 * The tile map (0059), one row per line: its first row lies beyond the north wall, and the cells
 * the tests probe are stone. Its top-left corner is at world (x −2, z −9.5); tiles are 1 m.
 */
export const PARITY_TILES = {
  origin: [-2, -9.5] as const,
  rows: [
    'moss moss dirt moss moss moss dirt moss moss',
    'stone stone stone stone crack stone stone stone stone',
    'stone moss stone stone stone stone stone stone dirt',
    'stone stone crack stone stone moss stone stone stone',
    'dirt stone stone stone stone stone stone crack stone',
    'stone stone stone moss stone stone dirt stone stone',
    'stone crack stone stone stone stone stone stone moss',
    'stone stone stone stone dirt stone stone stone stone',
  ],
}

/** Tile art: four 8×8 regions with a mortar line, made in code so the fixture needs no files. */
function tileAtlas(world: World): AssetRef<'TextureAtlas'> {
  const names = ['stone', 'crack', 'moss', 'dirt']
  const base: [number, number, number][] = [
    [150, 144, 132],
    [150, 144, 132],
    [78, 112, 60],
    [124, 94, 66],
  ]
  const pixels = new Uint8Array(32 * 8 * 4)
  for (let r = 0; r < 4; r++)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        // A little texel noise, a darker mortar edge, and a crack across one region.
        const n = ((x * 73 + y * 151 + r * 37) % 17) - 8
        const edge = x === 0 || y === 0 ? 0.7 : 1
        const crack = r === 1 && (x === y || x === y + 1) ? 0.55 : 1
        const [cr, cg, cb] = base[r]!
        const f = edge * crack
        pixels.set(
          [
            Math.max(0, Math.min(255, cr * f + n)),
            Math.max(0, Math.min(255, cg * f + n)),
            Math.max(0, Math.min(255, cb * f + n)),
            255,
          ],
          (y * 32 + r * 8 + x) * 4,
        )
      }
  const texture = world
    .resource(Textures)
    .add(Texture.create({ width: 32, height: 8, mips: [pixels] })) as AssetRef<'Texture'>
  return world.resource(TextureAtlases).add(
    new TextureAtlas(
      texture,
      names.map((name, i) => ({ name, rect: [i * 8, 0, 8, 8] })),
    ),
  ) as AssetRef<'TextureAtlas'>
}

export interface ParityScene {
  /** The orthographic Map camera: shared layer plus flat token discs. */
  map: Entity
  /** The perspective Tabletop camera: shared layer plus standees. */
  tabletop: Entity
  /** Token roots, each with a disc (Map) and a standee (Tabletop). */
  tokens: Entity[]
}

export type ParityView = 'map' | 'tabletop'
export type ParityAngle = 'top' | 30 | 55

export interface ParityOptions {
  /** Where the cameras render. Omit for the window (a canvas). */
  target?: AssetRef<'RenderTarget'>
  /** Who owns everything spawned (0061): releasing it removes the whole table. */
  owner?: Owner
}

/** Spawns the fixture into `world`. Both cameras start inactive: `showParityView` picks one. */
export function spawnParity(world: World, options: ParityOptions = {}): ParityScene {
  const owner = options.owner
  const plain = world.spawn.bind(world) as (...inits: ComponentInit[]) => Entity
  const spawn = (...inits: ComponentInit[]): Entity =>
    owner ? world.owners.spawn(owner, ...inits) : plain(...inits)
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const mat = (baseColor: [number, number, number, number], roughness = 0.8) =>
    materials.add(new MaterialAsset({ baseColor, roughness })) as AssetRef<'Material'>
  world.resource(AmbientLight).brightness = 1500
  spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: true, shadowUpdate: 'on-change' }],
    [Transform, { rotation: lookAt([-4, 10, 3], [0, 0, 0]) }],
  )
  // Floor and walls (0055), with a door and a window.
  spawn([
    Floor,
    {
      points: [
        [-10, -8],
        [10, -8],
        [10, 8],
        [-10, 8],
      ],
      material: mat([0.22, 0.21, 0.2, 1]),
    },
  ])
  const stone = mat([0.7, 0.68, 0.64, 1])
  const walls = [
    [
      [-10, -8],
      [10, -8],
    ],
    [
      [10, -8],
      [10, 8],
    ],
    [
      [-10, 8],
      [-10, -8],
    ],
    [
      [-3, -8],
      [-3, 2],
    ],
  ] as const
  const wallEntities: Entity[] = walls.map(([a, b]) =>
    spawn([Wall, { a: [...a], b: [...b], height: 2.5, thickness: 0.25, material: stone }]),
  )
  spawn([Opening, { wall: wallEntities[3]!, kind: 'door', offset: 5, width: 1.2, state: 'open' }])
  spawn([
    Opening,
    { wall: wallEntities[1]!, kind: 'window', offset: 6, width: 2, sill: 1, height: 1 },
  ])
  // Tiles (band 10, 0059): a map lit like the floor, running under the north wall.
  const data = TilemapData.create(9, PARITY_TILES.rows.length, ['floor'], [])
  PARITY_TILES.rows.forEach((row, y) => {
    row.split(' ').forEach((name, x) => {
      data.layers[0]!.set(x, y, data.tileId(name))
    })
  })
  const ground = tilemapOnGround()
  spawn(
    [
      Tilemap,
      {
        atlas: tileAtlas(world),
        data: world.resource(TilemapDatas).add(data),
        lit: '3d',
      },
    ],
    [GroundLayer, { band: 10 }],
    [
      Transform,
      {
        translation: [PARITY_TILES.origin[0], 0, PARITY_TILES.origin[1]],
        rotation: ground.rotation,
      },
    ],
  )
  // A tabletop light (bright, then dim to its range) over the tiles' northeast.
  spawn(
    [
      PointLight,
      {
        color: [1, 0.8, 0.55, 1],
        intensity: 600_000,
        range: 3.5,
        bright: 1.5,
        falloff: 'tabletop',
      },
    ],
    [Transform, { translation: [5.5, 1.2, -7] }],
  )
  // The grid (band 20).
  spawn(
    [Grid, { size: 1.5, color: [1, 1, 1, 1], opacity: 0.35, lineWidth: 1, extent: [20, 16] }],
    Transform,
  )
  // Drawings (band 30): a filled polygon over the tiles, a pen stroke, an ellipse outline.
  spawn(
    [
      VectorShape,
      {
        geometry: {
          kind: 'polygon',
          outer: [
            [0, 0],
            [4, 0],
            [5, 3],
            [1, 4],
          ],
        },
        fill: [0.1, 0.3, 1, 1],
        fillOpacity: 0.7,
        stroke: [0.1, 0.3, 1, 1],
        strokeWidth: 2,
        strokeUnits: 'css-px',
      },
    ],
    [Transform, { translation: [2, 0, -6] }],
  )
  const pen: [number, number][] = []
  for (let i = 0; i <= 40; i++) pen.push([i * 0.25, Math.sin(i * 0.4) * 1.2])
  spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'pen', points: pen },
        stroke: [1, 0.15, 0.1, 1],
        strokeWidth: 3,
        strokeUnits: 'css-px',
      },
    ],
    [Transform, { translation: [-1, 0, 3] }],
  )
  spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'ellipse', rx: 2, ry: 1.2 },
        stroke: [1, 0.9, 0.1, 1],
        strokeWidth: 0.12,
      },
    ],
    [Transform, { translation: [6, 0, 3] }],
  )
  // Tokens: a logical root, a flat disc for the Map (band 40), a standee for the Tabletop.
  const disc = meshes.add(cylinder({ radius: 0.5, height: 0.02 }))
  const standee = meshes.add(box({ x: 0.15, y: 1.6, z: 0.9 }))
  const tokenMat = mat([0.9, 0.35, 0.1, 1], 0.5)
  const tokens: Entity[] = []
  for (const [x, z] of [
    [3.5, -4.5],
    [-1.5, 3],
    [6, 2],
    [-6, -2],
  ] as const) {
    const root = spawn([Transform, { translation: [x, 0, z] }])
    spawn(
      [Mesh3d, { mesh: disc }],
      [MeshMaterial, { material: tokenMat }],
      [RenderLayers, { mask: PARITY_LAYERS.map }],
      [GroundLayer, { band: 40 }],
      NotShadowCaster,
      Transform,
      [ChildOf, { parent: root }],
    )
    spawn(
      [Mesh3d, { mesh: standee }],
      [MeshMaterial, { material: tokenMat }],
      [RenderLayers, { mask: PARITY_LAYERS.tabletop }],
      [Transform, { translation: [0, 0.8, 0] }],
      [ChildOf, { parent: root }],
    )
    tokens.push(root)
  }
  // Projected fog (0058): a hidden region with a revealed hole over the east side, and one over
  // the northeast prop, which it covers to its top.
  const fog = world.resource(FogRegionsStore).add({
    rev: 1,
    regions: [
      {
        op: 'hide',
        strength: 0.75,
        feather: 0.3,
        shape: {
          kind: 'polygon',
          outer: [
            [5.5, -3],
            [9.5, -3],
            [9.5, 3],
            [5.5, 3],
          ],
          holes: [
            [
              [6.5, -1],
              [8.5, -1],
              [8.5, 1],
              [6.5, 1],
            ],
          ],
        },
      },
      {
        op: 'hide',
        strength: 0.75,
        feather: 0.3,
        shape: { kind: 'rect', x: 7.5, y: 5.5, w: 2.2, h: 2 },
      },
      // Over the tiles' west end.
      {
        op: 'hide',
        strength: 0.75,
        feather: 0.3,
        shape: { kind: 'rect', x: -2, y: -8, w: 2, h: 1.8 },
      },
    ],
  }) as AssetRef<'FogRegions'>
  spawn([
    FogLayer,
    { base: 'revealed', extent: { min: [-10, -8], max: [10, 8] }, texelSize: 0.05, regions: fog },
  ])
  // Props: boxes and a pillar.
  const propMat = mat([0.3, 0.5, 0.35, 1])
  for (const [x, z, s] of [
    [-7, -5, 1],
    [-6, 5, 0.8],
    [8.5, 6.5, 1.2],
  ] as const)
    spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: s, y: s, z: s })) }],
      [MeshMaterial, { material: propMat }],
      [Transform, { translation: [x, s / 2, z] }],
    )
  // The pillar, whose shadow falls across the tiles.
  spawn(
    [Mesh3d, { mesh: meshes.add(cylinder({ radius: 0.3, height: 2.5 })) }],
    [MeshMaterial, { material: propMat }],
    [Transform, { translation: [1, 1.25, -6.6] }],
  )
  const camera = (layers: number, orthographic: boolean) =>
    spawn(
      [
        Camera3d,
        {
          ...(options.target ? { target: options.target } : {}),
          fovY: 45,
          layers,
          active: false,
          clearColor: [0.02, 0.02, 0.03, 1],
          ...(orthographic
            ? { projection: 'orthographic' as const, orthoHeight: 18, far: 200 }
            : {}),
        },
      ],
      [Exposure, { ev100: 12.5 }],
      [Tonemapping, { dither: false }],
      Transform,
    )
  const map = camera(PARITY_LAYERS.shared | PARITY_LAYERS.map, true)
  const tabletop = camera(PARITY_LAYERS.shared | PARITY_LAYERS.tabletop, false)
  return { map, tabletop, tokens }
}

/** Makes one view's camera the active one. */
export function showParityView(world: World, scene: ParityScene, view: ParityView): void {
  world.set(scene.map, Camera3d, { active: view === 'map' })
  world.set(scene.tabletop, Camera3d, { active: view === 'tabletop' })
}

/** Points a view's camera at the table's center from `angle` degrees above it (or straight down). */
export function poseParityCamera(
  world: World,
  scene: ParityScene,
  view: ParityView,
  angle: ParityAngle,
): void {
  const cam = view === 'map' ? scene.map : scene.tabletop
  const distance = view === 'map' ? 30 : 22
  const pitch = angle === 'top' ? 89.99 : angle
  const a = (pitch * Math.PI) / 180
  const eye: [number, number, number] = [0, Math.sin(a) * distance, Math.cos(a) * distance]
  world.set(cam, Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) })
}
