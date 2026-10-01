// Embedding (0052): a fake VTT page with two apps on one GPU device. The table renders opaque into
// its canvas; the dice render into a transparent canvas over the whole page, HTML included. Both
// run on demand: with nothing moving, the page requests no animation frames at all.
//
// Tracks (0053): a roll is recorded in a worker on Rapier's deterministic build, then played back
// on the dice. The live roll runs the ECS physics on the regular build: two builds, one page.

import {
  defineSystem,
  type Entity,
  quat,
  Rng,
  type ShardError,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { createGpuContext, type GpuContext, type GpuStats } from '@aethervtt/shard-gpu'
import { inputPlugin } from '@aethervtt/shard-input'
import { cube, cylinder, plane } from '@aethervtt/shard-mesh'
import {
  ParticleEffect,
  ParticleEffects,
  ParticleSystem,
  particlesPlugin,
} from '@aethervtt/shard-particles'
import { Collider, Physics, physics3dPlugin, RigidBody, Velocity } from '@aethervtt/shard-physics'
import {
  sampleTrack,
  TRACK_ENGINE,
  type Track,
  type TrackCollider,
  type TrackScene,
  trackHash,
  trackSceneFromJson,
} from '@aethervtt/shard-physics/track'
import { createTrackClient, type TrackClient, trackWorker } from '@aethervtt/shard-physics/worker'
import { createDomInputSource } from '@aethervtt/shard-platform-web'
import {
  AmbientLight,
  Bloom,
  Camera3d,
  Cameras,
  DirectionalLight,
  describeLens,
  Exposure,
  forwardLensFields,
  forwardPlugin,
  Lens,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  publishLensField,
  renderOwner,
  renderPlugin,
  ShadowCatcher,
} from '@aethervtt/shard-render'
import {
  App,
  animationFrameRunner,
  FrameDemand,
  LogResource,
  type Plugin,
  Time,
} from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
// The 0053 golden track: Node records it in the physics tests; this page records it in Chromium.
import golden from '../../../packages/physics/src/track/golden.json'
import { addBackendSelect, backendLine, graphicsOptions } from './backend'

const tableCanvas = document.getElementById('table') as HTMLCanvasElement
const diceCanvas = document.getElementById('dice') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLElement

// Count animation frame requests, so the HUD can show the page going quiet.
let rafCalls = 0
const raf = window.requestAnimationFrame.bind(window)
window.requestAnimationFrame = (fn) => {
  rafCalls++
  return raf(fn)
}

const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

// Dev builds check that host code wakes the app when it writes a resource (0052).
const runner = () => animationFrameRunner({ mode: 'on-demand', checkResourceWrites: true })

addBackendSelect(document.getElementById('bar') as HTMLElement, 'end')
const gpu: GpuContext = await createGpuContext(graphicsOptions())

// --- FPS: when each app's frames ran ------------------------------------------------------------

const frameTimes = new WeakMap<App, number[]>()

/** Records when each frame of `app` finishes, for the HUD's FPS. */
function meterFrames(app: App): void {
  const times: number[] = []
  frameTimes.set(app, times)
  app.onFrame(() => {
    times.push(performance.now())
    if (times.length > 240) times.splice(0, times.length - 240)
  })
}

/**
 * Frames in the last second (0 while idle), and the rate while frames ran back to back: an
 * on-demand app idles at 0 but should draw at the display's rate when it draws at all.
 */
function fps(app: App): string {
  const times = frameTimes.get(app) ?? []
  const now = performance.now()
  let recent = 0
  for (const t of times) if (now - t <= 1000) recent++
  // The median gap between consecutive frames under 100 ms: idle gaps aren't slow frames.
  const gaps: number[] = []
  for (let i = Math.max(1, times.length - 120); i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!
    if (gap < 100) gaps.push(gap)
  }
  gaps.sort((a, b) => a - b)
  const drawing = gaps.length > 0 ? 1000 / gaps[gaps.length >> 1]! : 0
  return `${String(recent).padStart(3)} fps (${drawing ? drawing.toFixed(0) : '—'} while drawing)`
}

// --- the table: opaque, on its own canvas -------------------------------------------------------

const tokens: Entity[] = []

async function mountTable(): Promise<App> {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, surface: gpu.addSurface(tableCanvas), owner: 'table' }),
    forwardPlugin(),
    // Pointer and keyboard input wake it: hover the table and its frame count moves.
    inputPlugin({ source: createDomInputSource(tableCanvas) }),
  )
  await app.init()
  const w = app.world
  const meshes = w.resource(Meshes)
  const materials = w.resource(Materials)
  w.resource(AmbientLight).brightness = 300
  w.spawn(
    [DirectionalLight, { illuminance: 25_000, shadows: true }],
    [Transform, { rotation: lookAt([-3, 10, 4], [0, 0, 0]) }],
  )
  w.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 30 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({ baseColor: [0.22, 0.3, 0.2, 1], roughness: 0.9 }),
        ),
      },
    ],
    Transform,
  )
  // A one-unit grid, as a VTT table has: straight lines show where a lens field bends it (0063).
  const line = meshes.add(cube({ size: 1 }))
  const ink = materials.add(new MaterialAsset({ baseColor: [0.12, 0.17, 0.11, 1], roughness: 0.9 }))
  for (let i = -8; i <= 8; i++) {
    for (const scale of [
      [0.04, 0.01, 16],
      [16, 0.01, 0.04],
    ] as const) {
      w.spawn([Mesh3d, { mesh: line }], [MeshMaterial, { material: ink }], NotShadowCaster, [
        Transform,
        { translation: scale[0] < 1 ? [i, 0.005, 0] : [0, 0.005, i], scale: [...scale] },
      ])
    }
  }
  const token = meshes.add(cylinder({ radius: 0.45, height: 0.25 }))
  const colors: [number, number, number, number][] = [
    [0.8, 0.25, 0.2, 1],
    [0.25, 0.45, 0.85, 1],
    [0.9, 0.75, 0.3, 1],
    [0.4, 0.75, 0.45, 1],
  ]
  for (let i = 0; i < 8; i++) {
    tokens.push(
      w.spawn(
        [Mesh3d, { mesh: token }],
        [
          MeshMaterial,
          {
            material: materials.add(
              new MaterialAsset({ baseColor: colors[i % 4]!, roughness: 0.5 }),
            ),
          },
        ],
        [Transform, { translation: [(i % 4) * 2.2 - 3.3, 0.125, Math.floor(i / 4) * 3 - 1.5] }],
      ),
    )
  }
  const eye: [number, number, number] = [0, 11, 9]
  w.spawn(
    [Camera3d, { fovY: 45, clearColor: [0.05, 0.06, 0.08, 1] }],
    [Exposure, { ev100: 13 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
    // The table bends its own pixels under the dice's lens fields (0063).
    Lens,
  )
  meterFrames(app)
  app.setRunner(runner())
  void app.run()
  return app
}

// --- the dice: transparent, over the whole page ----------------------------------------------------

interface Dice {
  app: App
  dice: Entity[]
  sparks: Entity | undefined
  /** Records tracks in a worker; disposed with the app. */
  tracks: TrackClient
  /** The roll still recording, which a new roll cancels. */
  recording: AbortController | undefined
}

/** What the HUD shows about tracks. */
const trackNotes = {
  golden: 'recording…',
  last: '—',
  cancel: '—',
}

// --- track playback: sampled every frame, holding the dice app awake until it ends -------------

interface Playback {
  track: Track
  dice: Entity[]
  time: number
}

const playbacks = new WeakMap<World, Playback>()
const pose = { pos: new Float64Array(3), rot: new Float64Array(4) }

const playTracks = defineSystem({
  name: 'embedding/play-tracks',
  run: (_, world) => {
    const p = playbacks.get(world)
    if (!p) return
    // A frame after a long idle gap doesn't skip the throw.
    p.time += Math.min(world.resource(Time).delta, 1 / 20)
    const { pos, rot } = pose
    for (let i = 0; i < p.dice.length; i++) {
      if (!world.isAlive(p.dice[i]!)) continue
      sampleTrack(p.track, p.time, i, pos, rot)
      world.set(p.dice[i]!, Transform, {
        translation: [pos[0]!, pos[1]!, pos[2]!],
        rotation: [rot[0]!, rot[1]!, rot[2]!, rot[3]!],
      })
    }
    const done = p.time >= p.track.steps * p.track.step
    world.resource(FrameDemand).set('dice-track', !done)
    if (done) playbacks.delete(world)
  },
})

/** Stops a playback mid-way, letting go of the frames it held. */
function stopPlayback(world: World): void {
  playbacks.delete(world)
  world.resource(FrameDemand).set('dice-track', false)
}

// --- the black hole (0063): a landed die publishes a lens field the table bends under ------------

interface BlackHole {
  die: Entity
  /** Elapsed time when the die landed; NaN while it's still rolling. */
  start: number
}

const blackHoles = new WeakMap<World, BlackHole>()
const diceCameras = new WeakMap<World, Entity>()
const BLACK_HOLE_S = 4
const holeAt = new Float64Array(2)

/** Where `entity` shows on the dice canvas, in its CSS pixels. False when it's behind the camera. */
function screenOf(world: World, entity: Entity, out: Float64Array): boolean {
  const cam = world.resource(Cameras).get(diceCameras.get(world)!)
  if (!cam) return false
  const p = world.get(entity, Transform).translation
  const x = p[0]!
  const y = p[1]!
  const z = p[2]!
  const m = cam.viewProj
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  if (w <= 0) return false
  const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w
  const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w
  out[0] = ((cx + 1) / 2) * (cam.displayWidth / cam.pixelRatio)
  out[1] = ((1 - cy) / 2) * (cam.displayHeight / cam.pixelRatio)
  return true
}

/**
 * Once the die has landed, it refreshes its field every frame for 4 s, ramping the pull in and out.
 * Then it stops refreshing: the field expires 250 ms later, here and in the table's copy.
 */
const blackHole = defineSystem({
  name: 'embedding/black-hole',
  run: (_, world) => {
    const hole = blackHoles.get(world)
    if (!hole || playbacks.has(world)) return
    const demand = world.resource(FrameDemand)
    const now = world.resource(Time).elapsed
    if (Number.isNaN(hole.start)) hole.start = now
    const t = now - hole.start
    if (t >= BLACK_HOLE_S || !world.isAlive(hole.die) || !screenOf(world, hole.die, holeAt)) {
      blackHoles.delete(world)
      demand.release('black-hole')
      return
    }
    demand.hold('black-hole')
    const ramp = Math.min(1, t / 0.5, (BLACK_HOLE_S - t) / 0.6)
    publishLensField(world, {
      screen: [holeAt[0]!, holeAt[1]!],
      radius: 170 + 12 * Math.sin(t * 4),
      strength: -ramp,
      ttlMs: 250,
      source: hole.die,
    })
  },
})

function trackPlugin(tracks: TrackClient): Plugin {
  return {
    name: 'embedding/dice-tracks',
    build: (app) => void app.addSystems(Update, playTracks, blackHole.after(playTracks)),
    // The worker goes with the app (0052 teardown): 20 mount cycles leave no workers behind.
    dispose: () => tracks.dispose(),
  }
}

const rng = new Rng(7)

const SPARKS = ParticleEffect.fromJson({
  emitters: [
    {
      name: 'sparks',
      capacity: 600,
      spawn: { rate: 0, bursts: [{ time: 0, count: 400 }] },
      shape: { type: 'sphere', radius: 0.3 },
      init: { lifetime: [0.5, 1.1], speed: [2, 6], size: [0.03, 0.07], color: '#ffb347' },
      update: [
        { module: 'gravity', acceleration: [0, -6, 0] },
        { module: 'drag', coefficient: 1.2 },
        {
          module: 'color-over-life',
          gradient: [
            [0, '#ffffff', 1],
            [0.3, '#ffb347', 1],
            [1, '#ff5020', 0],
          ],
        },
      ],
      render: { blend: 'additive', emissive: 40_000 },
    },
  ],
})

async function mountDice(): Promise<Dice> {
  const surface = gpu.addSurface(diceCanvas, { alpha: 'premultiplied', label: 'dice' })
  const tracks = createTrackClient({ spawn: trackWorker })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, surface, owner: 'dice' }),
    forwardPlugin(),
    // The live roll: ECS physics on the main thread, on the regular build.
    physics3dPlugin(),
    particlesPlugin,
    trackPlugin(tracks),
  )
  await app.init()
  const w = app.world
  w.resource(AmbientLight).brightness = 800
  w.spawn(
    [DirectionalLight, { illuminance: 60_000, shadows: true }],
    [Transform, { rotation: lookAt([-3, 10, 4], [0, 0, 0]) }],
  )
  // The tray: an invisible floor that shows only the shadows falling on it, and invisible walls.
  w.spawn(
    [Mesh3d, { mesh: w.resource(Meshes).add(plane({ size: 16 })) }],
    [
      MeshMaterial,
      { material: w.resource(Materials).add(new MaterialAsset({ opacity: 0.55 }, ShadowCatcher)) },
    ],
    NotShadowCaster,
    Transform,
  )
  // The floor's collider, its top face at y = 0 where the catcher is.
  w.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [8, 0.5, 8] }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
  for (const [x, z, hx, hz] of [
    [0, -4, 6, 0.2],
    [0, 3, 6, 0.2],
    [-5.5, 0, 0.2, 5],
    [5.5, 0, 0.2, 5],
  ] as const) {
    w.spawn(
      [RigidBody, { kind: 'fixed' }],
      [Collider, { shape: 'cuboid', halfExtents: [hx, 2, hz] }],
      [Transform, { translation: [x, 2, z] }],
    )
  }
  const eye: [number, number, number] = [0, 10, 8]
  const camera = w.spawn(
    // Alpha 0: nothing drawn shows the page. Bloom's glow raises alpha over it.
    [Camera3d, { fovY: 40, clearColor: [0, 0, 0, 0] }],
    [Exposure, { ev100: 13 }],
    // Only the sparks glow: a threshold keeps the dice from hazing the page around them.
    [Bloom, { intensity: 0.3, threshold: 1500 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
  )
  diceCameras.set(w, camera)
  w.resource(ParticleEffects).add(SPARKS)
  meterFrames(app)
  // The host forwards the dice's lens fields to the table after each dice frame (0063). Fields are
  // in each canvas's CSS pixels, and the table's canvas starts below the top bar: offset them.
  app.onFrame(() => {
    if (table.disposed) return
    const t = tableCanvas.getBoundingClientRect()
    const d = diceCanvas.getBoundingClientRect()
    forwardLensFields(w, table.world, [t.left - d.left, t.top - d.top])
  })
  app.setRunner(runner())
  void app.run()
  // Load the worker's WASM now, so the first roll doesn't wait for it.
  void tracks.ready().catch(() => {})
  return { app, dice: [], sparks: undefined, tracks, recording: undefined }
}

// --- rolling -------------------------------------------------------------------------------------

/** The tray as track colliders: the same floor and walls as the dice app's ECS colliders. */
const TRAY: TrackCollider[] = [
  { shape: 'cuboid', halfExtents: [8, 0.5, 8], translation: [0, -0.5, 0], ...surface(0.6, 0.3) },
  ...(
    [
      [0, -4, 6, 0.2],
      [0, 3, 6, 0.2],
      [-5.5, 0, 0.2, 5],
      [5.5, 0, 0.2, 5],
    ] as const
  ).map(
    ([x, z, hx, hz]): TrackCollider => ({
      shape: 'cuboid',
      halfExtents: [hx, 2, hz],
      translation: [x, 2, z],
      ...surface(0.3, 0.4),
    }),
  ),
]

function surface(friction: number, restitution: number) {
  return { friction, restitution, density: 1 }
}

/** A throw of `count` dice from the tray's right side. The page computes every number. */
function throwScene(count: number, maxSteps = 600): TrackScene {
  return {
    version: 1,
    dim: 3,
    step: 1 / 60,
    maxSteps,
    gravity: [0, -9.81, 0],
    fixed: TRAY,
    bodies: Array.from({ length: count }, (_, i) => ({
      id: `d6-${i}`,
      translation: [
        4 + (i % 3) * 0.3,
        2 + (i % 3) * 0.7 + Math.floor(i / 3) * 0.8,
        rng.range(-1, 1),
      ],
      rotation: q(rng.range(0, 360), rng.range(0, 360), 0),
      linear: [rng.range(-7, -4), rng.range(1, 3), rng.range(-2, 2)],
      angular: [rng.range(-15, 15), rng.range(-15, 15), rng.range(-15, 15)],
      colliders: [{ shape: 'cuboid', halfExtents: [0.3, 0.3, 0.3], ...surface(0.6, 0.3) }],
      ccd: true,
    })),
  }
}

const hex = (h: number) => h.toString(16).padStart(8, '0')
const isCancel = (err: unknown) => (err as ShardError).code === 'physics/track-cancelled'

/** Host code throwing dice: records a track in the worker, then plays it on the dice. */
async function roll(d: Dice, count = 3): Promise<void> {
  d.recording?.abort()
  const recording = new AbortController()
  d.recording = recording
  const started = performance.now()
  let track: Track
  try {
    track = await d.tracks.record(throwScene(count), {
      signal: recording.signal,
      contacts: { minForce: 0.5, dedupeSteps: 3, max: 256 },
    })
  } catch (err) {
    if (!isCancel(err)) trackNotes.last = `failed: ${(err as ShardError).code ?? String(err)}`
    return
  } finally {
    if (d.recording === recording) d.recording = undefined
  }
  const ms = performance.now() - started
  trackNotes.last = `${hex(trackHash(track))}, ${track.steps} steps, ${track.settled ? 'settled' : 'max steps'}, ${track.contacts.steps.length} contacts, ${track.simulationMs.toFixed(1)} ms simulated, ${ms.toFixed(1)} ms round trip, ${((track.positions.byteLength + track.rotations.byteLength) / 1024).toFixed(0)} KB`
  if (d.app.disposed) return
  const dice = spawnDice(d, count, false)
  playbacks.set(d.app.world, { track, dice, time: 0 })
}

/** The old roll: bodies in the dice app's own ECS physics (regular build, main thread). */
function liveRoll(d: Dice): void {
  d.recording?.abort()
  stopPlayback(d.app.world)
  spawnDice(d, 3, true)
}

/** Cancels a long recording mid-way, then rolls: the worker is free again at once. */
async function cancelRoll(d: Dice): Promise<void> {
  const abort = new AbortController()
  const long = d.tracks.record(throwScene(24, 6000), { signal: abort.signal })
  await new Promise((r) => setTimeout(r, 15))
  const abortedAt = performance.now()
  abort.abort()
  const rejected = await long.then(
    () => 'finished before the abort',
    (err: ShardError) =>
      `${err.code} ${(performance.now() - abortedAt).toFixed(2)} ms after abort()`,
  )
  const next = performance.now()
  await roll(d)
  trackNotes.cancel = `${rejected}; next roll recorded ${(performance.now() - next).toFixed(1)} ms later`
}

const dieMesh = new WeakMap<App, [unknown, unknown[]]>()

/** Spawns the dice: plain world writes, which wake the on-demand runner. */
function spawnDice(d: Dice, count: number, live: boolean): Entity[] {
  const w = d.app.world
  for (const e of d.dice) if (w.isAlive(e)) w.despawn(e)
  d.dice.length = 0
  let parts = dieMesh.get(d.app)
  if (!parts) {
    const materials = w.resource(Materials)
    parts = [
      w.resource(Meshes).add(cube({ size: 0.6 })),
      [
        materials.add(new MaterialAsset({ baseColor: [0.95, 0.93, 0.88, 1], roughness: 0.35 })),
        materials.add(new MaterialAsset({ baseColor: [0.85, 0.12, 0.1, 1], roughness: 0.3 })),
        materials.add(new MaterialAsset({ baseColor: [0.15, 0.35, 0.9, 1], roughness: 0.3 })),
      ],
    ]
    dieMesh.set(d.app, parts)
  }
  for (let i = 0; i < count; i++) {
    const look = [
      [Mesh3d, { mesh: parts[0] as never }],
      [MeshMaterial, { material: parts[1][i % parts[1].length] as never }],
    ] as const
    if (!live) {
      // Played from a track: the playback system poses it this frame, before it renders.
      d.dice.push(w.spawn(...look, Transform))
      continue
    }
    d.dice.push(
      w.spawn(
        ...look,
        [RigidBody, { kind: 'dynamic' }],
        [Collider, { shape: 'cuboid', halfExtents: [0.3, 0.3, 0.3] }],
        [
          Velocity,
          {
            linear: [rng.range(-7, -4), rng.range(1, 3), rng.range(-2, 2)],
            angular: [rng.range(-15, 15), rng.range(-15, 15), rng.range(-15, 15)],
          },
        ],
        [
          Transform,
          {
            translation: [4 + i * 0.3, 2 + i * 0.7, rng.range(-1, 1)],
            rotation: q(rng.range(0, 360), rng.range(0, 360), 0),
          },
        ],
      ),
    )
  }
  return d.dice
}

/**
 * The golden track (0053), recorded here in Chromium's worker: its hash must be the one Node
 * recorded, or tracks wouldn't replay the same for every viewer.
 */
async function checkGolden(d: Dice): Promise<void> {
  try {
    const track = await d.tracks.record(trackSceneFromJson(golden.scene), {
      contacts: golden.contacts,
    })
    const got = hex(trackHash(track))
    trackNotes.golden = `${got} ${got === golden.hash ? '= Node ✓' : `≠ Node's ${golden.hash} ✗`} (${track.steps} steps, ${track.engine})`
  } catch (err) {
    if (!isCancel(err)) trackNotes.golden = `failed: ${(err as ShardError).code ?? String(err)}`
  }
}

function sparks(d: Dice): void {
  const w = d.app.world
  if (d.sparks !== undefined && w.isAlive(d.sparks)) w.despawn(d.sparks)
  const at =
    d.dice[0] && w.isAlive(d.dice[0]) ? w.get(d.dice[0], Transform).translation : [0, 0.3, 0]
  d.sparks = w.spawn(
    [
      ParticleSystem,
      { effect: w.resource(ParticleEffects).add(SPARKS) as never, seed: rng.int(1, 1_000_000) },
    ],
    [Transform, { translation: [at[0]!, Math.max(0.3, at[1]!), at[2]!] }],
  )
}

// --- wiring ------------------------------------------------------------------------------------

const table = await mountTable()
let dice: Dice | undefined = await mountDice()
let note = ''
void checkGolden(dice)

const button = (action: string) =>
  document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!

button('roll').onclick = () => dice && void roll(dice)
button('live').onclick = () => dice && liveRoll(dice)
button('cancel').onclick = () => dice && void cancelRoll(dice)
button('sparks').onclick = () => dice && sparks(dice)
button('hole').onclick = async () => {
  const d = dice
  if (!d) return
  const w = d.app.world
  if (!d.dice.some((e) => w.isAlive(e))) await roll(d)
  const die = d.dice.find((e) => w.isAlive(e))
  if (die === undefined || d.app.disposed) return
  // Starts when the die lands: the system waits out the playback.
  blackHoles.set(w, { die, start: Number.NaN })
  d.app.requestFrame()
}
button('mount').onclick = async () => {
  if (dice) {
    const d = dice
    dice = undefined
    await d.app.dispose()
    button('mount').textContent = 'mount dice'
  } else {
    dice = await mountDice()
    button('mount').textContent = 'unmount dice'
  }
}
button('cycle').onclick = async () => {
  if (dice) {
    await dice.app.dispose()
    dice = undefined
  }
  const before = gpu.stats()
  for (let i = 0; i < 20; i++) {
    const d = await mountDice()
    // Disposed while the worker may still be recording: the roll rejects, nothing leaks.
    void roll(d)
    await new Promise((r) => setTimeout(r, 30))
    await d.app.dispose()
  }
  const after = gpu.stats()
  note = `20 cycles: device ${fmt(before)} → ${fmt(after)}`
  dice = await mountDice()
  button('mount').textContent = 'unmount dice'
}
let tokenStep = 0
button('token').onclick = () => {
  // A host write: exactly one table frame.
  const e = tokens[tokenStep++ % tokens.length]!
  const t = table.world.get(e, Transform).translation
  table.world.set(e, Transform, { translation: [t[0]!, t[1]!, t[2]! > 3 ? -3 : t[2]! + 1] })
}
let bright = false
button('patch').onclick = () => {
  bright = !bright
  table.world.patchResource(AmbientLight, { brightness: bright ? 3000 : 300 })
}
button('bare').onclick = () => {
  // The bug the dev check exists for: no frame, and a warning within a second.
  bright = !bright
  table.world.resource(AmbientLight).brightness = bright ? 3000 : 300
}

// --- HUD (on a timer, not rAF: it mustn't keep the page awake) -----------------------------------

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`
const fmt = (s: GpuStats) => `${s.buffers} buffers, ${s.textures} textures, ${mb(s.bytes)}`

function line(name: string, app: App | undefined): string {
  if (!app || app.disposed) return `${name.padEnd(6)} (unmounted)`
  const w = app.world
  const demand = w.resource(FrameDemand)
  const held = demand.held()
  return `${name.padEnd(6)} ${fps(app)}   frame ${String(w.resource(Time).frame).padStart(6)}   ${demand.mode}   holding: ${held.length ? held.join(', ') : '—'}\n       gpu: ${fmt(gpu.stats(renderOwner(w)))}`
}

/** Lens fields (0063): what the table bends, and whether its pass and lens target exist. */
function lensLine(): string {
  if (table.disposed) return ''
  const views = Object.values(describeLens(table.world).views) as {
    fields: unknown[]
    ran: boolean
    target: number[] | null
  }[]
  const v = views[0]
  if (!v) return 'lens: —'
  return `lens: table bending ${v.fields.length} field(s), post/lens ${v.ran ? 'ran' : 'off'}, target ${v.target ? v.target.join('×') : '— (released)'}`
}

/** Tracks (0053): which build does what, the golden check, the last roll, the last cancel. */
function tracksLines(): string {
  const physics = dice && !dice.app.disposed ? dice.app.world.tryResource(Physics) : undefined
  return [
    `tracks: ${TRACK_ENGINE} in a worker (spawned ${dice?.tracks.spawns ?? 0})   live roll: ${physics ? `${physics.variant} build, main thread` : '—'}`,
    `  golden: ${trackNotes.golden}`,
    `  last roll: ${trackNotes.last}`,
    `  cancel: ${trackNotes.cancel}`,
  ].join('\n')
}

function warning(): string {
  for (const app of [table, dice?.app]) {
    if (!app || app.disposed) continue
    const entry = app.world
      .resource(LogResource)
      .tail(30, 'warn')
      .findLast((e) => e.code === 'runtime/unmarked-resource-write')
    if (entry) return `last warning: ${entry.code} (${entry.path})`
  }
  return 'last warning: —'
}

let lastRaf = 0
let lastAt = performance.now()
setInterval(() => {
  const now = performance.now()
  const perSecond = ((rafCalls - lastRaf) * 1000) / (now - lastAt)
  lastRaf = rafCalls
  lastAt = now
  hud.textContent = [
    backendLine(gpu),
    `rAF calls/s: ${perSecond.toFixed(0)}`,
    line('table', table),
    line('dice', dice?.app),
    tracksLines(),
    lensLine(),
    `device: ${fmt(gpu.stats())}   owners: ${gpu.owners().join(', ')}   surfaces: ${gpu.surfaces.map((s) => `${s.label} (${s.alpha}, ${s.width}×${s.height})`).join(', ')}`,
    warning(),
    note,
  ]
    .filter(Boolean)
    .join('\n')
}, 250)

// Exposed for poking at from the devtools console.
Object.assign(globalThis, { gpu, table, dice: () => dice })
