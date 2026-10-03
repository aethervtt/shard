import {
  DragEnded,
  MapControls,
  OrbitControls,
  PlaneDrag,
  syncViews,
} from '@aethervtt/shard-controls'
import {
  type AssetRef,
  ChildOf,
  defineSystem,
  type Entity,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { FogLayer, FogRegionsStore } from '@aethervtt/shard-fog'
import { cellAt, cellCenter, Grid, type GridGeometry } from '@aethervtt/shard-grid'
import { Gesture, type GestureEvent, Gestures } from '@aethervtt/shard-input'
import { box, capsule, cylinder } from '@aethervtt/shard-mesh'
import { createMirror, type Mirror } from '@aethervtt/shard-mirror'
import {
  AmbientLight,
  Camera3d,
  CameraMoved,
  DirectionalLight,
  Exposure,
  GroundLayer,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  Outline,
  PointLight,
  pick,
  RenderLayers,
  RenderStats,
  screenToPlane,
  Visibility,
  worldToScreen,
} from '@aethervtt/shard-render'
import { SURFACE_PRESETS, SurfaceMaterial, SurfaceSettings } from '@aethervtt/shard-render/surface'
import { definePlugin } from '@aethervtt/shard-runtime'
import {
  Cutout,
  DoorLeaf,
  Floor,
  Level,
  Opening,
  Roof,
  roofAt,
  Structure,
  StructureSettings,
  Wall,
} from '@aethervtt/shard-structure'
import { brickMaterial } from '@aethervtt/shard-structure/fixtures'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { VectorShape } from '@aethervtt/shard-vector'
import { hudExtras } from './hud'

// A small VTT table (0055, 0057): a host's documents mirrored onto the engine, drawn two ways.
// The Map view is orthographic, tilted 10° off top-down so wall faces show, with flat token discs;
// the Tabletop view is a perspective orbit with standees. Both are camera controls (0060), synced
// when the view switches. Walls, doors, windows and floors compile into chunks; grid, drawings,
// discs and fog stack in ground bands. Drag a token to move it, cell by cell (Escape puts it back);
// click one to select it and click the floor to send it there; click a door to swing it. Dragging
// empty floor pans the Map and orbits the Tabletop; the wheel zooms to the cursor. Name labels are
// DOM, placed by worldToScreen.
// The east wing's straight walls and the yard's round tower and garden wall share one procedural
// brick material (0066), so the courses can be compared on straight, arc and Bézier walls.
// Levels and roofs (0067): the tower has a deck on a second level, with a parapet and a hatch; the
// hall and the east wing's two rooms have roofs, each hidden while a token stands under it. A
// hidden roof keeps casting, so the moon only reaches a room through its windows.
// Surface variation and contact shade (0068): each material's style, as a host's documents carry
// it, maps onto a preset and a seed; walls get dark strips where they meet floors and each other.
// The quality button turns both off and on, as a host's low preset would.

/** Layer 1 is shared; each view adds its own visuals' layer. */
const SHARED = 1
const MAP = 2
const TABLETOP = 4
/** One grid cell: 1.5 m. */
const CELL = 1.5
/** The Map view's pitch: 10° off straight down, the camera south of what it looks at. */
const MAP_PITCH = 80

type Vec2 = [number, number]

interface WallDoc {
  id: string
  rev: number
  a: Vec2
  b: Vec2
  material: string
  height?: number
  curve?: { kind: 'arc'; bow: number } | { kind: 'bezier'; c0: Vec2; c1: Vec2 }
  /** The level it stands on (0067); the ground level when absent. */
  level?: string
}
interface OpeningDoc {
  id: string
  rev: number
  wall: string
  kind: 'door' | 'window'
  offset: number
  width: number
  state: 'open' | 'closed'
}
interface FloorDoc {
  id: string
  rev: number
  points: Vec2[]
  material: string
  elevation?: number
  thickness?: number
  level?: string
}
interface TokenDoc {
  id: string
  rev: number
  name: string
  x: number
  z: number
  color: [number, number, number, number]
}

interface Table {
  walls: WallDoc[]
  openings: OpeningDoc[]
  floors: FloorDoc[]
  tokens: TokenDoc[]
}

/** The host's documents: three rooms and a corridor, a door each, windows, four tokens. */
function initialTable(): Table {
  const w = (id: string, a: Vec2, b: Vec2, material = 'stone'): WallDoc => ({
    id,
    rev: 0,
    a,
    b,
    material,
  })
  // A round brick tower in the yard: four quarter arcs, walked anticlockwise, bowing outward.
  const [tx, tz, r] = [-10, 4.5, 3]
  const corners: Vec2[] = [
    [tx + r, tz],
    [tx, tz + r],
    [tx - r, tz],
    [tx, tz - r],
  ]
  const tower = corners.map(
    (a, i): WallDoc => ({
      ...w(`tower-${i}`, a, corners[(i + 1) % 4]!, 'brick'),
      curve: { kind: 'arc', bow: -r * (1 - Math.SQRT1_2) },
    }),
  )
  // Its deck, a level up: a parapet on the same arcs.
  const parapet = corners.map(
    (a, i): WallDoc => ({
      ...w(`tower-top-${i}`, a, corners[(i + 1) % 4]!, 'brick'),
      curve: { kind: 'arc', bow: -r * (1 - Math.SQRT1_2) },
      height: 1,
      level: 'tower-top',
    }),
  )
  const towerFloor: Vec2[] = []
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * Math.PI * 2
    towerFloor.push([tx + Math.cos(t) * r, tz + Math.sin(t) * r])
  }
  return {
    walls: [
      w('hall-n', [-15, -9], [3, -9]),
      w('hall-s', [-15, 0], [-6, 0]),
      w('hall-s2', [-3, 0], [3, 0]),
      w('hall-w', [-15, -9], [-15, 9]),
      w('mid', [3, -9], [3, 9]),
      w('east-n', [3, -9], [15, -9], 'brick'),
      w('east-e', [15, -9], [15, 9], 'brick'),
      w('east-mid', [3, 1.5], [15, 1.5], 'brick'),
      w('south', [-15, 9], [15, 9]),
      ...tower,
      ...parapet,
      {
        ...w('garden', [-4, 8], [2, 3], 'brick'),
        height: 1.2,
        curve: { kind: 'bezier', c0: [-0.5, 8.8], c1: [3, 6] },
      },
    ],
    openings: [
      {
        id: 'door-hall',
        rev: 0,
        wall: 'mid',
        kind: 'door',
        offset: 4,
        width: 1.2,
        state: 'closed',
      },
      {
        id: 'door-east',
        rev: 0,
        wall: 'east-mid',
        kind: 'door',
        offset: 5.4,
        width: 1.2,
        state: 'open',
      },
      {
        id: 'door-south',
        rev: 0,
        wall: 'mid',
        kind: 'door',
        offset: 13.2,
        width: 1.2,
        state: 'closed',
      },
      {
        id: 'win-e1',
        rev: 0,
        wall: 'east-e',
        kind: 'window',
        offset: 3,
        width: 2.4,
        state: 'closed',
      },
      {
        id: 'win-e2',
        rev: 0,
        wall: 'east-e',
        kind: 'window',
        offset: 12.5,
        width: 2.4,
        state: 'closed',
      },
      { id: 'win-n', rev: 0, wall: 'hall-n', kind: 'window', offset: 6, width: 3, state: 'closed' },
      {
        id: 'door-tower',
        rev: 0,
        wall: 'tower-0',
        kind: 'door',
        offset: 1.75,
        width: 1.2,
        state: 'closed',
      },
      {
        id: 'win-tower',
        rev: 0,
        wall: 'tower-2',
        kind: 'window',
        offset: 1.8,
        width: 1.2,
        state: 'closed',
      },
    ],
    floors: [
      {
        id: 'hall',
        rev: 0,
        points: [
          [-15, -9],
          [3, -9],
          [3, 0],
          [-15, 0],
        ],
        material: 'flag',
      },
      {
        id: 'yard',
        rev: 0,
        points: [
          [-15, 0],
          [3, 0],
          [3, 9],
          [-15, 9],
        ],
        material: 'dirt',
      },
      {
        id: 'east',
        rev: 0,
        points: [
          [3, -9],
          [15, -9],
          [15, 9],
          [3, 9],
        ],
        material: 'plank',
      },
      { id: 'tower', rev: 0, points: towerFloor, material: 'flag', elevation: 0.02 },
      {
        id: 'tower-deck',
        rev: 0,
        points: towerFloor,
        material: 'plank',
        thickness: 0.2,
        level: 'tower-top',
      },
    ],
    tokens: [
      { id: 'ranger', rev: 0, name: 'Ranger', x: -9.75, z: -5.25, color: [0.2, 0.6, 0.25, 1] },
      { id: 'mage', rev: 0, name: 'Mage', x: -6.75, z: -3.75, color: [0.35, 0.3, 0.9, 1] },
      { id: 'knight', rev: 0, name: 'Knight', x: -2.25, z: 4.5, color: [0.8, 0.75, 0.7, 1] },
      { id: 'goblin', rev: 0, name: 'Goblin', x: 9.75, z: 5.25, color: [0.85, 0.25, 0.15, 1] },
    ],
  }
}

