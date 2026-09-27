import {
  type AnimationChannel,
  type AnimationClipAsset,
  AnimationClips,
  AnimationEvent,
  type AnimationEventData,
  AnimationMasks,
  AnimationPlayer,
  animationLayer,
  crossfade,
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
  defineSystem,
  type Entity,
  type JsonObject,
  ProfilerResource,
  quat,
  Update,
} from '@aethervtt/shard-core'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  Gizmos,
  Instances,
  setOverlays,
} from '@aethervtt/shard-render'
import { type App, definePlugin, Time } from '@aethervtt/shard-runtime'
import { loadScene, type SceneEntity, whenSceneReady } from '@aethervtt/shard-scene'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import morphUrl from '../../../packages/gltf/fixtures/khronos/AnimatedMorphCube/glTF-Binary/AnimatedMorphCube.glb?url'
import cesiumUrl from '../../../packages/gltf/fixtures/khronos/CesiumMan/glTF-Binary/CesiumMan.glb?url'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

const still = new URLSearchParams(location.search).has('still')

// --- clips made from the creature's rest pose --------------------------------------------------

export const axisAngle = (axis: number[], angle: number) => {
  const s = Math.sin(angle / 2)
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(angle / 2)]
}
export const mul = (a: number[], b: number[]) => [...quat.multiply([0, 0, 0, 1], a, b)]

/** A rotation channel per joint, `rotation(joint, arm, segment, u)` at 31 keys over `duration`. */
export function jointClip(
  c: Creature,
  name: string,
  duration: number,
  joints: (j: number) => boolean,
  rotation: (j: number, arm: number, segment: number, u: number) => number[],
): AnimationClipAsset {
  const keys = 31
  const times = Float32Array.from({ length: keys }, (_, k) => (k / (keys - 1)) * duration)
  const channels: AnimationChannel[] = []
  c.joints.forEach((target, j) => {
    if (!joints(j)) return
    const arm = Math.floor(j / 12)
    const segment = j % 12
    const values = new Float32Array(keys * 4)
    for (let k = 0; k < keys; k++) values.set(rotation(j, arm, segment, k / (keys - 1)), k * 4)
    channels.push({
      target,
      component: 'core/Transform',
      field: 'rotation',
      interpolation: 'linear',
      times,
      values,
      width: 4,
    })
  })
  return { name, duration, channels, events: [] }
}

/** Arms curled up over the body, breathing slowly. */
export function curl(c: Creature): AnimationClipAsset {
  return jointClip(
    c,
    'curl',
    3,
    () => true,
    (j, arm, s, u) => {
      const bend = (s === 0 ? -0.5 : 0.28) + 0.05 * Math.sin(u * Math.PI * 2 + arm)
      return mul(c.skin.restPose[j]!.rotation, axisAngle([0, 0, 1], bend))
    },
  )
}

/** One arm waving (its first frame is the rest pose, so it plays additive). */
export function wave(c: Creature): AnimationClipAsset {
  return jointClip(
    c,
    'wave',
    1.2,
    (j) => j < 12,
    (j, _arm, s, u) => {
      // Eased in and out of rest (sin²), so the first frame is rest (additive) and the loop is seamless.
      const ease = Math.sin(u * Math.PI) ** 2
      const swing = 0.9 * ease * Math.sin(u * Math.PI * 4 - s * 0.35) * (s === 0 ? 1.6 : 0.5)
      return mul(c.skin.restPose[j]!.rotation, axisAngle([1, 0, 0], swing))
    },
  )
}

/** The sway, plus the body crawling 0.9 m forward and turning 45° a loop (root motion). */
function crawl(c: Creature): AnimationClipAsset {
  const sway = c.clip.channels.filter((ch) => ch.field === 'rotation')
  const keys = 31
  const duration = c.clip.duration
  const times = Float32Array.from({ length: keys }, (_, k) => (k / (keys - 1)) * duration)
  const translation = new Float32Array(keys * 3)
  const rotation = new Float32Array(keys * 4)
  for (let k = 0; k < keys; k++) {
    const u = k / (keys - 1)
    translation.set([0, 0.9 + 0.05 * Math.sin(u * Math.PI * 4), -0.9 * u], k * 3)
    rotation.set(axisAngle([0, 1, 0], (u * Math.PI) / 4), k * 4)
  }
  const body = (field: string, values: Float32Array, width: number): AnimationChannel => ({
    target: 'Body',
    component: 'core/Transform',
    field,
    interpolation: 'linear',
    times,
    values,
    width,
  })
  return {
    name: 'crawl',
    duration,
    channels: [...sway, body('translation', translation, 3), body('rotation', rotation, 4)],
    events: [],
  }
}

