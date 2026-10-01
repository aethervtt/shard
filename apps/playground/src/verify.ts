// Verification fixture (0062): what `shard capture` plans run against in Shard's own repo. A small
// tabletop with the things the replacement gates ask about: a textured grid seen close and far,
// tokens with transparent edges and shadows, day and night, a map view and an oblique table view,
// a missing-asset fallback, DOM labels over the canvas, and a transparent dice surface.
//
// Roles and the visibility flow: `?role=gm` sees every token; `?role=player` sees the hero and
// what's within its vision, under fog. There is no server here: every client applies the same
// plan steps to its own copy of the session, and its world is that copy's projection for its
// role. `disconnect` stops applying (the steps still reach the session), and `reconnect` applies
// only the documents that changed while away. `?fault=keep-token` and `?fault=keep-scene` break
// the player's projection on purpose, so a plan can show that its checks catch it.

import { type AssetRef, defineComponent, type Entity, t } from '@aethervtt/shard-core'
import { DICE_SKINS, type DiceRoll, DiceTable, dicePlugin } from '@aethervtt/shard-dice'
import { diceWorker } from '@aethervtt/shard-dice/worker'
import { createGpuContext } from '@aethervtt/shard-gpu'
import { cylinder, plane } from '@aethervtt/shard-mesh'
import { createWebPerformance } from '@aethervtt/shard-platform-web'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  renderPlugin,
} from '@aethervtt/shard-render'
import { App, animationFrameRunner, FrameDemand } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { metricsPlugin } from '@aethervtt/shard-verify/metrics'
import { installCapturePage } from '@aethervtt/shard-verify/page'
import { graphicsOptions } from './backend'

type Vec2 = [number, number]
type Vec3 = [number, number, number]
type Color = [number, number, number, number]
type SceneName = 'keep' | 'crypt'

const params = new URLSearchParams(location.search)
const role = params.get('role') === 'player' ? 'player' : 'gm'
const fault = params.get('fault')

/** How far the hero sees, in meters (cells). */
const VISION = 4.5
/** The board is BOARD × BOARD cells of 1 m. */
const BOARD = 16

// --- the session: what a server would hold --------------------------------------------------------

interface PieceDoc {
  scene: SceneName
  at: Vec2
  color: Color
}

const session = {
  scene: 'keep' as SceneName,
  pieces: new Map<string, PieceDoc>([
    ['hero', { scene: 'keep', at: [-2.5, 1.5], color: [0.25, 0.45, 0.85, 1] }],
    ['goblin', { scene: 'keep', at: [4.5, -3.5], color: [0.8, 0.25, 0.2, 1] }],
    ['wolf', { scene: 'keep', at: [-5.5, -4.5], color: [0.55, 0.55, 0.6, 1] }],
    ['ogre', { scene: 'keep', at: [5.5, 5.5], color: [0.35, 0.65, 0.3, 1] }],
    ['skeleton', { scene: 'crypt', at: [1.5, -1.5], color: [0.9, 0.88, 0.8, 1] }],
    ['wraith', { scene: 'crypt', at: [-4.5, 3.5], color: [0.5, 0.3, 0.7, 1] }],
  ]),
}
// The hero travels with the party: it's on whichever scene is active.
const inScene = (name: string, doc: PieceDoc) => name === 'hero' || doc.scene === session.scene

const distance = (a: Vec2, b: Vec2) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

/** What this client's role is shown of the session: names of the pieces it may know about. */
function projection(): string[] {
  const hero = session.pieces.get('hero')!
  const names: string[] = []
  for (const [name, doc] of session.pieces) {
    if (!inScene(name, doc)) continue
    if (role === 'player' && name !== 'hero' && distance(doc.at, hero.at) > VISION) continue
    names.push(name)
  }
  return names.sort()
}

// --- the page ---------------------------------------------------------------------------------------

const tableCanvas = document.getElementById('table') as HTMLCanvasElement
const diceCanvas = document.getElementById('dice') as HTMLCanvasElement
const labels = document.getElementById('labels') as HTMLElement
;(document.getElementById('role') as HTMLElement).textContent = `role: ${role}`
const sceneLabel = document.getElementById('scene') as HTMLElement

/** A piece in the world: which one, and the scene it came from. */
const Piece = defineComponent('playground/Piece', {
  name: t.string(),
  scene: t.string(),
})

// `?backend=` picks the API, as on every playground page (0064).
const gpu = await createGpuContext({ features: ['timestamp-query'], ...graphicsOptions() })
const runner = () => animationFrameRunner({ mode: 'on-demand' })