interface Demo {
  table: Table
  walls: Mirror<WallDoc>
  openings: Mirror<OpeningDoc>
  floors: Mirror<FloorDoc>
  tokens: Mirror<TokenDoc>
  materials: Map<string, AssetRef<'Material'>>
  map: Entity
  tabletop: Entity
  view: 'map' | 'tabletop'
  grid: Entity
  gridMode: number
  fog: Entity
  selected: string | undefined
  hovered: string | undefined
  /** The tower's upper level, its deck's hatch, and the roofs. */
  towerTop: Entity
  hatch: Entity
  roofs: Entity[]
  labels: Map<string, HTMLElement>
  /** The token PlaneDrag is moving. */
  dragging: string | undefined
  wallCount: number
  drawCount: number
}

const demos = new WeakMap<World, Demo>()

const GRID_MODES = [
  { kind: 'square', orientation: 'pointy', size: CELL },
  { kind: 'hex', orientation: 'pointy', size: CELL },
  { kind: 'hex', orientation: 'flat', size: CELL },
  null,
] as const

function gridGeometry(d: Demo): GridGeometry {
  const mode = GRID_MODES[d.gridMode] ?? GRID_MODES[0]
  return { kind: mode.kind, orientation: mode.orientation, size: mode.size, offset: [0, 0] }
}