// --- the radar: a property clip, imported like any .anim.json -----------------------------------

const RADAR = {
  duration: 4,
  tracks: [
    {
      path: 'radar',
      component: 'core/Transform',
      field: 'rotation',
      keys: [
        [0, [0, 0, 0, 1]],
        [1, [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
        [2, [0, 1, 0, 0]],
        [3, [0, Math.SQRT1_2, 0, -Math.SQRT1_2]],
        [4, [0, 0, 0, -1]],
      ],
    },
    {
      path: '',
      component: 'render/PointLight',
      field: 'intensity',
      interpolation: 'step',
      keys: [
        [0, 0],
        [0.9, 60_000],
        [1.05, 0],
        [2.9, 60_000],
        [3.05, 0],
      ],
    },
  ],
  events: [
    { time: 0.9, name: 'ping' },
    { time: 2.9, name: 'ping' },
  ],
}

const MATERIALS = {
  'materials/ground.material.json': { baseColor: [0.2, 0.22, 0.25, 1], roughness: 0.95 },
  'materials/metal.material.json': {
    baseColor: [0.6, 0.62, 0.66, 1],
    metallic: 0.8,
    roughness: 0.35,
  },
  'materials/beacon.material.json': {
    baseColor: [1, 0.3, 0.2, 1],
    emissive: [1, 0.25, 0.15, 1],
    emissiveLuminance: 4000,
  },
}

const CESIUM_UPPER = 'Z_UP/Armature/Skeleton_torso_joint_1/Skeleton_torso_joint_2/torso_joint_3'

// --- the demo ------------------------------------------------------------------------------------

interface DemoState {
  field: Entity[]
  crawlers: Entity[]
  sway: AssetRef
  curl: AssetRef
  wave: AssetRef
  mask: AssetRef
  curled: boolean
  waving: boolean
  paused: boolean
  skeleton: boolean
  pings: number
  lastPing: number
  tower: Entity | undefined
  note: string
}

const demo: DemoState = {
  field: [],
  crawlers: [],
  sway: null as never,
  curl: null as never,
  wave: null as never,
  mask: null as never,
  curled: false,
  waving: false,
  paused: false,
  skeleton: false,
  pings: 0,
  lastPing: -10,
  tower: undefined,
  note: 'loading models…',
}

const orbit = defineSystem({
  name: 'playground/animation-orbit',
  setup: (world) => ({ q: world.query({ with: [Camera3d, Transform] }) }),
  run: ({ q }, world) => {
    const t = still ? 0.5 : world.resource(Time).elapsed * 0.04 + 0.5
    const eye: [number, number, number] = [Math.sin(t) * 19, 8.5, Math.cos(t) * 19 - 4]
    const rotation = lookAt(eye, [0, 0.6, -5])
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

/** Radar pings (clip events) flash a ring out from the tower. */
const pings = defineSystem({
  name: 'playground/animation-pings',
  run: (_, world, ctx) => {
    const now = world.resource(Time).elapsed
    for (const e of ctx.reader(AnimationEvent).read() as AnimationEventData[]) {
      if (e.name !== 'ping') continue
      demo.pings++
      demo.lastPing = now
    }
    const age = now - demo.lastPing
    if (age < 0.8 && demo.tower !== undefined) {
      const p = world.get(demo.tower, Transform).translation
      world
        .resource(Gizmos)
        .circle([p[0], 0.05, p[2]], 0.5 + age * 9, 1, [1, 0.35, 0.2, 1 - age / 0.8])
    }
  },
})

function setAll(
  world: App['world'],
  entities: Entity[],
  fn: (layers: ReturnType<typeof layersOf>) => void,
) {
  for (const e of entities) {
    const layers = layersOf(world, e)
    fn(layers)
    world.set(e, AnimationPlayer, { layers })
  }
}

const layersOf = (world: App['world'], e: Entity) => world.get(e, AnimationPlayer).layers

export const animationDemoPlugin = definePlugin({
  name: 'animation-demo',
  dependencies: ['scene', 'animation'],
  build(app) {
    app.addSystems(Update, orbit, pings)
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

    // The field: 200 creatures of 60 joints, the spec's benchmark, swaying out of step.
    const c = creature()
    const assets = addCreatureAssets(world, c, [0.95, 0.55, 0.3, 1])
    const clips = world.resource(AnimationClips)
    demo.sway = assets.clip
    demo.curl = clips.add(curl(c), 'creature-curl')
    demo.wave = clips.add(wave(c), 'creature-wave')
    demo.mask = world.resource(AnimationMasks).add({ joints: { 'Body/a0_0': 1 } }, 'first-arm')
    const grid: [number, number, number][] = []
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 20; x++) grid.push([(x - 9.5) * 1.5, 0, -6 - z * 1.5])
    demo.field = spawnCreatures(world, c, assets, grid)

    // Crawlers: root motion moves the entity; their bodies stay over their arms.
    const crawler = addCreatureAssets(world, c, [0.35, 0.8, 0.55, 1])
    const crawlRef = clips.add(crawl(c), 'creature-crawl')
    demo.crawlers = spawnCreatures(world, c, crawler, [
      [-9, 0, 2],
      [9, 0, 2],
      [-12, 0, -3],
      [12, 0, -3],
    ])
    for (const [i, e] of demo.crawlers.entries()) {
      world.set(e, AnimationPlayer, {
        layers: [animationLayer(crawlRef, { time: i * 0.5 })],
        rootMotion: 'transform',
        rootJoint: 'Body',
      })
    }

    // A project folder in memory: two Khronos models, a property clip, a few materials.
    const platform = memoryPlatform()
    const [cesium, morph] = await Promise.all(
      [cesiumUrl, morphUrl].map(
        async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
      ),
    )
    await platform.fs.writeBytes('assets/CesiumMan.glb', cesium!)
    await platform.fs.writeBytes('assets/AnimatedMorphCube.glb', morph!)
    await platform.fs.writeText('assets/anims/radar.anim.json', JSON.stringify(RADAR, null, 2))
    for (const [path, json] of Object.entries(MATERIALS))
      await platform.fs.writeText(path, JSON.stringify(json))
    // The middle walker's mask: arms, chest, and head.
    await platform.fs.writeText(
      'assets/masks/upper.mask.json',
      JSON.stringify({ joints: { [CESIUM_UPPER]: 1 } }),
    )
    const server = assetServer(world).configure({ platform, roots: ['assets', 'materials'] })
    const report = await server.scan()
    if (report.failed.length) {
      demo.note = `import failed: ${report.failed.map((f) => `${f.path} ${f.error.code}`).join(', ')}`
      return
    }
    const clipOf = (source: string) =>
      server.info(source).subAssets!.find((a) => a.type === 'AnimationClip')!.path
    const walk = clipOf('assets/CesiumMan.glb')
    const pulse = clipOf('assets/AnimatedMorphCube.glb')
    const man = (
      name: string,
      x: number,
      speed: number,
      layers: JsonObject[] = [],
    ): SceneEntity => ({
      name,
      components: {
        'core/Transform': { translation: [x, 0, 3.5], scale: [1.4, 1.4, 1.4] },
        'scene/SceneInstance': { scene: { path: 'assets/CesiumMan.glb#Scene' } },
        'animation/AnimationPlayer': {
          layers: [{ clip: { path: walk }, speed, time: x * 0.3 }, ...layers],
        },
      },
    })
    const { entities } = loadScene(
      world,
      {
        version: 1,
        entities: [
          {
            name: 'ground',
            components: {
              'core/Transform': { translation: [0, 0, -6] },
              'render/Mesh3d': { mesh: { path: 'procedural:plane?size=46' } },
              'render/MeshMaterial': { material: { path: 'materials/ground.material.json' } },
            },
          },
          man('walker-slow', -2.2, 0.6),
          // The same clip half a cycle later on the upper body only: a mask at work.
          man('walker', 0, 1, [
            {
              clip: { path: walk },
              time: 1,
              mask: { path: 'assets/masks/upper.mask.json' },
            },
          ]),
          man('walker-fast', 2.2, 1.5),
          {
            name: 'cube',
            components: {
              'core/Transform': { translation: [5.5, 1.2, 3.5], scale: [0.8, 0.8, 0.8] },
              'scene/SceneInstance': { scene: { path: 'assets/AnimatedMorphCube.glb#Scene' } },
              'animation/AnimationPlayer': { layers: [{ clip: { path: pulse } }] },
            },
          },
          {
            name: 'tower',
            components: {
              'core/Transform': { translation: [-5.5, 0, 3.5] },
              'render/PointLight': { intensity: 0, range: 12, color: [1, 0.35, 0.2, 1] },
              'animation/AnimationPlayer': {
                layers: [{ clip: { path: 'assets/anims/radar.anim.json' } }],
              },
            },
            children: [
              {
                name: 'mast',
                components: {
                  'core/Transform': { translation: [0, 1.5, 0] },
                  'render/Mesh3d': { mesh: { path: 'procedural:cylinder?radius=0.12&height=3' } },
                  'render/MeshMaterial': { material: { path: 'materials/metal.material.json' } },
                },
              },
              {
                name: 'radar',
                components: { 'core/Transform': { translation: [0, 3.1, 0] } },
                children: [
                  {
                    name: 'dish',
                    components: {
                      'core/Transform': { translation: [0, 0, 0.25], rotationEuler: [-20, 0, 0] },
                      'render/Mesh3d': { mesh: { path: 'procedural:box?x=1.4&y=0.7&z=0.08' } },
                      'render/MeshMaterial': {
                        material: { path: 'materials/metal.material.json' },
                      },
                    },
                  },
                  {
                    name: 'beacon',
                    components: {
                      'core/Transform': { translation: [0, 0.45, 0.25] },
                      'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=0.1' } },
                      'render/MeshMaterial': {
                        material: { path: 'materials/beacon.material.json' },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { id: 'stage' },
    )
    await whenSceneReady(world, 'stage')
    demo.tower = entities.get('tower')
    demo.note = 'imported CesiumMan.glb, AnimatedMorphCube.glb, radar.anim.json, upper.mask.json'

    const actions: Record<string, () => void> = {
      // Every field creature crossfades to the other clip over half a second.
      crossfade: () => {
        demo.curled = !demo.curled
        for (const e of demo.field) {
          crossfade(world, e, demo.curled ? demo.curl : demo.sway, 0.5)
          if (demo.waving) addWave(e)
        }
      },
      wave: () => {
        demo.waving = !demo.waving
        setAll(world, demo.field, (layers) => {
          const i = layers.findIndex((l) => l.clip?.guid === demo.wave.guid)
          if (demo.waving && i === -1) layers.push(waveLayer())
          if (!demo.waving && i !== -1) layers.splice(i, 1)
        })
      },
      skeleton: () => {
        demo.skeleton = !demo.skeleton
        setOverlays(world, { skeleton: demo.skeleton })
      },
      pause: () => {
        demo.paused = !demo.paused
        const all = [...demo.field, ...demo.crawlers, ...entities.values()].filter((e) =>
          world.has(e, AnimationPlayer),
        )
        setAll(world, all, (layers) => {
          for (const l of layers) l.playing = !demo.paused
        })
      },
    }
    const waveLayer = () =>
      animationLayer(demo.wave, {
        blend: 'additive',
        mask: demo.mask as AssetRef<'AnimationMask'>,
        time: Math.random(),
      })
    const addWave = (e: Entity) => {
      const layers = layersOf(world, e)
      // A crossfade fades every layer out; the wave comes back on top at full weight.
      const kept = layers.filter((l) => l.clip?.guid !== demo.wave.guid || l.fadeTo !== 0)
      kept.push(waveLayer())
      world.set(e, AnimationPlayer, { layers: kept })
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-anim]')) {
      button.addEventListener('click', () => actions[button.dataset.anim!]?.())
    }
    window.addEventListener('keydown', (event) => {
      const key = { Digit1: 'crossfade', Digit2: 'wave', Digit3: 'skeleton', Digit4: 'pause' }[
        event.code
      ]
      if (key) actions[key]!()
    })

    hudExtras.push((w) => {
      const timings = w.resource(ProfilerResource).all()
      const players = w.query({ with: [AnimationPlayer] }).tables.reduce((n, t) => n + t.count, 0)
      const d = w.resource(Instances).deform
      return [
        '',
        `animation: ${players} players · field ${demo.curled ? 'curl' : 'sway'}${demo.waving ? ' + wave (additive, first arm)' : ''}${demo.paused ? ' · paused' : ''}`,
        `  sample ${(timings['animation/sample']?.avg ?? 0).toFixed(2)} ms · joint matrices ${(timings['render/prepare-deforms']?.avg ?? 0).toFixed(2)} ms · ${d.poseCount} pose vec4s`,
        `  radar pings: ${demo.pings} · ${demo.note}`,
      ]
    })
  },
})