// --- textures -----------------------------------------------------------------------------------------

/** The board: light felt with a line every cell, so filtering shows close up and far away. */
function gridTexture(): Texture {
  const size = 1024
  const cell = size / BOARD
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const line = x % cell < 2 || y % cell < 2
      const noise = ((x * 73856093) ^ (y * 19349663)) & 7
      const v = line ? 70 : 200 + noise
      const o = (y * size + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return Texture.create({ width: size, height: size, mips: [data], mipmaps: true })
}

/** A token's art: a disc with a rim, transparent past a feathered edge. */
function tokenArt(color: Color): Texture {
  const size = 128
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.sqrt((x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2)
      const alpha = Math.max(0, Math.min(1, 62 - r))
      const rim = r > 52
      const emblem = Math.abs(x - size / 2) < 6 || Math.abs(y - size / 2) < 6
      const o = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        const base = rim ? 0.95 : emblem ? color[c]! * 0.5 : color[c]!
        data[o + c] = Math.round(base * 255)
      }
      data[o + 3] = Math.round(alpha * 255)
    }
  }
  return Texture.create({ width: size, height: size, mips: [data], mipmaps: true })
}

// --- the table ---------------------------------------------------------------------------------------

interface Token {
  base: Entity
  art: Entity
  artMaterial: MaterialAsset
  artRef: AssetRef<'Texture'>
}

const tokens = new Map<string, Token>()
let fog: Entity[] = []

const table = new App().addPlugin(
  TransformPlugin,
  renderPlugin({ gpu, surface: gpu.addSurface(tableCanvas), owner: 'table' }),
  forwardPlugin(),
  metricsPlugin({ performance: createWebPerformance(), renderer: 'shard' }),
)
await table.init()
const w = table.world
const meshes = w.resource(Meshes)
const materials = w.resource(Materials)
const textures = w.resource(Textures)

const tokenMesh = meshes.add(cylinder({ radius: 0.4, height: 0.2 }))
const artMesh = meshes.add(plane({ size: 0.8 }))
const fogMesh = meshes.add(plane({ size: 1 }))
const fogMaterial = materials.add(
  new MaterialAsset({ baseColor: [0.01, 0.012, 0.02, 0.88], alphaMode: 'alpha', roughness: 1 }),
)
// A texture that isn't there: materials pointing at it show the missing-asset fallback.
const missing = textures.add(tokenArt([1, 0, 1, 1]))
textures.delete(missing.guid!)

const groundMaterial = new MaterialAsset({
  baseColor: [0.42, 0.56, 0.4, 1],
  roughness: 0.95,
  baseColorTexture: { texture: textures.add(gridTexture()) },
})
w.spawn(
  [Mesh3d, { mesh: meshes.add(plane({ size: BOARD })) }],
  [MeshMaterial, { material: materials.add(groundMaterial) }],
  Transform,
)
const sun = w.spawn(
  [DirectionalLight, { illuminance: 25_000, shadows: true }],
  [Transform, { rotation: lookAt([-4, 10, 5], [0, 0, 0]) }],
)
const camera = w.spawn(
  [Camera3d, { fovY: 40, clearColor: [0.05, 0.06, 0.08, 1] }],
  [Exposure, { ev100: 13 }],
  Transform,
)

function spawnToken(name: string, doc: PieceDoc): Token {
  const artRef = textures.add(tokenArt(doc.color))
  const artMaterial = new MaterialAsset({
    alphaMode: 'alpha',
    roughness: 0.6,
    baseColorTexture: { texture: artRef },
  })
  const base = w.spawn(
    [Piece, { name, scene: doc.scene }],
    [Mesh3d, { mesh: tokenMesh }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({ baseColor: [0.12, 0.1, 0.09, 1], roughness: 0.7 }),
        ),
      },
    ],
    [Transform, { translation: [doc.at[0], 0.1, doc.at[1]] }],
  )
  const art = w.spawn(
    [Mesh3d, { mesh: artMesh }],
    [MeshMaterial, { material: materials.add(artMaterial) }],
    NotShadowCaster,
    [Transform, { translation: [doc.at[0], 0.205, doc.at[1]] }],
  )
  return { base, art, artMaterial, artRef }
}

function despawnToken(name: string): void {
  const token = tokens.get(name)!
  w.despawn(token.base)
  w.despawn(token.art)
  tokens.delete(name)
}