function mirrors(
  world: World,
  materials: Map<string, AssetRef<'Material'>>,
  levels: Map<string, Entity>,
) {
  const meshes = world.resource(Meshes)
  const disc = meshes.add(cylinder({ radius: 0.62, height: 0.04, segments: 40 }), 'demo:disc')
  const standee = meshes.add(capsule({ radius: 0.32, height: 1.7 }), 'demo:standee')
  const ring = meshes.add(cylinder({ radius: 0.72, height: 0.02, segments: 40 }), 'demo:ring')
  const wallDocs = createMirror<WallDoc>(world, {
    key: (d) => d.id,
    rev: (d) => d.rev,
    spawn: (_d, w) => w.spawn(Wall),
    apply: (e, d, w) =>
      w.set(e, Wall, {
        a: d.a,
        b: d.b,
        shape: d.curve?.kind ?? 'straight',
        bow: d.curve?.kind === 'arc' ? d.curve.bow : 0,
        c0: d.curve?.kind === 'bezier' ? d.curve.c0 : [0, 0],
        c1: d.curve?.kind === 'bezier' ? d.curve.c1 : [0, 0],
        height: d.height ?? 2.8,
        thickness: 0.3,
        material: materials.get(d.material) ?? null,
        level: (d.level && levels.get(d.level)) || null,
      }),
  })
  const openings = createMirror<OpeningDoc>(world, {
    key: (d) => d.id,
    rev: (d) => d.rev,
    spawn: (_d, w) => w.spawn(Opening),
    apply: (e, d, w) =>
      w.set(e, Opening, {
        wall: wallDocs.entity(d.wall) ?? null,
        kind: d.kind,
        offset: d.offset,
        width: d.width,
        height: d.kind === 'door' ? 2.1 : 1.1,
        sill: d.kind === 'door' ? 0 : 0.9,
        frameWidth: 0.1,
        frameDepth: 0.05,
        frameMaterial: materials.get('wood') ?? null,
        state: d.state,
        sight: d.kind === 'window' ? 'none' : 'normal',
      }),
  })
  const floors = createMirror<FloorDoc>(world, {
    key: (d) => d.id,
    rev: (d) => d.rev,
    spawn: (_d, w) => w.spawn(Floor),
    apply: (e, d, w) =>
      w.set(e, Floor, {
        points: d.points,
        elevation: d.elevation ?? 0,
        thickness: d.thickness ?? 0,
        material: materials.get(d.material) ?? null,
        level: (d.level && levels.get(d.level)) || null,
      }),
  })
  const tokenMaterials = new Map<string, AssetRef<'Material'>>()
  const tokens = createMirror<TokenDoc>(world, {
    key: (d) => d.id,
    rev: (d) => d.rev,
    spawn: (d, w) => {
      const material = world
        .resource(Materials)
        .add(
          new MaterialAsset({ baseColor: d.color, roughness: 0.55 }),
          `demo:token/${d.id}`,
        ) as AssetRef<'Material'>
      tokenMaterials.set(d.id, material)
      const root = w.spawn(Transform)
      // The Map's flat disc, in the flat-tokens band; its rim ring under it.
      w.spawn(
        [Mesh3d, { mesh: ring }],
        [MeshMaterial, { material: materials.get('ink')! }],
        [RenderLayers, { mask: MAP }],
        [GroundLayer, { band: 40, order: 0 }],
        NotShadowCaster,
        Transform,
        [ChildOf, { parent: root }],
      )
      w.spawn(
        [Mesh3d, { mesh: disc }],
        [MeshMaterial, { material }],
        [RenderLayers, { mask: MAP }],
        [GroundLayer, { band: 40, order: 1 }],
        NotShadowCaster,
        Transform,
        [ChildOf, { parent: root }],
      )
      // The Tabletop's standee.
      w.spawn(
        [Mesh3d, { mesh: standee }],
        [MeshMaterial, { material }],
        [RenderLayers, { mask: TABLETOP }],
        [Transform, { translation: [0, 0.85, 0] }],
        [ChildOf, { parent: root }],
      )
      return root
    },
    apply: (e, d, w) => w.set(e, Transform, { translation: [d.x, 0, d.z] }),
  })
  return { walls: wallDocs, openings, floors, tokens }
}

