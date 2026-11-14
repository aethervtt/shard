import { AnimationPlayer, animationLayer } from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import {
  type CharacterRig,
  CharacterStates,
  CharacterTier,
  createCharacterRig,
  partsOf,
  spawnCharacter,
  TierSource,
} from '@aethervtt/shard-characters'
import {
  type AssetRef,
  defineComponent,
  defineSystem,
  type Entity,
  quat,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { type Mesh, plane } from '@aethervtt/shard-mesh'
import { Collider, RigidBody } from '@aethervtt/shard-physics'
import {
  castHit,
  describeSim,
  generateRagdoll,
  hit,
  parseRagdoll,
  Ragdoll,
  RagdollAssets,
  Reaction,
} from '@aethervtt/shard-ragdoll'
import { HUMANOID_RESTS, registerRestClips } from '@aethervtt/shard-ragdoll/testing'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  Skins,
  setOverlays,
} from '@aethervtt/shard-render'
import { type App, definePlugin, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import attackUrl from '../../../packages/characters/fixtures/cmu/attack.glb?url'
import mapUrl from '../../../packages/characters/fixtures/cmu/cmu-risen.jointmap.json?url'
import idleUrl from '../../../packages/characters/fixtures/cmu/idle.glb?url'
import walkUrl from '../../../packages/characters/fixtures/cmu/walk.glb?url'
import bodyUrl from '../../../packages/characters/fixtures/risen/base.glb?url'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

/** A zombie of the demo's: shambles toward the player while it isn't down. */
const Shambler = defineComponent('playground/Shambler', { speed: t.f32({ default: 1 }) })

const ZOMBIES = 14
/** Where the player stands: zombies come at it and respawn when they get close. */
const PLAYER = [0, 0, 4]

const demo = {
  rig: undefined as CharacterRig | undefined,
  model: undefined as AssetRef<'Scene'> | undefined,
  asset: undefined as AssetRef<'Ragdoll'> | undefined,
  walk: undefined as AssetRef<'AnimationClip'> | undefined,
  camera: -1 as Entity,
  zombies: [] as Entity[],
  overlay: false,
  last: 'click a zombie',
  note: 'loading…',
}

function spawnZombie(world: World, k: number): Entity {
  const rig = demo.rig!
  // Spread over an arc 14–28 m out, facing the player.
  const angle = ((k % 7) / 6 - 0.5) * 1.6 + (k % 2) * 0.07
  const dist = 14 + ((k * 7.3) % 14)
  const x = PLAYER[0]! + Math.sin(angle) * dist
  const z = PLAYER[2]! - Math.cos(angle) * dist
  const yaw = Math.atan2(PLAYER[0]! - x, PLAYER[2]! - z)
  const e = spawnCharacter(world, rig, {
    parts: partsOf(world, demo.model!),
    transform: { translation: [x, 0, z], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] },
  })
  world.set(e, AnimationPlayer, {
    ...world.get(e, AnimationPlayer),
    layers: [animationLayer(demo.walk!, { time: (k * 0.37) % 1, speed: 0.8 })],
  })
  world.add(e, Ragdoll, { asset: demo.asset!, drive: 'auto' })
  world.add(e, Shambler, { speed: 0.75 + ((k * 13) % 5) * 0.08 })
  return e
}

function resetZombies(world: World): void {
  for (const e of demo.zombies) if (world.isAlive(e)) world.despawn(e)
  demo.zombies = []
  for (let k = 0; k < ZOMBIES; k++) demo.zombies.push(spawnZombie(world, k))
}

/** Shamblers walk at the player while standing; a zombie that reaches it starts over far away. */
const shamble = defineSystem({
  name: 'playground/ragdoll-shamble',
  setup: (world) => ({ q: world.query({ with: [Shambler, Transform, Reaction] }) }),
  run: ({ q }, world) => {
    const dt = world.resource(Time).delta
    for (const table of q.tables) {
      for (let i = 0; i < table.count; i++) {
        const e = table.entities[i]!
        const state = world.get(e, Reaction).state
        if (state !== 'none' && state !== 'partial') continue
        const t = world.get(e, Transform)
        const dx = PLAYER[0]! - t.translation[0]
        const dz = PLAYER[2]! - t.translation[2]
        const d = Math.hypot(dx, dz)
        if (d < 1.5) {
          const k = demo.zombies.indexOf(e)
          world.despawn(e)
          if (k >= 0) demo.zombies[k] = spawnZombie(world, k + ZOMBIES)
          continue
        }
        const speed = world.get(e, Shambler).speed
        const yaw = Math.atan2(dx, dz)
        world.set(e, Transform, {
          ...t,
          translation: [
            t.translation[0] + (dx / d) * speed * dt,
            0,
            t.translation[2] + (dz / d) * speed * dt,
          ],
          rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        })
      }
    }
  },
})

