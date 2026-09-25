import {
  type AssetRef,
  defineSystem,
  type Entity,
  quat,
  Rng,
  Update,
  type World,
} from '@shard/core'
import { capsule, cube, plane, sphere } from '@shard/mesh'
import {
  describeNav,
  findPath,
  Nav,
  NavAgent,
  NavAgentState,
  NavArrived,
  NavGrid,
  NavGridData,
  NavGridDatas,
  NavMesh,
  NavSource,
  nearestPoint,
  OffMeshLink,
  setNavAreas,
} from '@shard/nav'
import { CharacterController, Collider, RigidBody } from '@shard/physics'
import {
  AmbientLight,
  Camera3d,
  DebugOverlays,
  DirectionalLight,
  Exposure,
  isOverlayOn,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  setOverlays,
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import { lookAt, Transform } from '@shard/transform'
import { hudExtras } from './hud'

type Vec3 = [number, number, number]
type Mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) => AssetRef<'Material'>

function materials(world: World): Mat {
  const store = world.resource(Materials)
  return (value) => store.add(new MaterialAsset(value))
}

function toggleOverlay(world: World): void {
  setOverlays(world, { navmesh: !isOverlayOn(world.resource(DebugOverlays), 'navmesh') })
}

function onButtons(attr: string, handlers: Record<string, () => void>): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`)) {
    const handler = handlers[button.dataset[attr]!]
    if (handler) button.addEventListener('click', handler)
  }
}

// --- 3D: a navmesh over a courtyard -------------------------------------------------

interface Courtyard {
  beacon: Entity
  followers: Entity[]
  crowd: Entity[]
  rock: Entity
  rockAt: number
  swamp: number
  keys: Set<string>
  rng: Rng
  camera: Entity
}

let yard: Courtyard | undefined

/** Where the beacon can jump to, and what the followers should make of it. */
const SPOTS: Record<string, Vec3> = {
  upper: [10, 3, -12], // up the ramp
  ledge: [17, 1.2, 12], // only by the off-mesh link
  steep: [-10, 3, -12], // only up a 55° ramp: unreachable
  swamp: [-8, 0.1, 10], // across the swamp or around it
}

/** A box from a unit cube scaled to `size`; fixed, and a nav source (with `area`). */
function box(
  world: World,
  mesh: AssetRef<'Mesh'>,
  material: AssetRef<'Material'>,
  at: Vec3,
  size: Vec3,
  rotation: number[] = [0, 0, 0, 1],
  area = 0,
): Entity {
  return world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], friction: 0.8 }],
    [NavSource, { area }],
    [Mesh3d, { mesh }],
    [MeshMaterial, { material }],
    [Transform, { translation: at, rotation: rotation as never, scale: size }],
  )
}

/** A ramp `width` wide rising toward -z at `degrees` from (x, 0, z) until it climbs `rise`. */
function ramp(
  world: World,
  mesh: AssetRef<'Mesh'>,
  material: AssetRef<'Material'>,
  x: number,
  z: number,
  degrees: number,
  rise: number,
  width: number,
): Entity {
  const a = (degrees * Math.PI) / 180
  const t = 0.4
  const half = rise / Math.sin(a) / 2
  return box(
    world,
    mesh,
    material,
    [x, Math.sin(a) * half - (Math.cos(a) * t) / 2, z - Math.cos(a) * half - (Math.sin(a) * t) / 2],
    [width, t, half * 2],
    [Math.sin(a / 2), 0, 0, Math.cos(a / 2)],
  )
}

/** A random walkable point on the navmesh near (x, z). */
function walkable(world: World, rng: Rng): Vec3 {
  const out: Vec3 = [0, 0, 0]
  for (let i = 0; i < 20; i++) {
    const p: Vec3 = [rng.range(-18, 18), 0.2, rng.range(-4, 18)]
    if (nearestPoint(world, p, out) && Math.hypot(out[0] - p[0], out[2] - p[2]) < 0.5) return out
  }
  return [0, 0, 8]
}

/**
 * Beacon on WASD or the arrows (it rides the navmesh surface), camera orbit on Q/E, and the crowd
 * picking new destinations as each one arrives.
 */
const courtyard = defineSystem({
  name: 'nav-demo/courtyard',
  setup: (world) => ({ arrived: world.reader(NavArrived), angle: 0.6 }),
  run: (s, world) => {
    const d = yard
    if (!d) return
    const dt = world.resource(Time).delta
    const k = d.keys
    const held = (...codes: string[]) => codes.some((c) => k.has(c))
    const dx = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
    const dz = (held('KeyS', 'ArrowDown') ? 1 : 0) - (held('KeyW', 'ArrowUp') ? 1 : 0)
    if (dx !== 0 || dz !== 0) {
      const [x, y, z] = world.get(d.beacon, Transform).translation
      const want: Vec3 = [x + dx * 8 * dt, y, z + dz * 8 * dt]
      const out: Vec3 = [0, 0, 0]
      // Keep it on walkable ground: it slides up the ramp and stops at walls.
      if (nearestPoint(world, want, out)) {
        world.set(d.beacon, Transform, { translation: [out[0], out[1] + 0.4, out[2]] })
      }
    }
    s.angle += ((held('KeyE') ? 1 : 0) - (held('KeyQ') ? 1 : 0)) * dt
    const eye: Vec3 = [Math.sin(s.angle) * 34, 26, Math.cos(s.angle) * 34 + 2]
    world.set(d.camera, Transform, {
      translation: eye,
      rotation: lookAt(eye, [0, 0, 2], [0, 1, 0]),
    })
    for (const e of s.arrived.read()) {
      if (d.crowd.includes(e.entity))
        world.set(e.entity, NavAgent, { destination: walkable(world, d.rng) })
    }
  },
})

export const navDemoPlugin = definePlugin({
  name: 'nav-demo',
  dependencies: ['render/forward', 'physics3d', 'nav'],
  build(app) {
    app.addSystems(Update, courtyard)
    hudExtras.push((world) => {
      const d = yard
      if (!d) return []
      const nav = describeNav(world)
      const mesh = nav.meshes[0] as ReturnType<typeof describeNav>['meshes'][number] & {
        tiles?: number
        polygons?: number
        lastBake?: { ms: number; built: number; fromCache: number; kept: number }
        tilesBuilt?: number
      }
      const status = (e: Entity) => world.get(e, NavAgentState).status
      const counts: Record<string, number> = {}
      for (const e of d.followers) counts[status(e)] = (counts[status(e)] ?? 0) + 1
      const f = world.get(d.followers[0]!, NavAgentState)
      return [
        `navmesh   ${mesh?.tiles ?? 0} tiles, ${mesh?.polygons ?? 0} polys, ${nav.sources.links} link`,
        mesh?.lastBake
          ? `last bake ${mesh.lastBake.built} built, ${mesh.lastBake.kept} kept, ${mesh.lastBake.fromCache} cached in ${mesh.lastBake.ms} ms (${mesh.tilesBuilt} built total)`
          : 'last bake —',
        `followers ${Object.entries(counts)
          .map(([k, n]) => `${n} ${k}`)
          .join(', ')}   lead ${f.remaining.toFixed(1)} m to go`,
        `crowd     ${d.crowd.length} agents wandering   swamp cost ${d.swamp}`,
        `wasd/arrows: move the beacon   q/e: orbit   n: navmesh overlay`,
      ]
    })
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const mat = materials(world)
    world.resource(AmbientLight).brightness = 900
    world.spawn(
      [DirectionalLight, { illuminance: 60_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.5, 0) as never }],
    )
    const camera = world.spawn(
      [Camera3d, { fovY: 50, clearColor: [0.03, 0.035, 0.05, 1] }],
      [Exposure, { ev100: 13 }],
      [Transform, {}],
    )
    const unit = meshes.add(cube({ size: 1 }))
    const ground = mat({ baseColor: [0.32, 0.34, 0.38, 1], roughness: 0.9 })
    const stone = mat({ baseColor: [0.55, 0.56, 0.6, 1], roughness: 0.8 })
    const ok = mat({ baseColor: [0.3, 0.6, 0.42, 1], roughness: 0.7 })
    const steep = mat({ baseColor: [0.8, 0.3, 0.25, 1], roughness: 0.7 })
    const mud = mat({ baseColor: [0.28, 0.36, 0.16, 1], roughness: 1 })
    const wood = mat({ baseColor: [0.6, 0.42, 0.25, 1], roughness: 0.8 })

    world.spawn([NavMesh, { tileSize: 48, agentRadius: 0.4, maxSlope: 40 }])
    box(world, unit, ground, [0, -0.5, 0], [40, 1, 40])
    // Upper floor up a 27° ramp, and a platform only a 55° ramp reaches.
    box(world, unit, stone, [10, 1.5, -12], [12, 3, 10])
    ramp(world, unit, ok, 10, -1, 26.6, 3, 4)
    box(world, unit, stone, [-10, 1.5, -12], [8, 3, 8])
    ramp(world, unit, steep, -10, -6.4, 55, 3, 3)
    // A swamp (area 1): paths go around it unless its cost is low.
    box(world, unit, mud, [-8, 0.05, 6], [12, 0.1, 6], undefined, 1)
    // A ledge too high to step onto, reached by jumping: an off-mesh link from the ground.
    box(world, unit, wood, [17, 0.6, 12], [6, 1.2, 8])
    const landing = world.spawn([Transform, { translation: [15.4, 1.2, 12] }])
    world.spawn(
      [OffMeshLink, { to: landing, radius: 0.6 }],
      [Transform, { translation: [12.8, 0, 12] }],
    )
    // A crate that moves: each move rebuilds only the tiles it touches.
    const rock = box(world, unit, wood, [2, 0.75, 6], [1.5, 1.5, 1.5])
    setNavAreas(world, { 0: 1, 1: 6 })

    const rng = new Rng(11)
    const beaconMat = mat({
      baseColor: [1, 0.85, 0.3, 1],
      emissive: [1, 0.8, 0.2, 1],
      emissiveLuminance: 3000,
    })
    const beacon = world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 0.35 })) }],
      [MeshMaterial, { material: beaconMat }],
      [Transform, { translation: [0, 0.4, 14] }],
    )
    const body = meshes.add(capsule({ radius: 0.35, height: 1.8, segments: 16, rings: 4 }))
    const hero = mat({ baseColor: [0.25, 0.6, 0.95, 1], roughness: 0.4 })
    const followers: Entity[] = []
    for (let i = 0; i < 6; i++) {
      followers.push(
        world.spawn(
          [CharacterController, {}],
          [NavAgent, { target: beacon, drive: 'character', speed: 4, stoppingDistance: 1.2 }],
          [Mesh3d, { mesh: body }],
          [MeshMaterial, { material: hero }],
          [Transform, { translation: [-4 + i * 1.6, 0.95, 16] }],
        ),
      )
    }
    const small = meshes.add(capsule({ radius: 0.3, height: 1.2, segments: 12, rings: 3 }))
    const npc = mat({ baseColor: [0.9, 0.6, 0.2, 1], roughness: 0.6 })
    const crowd: Entity[] = []
    for (let i = 0; i < 40; i++) {
      const at: Vec3 = [rng.range(-16, 16), 0.6, rng.range(-2, 16)]
      crowd.push(
        world.spawn(
          [
            NavAgent,
            { destination: at, radius: 0.35, speed: rng.range(1.5, 3), drive: 'transform' },
          ],
          [Mesh3d, { mesh: small }],
          [MeshMaterial, { material: npc }],
          [Transform, { translation: [rng.range(-16, 16), 0.6, rng.range(-2, 16)] }],
        ),
      )
    }
    yard = { beacon, followers, crowd, rock, rockAt: 2, swamp: 6, keys: new Set(), rng, camera }
    setOverlays(world, { navmesh: true })

    const place = (spot: Vec3) =>
      world.set(beacon, Transform, { translation: [spot[0], spot[1] + 0.4, spot[2]] })
    onButtons('nav', {
      overlay: () => toggleOverlay(world),
      rock: () => {
        yard!.rockAt = yard!.rockAt === 2 ? 6 : 2
        world.set(rock, Transform, { translation: [yard!.rockAt, 0.75, 6] })
      },
      swamp: () => {
        yard!.swamp = yard!.swamp === 6 ? 1 : yard!.swamp === 1 ? 0 : 6
        setNavAreas(world, { 0: 1, 1: yard!.swamp })
      },
      upper: () => place(SPOTS.upper!),
      ledge: () => place(SPOTS.ledge!),
      steep: () => place(SPOTS.steep!),
      across: () => place(SPOTS.swamp!),
    })
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return
      yard?.keys.add(event.code)
      if (event.code === 'KeyN') toggleOverlay(world)
    })
    window.addEventListener('keyup', (event) => yard?.keys.delete(event.code))
    window.addEventListener('blur', () => yard?.keys.clear())
    // For poking at from the console: the lead follower's path to the beacon.
    Object.assign(globalThis, {
      navPath: () =>
        findPath(
          world,
          world.get(followers[0]!, Transform).translation,
          world.get(beacon, Transform).translation,
        ),
      nav: () => world.resource(Nav),
    })
  },
})

// --- 2D: a grid maze -----------------------------------------------------------------

const MAZE_W = 41
const MAZE_H = 25

interface Maze {
  grid: NavGridData
  walls: (Entity | null)[]
  target: Entity
  chasers: Entity[]
  camera: Entity
  wall: AssetRef<'Material'>
  unit: AssetRef<'Mesh'>
  keys: Set<string>
}

let maze: Maze | undefined

function carve(grid: NavGridData, rng: Rng): void {
  const stack = [1 + MAZE_W]
  grid.costs.fill(0)
  grid.costs[1 + MAZE_W] = 1
  while (stack.length > 0) {
    const cur = stack[stack.length - 1]!
    const x = cur % MAZE_W
    const y = (cur - x) / MAZE_W
    const next: [number, number][] = []
    for (const [dx, dy] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx > 0 && ny > 0 && nx < MAZE_W - 1 && ny < MAZE_H - 1 && grid.get(nx, ny) === 0)
        next.push([dx, dy])
    }
    if (next.length === 0) {
      stack.pop()
      continue
    }
    const [dx, dy] = next[rng.int(0, next.length - 1)]!
    grid.costs[(y + dy / 2) * MAZE_W + x + dx / 2] = 1
    grid.costs[(y + dy) * MAZE_W + x + dx] = 1
    stack.push((y + dy) * MAZE_W + x + dx)
  }
  // Knock out some walls so there are loops to take.
  for (let i = 0; i < 90; i++) {
    const x = rng.int(1, MAZE_W - 2)
    const y = rng.int(1, MAZE_H - 2)
    if ((x + y) % 2 === 1) grid.costs[y * MAZE_W + x] = 1
  }
  grid.version++
}

function spawnWall(world: World, m: Maze, x: number, y: number): Entity {
  return world.spawn(
    [Mesh3d, { mesh: m.unit }],
    [MeshMaterial, { material: m.wall }],
    [Transform, { translation: [x + 0.5, y + 0.5, 0], scale: [1, 1, 1] }],
  )
}

/** The target on the arrows or WASD (stopped by walls), and clicks toggling walls. */
const chase = defineSystem({
  name: 'nav2d-demo/chase',
  run: (_, world) => {
    const m = maze
    if (!m) return
    const dt = world.resource(Time).delta
    const k = m.keys
    const held = (...codes: string[]) => codes.some((c) => k.has(c))
    const dx = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
    const dy = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0)
    if (dx === 0 && dy === 0) return
    const [x, y, z] = world.get(m.target, Transform).translation
    const r = 0.3
    const open = (px: number, py: number) =>
      m.grid.get(Math.floor(px - r), Math.floor(py - r)) > 0 &&
      m.grid.get(Math.floor(px + r), Math.floor(py - r)) > 0 &&
      m.grid.get(Math.floor(px - r), Math.floor(py + r)) > 0 &&
      m.grid.get(Math.floor(px + r), Math.floor(py + r)) > 0
    let nx = x + dx * 6 * dt
    if (!open(nx, y)) nx = x
    let ny = y + dy * 6 * dt
    if (!open(nx, ny)) ny = y
    world.set(m.target, Transform, { translation: [nx, ny, z] })
  },
})

export const nav2dDemoPlugin = definePlugin({
  name: 'nav2d-demo',
  dependencies: ['render/forward', 'nav/grid'],
  build(app) {
    app.addSystems(Update, chase)
    hudExtras.push((world) => {
      const m = maze
      if (!m) return []
      const counts: Record<string, number> = {}
      for (const e of m.chasers) {
        const s = world.get(e, NavAgentState).status
        counts[s] = (counts[s] ?? 0) + 1
      }
      return [
        `grid      ${MAZE_W}×${MAZE_H}, ${m.chasers.length} chasers: ${Object.entries(counts)
          .map(([k, n]) => `${n} ${k}`)
          .join(', ')}`,
        'wasd/arrows: run   click: add or remove a wall   n: grid overlay',
      ]
    })
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const mat = materials(world)
    world.resource(AmbientLight).brightness = 2500
    const camera = world.spawn(
      [
        Camera3d,
        {
          projection: 'orthographic',
          orthoHeight: MAZE_H + 1,
          clearColor: [0.02, 0.022, 0.03, 1],
        },
      ],
      [Exposure, { ev100: 11 }],
      [Transform, { translation: [MAZE_W / 2, MAZE_H / 2, 20] }],
    )
    const grid = new NavGridData(MAZE_W, MAZE_H)
    carve(grid, new Rng(3))
    world.spawn(
      [NavGrid, { source: 'data', data: world.resource(NavGridDatas).add(grid) }],
      [Transform, {}],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 1 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.06, 0.07, 0.09, 1], roughness: 1 }) }],
      [
        Transform,
        {
          translation: [MAZE_W / 2, MAZE_H / 2, -0.6],
          rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          scale: [MAZE_W, 1, MAZE_H],
        },
      ],
    )
    const m: Maze = {
      grid,
      walls: [],
      target: 0,
      chasers: [],
      camera,
      wall: mat({ baseColor: [0.3, 0.36, 0.5, 1], roughness: 0.7 }),
      unit: meshes.add(cube({ size: 1 })),
      keys: new Set(),
    }
    for (let y = 0; y < MAZE_H; y++) {
      for (let x = 0; x < MAZE_W; x++)
        m.walls.push(grid.get(x, y) === 0 ? spawnWall(world, m, x, y) : null)
    }
    const ball = meshes.add(sphere({ radius: 0.35 }))
    m.target = world.spawn(
      [Mesh3d, { mesh: ball }],
      [
        MeshMaterial,
        {
          material: mat({
            baseColor: [0.35, 0.9, 0.55, 1],
            emissive: [0.3, 1, 0.5, 1],
            emissiveLuminance: 800,
          }),
        },
      ],
      [Transform, { translation: [MAZE_W - 1.5, 1.5, 0] }],
    )
    const red = mat({
      baseColor: [0.95, 0.3, 0.3, 1],
      emissive: [1, 0.3, 0.3, 1],
      emissiveLuminance: 400,
    })
    const rng = new Rng(21)
    while (m.chasers.length < 60) {
      const x = rng.int(1, MAZE_W - 2)
      const y = rng.int(1, MAZE_H - 2)
      if (grid.get(x, y) === 0 || x > MAZE_W - 8) continue
      m.chasers.push(
        world.spawn(
          [
            NavAgent,
            {
              target: m.target,
              speed: rng.range(2, 4),
              radius: 0.3,
              drive: 'transform',
              stoppingDistance: 0.5,
            },
          ],
          [Mesh3d, { mesh: ball }],
          [MeshMaterial, { material: red }],
          [Transform, { translation: [x + 0.5, y + 0.5, 0], scale: [0.7, 0.7, 0.7] }],
        ),
      )
    }
    maze = m
    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    canvas.addEventListener('pointerdown', (event) => {
      // Orthographic, looking down -Z at the maze's center: pixels map straight to cells.
      const rect = canvas.getBoundingClientRect()
      const h = MAZE_H + 1
      const w = (h * rect.width) / rect.height
      const x = Math.floor(MAZE_W / 2 + ((event.clientX - rect.left) / rect.width - 0.5) * w)
      const y = Math.floor(MAZE_H / 2 - ((event.clientY - rect.top) / rect.height - 0.5) * h)
      if (x <= 0 || y <= 0 || x >= MAZE_W - 1 || y >= MAZE_H - 1) return
      const i = y * MAZE_W + x
      if (grid.get(x, y) === 0) {
        grid.set(x, y, 1)
        world.despawn(m.walls[i]!)
        m.walls[i] = null
      } else {
        grid.set(x, y, 0)
        m.walls[i] = spawnWall(world, m, x, y)
      }
    })
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return
      maze?.keys.add(event.code)
      if (event.code === 'KeyN') toggleOverlay(world)
    })
    window.addEventListener('keyup', (event) => maze?.keys.delete(event.code))
    window.addEventListener('blur', () => maze?.keys.clear())
  },
})