function sync(d: Demo): void {
  d.walls.sync(d.table.walls)
  d.openings.sync(d.table.openings)
  d.floors.sync(d.table.floors)
  d.tokens.sync(d.table.tokens)
}

/** Replaces a document with a changed copy (a new revision), the way a host's store does. */
function edit<T extends { id: string; rev: number }>(
  list: T[],
  id: string,
  change: Partial<T>,
): void {
  const i = list.findIndex((x) => x.id === id)
  if (i >= 0) list[i] = { ...list[i]!, ...change, rev: list[i]!.rev + 1 }
}

function setView(world: World, d: Demo, view: 'map' | 'tabletop'): void {
  if (view === d.view) return
  // The other view picks up where this one is: same target, about the same floor area.
  syncViews(world, d.view === 'map' ? d.map : d.tabletop, view === 'map' ? d.map : d.tabletop)
  d.view = view
  world.set(d.map, Camera3d, { active: view === 'map' })
  world.set(d.tabletop, Camera3d, { active: view === 'tabletop' })
}

function setGrid(world: World, d: Demo, mode: number): void {
  d.gridMode = mode % GRID_MODES.length
  const m = GRID_MODES[d.gridMode]
  if (!m) {
    world.set(d.grid, Grid, { opacity: 0 })
    return
  }
  world.set(d.grid, Grid, { kind: m.kind, orientation: m.orientation, size: m.size, opacity: 0.28 })
}

/** Outlines: selection (gold, shown through walls) and hover (cyan, hidden behind them). */
function outline(world: World, d: Demo): void {
  for (const t of d.table.tokens) {
    const root = d.tokens.entity(t.id)
    if (root === undefined) continue
    if (t.id === d.selected)
      world.add(root, Outline, { color: [1, 0.78, 0.15, 1], width: 3, occluded: 'show' })
    else if (t.id === d.hovered)
      world.add(root, Outline, { color: [0.3, 0.85, 1, 1], width: 2, occluded: 'hide' })
    else if (world.has(root, Outline)) world.remove(root, Outline)
  }
}

/** DOM labels over tokens: repositioned on CameraMoved and when a token moves, not every frame. */
/** Hides each roof while a token stands under it (a host's rule; the engine answers roofAt). */
const hideRoofs = defineSystem({
  name: 'tabletop-demo/roofs',
  run: (_, world) => {
    const d = demos.get(world)
    if (!d) return
    for (const roof of d.roofs) {
      let under = false
      for (const t of d.table.tokens) if (roofAt(world, t.x, t.z, null) === roof) under = true
      const mode = under ? 'hidden' : 'inherit'
      if (world.get(roof, Visibility).mode !== mode) world.set(roof, Visibility, { mode })
    }
  },
})

