// Embedding (0052): a fake VTT page with two apps on one GPU device. The table renders opaque into
// its canvas; the dice render into a transparent canvas over the whole page, HTML included. Both
// run on demand: with nothing moving, the page requests no animation frames at all.

import { type Entity, quat, Rng } from '@aethervtt/shard-core'
import { createGpuContext, type GpuContext, type GpuStats } from '@aethervtt/shard-gpu'
import { inputPlugin } from '@aethervtt/shard-input'
import { cube, cylinder, plane } from '@aethervtt/shard-mesh'
import {
  ParticleEffect,
  ParticleEffects,
  ParticleSystem,
  particlesPlugin,
} from '@aethervtt/shard-particles'
import { Collider, physics3dPlugin, RigidBody, Velocity } from '@aethervtt/shard-physics'
import { createDomInputSource } from '@aethervtt/shard-platform-web'
import {
  AmbientLight,
  Bloom,
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
  renderOwner,
  renderPlugin,
  ShadowCatcher,
} from '@aethervtt/shard-render'
import { App, animationFrameRunner, FrameDemand, LogResource, Time } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'

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

const gpu: GpuContext = await createGpuContext()

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
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, surface, owner: 'dice' }),
    forwardPlugin(),
    physics3dPlugin,
    particlesPlugin,
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
  w.spawn(
    // Alpha 0: nothing drawn shows the page. Bloom's glow raises alpha over it.
    [Camera3d, { fovY: 40, clearColor: [0, 0, 0, 0] }],
    [Exposure, { ev100: 13 }],
    // Only the sparks glow: a threshold keeps the dice from hazing the page around them.
    [Bloom, { intensity: 0.3, threshold: 1500 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
  )
  w.resource(ParticleEffects).add(SPARKS)
  meterFrames(app)
  app.setRunner(runner())
  void app.run()
  return { app, dice: [], sparks: undefined }
}

const dieMesh = new WeakMap<App, [unknown, unknown[]]>()

/** Host code throwing dice: plain world writes, which wake the on-demand runner. */
function roll(d: Dice): void {
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
  for (let i = 0; i < 3; i++) {
    d.dice.push(
      w.spawn(
        [Mesh3d, { mesh: parts[0] as never }],
        [MeshMaterial, { material: parts[1][i] as never }],
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

const button = (action: string) =>
  document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!

button('roll').onclick = () => dice && roll(dice)
button('sparks').onclick = () => dice && sparks(dice)
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
    roll(d)
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
    `rAF calls/s: ${perSecond.toFixed(0)}`,
    line('table', table),
    line('dice', dice?.app),
    `device: ${fmt(gpu.stats())}   owners: ${gpu.owners().join(', ')}   surfaces: ${gpu.surfaces.map((s) => `${s.label} (${s.alpha}, ${s.width}×${s.height})`).join(', ')}`,
    warning(),
    note,
  ]
    .filter(Boolean)
    .join('\n')
}, 250)

// Exposed for poking at from the devtools console.
Object.assign(globalThis, { gpu, table, dice: () => dice })