/** The cells the hero can't see, for the player; none for the GM. */
function fogCells(): Vec2[] {
  if (role !== 'player') return []
  const hero = session.pieces.get('hero')!.at
  const cells: Vec2[] = []
  for (let z = 0; z < BOARD; z++) {
    for (let x = 0; x < BOARD; x++) {
      const center: Vec2 = [x - BOARD / 2 + 0.5, z - BOARD / 2 + 0.5]
      if (distance(center, hero) > VISION) cells.push(center)
    }
  }
  return cells
}

/** Fog over every cell the hero can't see. */
function syncFog(): void {
  for (const e of fog) w.despawn(e)
  fog = fogCells().map((center) =>
    w.spawn(
      [Mesh3d, { mesh: fogMesh }],
      [MeshMaterial, { material: fogMaterial }],
      NotShadowCaster,
      [Transform, { translation: [center[0], 0.02, center[1]] }],
    ),
  )
}

let shownScene: SceneName | undefined
const shownAt = new Map<string, string>()

/**
 * Makes the world match this client's projection of the session, touching only what differs.
 * Returns how many documents it applied (a spawn, a move, a despawn, the scene), for mirror counts.
 */
function sync(): number {
  let applied = 0
  const wanted = new Set(projection())
  if (shownScene !== session.scene) {
    shownScene = session.scene
    groundMaterial.set({
      baseColor: session.scene === 'keep' ? [0.42, 0.56, 0.4, 1] : [0.36, 0.34, 0.42, 1],
    })
    sceneLabel.textContent = `scene: ${session.scene}`
    applied++
  }
  let keptOld = false
  for (const name of [...tokens.keys()]) {
    if (wanted.has(name)) continue
    const doc = session.pieces.get(name)!
    // Faults on purpose: a player that keeps what it shouldn't.
    if (role === 'player' && fault === 'keep-token' && inScene(name, doc)) continue
    if (fault === 'keep-scene' && !inScene(name, doc) && !keptOld) {
      keptOld = true
      continue
    }
    despawnToken(name)
    shownAt.delete(name)
    applied++
  }
  for (const name of wanted) {
    const doc = session.pieces.get(name)!
    const key = `${doc.at[0]},${doc.at[1]}`
    if (!tokens.has(name)) tokens.set(name, spawnToken(name, doc))
    else if (shownAt.get(name) === key) continue
    else {
      const token = tokens.get(name)!
      w.set(token.base, Transform, { translation: [doc.at[0], 0.1, doc.at[1]] })
      w.set(token.art, Transform, { translation: [doc.at[0], 0.205, doc.at[1]] })
    }
    if (name === 'hero') syncFog()
    shownAt.set(name, key)
    applied++
  }
  applyBreaks()
  placeLabels()
  return applied
}

// --- views ---------------------------------------------------------------------------------------------

interface ViewState {
  view: 'map' | 'tabletop'
  zoom: number
  target: Vec3
  pitch: number
  yaw: number
  lighting: 'day' | 'night'
  break: string[]
  labels: boolean
}

const DEFAULT_VIEW: ViewState = {
  view: 'tabletop',
  zoom: 1,
  target: [0, 0, 0],
  pitch: 50,
  yaw: 0,
  lighting: 'day',
  break: [],
  labels: true,
}
let view: ViewState = { ...DEFAULT_VIEW }
let eye: Vec3 = [0, 0, 0]
let up: Vec3 = [0, 1, 0]

/** Every shot starts from the defaults, so shots don't depend on the order they're taken in. */
function applyView(state: Partial<ViewState>): void {
  view = { ...DEFAULT_VIEW, ...state }
  const [tx, ty, tz] = view.target
  if (view.view === 'map') {
    eye = [tx, 40, tz]
    up = [0, 0, -1]
    w.set(camera, Camera3d, {
      projection: 'orthographic',
      orthoHeight: BOARD / view.zoom,
      near: 0.1,
      far: 100,
    })
  } else {
    const pitch = (view.pitch * Math.PI) / 180
    const yaw = (view.yaw * Math.PI) / 180
    const d = 22 / view.zoom
    eye = [
      tx + d * Math.sin(yaw) * Math.cos(pitch),
      ty + d * Math.sin(pitch),
      tz + d * Math.cos(yaw) * Math.cos(pitch),
    ]
    up = [0, 1, 0]
    w.set(camera, Camera3d, { projection: 'perspective', fovY: 40, near: 0.1 })
  }
  w.set(camera, Transform, { translation: eye, rotation: lookAt(eye, view.target, up) })
  const night = view.lighting === 'night'
  w.patchResource(AmbientLight, {
    brightness: night ? 90 : 350,
    color: night ? [0.5, 0.6, 1] : [1, 1, 1],
  })
  w.set(sun, DirectionalLight, {
    illuminance: night ? 4000 : 25_000,
    color: night ? [0.6, 0.7, 1, 1] : [1, 0.97, 0.92, 1],
    shadows: true,
  })
  applyBreaks()
  placeLabels()
}