/** The camera ray through a canvas point (CSS pixels). */
function rayAt(world: World, canvas: HTMLCanvasElement, x: number, y: number) {
  const cam = world.get(demo.camera, Camera3d)
  const g = world.get(demo.camera, GlobalTransform).matrix
  const rect = canvas.getBoundingClientRect()
  const nx = ((x - rect.left) / rect.width) * 2 - 1
  const ny = 1 - ((y - rect.top) / rect.height) * 2
  const t = Math.tan(((cam.fovY ?? 50) * Math.PI) / 360)
  const vx = nx * t * (rect.width / rect.height)
  const vy = ny * t
  const vz = -1
  // Camera space to world: the camera's rotation columns.
  const dir = [
    g[0]! * vx + g[1]! * vy + g[2]! * vz,
    g[4]! * vx + g[5]! * vy + g[6]! * vz,
    g[8]! * vx + g[9]! * vy + g[10]! * vz,
  ]
  const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
  return { origin: [g[3]!, g[7]!, g[11]!], dir: dir.map((v) => v / l) }
}

type Shot = 'shot' | 'heavy' | 'kill' | 'car'

function shoot(world: World, canvas: HTMLCanvasElement, x: number, y: number, shot: Shot): void {
  const { origin, dir } = rayAt(world, canvas, x, y)
  shootRay(world, origin, dir, shot)
}

