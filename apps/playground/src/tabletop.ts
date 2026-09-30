import {
  type AssetRef,
  ChildOf,
  defineSystem,
  type Entity,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { cellAt, cellCenter, Grid, type GridGeometry } from '@aethervtt/shard-grid'
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
  worldToScreen,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { DoorLeaf, Floor, Opening, Structure, Wall } from '@aethervtt/shard-structure'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { VectorShape } from '@aethervtt/shard-vector'
import { hudExtras } from './hud'

// A small VTT table (0055, 0057): a host's documents mirrored onto the engine, drawn two ways.
// The Map view is orthographic and top-down with flat token discs; the Tabletop view is a
// perspective orbit with standees. Walls, doors, windows and floors compile into chunks; grid,
// drawings, discs and fog stack in ground bands. Click a token to select it (and move it by
// clicking the floor), click a door to swing it. Name labels are DOM, placed by worldToScreen.

/** Layer 1 is shared; each view adds its own visuals' layer. */
const SHARED = 1
const MAP = 2
const TABLETOP = 4
/** One grid cell: 1.5 m. */
const CELL = 1.5
const TOP_DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]

type Vec2 = [number, number]

interface WallDoc {
  id: string
  rev: number
  a: Vec2
  b: Vec2
  material: string
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
  labels: Map<string, HTMLElement>
  /** Map pan (x, z) and zoom; Tabletop orbit. */
  pan: Vec2
  orthoHeight: number
  yaw: number
  pitch: number
  distance: number
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

function mirrors(world: World, materials: Map<string, AssetRef<'Material'>>) {
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
        height: 2.8,
        thickness: 0.3,
        material: materials.get(d.material) ?? null,
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
      w.set(e, Floor, { points: d.points, material: materials.get(d.material) ?? null }),
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

function placeCameras(world: World, d: Demo): void {
  world.set(d.map, Transform, { translation: [d.pan[0], 40, d.pan[1]], rotation: TOP_DOWN })
  world.set(d.map, Camera3d, { orthoHeight: d.orthoHeight })
  const p = (d.pitch * Math.PI) / 180
  const y = (d.yaw * Math.PI) / 180
  const eye: [number, number, number] = [
    d.pan[0] + Math.sin(y) * Math.cos(p) * d.distance,
    Math.sin(p) * d.distance,
    d.pan[1] + Math.cos(y) * Math.cos(p) * d.distance,
  ]
  world.set(d.tabletop, Transform, {
    translation: eye,
    rotation: lookAt(eye, [d.pan[0], 0, d.pan[1]]),
  })
}

function setView(world: World, d: Demo, view: 'map' | 'tabletop'): void {
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

function spawnScene(world: World): Demo {
  const materials = world.resource(Materials)
  const mat = (name: string, value: Record<string, unknown>) => {
    const ref = materials.add(new MaterialAsset(value), `demo:${name}`) as AssetRef<'Material'>
    return [name, ref] as const
  }
  const refs = new Map<string, AssetRef<'Material'>>([
    mat('stone', { baseColor: [0.55, 0.53, 0.5, 1], roughness: 0.9 }),
    mat('brick', { baseColor: [0.5, 0.26, 0.18, 1], roughness: 0.85 }),
    mat('wood', { baseColor: [0.33, 0.2, 0.1, 1], roughness: 0.6 }),
    mat('flag', { baseColor: [0.3, 0.31, 0.33, 1], roughness: 0.9 }),
    mat('dirt', { baseColor: [0.28, 0.22, 0.14, 1], roughness: 1 }),
    mat('plank', { baseColor: [0.42, 0.3, 0.18, 1], roughness: 0.7 }),
    mat('moss', { baseColor: [0.2, 0.34, 0.18, 1], roughness: 0.9 }),
    mat('ink', { baseColor: [0.05, 0.05, 0.06, 1], roughness: 0.5 }),
  ])
  const m = mirrors(world, refs)
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
    [pillar, 'brick', 9, 1.4, -4],
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
  // Fog over the unexplored east wing, with the lit window bay cut out.
  const fog = world.spawn(
    [
      VectorShape,
      {
        geometry: {
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
        fill: [0.02, 0.02, 0.04, 1],
        fillOpacity: 0.82,
        strokeWidth: 0,
      },
    ],
    [GroundLayer, { band: 50 }],
    Transform,
  )
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
  )
  const tabletop = world.spawn(
    [
      Camera3d,
      { fovY: 40, layers: SHARED | TABLETOP, active: false, clearColor: [0.02, 0.02, 0.03, 1] },
    ],
    [Exposure, { ev100: 9.2 }],
    Transform,
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
    labels: new Map(),
    pan: [0, 0],
    orthoHeight: 20,
    yaw: 20,
    pitch: 50,
    distance: 26,
    wallCount: 0,
    drawCount: 0,
  }
  sync(d)
  placeCameras(world, d)
  return d
}

type Action = 'view' | 'grid' | 'fog' | 'doors' | 'wall' | 'draw'

function act(world: World, d: Demo, action: Action): void {
  if (action === 'view') setView(world, d, d.view === 'map' ? 'tabletop' : 'map')
  else if (action === 'grid') setGrid(world, d, d.gridMode + 1)
  else if (action === 'fog') {
    const v = world.get(d.fog, VectorShape)
    world.set(d.fog, VectorShape, { fillOpacity: v.fillOpacity > 0 ? 0 : 0.82 })
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

/** Target pixels of a pointer event on the canvas (pick wants the view's pixels). */
function targetPixels(canvas: HTMLCanvasElement, e: PointerEvent | MouseEvent): Vec2 {
  const r = canvas.getBoundingClientRect()
  return [
    ((e.clientX - r.left) * canvas.width) / r.width,
    ((e.clientY - r.top) * canvas.height) / r.height,
  ]
}

/** The host id of what's under the pointer: a token (through its visual child), or a door. */
async function hostHit(
  world: World,
  d: Demo,
  canvas: HTMLCanvasElement,
  e: PointerEvent | MouseEvent,
) {
  const [x, y] = targetPixels(canvas, e)
  const hit = await pick(world, d.view === 'map' ? d.map : d.tabletop, x, y)
  if (!hit) return undefined
  const token = d.tokens.keyOf(hit.entity)
  if (token) return { kind: 'token' as const, id: token }
  const leaf = world.tryGet(hit.entity, DoorLeaf)
  const door = leaf?.opening != null ? d.openings.keyOf(leaf.opening) : undefined
  if (door) return { kind: 'door' as const, id: door }
  return { kind: 'floor' as const, id: '' }
}

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
  let drag: { x: number; y: number; moved: boolean } | undefined
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      drag.x = e.clientX
      drag.y = e.clientY
      if (d.view === 'map' || e.shiftKey) {
        const perPx = (d.view === 'map' ? d.orthoHeight : d.distance * 0.8) / canvas.clientHeight
        const yaw = d.view === 'map' ? 0 : (d.yaw * Math.PI) / 180
        const c = Math.cos(yaw)
        const s = Math.sin(yaw)
        d.pan[0] -= (dx * c + dy * s) * perPx
        d.pan[1] -= (dy * c - dx * s) * perPx
      } else {
        d.yaw -= dx * 0.3
        d.pitch = Math.min(88, Math.max(12, d.pitch + dy * 0.2))
      }
      placeCameras(world, d)
      return
    }
    void hostHit(world, d, canvas, e).then((h) => {
      const hovered = h?.kind === 'token' ? h.id : undefined
      if (hovered !== d.hovered) {
        d.hovered = hovered
        outline(world, d)
      }
      canvas.style.cursor = h?.kind === 'door' || h?.kind === 'token' ? 'pointer' : 'default'
    })
  })
  canvas.addEventListener('pointerup', (e) => {
    const click = drag && !drag.moved
    drag = undefined
    if (!click) return
    void hostHit(world, d, canvas, e).then((h) => {
      if (h?.kind === 'token') d.selected = d.selected === h.id ? undefined : h.id
      else if (h?.kind === 'door') {
        const o = d.table.openings.find((x) => x.id === h.id)!
        edit(d.table.openings, h.id, { state: o.state === 'open' ? 'closed' : 'open' })
        sync(d)
      } else if (d.selected) {
        // Move the selected token to the clicked cell: one Transform write, one instance slot.
        const [x, y] = targetPixels(canvas, e)
        const cam = d.view === 'map' ? d.map : d.tabletop
        const p = [0, 0, 0]
        const css = window.devicePixelRatio || 1
        if (screenToPlane(world, cam, x / css, y / css, 0, p)) {
          const grid = gridGeometry(d)
          const [cx, cz] = cellCenter(grid, cellAt(grid, p[0]!, p[2]!))
          edit(d.table.tokens, d.selected, { x: cx, z: cz })
          sync(d)
        }
      }
      outline(world, d)
    })
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const k = Math.exp(e.deltaY * 0.001)
      if (d.view === 'map') d.orthoHeight = Math.min(80, Math.max(3, d.orthoHeight * k))
      else d.distance = Math.min(80, Math.max(4, d.distance * k))
      placeCameras(world, d)
    },
    { passive: false },
  )
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tabletop]'))
    button.addEventListener('click', () => act(world, d, button.dataset.tabletop as Action))
}

/** The playground's tabletop demo: structure, ground bands, render layers, outlines, projection. */
export const tabletopDemoPlugin = definePlugin({
  name: 'tabletop-demo',
  dependencies: ['structure', 'grid', 'vector', 'render/outline'],
  build(app) {
    app.addSystems(Update, placeLabels)
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
        `uploads   ${f.sceneBytes} B scene, ${f.bytes.view} B view (last frame)`,
        `recent    ${stats.recent.sceneBytes} B scene, ${stats.recent.shadowMapsRendered} shadow maps (60 frames)`,
        `selected  ${d.selected ?? '—'} (click a token; click the floor to move it; click a door)`,
      ]
    })
  },
})