function applyBreaks(): void {
  const broken = view.break.includes('token-art')
  for (const token of tokens.values()) {
    const texture = broken ? missing : token.artRef
    if (token.artMaterial.value.baseColorTexture?.texture?.guid === texture.guid) continue
    token.artMaterial.set({ baseColorTexture: { texture } })
  }
}

/** A world point to CSS pixels over the table canvas, through the camera's basis. */
function toScreen(p: Vec3): Vec2 | undefined {
  const f = normalize([view.target[0] - eye[0], view.target[1] - eye[1], view.target[2] - eye[2]])
  const r = normalize(cross(f, up))
  const u = cross(r, f)
  const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]
  const x = dot(d, r)
  const y = dot(d, u)
  const z = dot(d, f)
  const width = tableCanvas.clientWidth
  const height = tableCanvas.clientHeight
  const aspect = width / height
  let nx: number
  let ny: number
  if (view.view === 'map') {
    const half = BOARD / view.zoom / 2
    nx = x / (half * aspect)
    ny = y / half
  } else {
    if (z <= 0.1) return undefined
    const tan = Math.tan((40 * Math.PI) / 360)
    nx = x / (z * tan * aspect)
    ny = y / (z * tan)
  }
  return [((nx + 1) / 2) * width, ((1 - ny) / 2) * height]
}

function placeLabels(): void {
  labels.replaceChildren()
  if (!view.labels) return
  for (const name of [...tokens.keys()].sort()) {
    const doc = session.pieces.get(name)!
    const at = toScreen([doc.at[0], 0.3, doc.at[1]])
    if (!at) continue
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = name
    label.style.left = `${at[0].toFixed(1)}px`
    label.style.top = `${at[1].toFixed(1)}px`
    labels.append(label)
  }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Vec3): Vec3 => {
  const l = Math.sqrt(dot(a, a))
  return [a[0] / l, a[1] / l, a[2] / l]
}

// --- the dice: a transparent surface (0052) with the dice table (0054) ------------------------------------

// `?focus=dice`: the dice surface covers the page, as a VTT's dice overlay does, and its app records
// the scenario's metrics (the page API records from the first app that has them).
const focusDice = params.get('focus') === 'dice'
if (focusDice) diceCanvas.style.cssText = 'right: 0; bottom: 0; width: 100%; height: 100%;'

const dice = new App().addPlugin(
  TransformPlugin,
  renderPlugin({
    gpu,
    surface: gpu.addSurface(diceCanvas, { alpha: 'premultiplied' }),
    owner: 'dice',
  }),
  forwardPlugin(),
  ...(focusDice ? [metricsPlugin({ performance: createWebPerformance(), renderer: 'shard' })] : []),
  // Dice stay on the table until the next roll: captures see them at rest.
  dicePlugin({ worker: diceWorker, restMs: 1e9 }),
)
await dice.init()
const diceTable = dice.world.resource(DiceTable)
void diceTable.tracks().ready()

const KINDS = ['d20', 'd6', 'd8', 'd12', 'd10', 'd4', 'd100'] as const
const SKINS = [
  DICE_SKINS.ivory,
  DICE_SKINS.teal,
  DICE_SKINS.brass,
  DICE_SKINS.obsidian,
  DICE_SKINS.frost,
  DICE_SKINS.ember,
]

/** A roll of `count` mixed dice, values from the seed's position in the cycle. */
function mixedRoll(id: string, count: number): DiceRoll {
  return {
    id,
    dice: Array.from({ length: count }, (_, i) => {
      const kind = KINDS[i % KINDS.length]!
      const sides = kind === 'd100' ? 100 : Number(kind.slice(1))
      return { kind, value: ((i * 7) % sides) + 1, skin: SKINS[i % SKINS.length]! }
    }),
  }
}

