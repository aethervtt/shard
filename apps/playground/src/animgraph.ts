import {
  type AnimationClipAsset,
  Animator,
  AnimatorStateEntered,
  type AnimatorStateEnteredData,
  describeAnimator,
  setAnimParam,
} from '@aethervtt/shard-animation'
import {
  addCreatureAssets,
  type Creature,
  creature,
  spawnCreatures,
} from '@aethervtt/shard-animation/testing'
import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineComponent,
  defineSystem,
  type Entity,
  ProfilerResource,
  quat,
  t,
  Update,
} from '@aethervtt/shard-core'
import { AmbientLight, Camera3d, DirectionalLight, Exposure, Gizmos } from '@aethervtt/shard-render'
import { type App, definePlugin, Time } from '@aethervtt/shard-runtime'
import { loadScene, whenSceneReady } from '@aethervtt/shard-scene'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { axisAngle, curl, jointClip, mul, wave } from './animation'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

const still = new URLSearchParams(location.search).has('still')

/** What a character controller would publish; the graphs bind to it. */
const Critter = defineComponent('playground/Critter', {
  velocity: t.vec3({ unit: 'm/s' }),
  grounded: t.bool({ default: true }),
  /** 0: wander the meadow. 1: fly a figure eight (the hero). */
  mode: t.u8(),
  heading: t.f32(),
  speed: t.f32(),
  target: t.f32(),
  /** Seconds until the next change of pace. */
  retarget: t.f32(),
  /** Seconds until the next hop. */
  hopIn: t.f32({ default: 3 }),
})

// --- clips, written to the project as .anim.json files -----------------------------------------

/** Faster, wider sway: the run cycle. */
function run(c: Creature): AnimationClipAsset {
  return jointClip(
    c,
    'run',
    0.8,
    () => true,
    (j, arm, s, u) => {
      const swing = Math.sin(u * Math.PI * 2 + arm * 1.3 - s * 0.45) * (s === 0 ? 0.55 : 0.2)
      return mul(c.skin.restPose[j]!.rotation, axisAngle([0, 0, 1], swing - (s === 0 ? 0.25 : 0)))
    },
  )
}

/** Arms thrown up while airborne, fluttering. */
function air(c: Creature): AnimationClipAsset {
  return jointClip(
    c,
    'air',
    0.6,
    () => true,
    (j, arm, s, u) => {
      const flutter = 0.08 * Math.sin(u * Math.PI * 2 + arm)
      const bend = (s === 0 ? -0.9 : -0.06) + flutter
      return mul(c.skin.restPose[j]!.rotation, axisAngle([0, 0, 1], bend))
    },
  )
}

/** Splayed flat on landing, then back up (plays once). */
function land(c: Creature): AnimationClipAsset {
  return jointClip(
    c,
    'land',
    0.45,
    () => true,
    (j, _arm, s, u) => {
      const squash = Math.sin(Math.min(1, u * 1.6) * Math.PI) * (s === 0 ? 0.75 : 0.05)
      return mul(c.skin.restPose[j]!.rotation, axisAngle([0, 0, 1], squash))
    },
  )
}

/** Arms swept away from a direction (dx, dz): the hero's lean samples. */
function lean(c: Creature, name: string, dx: number, dz: number): AnimationClipAsset {
  return jointClip(
    c,
    name,
    1.6,
    () => true,
    (j, arm, s, u) => {
      const angle = (arm / 5) * Math.PI * 2
      const facing = Math.cos(angle) * dx + Math.sin(angle) * dz
      const sway = 0.06 * Math.sin(u * Math.PI * 2 + arm - s * 0.3)
      const bend = (s === 0 ? -0.55 * facing : 0.05 * facing) + sway
      return mul(c.skin.restPose[j]!.rotation, axisAngle([0, 0, 1], bend))
    },
  )
}

/** A clip as a .anim.json property clip (joint paths, Transform fields, keys). */
function animJson(clip: AnimationClipAsset) {
  return {
    duration: clip.duration,
    tracks: clip.channels.map((ch) => ({
      path: ch.target,
      component: ch.component,
      field: ch.field,
      keys: [...ch.times].map((time, k) => [
        time,
        [...ch.values.subarray(k * ch.width, (k + 1) * ch.width)],
      ]),
    })),
  }
}