/** Aims at the nearest standing zombie's chest (window.ragdollDemo.nearest, the N key). */
function shootNearest(world: World, shot: Shot): void {
  const g = world.get(demo.camera, GlobalTransform).matrix
  const origin = [g[3]!, g[7]!, g[11]!]
  let best: number[] | undefined
  let bestD = Number.POSITIVE_INFINITY
  for (const e of demo.zombies) {
    if (!world.isAlive(e) || world.get(e, Reaction).state === 'dead') continue
    const m = world.get(e, GlobalTransform).matrix
    const p = [m[3]!, m[7]! + 1.35, m[11]!]
    const d = Math.hypot(p[0]! - origin[0]!, p[1]! - origin[1]!, p[2]! - origin[2]!)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  if (!best) return
  const dir = best.map((v, k) => (v - origin[k]!) / bestD)
  shootRay(world, origin, dir, shot)
}

function shootRay(world: World, origin: number[], dir: number[], shot: Shot): void {
  const h = castHit(world, origin, dir, { maxDistance: 80 })
  if (!h || h.root < 0) {
    demo.last = h ? `missed (hit the ground at ${h.distance.toFixed(1)} m)` : 'missed'
    return
  }
  const strength = shot === 'heavy' ? 200 : shot === 'kill' ? 70 : h.zone === 'head' ? 55 : 40
  if (shot === 'car') {
    hit(world, h.root, { launch: [dir[0]! * 9, 3.5, dir[2]! * 9], bone: h.bone })
  } else {
    hit(world, h.root, {
      bone: h.bone,
      point: h.point,
      impulse: dir.map((v) => v * strength),
      kind: shot === 'kill' ? 'death' : 'auto',
    })
  }
  const r = world.get(h.root, Reaction)
  demo.last = `${shot} → ${h.bone} (${h.zone}) at ${h.distance.toFixed(1)} m: ${r.state}, stagger ${r.stagger.toFixed(2)}`
}

function hudLines(world: World): string[] {
  const sim = describeSim(world)
  let near = 0
  for (const e of demo.zombies)
    if (world.isAlive(e) && world.get(e, CharacterTier).tier === 'near') near++
  return [
    'click: shoot (40 N·s, head 55) · shift+click: heavy (knockdown) · alt+click: kill shot',
    'N: shoot the nearest (shift/alt too) · C: car at the cursor · R: respawn · O: overlay',
    `${demo.zombies.length} zombies (${near} near) · simulated ${sim?.active.filter((a) => a.physics).length ?? 0} · corpses ${sim?.corpses ?? 0} · bodies ${sim?.bodies ?? 0}`,
    `last: ${demo.last}`,
    demo.note,
  ]
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

export const ragdollDemoPlugin = definePlugin({
  name: 'ragdoll-demo',
  dependencies: ['scene', 'animation', 'characters', 'ragdoll'],
  build(app) {
    app.addSystems(Update, shamble)
  },
  async ready(app: App) {
    const world = app.world
    world.resource(AmbientLight).brightness = 1600
    world.spawn(
      [DirectionalLight, { illuminance: 40_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.8, 0.5, 0) as never }],
    )
    demo.camera = world.spawn(
      [Camera3d, { fovY: 50, clearColor: [0.05, 0.06, 0.08, 1] }],
      [Exposure, { ev100: 13.6 }],
      [Transform, { translation: [0, 2.2, 8] }],
      orbitFrom([0.5, 2.4, 8.5], [0, 1, -2]),
      [TierSource, { viewer: true, player: true }],
    )
    const materials = world.resource(Materials)
    const meshes = world.resource(Meshes)
    world.spawn(
      [RigidBody, { kind: 'fixed' }],
      [Collider, { shape: 'cuboid', halfExtents: [60, 0.5, 60], friction: 0.9 }],
      [Transform, { translation: [0, -0.5, 0] }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 120 })) as never }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({ baseColor: [0.2, 0.22, 0.2, 1], roughness: 0.95 }),
          ) as never,
        },
      ],
      [Transform, {}],
    )

    // The fixture project in memory: Risen's body, CMU clips and their joint map.
    const platform = memoryPlatform()
    const [body, walk, idle, attack, map] = await Promise.all(
      [bodyUrl, walkUrl, idleUrl, attackUrl, mapUrl].map(fetchBytes),
    )
    await platform.fs.writeBytes('assets/risen/base.glb', body!)
    await platform.fs.writeBytes('assets/cmu/walk.glb', walk!)
    await platform.fs.writeBytes('assets/cmu/idle.glb', idle!)
    await platform.fs.writeBytes('assets/cmu/attack.glb', attack!)
    await platform.fs.writeBytes('assets/cmu/cmu-risen.jointmap.json', map!)
    const server = assetServer(world).configure({ platform, roots: ['assets'] })
    const report = await server.scan()
    if (report.failed.length) {
      demo.note = `import failed: ${report.failed.map((f) => `${f.path} ${f.error.code}`).join(', ')}`
      return
    }
    const sub = (path: string, type: string) =>
      server.info(path).subAssets!.find((a) => a.type === type)!.path
    for (const s of server.info('assets/risen/base.glb').subAssets ?? []) await server.load(s.path)
    const clip = async (name: string) => {
      await server.load(sub(`assets/cmu/${name}.glb`, 'AnimationClip'))
      await server.load(sub(`assets/cmu/${name}.glb`, 'Skin'))
      return server.resolve<'AnimationClip'>(sub(`assets/cmu/${name}.glb`, 'AnimationClip'))!
    }
    const walkRef = await clip('walk')
    const idleRef = await clip('idle')
    const attackRef = await clip('attack')
    await server.load('assets/cmu/cmu-risen.jointmap.json')
    const cmuSkin = server.resolve<'Skin'>(sub('assets/cmu/walk.glb', 'Skin'))!
    demo.model = server.resolve<'Scene'>('assets/risen/base.glb#Scene')!
    demo.walk = walkRef
    demo.rig = createCharacterRig(world, {
      name: 'zombie',
      model: demo.model,
      builds: [],
      clips: { walk: walkRef, idle: idleRef, attack: attackRef },
      retarget: {
        source: cmuSkin,
        map: server.resolve<'JointMap'>('assets/cmu/cmu-risen.jointmap.json')!,
        mode: 'rotation-and-root',
        align: true,
      },
      far: { merge: ['body-*'] },
      parts: {
        eyelashes: { minTier: 'near' },
        eyebrows: { minTier: 'mid' },
        eyes: { minTier: 'mid' },
      },
    })

    // The ragdoll, generated from the body's skin weights; rests on stand-in clips.
    const probe = spawnCharacter(world, demo.rig, { parts: partsOf(world, demo.model) })
    const st = world.resource(CharacterStates).get(probe)!
    const partMeshes: Mesh[] = []
    for (const part of st.parts) {
      const ref = world.get(part, Mesh3d).mesh
      const m = ref ? meshes.get(ref) : undefined
      if (m?.joints && m.weights) partMeshes.push(m)
    }
    const json = generateRagdoll(
      { skeleton: demo.rig.skeleton, rest: demo.rig.builds[0]!.rest, meshes: partMeshes },
      { skeleton: 'assets/risen/base.glb' },
    )
    world.despawn(probe)
    json.rests = structuredClone(HUMANOID_RESTS)
    demo.asset = world
      .resource(RagdollAssets)
      .add(parseRagdoll(json), 'zombie') as AssetRef<'Ragdoll'>
    registerRestClips(world, world.resource(Skins).get(cmuSkin)!)
    resetZombies(world)
    demo.note = `ragdoll: ${Object.keys(json.bodies as object).length} bodies generated from the skin`

    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    let down: { x: number; y: number } | null = null
    let cursor = { x: 0, y: 0 }
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY }
    })
    canvas.addEventListener('pointermove', (e) => {
      cursor = { x: e.clientX, y: e.clientY }
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 5) return // an orbit drag
      shoot(world, canvas, e.clientX, e.clientY, e.shiftKey ? 'heavy' : e.altKey ? 'kill' : 'shot')
    })
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyN') shootNearest(world, e.shiftKey ? 'heavy' : e.altKey ? 'kill' : 'shot')
      else if (e.code === 'KeyC') shoot(world, canvas, cursor.x, cursor.y, 'car')
      else if (e.code === 'KeyR') resetZombies(world)
      else if (e.code === 'KeyO') {
        demo.overlay = !demo.overlay
        setOverlays(world, { ragdoll: demo.overlay, skeleton: demo.overlay })
      }
    })
    ;(window as unknown as { ragdollDemo: object }).ragdollDemo = {
      nearest: (shot: Shot = 'shot') => shootNearest(world, shot),
      at: (x: number, y: number, shot: Shot = 'shot') => shoot(world, canvas, x, y, shot),
      reset: () => resetZombies(world),
      last: () => demo.last,
      describe: () => describeSim(world),
      states: () =>
        demo.zombies.filter((e) => world.isAlive(e)).map((e) => world.get(e, Reaction).state),
    }
    hudExtras.push(hudLines)
  },
})