const placeLabels = defineSystem({
  name: 'tabletop-demo/labels',
  setup: (world) => ({ moved: world.reader(CameraMoved), revs: new Map<string, number>() }),
  run: ({ moved, revs }, world) => {
    const d = demos.get(world)
    if (!d) return
    const cameraMoved = moved.read().length > 0
    let tokenMoved = false
    for (const t of d.table.tokens) {
      if (revs.get(t.id) !== t.rev) {
        revs.set(t.id, t.rev)
        tokenMoved = true
      }
    }
    if (!cameraMoved && !tokenMoved) return
    const cam = d.view === 'map' ? d.map : d.tabletop
    const at = [0, 0]
    for (const t of d.table.tokens) {
      const el = d.labels.get(t.id)
      if (!el) continue
      const shown = worldToScreen(world, cam, [t.x, d.view === 'map' ? 0 : 2, t.z], at)
      el.style.display = shown ? 'block' : 'none'
      if (shown)
        el.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, ${d.view === 'map' ? '18px' : '-120%'})`
    }
  },
})

/** Aether's style seed: FNV-1a of the material's saved identity, never of runtime order. */
function styleSeed(identity: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < identity.length; i++)
    value = Math.imul(value ^ identity.charCodeAt(i), 0x01000193)
  return value >>> 0
}

/**
 * A host material with a surface style (a recipe name and a seed): the engine only knows
 * variations, so the adapter maps the recipe onto a preset (0068). No style is a plain material.
 */
function styledMaterial(value: Record<string, unknown>, style?: { recipe: string; seed: number }) {
  const preset = style && SURFACE_PRESETS[style.recipe]
  if (!preset) return new MaterialAsset(value)
  return new MaterialAsset(
    { ...value, variation: { ...preset, seed: style.seed }, projection: 'uv' },
    SurfaceMaterial,
  )
}

function spawnScene(world: World): Demo {
  const materials = world.resource(Materials)
  const mat = (name: string, value: Record<string, unknown>, recipe?: string) => {
    const style = recipe ? { recipe, seed: styleSeed(`demo:${name}`) } : undefined
    const ref = materials.add(styledMaterial(value, style), `demo:${name}`) as AssetRef<'Material'>
    return [name, ref] as const
  }
  const refs = new Map<string, AssetRef<'Material'>>([
    mat('stone', { baseColor: [0.55, 0.53, 0.5, 1], roughness: 0.9 }, 'stone'),
    mat('wood', { baseColor: [0.33, 0.2, 0.1, 1], roughness: 0.6 }, 'timber'),
    mat('flag', { baseColor: [0.3, 0.31, 0.33, 1], roughness: 0.9 }, 'tile'),
    mat('dirt', { baseColor: [0.28, 0.22, 0.14, 1], roughness: 1 }, 'ground'),
    mat('plank', { baseColor: [0.42, 0.3, 0.18, 1], roughness: 0.7 }, 'timber'),
    mat('moss', { baseColor: [0.2, 0.34, 0.18, 1], roughness: 0.9 }, 'ground'),
    mat('ink', { baseColor: [0.05, 0.05, 0.06, 1], roughness: 0.5 }),
    mat('slate', { baseColor: [0.2, 0.22, 0.26, 1], roughness: 0.8 }, 'solid'),
  ])
  refs.set('brick', brickMaterial(world))
  // The tower's deck stands on the ground floor's walls.
  const towerTop = world.spawn([Level, { index: 1, elevation: 2.8, height: 2.4 }], Visibility)
  const m = mirrors(world, refs, new Map([['tower-top', towerTop]]))
  // Roofs: single slopes, the east wing's two rising to meet over its middle wall.
  const roof = (points: Vec2[], ridge: Vec2) =>
    world.spawn(
      [Roof, { points, height: 2.8, pitch: 18, ridge, material: refs.get('slate')! }],
      Visibility,
    )
  const roofs = [
    roof(
      [
        [-15.3, -9.3],
        [3, -9.3],
        [3, 0.3],
        [-15.3, 0.3],
      ],
      [0, 1],
    ),
    roof(
      [
        [3, -9.3],
        [15.3, -9.3],
        [15.3, 1.5],
        [3, 1.5],
      ],
      [0, 1],
    ),
    roof(
      [
        [3, 1.5],
        [15.3, 1.5],
        [15.3, 9.3],
        [3, 9.3],
      ],
      [0, -1],
    ),
  ]
  const table = initialTable()
  // Props: barrels, crates and pillars (they cast shadows and hide the bands behind them).
  const meshes = world.resource(Meshes)
  const crate = meshes.add(box({ x: 1, y: 1, z: 1 }), 'demo:crate')
  const pillar = meshes.add(cylinder({ radius: 0.35, height: 2.8, segments: 20 }), 'demo:pillar')
  for (const [mesh, material, x, y, z] of [
    [crate, 'wood', -13.5, 0.5, -7.5],
    [crate, 'wood', -12.4, 0.5, -7.6],
    [crate, 'wood', -13, 1.5, -7.5],
    [pillar, 'stone', -9, 1.4, -4.5],
    [pillar, 'stone', -3, 1.4, -4.5],
    [crate, 'moss', 12.5, 0.5, 6.5],
    [pillar, 'stone', 9, 1.4, -4],
  ] as const)
    world.spawn(
      [Mesh3d, { mesh }],
      [MeshMaterial, { material: refs.get(material)! }],
      [Transform, { translation: [x, y, z] }],
    )
  // Light: a dim moon with cached shadows, and tabletop torches (bright radius, then dim).
  world.resource(AmbientLight).brightness = 900
  world.spawn(
    [
      DirectionalLight,
      { illuminance: 1200, shadows: true, shadowUpdate: 'on-change', color: [0.7, 0.78, 1, 1] },
    ],
    [Transform, { rotation: lookAt([-5, 12, 6], [0, 0, 0]) }],
  )
  for (const [x, z, color] of [
    [-12, -4.5, [1, 0.72, 0.45, 1]],
    [-1, -6, [1, 0.72, 0.45, 1]],
    [-8, 5, [1, 0.8, 0.55, 1]],
    [9, -4, [1, 0.6, 0.35, 1]],
    [9, 5.5, [0.6, 0.8, 1, 1]],
  ] as const)
    world.spawn(
      [
        PointLight,
        {
          intensity: 5000,
          range: 9,
          falloff: 'tabletop',
          bright: 4,
          color: [...color],
          shadows: true,
          shadowUpdate: 'on-change',
        },
      ],
      [Transform, { translation: [x, 2.2, z] }],
    )
  // The grid.
  const grid = world.spawn(
    [
      Grid,
      { size: CELL, color: [0.95, 0.95, 0.9, 1], opacity: 0.28, lineWidth: 1, extent: [30, 18] },
    ],
    Transform,
  )
  // Drawings: a spell cone, a route, a warded zone, a circle of salt.
  world.spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'cone', length: 6, angle: 60 },
        fill: [1, 0.4, 0.1, 1],
        fillOpacity: 0.35,
        stroke: [1, 0.55, 0.2, 1],
        strokeWidth: 2,
        strokeUnits: 'css-px',
      },
    ],
    [
      Transform,
      { translation: [-6.75, 0, -3.75], rotation: [0, Math.sin(-0.35), 0, Math.cos(-0.35)] },
    ],
  )
  const route: Vec2[] = []
  for (let i = 0; i <= 60; i++) route.push([i * 0.22, Math.sin(i * 0.18) * 1.5])
  world.spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'pen', points: route },
        stroke: [0.95, 0.9, 0.3, 1],
        strokeWidth: 3,
        strokeUnits: 'css-px',
      },
    ],
    [Transform, { translation: [-13, 0, 4.5] }],
  )
  world.spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'rect', width: 4.5, height: 3 },
        fill: [0.3, 0.7, 1, 1],
        fillOpacity: 0.18,
        stroke: [0.3, 0.7, 1, 1],
        strokeWidth: 0.08,
      },
    ],
    [Transform, { translation: [-5, 0, 3] }],
  )
  world.spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'ellipse', rx: 2.2, ry: 2.2 },
        stroke: [0.95, 0.95, 0.95, 1],
        strokeWidth: 2,
        strokeUnits: 'css-px',
      },
    ],
    [Transform, { translation: [-9.75, 0, -5.25] }],
  )
  // Projected fog (0058) over the unexplored east wing, with the lit window bay revealed: it covers
  // floors, walls and props alike, in both views.
  const fogRegions = world.resource(FogRegionsStore).add({
    rev: 1,
    regions: [
      {
        op: 'hide',
        strength: 0.82,
        feather: 0.4,
        shape: {
          kind: 'polygon',
          outer: [
            [3, -9],
            [15, -9],
            [15, 1.5],
            [3, 1.5],
          ],
          holes: [
            [
              [12, -8],
              [14.8, -8],
              [14.8, -3],
              [12, -3],
            ],
          ],
        },
      },
    ],
  }) as AssetRef<'FogRegions'>
  const fog = world.spawn([
    FogLayer,
    {
      base: 'revealed',
      extent: { min: [-16, -12], max: [16, 12] },
      color: [0.02, 0.02, 0.04, 1],
      regions: fogRegions,
    },
  ])
  const map = world.spawn(
    [
      Camera3d,
      {
        projection: 'orthographic',
        orthoHeight: 20,
        far: 200,
        layers: SHARED | MAP,
        clearColor: [0.02, 0.02, 0.03, 1],
      },
    ],
    [Exposure, { ev100: 9.2 }],
    Transform,
    [
      MapControls,
      // 3 m to 80 m of floor top to bottom.
      { pitch: MAP_PITCH, elevation: 40, height: 20, minZoom: 0.25, maxZoom: 20 / 3 },
    ],
  )
  const tabletop = world.spawn(
    [
      Camera3d,
      { fovY: 40, layers: SHARED | TABLETOP, active: false, clearColor: [0.02, 0.02, 0.03, 1] },
    ],
    [Exposure, { ev100: 9.2 }],
    Transform,
    [
      OrbitControls,
      {
        distance: 26,
        yaw: 20,
        pitch: 50,
        minPitch: 12,
        maxPitch: 88,
        minDistance: 4,
        maxDistance: 80,
      },
    ],
  )
  const d: Demo = {
    table,
    ...m,
    materials: refs,
    map,
    tabletop,
    view: 'map',
    grid,
    gridMode: 0,
    fog,
    selected: undefined,
    hovered: undefined,
    towerTop,
    hatch: -1 as Entity,
    roofs,
    labels: new Map(),
    dragging: undefined,
    wallCount: 0,
    drawCount: 0,
  }
  sync(d)
  // A hatch in the deck, hinged on the edge nearest the tower's centre.
  d.hatch = world.spawn([
    Cutout,
    {
      host: d.floors.entity('tower-deck')!,
      points: [
        [-11.9, 5.5],
        [-10.9, 5.5],
        [-10.9, 6.5],
        [-11.9, 6.5],
      ],
      kind: 'hatch',
      hinge: 0,
      frameMaterial: refs.get('wood')!,
    },
  ])
  return d
}

type Action = 'view' | 'grid' | 'fog' | 'doors' | 'wall' | 'draw' | 'level' | 'hatch' | 'quality'

function act(world: World, d: Demo, action: Action): void {
  if (action === 'view') setView(world, d, d.view === 'map' ? 'tabletop' : 'map')
  else if (action === 'grid') setGrid(world, d, d.gridMode + 1)
  else if (action === 'fog') {
    const v = world.get(d.fog, FogLayer)
    world.set(d.fog, FogLayer, { opacity: v.opacity > 0 ? 0 : 1 })
  } else if (action === 'doors') {
    for (const o of [...d.table.openings])
      if (o.kind === 'door')
        edit(d.table.openings, o.id, { state: o.state === 'open' ? 'closed' : 'open' })
    sync(d)
  } else if (action === 'wall') {
    // A new wall somewhere in the yard: only the chunks it touches rebuild.
    const i = d.wallCount++
    const x = -14 + ((i * 3.7) % 16)
    const z = 1.5 + ((i * 2.3) % 6)
    d.table.walls.push({
      id: `extra-${i}`,
      rev: 0,
      a: [x, z],
      b: [x + 3, z + 0.8],
      material: 'brick',
    })
    sync(d)
  } else if (action === 'level') {
    // Show this level and below: hiding the tower's deck is one Visibility write, no rebuild.
    const v = world.get(d.towerTop, Visibility)
    world.set(d.towerTop, Visibility, { mode: v.mode === 'hidden' ? 'inherit' : 'hidden' })
  } else if (action === 'quality') {
    // A host's low preset: surface variation and contact shade off; both cost nothing then.
    const on = !world.resource(SurfaceSettings).variation
    world.patchResource(SurfaceSettings, { variation: on })
    world.patchResource(StructureSettings, {
      contact: { ...world.resource(StructureSettings).contact, enabled: on },
    })
  } else if (action === 'hatch') {
    const c = world.get(d.hatch, Cutout)
    world.set(d.hatch, Cutout, { state: c.state === 'open' ? 'closed' : 'open' })
  } else if (action === 'draw') {
    const i = d.drawCount++
    const points: Vec2[] = []
    for (let k = 0; k <= 30; k++) points.push([k * 0.2, Math.sin(k * 0.5 + i) * 0.8])
    world.spawn(
      [
        VectorShape,
        {
          geometry: { kind: 'pen', points },
          stroke: [0.9, 0.2 + ((i * 0.3) % 0.7), 0.6, 1],
          strokeWidth: 4,
          strokeUnits: 'css-px',
        },
      ],
      [Transform, { translation: [-13 + ((i * 2.9) % 13), 0, -8 + ((i * 1.7) % 7)] }],
    )
  }
}

/** What's under CSS pixel (x, y): a token (through its visual child), a door, or the floor. */
async function hostHit(world: World, d: Demo, x: number, y: number) {
  // pick wants the view's pixels.
  const canvas = document.getElementById('viewport') as HTMLCanvasElement
  const scale = canvas.width / Math.max(1, canvas.clientWidth)
  const hit = await pick(world, d.view === 'map' ? d.map : d.tabletop, x * scale, y * scale)
  if (!hit) return undefined
  const token = d.tokens.keyOf(hit.entity)
  if (token) return { kind: 'token' as const, id: token, position: hit.position }
  const leaf = world.tryGet(hit.entity, DoorLeaf)
  const door = leaf?.opening != null ? d.openings.keyOf(leaf.opening) : undefined
  if (door) return { kind: 'door' as const, id: door, position: hit.position }
  return { kind: 'floor' as const, id: '', position: hit.position }
}

/** Snaps a dragged position to its grid cell's center. */
function snapToCell(d: Demo, p: [number, number, number]): void {
  const grid = gridGeometry(d)
  const [cx, cz] = cellCenter(grid, cellAt(grid, p[0], p[2]))
  p[0] = cx
  p[2] = cz
}

async function onTap(world: World, d: Demo, x: number, y: number): Promise<void> {
  const h = await hostHit(world, d, x, y)
  if (h?.kind === 'token') d.selected = d.selected === h.id ? undefined : h.id
  else if (h?.kind === 'door') {
    const o = d.table.openings.find((o) => o.id === h.id)!
    edit(d.table.openings, h.id, { state: o.state === 'open' ? 'closed' : 'open' })
    sync(d)
  } else if (d.selected) {
    // Send the selected token to the clicked cell: one Transform write, one instance slot.
    const p: [number, number, number] = [0, 0, 0]
    if (screenToPlane(world, d.view === 'map' ? d.map : d.tabletop, x, y, 0, p)) {
      snapToCell(d, p)
      edit(d.table.tokens, d.selected, { x: p[0], z: p[2] })
      sync(d)
    }
  }
  outline(world, d)
}

/**
 * A left drag: if it started on a token, PlaneDrag moves the token; otherwise the camera's
 * control pans or orbits. The pick is async, so the drag is held until it answers: the control
 * waits instead of panning while we look.
 */
async function onDragStart(world: World, d: Demo, g: GestureEvent): Promise<void> {
  const gestures = world.resource(Gestures)
  gestures.hold(g.id)
  try {
    const h = await hostHit(world, d, g.startX, g.startY)
    if (h?.kind !== 'token') return
    const entity = d.tokens.entity(h.id)
    if (entity === undefined) return
    const begun = world.resource(PlaneDrag).begin({
      entity,
      gesture: g,
      grab: h.position,
      snap: (p) => snapToCell(d, p),
    })
    if (begun) {
      d.dragging = h.id
      d.selected = h.id
      outline(world, d)
    }
  } finally {
    gestures.release(g.id)
  }
}

/** Taps and drags (gestures, 0060), and committing a token's move when its drag ends. */
const tabletopInput = defineSystem({
  name: 'tabletop-demo/input',
  setup: (world) => ({ gestures: world.reader(Gesture), ended: world.reader(DragEnded) }),
  run: ({ gestures, ended }, world) => {
    const d = demos.get(world)
    if (!d) return
    for (const g of gestures.read()) {
      if (g.button !== 'left') continue
      if (g.kind === 'tap') void onTap(world, d, g.x, g.y)
      else if (g.kind === 'drag-start') void onDragStart(world, d, { ...g })
    }
    for (const e of ended.read()) {
      const id = d.dragging
      d.dragging = undefined
      // The host commits the drop; a cancelled drag is already back where it was.
      if (id === undefined || e.cancelled) continue
      edit(d.table.tokens, id, { x: e.position[0], z: e.position[2] })
      sync(d)
    }
  },
})

function wireInput(world: World, d: Demo): void {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement
  const layer = document.createElement('div')
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden'
  document.body.append(layer)
  for (const t of d.table.tokens) {
    const el = document.createElement('div')
    el.textContent = t.name
    el.style.cssText =
      'position:absolute;left:0;top:0;padding:1px 6px;border-radius:9px;background:rgba(8,10,16,.75);color:#e8ecf4;font:11px system-ui;white-space:nowrap'
    layer.append(el)
    d.labels.set(t.id, el)
  }
  // Hover: outline the token under the pointer while nothing is pressed.
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons !== 0) return
    const r = canvas.getBoundingClientRect()
    void hostHit(world, d, e.clientX - r.left, e.clientY - r.top).then((h) => {
      const hovered = h?.kind === 'token' ? h.id : undefined
      if (hovered !== d.hovered) {
        d.hovered = hovered
        outline(world, d)
      }
      canvas.style.cursor = h?.kind === 'door' || h?.kind === 'token' ? 'pointer' : 'default'
    })
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tabletop]'))
    button.addEventListener('click', () => act(world, d, button.dataset.tabletop as Action))
}

/** The playground's tabletop demo: structure, ground bands, render layers, outlines, projection. */
export const tabletopDemoPlugin = definePlugin({
  name: 'tabletop-demo',
  dependencies: ['structure', 'grid', 'vector', 'render/outline', 'controls'],
  build(app) {
    app.addSystems(Update, placeLabels, hideRoofs, tabletopInput)
  },
  ready(app) {
    const world = app.world
    const d = spawnScene(world)
    demos.set(world, d)
    wireInput(world, d)
    hudExtras.push((w) => {
      const stats = w.resource(RenderStats)
      const s = w.resource(Structure).describe()
      const f = stats.lastFrame
      return [
        `view      ${d.view}   grid ${GRID_MODES[d.gridMode] ? `${GRID_MODES[d.gridMode]!.kind} ${GRID_MODES[d.gridMode]!.kind === 'hex' ? GRID_MODES[d.gridMode]!.orientation : ''}` : 'off'}`,
        `structure ${s.walls} walls, ${s.openings} openings, ${s.chunks} chunks, ${s.meshes} meshes`,
        `last edit ${s.lastCompile.chunksRebuilt} chunks rebuilt in ${s.lastCompile.ms.toFixed(2)} ms`,
        `quality   ${w.resource(SurfaceSettings).variation ? 'high' : 'low'}: variation, contact shade ${s.contact.enabled ? `${s.contact.meshes} meshes, ${s.contact.triangles} triangles` : 'off'}`,
        `levels    tower deck ${w.get(d.towerTop, Visibility).mode === 'hidden' ? 'hidden' : 'shown'}, hatch ${w.get(d.hatch, Cutout).state}, roofs ${d.roofs.filter((e) => w.get(e, Visibility).mode === 'hidden').length}/${d.roofs.length} hidden`,
        `uploads   ${f.sceneBytes} B scene, ${f.bytes.view} B view (last frame)`,
        `recent    ${stats.recent.sceneBytes} B scene, ${stats.recent.shadowMapsRendered} shadow maps (60 frames)`,
        `selected  ${d.selected ?? '—'}   drag a token to move it (Esc puts it back), or click it, then the floor`,
        `camera    drag the floor to ${d.view === 'map' ? 'pan' : 'orbit (middle-drag pans)'}; the wheel zooms to the cursor`,
      ]
    })
  },
})