// --- the graphs --------------------------------------------------------------------------------

const CRITTER_GRAPH = 'data/critter.animgraph.json'
const HERO_GRAPH = 'data/hero.animgraph.json'
const clip = (name: string) => ({ path: `assets/anims/${name}.anim.json` })

const bound = (field: string, op: string) => ({
  component: 'playground/Critter',
  field,
  ...(op ? { op } : {}),
})

/** The upper layer both graphs share: a swing on the first arm when `attack` fires. */
const armLayer = {
  name: 'arm',
  mask: { path: 'assets/masks/first-arm.mask.json' },
  entry: 'none',
  states: { none: {}, swing: { clip: '#swing', loop: 'once', speed: 1.4 } },
  transitions: [
    { from: 'none', to: 'swing', when: 'attack', duration: 0.1 },
    { from: 'swing', to: 'none', exitTime: 1, duration: 0.2 },
  ],
}

function critterGraph(runAt: number, typo: boolean) {
  return {
    $schema: '../.shard/schemas/animgraph.schema.json',
    parameters: {
      speed: { type: 'float', bind: bound('velocity', 'horizontal') },
      grounded: { type: 'bool', default: true, bind: bound('grounded', '') },
      attack: { type: 'trigger' },
    },
    layers: [
      {
        name: 'base',
        entry: 'locomotion',
        states: {
          locomotion: {
            blend1d: {
              parameter: 'speed',
              clips: [
                [0, '#idle'],
                [1.2, '#walk'],
                [runAt, '#run'],
              ],
            },
          },
          air: { clip: '#air' },
          land: { clip: '#land', loop: 'once' },
        },
        transitions: [
          { from: 'locomotion', to: 'air', when: typo ? '!grnded' : '!grounded', duration: 0.15 },
          { from: 'air', to: 'land', when: 'grounded', duration: 0.05 },
          { from: 'land', to: 'air', when: '!grounded', duration: 0.1 },
          { from: 'land', to: 'locomotion', exitTime: 0.8, duration: 0.25 },
        ],
      },
      armLayer,
    ],
    clips: {
      idle: clip('idle'),
      walk: clip('walk'),
      run: clip('run'),
      air: clip('air'),
      land: clip('land'),
      swing: clip('swing'),
    },
  }
}

/** The hero flies a figure eight: a 2D blend space over its velocity leans it into each turn. */
const HERO = {
  $schema: '../.shard/schemas/animgraph.schema.json',
  parameters: {
    vx: { type: 'float', bind: bound('velocity', 'x') },
    vz: { type: 'float', bind: bound('velocity', 'z') },
    attack: { type: 'trigger' },
  },
  layers: [
    {
      name: 'base',
      states: {
        fly: {
          blend2d: {
            x: 'vx',
            y: 'vz',
            clips: [
              [0, 0, '#idle'],
              [3, 0, '#leanRight'],
              [-3, 0, '#leanLeft'],
              [0, 3, '#leanBack'],
              [0, -3, '#leanForward'],
            ],
          },
        },
      },
    },
    armLayer,
  ],
  clips: {
    idle: clip('walk'),
    leanRight: clip('lean-right'),
    leanLeft: clip('lean-left'),
    leanBack: clip('lean-back'),
    leanForward: clip('lean-forward'),
    swing: clip('swing'),
  },
}

// --- behaviour ---------------------------------------------------------------------------------

const BOUNDS = { x: 11, zMin: -16, zMax: 1 }
const PACES = [0, 0.6, 1.4, 2.4, 4.2, 5.5]