// At rest from the start: two dice on a fixed tray, placed (reduced motion), for the static shots.
void diceTable.play({
  id: 'verify-start',
  motion: 'reduced',
  tray: { halfWidth: 1.7, halfDepth: 1.15 },
  dice: [
    { kind: 'd20', value: 20, skin: DICE_SKINS.obsidian },
    { kind: 'd6', value: 5, skin: DICE_SKINS.ivory },
  ],
})

// --- steps and probes for plans ---------------------------------------------------------------------------

let connected = true
const changedWhileAway = new Set<string>()
let lastReconnect = { applied: 0, changed: 0 }

/** A change reaches the session; a connected client applies it at once. */
function change(doc: string): void {
  if (connected) sync()
  else changedWhileAway.add(doc)
}

const steps: Record<string, (args: unknown) => unknown> = {
  /** Rolls `count` mixed dice (default 32) with physics; the capture waits until they rest. */
  roll(args) {
    const { count = 32, seed = 'verify-roll' } = (args ?? {}) as { count?: number; seed?: string }
    void diceTable.play({ ...mixedRoll(seed, count), seed }, { replace: true })
  },
  move(args) {
    const { name, to } = args as { name: string; to: Vec2 }
    const doc = session.pieces.get(name)
    if (!doc) throw new Error(`No piece "${name}"`)
    doc.at = [to[0], to[1]]
    change(`piece:${name}`)
  },
  switchScene(args) {
    session.scene = (args as { scene: SceneName }).scene
    change('scene')
  },
  disconnect() {
    connected = false
    changedWhileAway.clear()
  },
  reconnect() {
    connected = true
    lastReconnect = { applied: sync(), changed: changedWhileAway.size }
    changedWhileAway.clear()
  },
  /** Orbits the table camera for `seconds`, for measured scenarios: a frame every refresh. */
  pan(args) {
    const seconds = (args as { seconds?: number } | null)?.seconds ?? 5
    const start = performance.now()
    const demand = w.resource(FrameDemand)
    demand.hold('verify/pan')
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000
      applyView({ ...view, yaw: (elapsed / seconds) * 90 })
      if (elapsed < seconds) requestAnimationFrame(tick)
      else demand.release('verify/pan')
    }
    requestAnimationFrame(tick)
  },
}

function diceProbe() {
  const d = diceTable.describe() as {
    phase: string
    dice: { value: number; shown: number | null; placed: string | null }[]
    track: { settled: boolean } | null
    lastError: { code: string } | null
  }
  return {
    phase: d.phase,
    count: d.dice.length,
    asked: d.dice.map((x) => x.value),
    shown: d.dice.map((x) => x.shown),
    placed: d.dice.filter((x) => x.placed).length,
    settled: d.track?.settled ?? null,
    error: d.lastError?.code ?? null,
  }
}

function probe() {
  const names: string[] = []
  const scenes: Record<string, string> = {}
  for (const e of w.query({ with: [Piece] }).entities()) {
    const piece = w.get(e, Piece)
    names.push(piece.name)
    scenes[piece.name] = piece.scene
  }
  names.sort()
  const positions = (list: readonly string[]) =>
    Object.fromEntries(list.map((n) => [n, [...session.pieces.get(n)!.at]]))
  const shown = (list: readonly string[]) =>
    Object.fromEntries(
      list.map((n) => {
        const t = w.get(tokens.get(n)!.base, Transform).translation
        return [n, [t[0], t[2]]]
      }),
    )
  const fresh = projection()
  return {
    role,
    scene: session.scene,
    connected,
    entities: names,
    positions: shown(names.filter((n) => tokens.has(n))),
    fog: fog.length,
    // Entities left over from a scene that isn't active: 0 at baseline (0061's owner counts).
    owners: { oldScene: names.filter((n) => n !== 'hero' && scenes[n] !== session.scene).length },
    // What a fresh load of the same state would show this client.
    fresh: { entities: fresh, positions: positions(fresh), fog: fogCells().length },
    // Documents re-applied at the last reconnect, and how many changed while away (0055).
    mirror: lastReconnect,
    // The dice table (0054): where the roll is, and whether every die shows what was asked.
    dice: diceProbe(),
  }
}

sync()
applyView({})
table.setRunner(runner())
dice.setRunner(runner())
void table.run()
void dice.run()
table.markUsable()
dice.markUsable()
installCapturePage(focusDice ? [dice, table] : [table, dice], {
  apply: (state) => applyView(state),
  steps,
  probe,
})

Object.assign(globalThis, { table, dice, session, probe })

// A resize moves the labels with the canvas.
window.addEventListener('resize', () => placeLabels())