/** Wandering critters change pace, turn, and hop; the hero flies its eight. */
const wander = defineSystem({
  name: 'playground/animgraph-wander',
  setup: (world) => ({ q: world.query({ with: [Critter, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time)
    const dt = time.delta
    for (const table of q.tables) {
      const vel = table.column(Critter, 'velocity')
      const grounded = table.column(Critter, 'grounded')
      const mode = table.column(Critter, 'mode')
      const heading = table.column(Critter, 'heading')
      const speed = table.column(Critter, 'speed')
      const target = table.column(Critter, 'target')
      const retarget = table.column(Critter, 'retarget')
      const hopIn = table.column(Critter, 'hopIn')
      const tr = table.column(Transform, 'translation')
      const rot = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        if (mode[i] === 1) {
          // x = 6 sin(wt), z = 3 sin(2wt) − 1 in front of the herd.
          const w = 0.45
          const s = time.elapsed * w
          const x = 6 * Math.sin(s)
          const z = 3.2 + 2.2 * Math.sin(2 * s)
          vel[i * 3] = 6 * w * Math.cos(s)
          vel[i * 3 + 2] = 4.4 * w * Math.cos(2 * s)
          tr[i * 3] = x
          tr[i * 3 + 1] = 1.2 + 0.15 * Math.sin(s * 3)
          tr[i * 3 + 2] = z
          continue
        }
        retarget[i] = retarget[i]! - dt
        if (retarget[i]! <= 0) {
          target[i] = PACES[Math.floor(Math.random() * PACES.length)]!
          retarget[i] = 2 + Math.random() * 4
        }
        speed[i] = speed[i]! + (target[i]! - speed[i]!) * Math.min(1, dt * 1.5)
        // Turn gently, and back toward the meadow near its edges.
        let h = heading[i]! + (Math.random() - 0.5) * dt * 1.5
        const x = tr[i * 3]!
        const z = tr[i * 3 + 2]!
        if (Math.abs(x) > BOUNDS.x || z < BOUNDS.zMin || z > BOUNDS.zMax) {
          const home = Math.atan2(-7 - z, -x)
          let d = home - h
          d = Math.atan2(Math.sin(d), Math.cos(d))
          h += d * Math.min(1, dt * 2)
        }
        heading[i] = h
        vel[i * 3] = Math.cos(h) * speed[i]!
        vel[i * 3 + 2] = Math.sin(h) * speed[i]!
        tr[i * 3] = x + vel[i * 3]! * dt
        tr[i * 3 + 2] = z + vel[i * 3 + 2]! * dt
        // Hops: up at 4.5 m/s, down under 12 m/s².
        hopIn[i] = hopIn[i]! - dt
        if (grounded[i] === 1 && hopIn[i]! <= 0) {
          grounded[i] = 0
          vel[i * 3 + 1] = 4.5
          hopIn[i] = 3 + Math.random() * 8
        }
        if (grounded[i] === 0) {
          vel[i * 3 + 1] = vel[i * 3 + 1]! - 12 * dt
          const y = tr[i * 3 + 1]! + vel[i * 3 + 1]! * dt
          if (y <= 0 && vel[i * 3 + 1]! < 0) {
            tr[i * 3 + 1] = 0
            vel[i * 3 + 1] = 0
            grounded[i] = 1
          } else tr[i * 3 + 1] = y
        }
        const q = quat.fromEuler([0, 0, 0, 1], 0, -h, 0)
        rot.set(q, i * 4)
      }
      table.markChanged(Transform)
      table.markChanged(Critter)
    }
  },
})

const orbit = defineSystem({
  name: 'playground/animgraph-orbit',
  setup: (world) => ({ q: world.query({ with: [Camera3d, Transform] }) }),
  run: ({ q }, world) => {
    const t = still ? 0.3 : Math.sin(world.resource(Time).elapsed * 0.05) * 0.5 + 0.3
    const eye: [number, number, number] = [Math.sin(t) * 17, 7.5, Math.cos(t) * 17 - 2]
    const rotation = lookAt(eye, [0, 0.8, -5])
    for (const table of q.tables) {
      const tr = table.column(Transform, 'translation')
      const rot = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        tr.set(eye, i * 3)
        rot.set(rotation, i * 4)
      }
      table.markChanged(Transform)
    }
  },
})

interface DemoState {
  herd: Entity[]
  hero: Entity | undefined
  entered: Map<string, number>
  runAt: number
  broken: boolean
  note: string
}

const demo: DemoState = {
  herd: [],
  hero: undefined,
  entered: new Map(),
  runAt: 4.5,
  broken: false,
  note: 'importing…',
}

/** Counts state entries (AnimatorStateEntered) and rings the watched critter's landings. */
const tally = defineSystem({
  name: 'playground/animgraph-tally',
  run: (_, world, ctx) => {
    for (const e of ctx.reader(AnimatorStateEntered).read() as AnimatorStateEnteredData[]) {
      if (e.from === null) continue
      demo.entered.set(e.state, (demo.entered.get(e.state) ?? 0) + 1)
    }
    const watched = demo.herd[0]
    if (watched === undefined) return
    const p = world.get(watched, Transform).translation
    world.resource(Gizmos).circle([p[0], 0.04, p[2]], 1.1, 1, [0.4, 0.9, 1, 0.9])
  },
})

// --- HUD ---------------------------------------------------------------------------------------

const bar = (u: number, width = 10) => {
  const n = Math.round(Math.max(0, Math.min(1, u)) * width)
  return `[${'#'.repeat(n)}${'.'.repeat(width - n)}]`
}

function describeLines(world: App['world'], label: string, entity: Entity | undefined): string[] {
  if (entity === undefined) return []
  const d = describeAnimator(world, entity)
  if (!d?.loaded) return [`${label}: graph not loaded`]
  const params = Object.entries(d.parameters)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
    .join(' ')
  const lines = [`${label} (${d.graph}): ${params}`]
  for (const l of d.layers) {
    const blend = l.active[l.active.length - 1]!.motions.filter((m) => m.weight > 0.005)
    const weights =
      blend.length > 1
        ? `  ${blend.map((m) => `${m.name} ${m.weight.toFixed(2)}`).join(' + ')}`
        : ''
    const fading = l.transition
      ? `  ${l.transition.from}→${l.transition.to} ${bar(l.transition.progress)} ${l.transition.duration}s`
      : ''
    lines.push(
      `  ${l.name}: ${l.state} ${l.timeInState.toFixed(2)}s (t ${l.normalizedTime.toFixed(2)})${fading}${weights}`,
    )
  }
  return lines
}

// --- the demo ----------------------------------------------------------------------------------

export const animgraphDemoPlugin = definePlugin({
  name: 'animgraph-demo',
  dependencies: ['scene', 'animation'],
  build(app) {
    app.addSystems(Update, wander, orbit, tally)
  },
  async ready(app: App) {
    const world = app.world
    world.resource(AmbientLight).brightness = 900
    world.spawn(
      [DirectionalLight, { illuminance: 40_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.95, 0.6, 0) as never }],
    )
    world.spawn(
      [Camera3d, { fovY: 50, clearColor: [0.02, 0.025, 0.035, 1] }],
      [Exposure, { ev100: 13.5 }],
      [Transform, { translation: [0, 8, 18] }],
    )

    // A project in memory: the clips as .anim.json files, a mask, two graphs, a material.
    const c = creature()
    const platform = memoryPlatform()
    const clips: Record<string, AnimationClipAsset> = {
      idle: curl(c),
      walk: c.clip,
      run: run(c),
      air: air(c),
      land: land(c),
      swing: wave(c),
      'lean-right': lean(c, 'lean-right', 1, 0),
      'lean-left': lean(c, 'lean-left', -1, 0),
      'lean-back': lean(c, 'lean-back', 0, 1),
      'lean-forward': lean(c, 'lean-forward', 0, -1),
    }
    for (const [name, clipAsset] of Object.entries(clips))
      await platform.fs.writeText(
        `assets/anims/${name}.anim.json`,
        JSON.stringify(animJson(clipAsset)),
      )
    await platform.fs.writeText(
      'assets/masks/first-arm.mask.json',
      JSON.stringify({ joints: { 'Body/a0_0': 1 } }),
    )
    const writeGraph = () =>
      platform.fs.writeText(
        CRITTER_GRAPH,
        `${JSON.stringify(critterGraph(demo.runAt, demo.broken), null, 2)}\n`,
      )
    await writeGraph()
    await platform.fs.writeText(HERO_GRAPH, `${JSON.stringify(HERO, null, 2)}\n`)
    await platform.fs.writeText(
      'materials/meadow.material.json',
      JSON.stringify({ baseColor: [0.16, 0.22, 0.14, 1], roughness: 0.95 }),
    )
    const server = assetServer(world).configure({
      platform,
      roots: ['assets', 'materials', 'data'],
    })
    const report = await server.scan()
    if (report.failed.length) {
      demo.note = `import failed: ${report.failed.map((f) => `${f.path} ${f.error.code}: ${f.error.message}`).join(', ')}`
      return
    }
    const graphRef = async (path: string) => {
      const info = server.info(path)
      await server.load(info.guid)
      return { type: 'AnimationGraph', guid: info.guid, path } as AssetRef<'AnimationGraph'>
    }
    const critter = await graphRef(CRITTER_GRAPH)
    const hero = await graphRef(HERO_GRAPH)

    loadScene(
      world,
      {
        version: 1,
        entities: [
          {
            name: 'meadow',
            components: {
              'core/Transform': { translation: [0, 0, -6] },
              'render/Mesh3d': { mesh: { path: 'procedural:plane?size=40' } },
              'render/MeshMaterial': { material: { path: 'materials/meadow.material.json' } },
            },
          },
        ],
      },
      { id: 'meadow' },
    )
    await whenSceneReady(world, 'meadow')

    // The herd: 48 critters wandering the meadow, each its own Animator on the critter graph.
    const herdAssets = addCreatureAssets(world, c, [0.95, 0.6, 0.3, 1])
    const spots: [number, number, number][] = []
    for (let k = 0; k < 48; k++)
      spots.push([(Math.random() - 0.5) * 20, 0, -1 - Math.random() * 14])
    demo.herd = spawnCreatures(world, c, herdAssets, spots)
    for (const e of demo.herd) {
      world.add(e, Critter, {
        heading: Math.random() * Math.PI * 2,
        target: PACES[Math.floor(Math.random() * PACES.length)]!,
        retarget: Math.random() * 3,
        hopIn: 1 + Math.random() * 8,
      })
      world.add(e, Animator, { graph: critter })
    }
    // The hero, bigger and blue, on the 2D blend space.
    const heroAssets = addCreatureAssets(world, c, [0.3, 0.6, 1, 1])
    demo.hero = spawnCreatures(world, c, heroAssets, [[0, 1.2, 3]])[0]!
    world.set(demo.hero, Transform, { scale: [1.8, 1.8, 1.8] })
    world.add(demo.hero, Critter, { mode: 1 })
    world.add(demo.hero, Animator, { graph: hero })
    demo.note = `imported ${Object.keys(clips).length} .anim.json clips, first-arm.mask.json, critter + hero .animgraph.json`

    const rescan = async (what: string) => {
      await writeGraph()
      const r = await server.scan()
      const failed = r.failed.find((f) => f.path === CRITTER_GRAPH)
      demo.note = failed
        ? `${what}: ${failed.error.path} ${failed.error.message.replace(`${CRITTER_GRAPH}: `, '')}${failed.error.hint ? ` (${failed.error.hint})` : ''}; last good graph kept`
        : `${what}: reimported, animators restarted on it`
    }
    const actions: Record<string, () => void> = {
      attack: () => {
        for (const e of [...demo.herd, demo.hero!]) setAnimParam(world, e, 'attack', true)
      },
      hop: () => {
        for (const e of demo.herd) world.set(e, Critter, { hopIn: Math.random() * 0.4 })
      },
      edit: () => {
        demo.runAt = demo.runAt === 4.5 ? 2 : 4.5
        void rescan(`run threshold → ${demo.runAt} m/s`)
      },
      break: () => {
        demo.broken = !demo.broken
        void rescan(demo.broken ? 'typo "!grnded"' : 'typo fixed')
      },
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-graph]'))
      button.addEventListener('click', () => actions[button.dataset.graph!]?.())
    window.addEventListener('keydown', (event) => {
      const key = { Digit1: 'attack', Digit2: 'hop', Digit3: 'edit', Digit4: 'break' }[event.code]
      if (key) actions[key]!()
    })

    hudExtras.push((w) => {
      const timings = w.resource(ProfilerResource).all()
      const counts = ['air', 'land', 'locomotion', 'swing']
        .map((s) => `${s} ${demo.entered.get(s) ?? 0}`)
        .join(' · ')
      return [
        '',
        `animation graphs: ${demo.herd.length + 1} animators · graph ${(timings['animation/graph']?.avg ?? 0).toFixed(3)} ms · sample ${(timings['animation/sample']?.avg ?? 0).toFixed(2)} ms`,
        `  states entered: ${counts}`,
        ...describeLines(w, 'critter (ringed)', demo.herd[0]),
        ...describeLines(w, 'hero', demo.hero),
        `  ${demo.note}`,
      ]
    })
  },
})
