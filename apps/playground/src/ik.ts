import {
  AnimationPlayer,
  Attach,
  animationLayer,
  BoneSocket,
  ChainIk,
  describeIk,
  describePlayer,
  FootPlacement,
  LookAtIk,
  Retarget,
  TwoBoneIk,
} from '@shard/animation'
import {
  addBipedAssets,
  addCreatureAssets,
  type Biped,
  type BipedAssets,
  biped,
  creature,
  spawnBiped,
  spawnCreatures,
} from '@shard/animation/testing'
import {
  type AssetRef,
  ChildOf,
  defineComponent,
  defineSystem,
  type Entity,
  ProfilerResource,
  quat,
  t,
  Update,
  type World,
} from '@shard/core'
import { box, plane, sphere } from '@shard/mesh'
import { Collider, createRayHit, Physics, RigidBody } from '@shard/physics'
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
  setOverlays,
} from '@shard/render'
import { type App, definePlugin, Time } from '@shard/runtime'
import { lookAt, Transform, worldPosition } from '@shard/transform'
import { hudExtras } from './hud'

const still = new URLSearchParams(location.search).has('still')

/** How a biped moves: 0 follows the waypoint loop over the hill and stairs, 1 walks a circle. */
const Stroll = defineComponent('playground/Stroll', {
  mode: t.u8(),
  /** Circle: turn rate, rad/s. */
  rate: t.f32(),
  /** Waypoint loop: which one it heads for. */
  next: t.u8(),
})

/** Tentacle targets: arm k reaches for the orb, offset around it. */
const Reach = defineComponent('playground/Reach', {
  arm: t.u8(),
  /** The creature root, for the reach distance. */
  body: t.entity(),
})

// --- terrain -----------------------------------------------------------------------------------

const SLOPE = (20 * Math.PI) / 180
const HILL_TOP = 3 * Math.tan(SLOPE)
/** The walker's loop: over the hill on z = 0, back over the stairs on z = 4.5. */
const WAYPOINTS: [number, number][] = [
  [-4, 0],
  [11, 0],
  [11, 4.5],
  [-4, 4.5],
]

function terrain(world: World, stone: AssetRef, grass: AssetRef): void {
  const meshes = world.resource(Meshes)
  const solid = (
    size: [number, number, number],
    translation: number[],
    rotationZ = 0,
    material = stone,
  ) =>
    world.spawn(
      [RigidBody, { kind: 'fixed' }],
      [Collider, { shape: 'cuboid', halfExtents: size.map((v) => v / 2) as never }],
      [Mesh3d, { mesh: meshes.add(box({ x: size[0], y: size[1], z: size[2] })) as never }],
      [MeshMaterial, { material: material as never }],
      [
        Transform,
        {
          translation: translation as never,
          rotation: [0, 0, Math.sin(rotationZ / 2), Math.cos(rotationZ / 2)] as never,
        },
      ],
    )
  // Ground.
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [30, 0.5, 30] }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 60 })) as never }],
    [MeshMaterial, { material: grass as never }],
    [Transform, {}],
  )
  // The hill: up at 20°, a plateau, down at 20°. Each slab's top passes through its edge points.
  const len = 3 / Math.cos(SLOPE)
  const n = [-Math.sin(SLOPE), Math.cos(SLOPE)]
  solid([len, 0.4, 3.4], [1.5 - n[0]! * 0.2, HILL_TOP / 2 - n[1]! * 0.2, 0], SLOPE)
  solid([2, HILL_TOP, 3.4], [4, HILL_TOP / 2, 0])
  solid([len, 0.4, 3.4], [6.5 + n[0]! * 0.2, HILL_TOP / 2 - n[1]! * 0.2, 0], -SLOPE)
  // Stairs up and down on the way back.
  const steps = [0.15, 0.3, 0.45, 0.3, 0.15]
  for (const [k, h] of steps.entries()) solid([0.9, h, 2.4], [1.5 + k * 0.9, h / 2, 4.5])
}

// --- behaviour ---------------------------------------------------------------------------------

const rayHit = createRayHit()
const down = [0, -1, 0]
const origin = [0, 0, 0]

/** Steers strollers (waypoints or circles) and keeps each on the ground under it. */
const stroll = defineSystem({
  name: 'playground/ik-stroll',
  setup: (world) => ({ q: world.query({ with: [Stroll, Transform] }) }),
  run: ({ q }, world) => {
    const dt = world.resource(Time).delta
    const physics = world.tryResource(Physics)
    for (const table of q.tables) {
      const modes = table.column(Stroll, 'mode')
      const rates = table.column(Stroll, 'rate')
      const next = table.column(Stroll, 'next')
      const tr = table.column(Transform, 'translation')
      const ro = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        let yaw = 2 * Math.atan2(ro[i * 4 + 1]!, ro[i * 4 + 3]!)
        const x = tr[i * 3]!
        const z = tr[i * 3 + 2]!
        if (modes[i] === 0) {
          const [wx, wz] = WAYPOINTS[next[i]!]!
          if (Math.hypot(wx - x, wz - z) < 0.6) next[i] = (next[i]! + 1) % WAYPOINTS.length
          // Forward is -Z turned by yaw: face (dx, dz) with yaw = atan2(-dx, -dz).
          let d = Math.atan2(-(wx - x), -(wz - z)) - yaw
          d = Math.atan2(Math.sin(d), Math.cos(d))
          yaw += Math.max(-1.6 * dt, Math.min(1.6 * dt, d))
        } else {
          yaw += rates[i]! * dt
        }
        ro[i * 4] = 0
        ro[i * 4 + 1] = Math.sin(yaw / 2)
        ro[i * 4 + 2] = 0
        ro[i * 4 + 3] = Math.cos(yaw / 2)
        // Stand on whatever is below.
        if (physics) {
          origin[0] = x
          origin[1] = tr[i * 3 + 1]! + 1.5
          origin[2] = z
          if (physics.raycast(origin, down, undefined, rayHit)) {
            const y = tr[i * 3 + 1]!
            tr[i * 3 + 1] = y + (rayHit.point[1]! - y) * Math.min(1, dt * 12)
          }
        }
      }
      table.markChanged(Transform)
    }
  },
})

interface DemoState {
  ik: number
  ikOn: boolean
  retarget: boolean
  swordHand: 'hand_r' | 'hand_l'
  overlay: boolean
  walker: Entity | undefined
  stander: Entity | undefined
  sword: Entity | undefined
  orb: Entity | undefined
  creature: Entity | undefined
  rigs: { root: Entity; label: string; source: AssetRef }[]
  note: string
}

const demo: DemoState = {
  ik: 1,
  ikOn: true,
  retarget: true,
  swordHand: 'hand_r',
  overlay: false,
  walker: undefined,
  stander: undefined,
  sword: undefined,
  orb: undefined,
  creature: undefined,
  rigs: [],
  note: '',
}

/** The orb drifts through the scene; tentacle targets circle it; IK weights fade with the toggle. */
const animate = defineSystem({
  name: 'playground/ik-animate',
  setup: (world) => ({
    reach: world.query({ with: [Reach, Transform] }),
    two: world.query({ with: [TwoBoneIk] }),
    feet: world.query({ with: [FootPlacement] }),
    look: world.query({ with: [LookAtIk] }),
    chain: world.query({ with: [ChainIk] }),
    cams: world.query({ with: [Camera3d, Transform] }),
  }),
  run: (q, world) => {
    const time = world.resource(Time)
    const dt = time.delta
    const s = time.elapsed
    demo.ik += ((demo.ikOn ? 1 : 0) - demo.ik) * Math.min(1, dt * 5)
    if (Math.abs(demo.ik - (demo.ikOn ? 1 : 0)) < 0.002) demo.ik = demo.ikOn ? 1 : 0
    // The orb: a slow Lissajous loop over everything.
    const orb = demo.orb
    let ox = 0
    let oy = 0
    let oz = 0
    if (orb !== undefined) {
      ox = 1 + 7.5 * Math.sin(s * 0.23)
      oy = 1.7 + 0.8 * Math.sin(s * 0.61)
      oz = 4 + 4.5 * Math.sin(s * 0.37 + 1)
      const tr = world.entityTable(orb).column(Transform, 'translation')
      const row = world.entityRow(orb)
      tr[row * 3] = ox
      tr[row * 3 + 1] = oy
      tr[row * 3 + 2] = oz
      world.entityTable(orb).markChanged(Transform, row)
    }
    // Tentacles reach for the orb when it's near, each arm to its own side of it.
    let reachWeight = 0
    if (demo.creature !== undefined) {
      const c = worldPosition(world, demo.creature)
      const d = Math.hypot(ox - c[0], oy - (c[1] + 0.9), oz - c[2])
      reachWeight = Math.max(0, Math.min(1, (3.2 - d) / 1.2))
      for (const table of q.reach.tables) {
        const arms = table.column(Reach, 'arm')
        const tr = table.column(Transform, 'translation')
        for (let i = 0; i < table.count; i++) {
          const a = (arms[i]! / 5) * Math.PI * 2 + s * 1.3
          tr[i * 3] = ox + Math.cos(a) * 0.3
          tr[i * 3 + 1] = oy + Math.sin(a * 2) * 0.15
          tr[i * 3 + 2] = oz + Math.sin(a) * 0.3
        }
        table.markChanged(Transform)
      }
    }
    const w = demo.ik
    for (const table of q.two.tables) {
      table.column(TwoBoneIk, 'weight').fill(w)
      table.markChanged(TwoBoneIk)
    }
    for (const table of q.feet.tables) {
      table.column(FootPlacement, 'weight').fill(w)
      table.markChanged(FootPlacement)
    }
    for (const table of q.look.tables) {
      table.column(LookAtIk, 'weight').fill(w)
      table.markChanged(LookAtIk)
    }
    for (const table of q.chain.tables) {
      table.column(ChainIk, 'weight').fill(w * reachWeight)
      table.markChanged(ChainIk)
    }
    // The camera circles slowly.
    // From the front (the walkers face -Z), swinging slowly side to side.
    const angle = still ? -0.35 : -0.35 + Math.sin(s * 0.05) * 0.45
    const eye: [number, number, number] = [2 + Math.sin(angle) * 19, 9, 5 - Math.cos(angle) * 19]
    const rotation = lookAt(eye, [4.5, 2.6, 5])
    for (const table of q.cams.tables) {
      const tr = table.column(Transform, 'translation')
      const ro = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        tr.set(eye, i * 3)
        ro.set(rotation, i * 4)
      }
      table.markChanged(Transform)
    }
  },
})

// --- rigs --------------------------------------------------------------------------------------

/** Legs with two-bone IK and foot placement, and a head (with spine, chest, neck) that watches `target`. */
function rigBiped(
  world: World,
  body: Biped,
  root: Entity,
  target: Entity,
  options: { feet: boolean },
): void {
  const legs: { ik: Entity; foot: string }[] = []
  if (options.feet) {
    for (const side of ['L', 'R'] as const) {
      const x = side === 'L' ? -0.1 : 0.1
      const s = body.scale
      const goal = world.spawn([Transform, {}])
      const pole = world.spawn(
        [Transform, { translation: [x * s, 0.5 * s, -1 * s] }],
        [ChildOf, { parent: root }],
      )
      const ik = world.spawn(
        [
          TwoBoneIk,
          {
            root: body.path('UpLeg', side),
            mid: body.path('Leg', side),
            tip: body.path('Foot', side),
            target: goal,
            pole,
            tipRotation: 1,
          },
        ],
        [ChildOf, { parent: root }],
      )
      legs.push({ ik, foot: body.path('Foot', side) })
    }
    world.add(root, FootPlacement, {
      feet: legs.map((l) => ({ ik: l.ik, footJoint: l.foot, offset: body.ankle })),
      hips: body.path('Hips'),
      maxStep: 0.45 * body.scale,
    })
  }
  world.add(root, LookAtIk, {
    joint: body.path('Head'),
    target,
    axis: body.localAxis('Head', undefined, [0, 0, -1]) as never,
    maxAngle: 70,
    chain: [
      { joint: body.path('Spine'), share: 0.15 },
      { joint: body.path('Chest'), share: 0.2 },
      { joint: body.path('Neck'), share: 0.25 },
    ],
  })
}

function spawnSword(world: World, owner: Entity, steel: AssetRef, hilt: AssetRef): Entity {
  const meshes = world.resource(Meshes)
  const sword = world.spawn([Transform, {}], [Attach, { owner, socket: demo.swordHand }])
  const part = (size: [number, number, number], y: number, material: AssetRef) =>
    world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: size[0], y: size[1], z: size[2] })) as never }],
      [MeshMaterial, { material: material as never }],
      [Transform, { translation: [0, y, 0] }],
      [ChildOf, { parent: sword }],
    )
  part([0.035, 0.85, 0.012], -0.52, steel)
  part([0.16, 0.025, 0.04], -0.09, hilt)
  part([0.03, 0.14, 0.03], 0, hilt)
  return sword
}

// --- HUD ---------------------------------------------------------------------------------------

const cm = (m: unknown) => (typeof m === 'number' ? `${(m * 100).toFixed(1)} cm` : '—')

function hudLines(world: World): string[] {
  const timings = world.resource(ProfilerResource).all()
  const all = describeIk(world)
  const lines = [
    '',
    `ik: ${all.length} solvers at weight ${demo.ik.toFixed(2)} · ik ${(timings['animation/ik']?.avg ?? 0).toFixed(3)} ms · sample ${(timings['animation/sample']?.avg ?? 0).toFixed(2)} ms`,
  ]
  const feet = (label: string, e: Entity | undefined) => {
    if (e === undefined) return
    const f = describeIk(world, e).find((s) => s.kind === 'feet') as
      | { hipsDrop: number | null; feet: { grounded: boolean }[] }
      | undefined
    if (!f) return
    lines.push(
      `  ${label}: feet ${f.feet.map((x) => (x.grounded ? 'on ground' : 'no ground')).join(' / ')} · hips ${cm(f.hipsDrop)}`,
    )
  }
  feet('walker (hill, stairs)', demo.walker)
  feet('stander (20° slope)', demo.stander)
  const looks = all.filter((s) => s.kind === 'look-at' && s.solved)
  const clamped = looks.filter((s) => s.clamped).length
  lines.push(
    `  heads on the orb: ${looks.length - clamped} tracking, ${clamped} at their 70° limit`,
  )
  const chains = all.filter((s) => s.kind === 'chain' && s.solved)
  if (chains.length > 0) {
    const worst = Math.max(...chains.map((s) => (s.targetError as number) ?? 0))
    const passes = Math.max(...chains.map((s) => (s.iterations as number) ?? 0))
    lines.push(
      `  tentacles: reaching, worst ${(worst * 1000).toFixed(1)} mm off in ≤${passes} FABRIK passes`,
    )
  } else {
    lines.push('  tentacles: waiting for the orb')
  }
  for (const rig of demo.rigs) {
    const r = describePlayer(world, rig.root).retarget
    lines.push(
      r
        ? `  ${rig.label}: retargeted, hips ×${r.hipRatio ?? '?'}${r.unmappedJoints.length ? `, unmapped ${r.unmappedJoints.join(' ')}` : ''}`
        : `  ${rig.label}: retarget off (raw source rotations)`,
    )
  }
  lines.push(`  sword on ${demo.swordHand}${demo.note ? ` · ${demo.note}` : ''}`)
  return lines
}

// --- the demo ----------------------------------------------------------------------------------

export const ikDemoPlugin = definePlugin({
  name: 'ik-demo',
  dependencies: ['scene', 'animation'],
  build(app) {
    app.addSystems(Update, stroll, animate)
  },
  async ready(app: App) {
    const world = app.world
    world.resource(AmbientLight).brightness = 1100
    world.spawn(
      [DirectionalLight, { illuminance: 45_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.7, 0) as never }],
    )
    world.spawn(
      [Camera3d, { fovY: 50, clearColor: [0.03, 0.035, 0.05, 1] }],
      [Exposure, { ev100: 13.8 }],
      [Transform, { translation: [4, 6, 18] }],
    )
    const materials = world.resource(Materials)
    const mat = (baseColor: number[], extra: Record<string, unknown> = {}) =>
      materials.add(new MaterialAsset({ baseColor, roughness: 0.8, metallic: 0, ...extra }))
    terrain(world, mat([0.42, 0.4, 0.38, 1]), mat([0.16, 0.22, 0.14, 1], { roughness: 0.95 }))
    const orb = world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(sphere({ radius: 0.12 })) as never }],
      [
        MeshMaterial,
        {
          material: mat([1, 0.9, 0.5, 1], {
            emissive: [1, 0.8, 0.35, 1],
            emissiveLuminance: 6000,
          }) as never,
        },
      ],
      [Transform, { translation: [0, 1.5, 4] }],
    )
    demo.orb = orb

    // The walker: foot placement over the hill and stairs, a sword in its hand.
    const body = biped()
    const assets = addBipedAssets(world, body, [0.9, 0.55, 0.3, 1])
    const walker = spawnBiped(world, body, assets, [-4, 0, 4.5], 0, 'walker')
    world.add(walker.root, AnimationPlayer, {
      layers: [animationLayer(assets.walk)],
      rootMotion: 'transform',
    })
    world.add(walker.root, Stroll, { mode: 0 })
    rigBiped(world, body, walker.root, orb, { feet: true })
    world.add(walker.joint(body.path('Hand', 'R')), BoneSocket, {
      name: 'hand_r',
      offset: [0, -0.07, 0],
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    })
    world.add(walker.joint(body.path('Hand', 'L')), BoneSocket, {
      name: 'hand_l',
      offset: [0, -0.07, 0],
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    })
    demo.walker = walker.root
    demo.sword = spawnSword(
      world,
      walker.root,
      mat([0.8, 0.82, 0.86, 1], { metallic: 1, roughness: 0.25 }),
      mat([0.3, 0.18, 0.1, 1]),
    )

    // The stander: idle across the slope, downhill foot lower, hips dropped to reach it.
    const blue = addBipedAssets(world, body, [0.3, 0.55, 0.95, 1])
    const stander = spawnBiped(world, body, blue, [1.6, HILL_TOP * (1.6 / 3), -1.1], 0, 'stander')
    world.add(stander.root, AnimationPlayer, { layers: [animationLayer(blue.idle)] })
    rigBiped(world, body, stander.root, orb, { feet: true })
    demo.stander = stander.root

    // Three other rigs on the walker's clip: other sizes, names, and bind orientations.
    const rigs: { label: string; b: Biped; color: number[]; at: [number, number, number] }[] = [
      {
        label: 'short, twisted bind',
        b: biped({ scale: 0.6, twisted: true, name: 'short' }),
        color: [0.55, 0.85, 0.4, 1],
        at: [-3, 0, -5],
      },
      {
        label: 'tall, LeftUpLeg names',
        b: biped({ scale: 1.3, names: 'prefix', name: 'tall' }),
        color: [0.85, 0.4, 0.75, 1],
        at: [4, 0, -6.5],
      },
      {
        label: 'tiny, twisted, Left names',
        b: biped({ scale: 0.42, names: 'prefix', twisted: true, name: 'tiny' }),
        color: [0.95, 0.85, 0.35, 1],
        at: [10, 0, -4.5],
      },
    ]
    for (const [k, r] of rigs.entries()) {
      const a: BipedAssets = addBipedAssets(world, r.b, r.color)
      const spawned = spawnBiped(world, r.b, a, r.at, k * 120, r.label.split(',')[0]!)
      world.add(spawned.root, Retarget, { source: assets.skin as never, mode: 'rotation-and-root' })
      world.add(spawned.root, AnimationPlayer, {
        layers: [animationLayer(assets.walk, { time: k * 0.31 })],
        rootMotion: 'transform',
      })
      world.add(spawned.root, Stroll, { mode: 1, rate: 0.45 + k * 0.1 })
      rigBiped(world, r.b, spawned.root, orb, { feet: false })
      demo.rigs.push({ root: spawned.root, label: r.label, source: assets.skin })
    }

    // A tentacle creature: every arm a 12-joint FABRIK chain reaching for the orb.
    const c = creature()
    const cAssets = addCreatureAssets(world, c, [0.55, 0.35, 0.8, 1])
    const [critter] = spawnCreatures(world, c, cAssets, [[-5, 0, 3]])
    demo.creature = critter
    for (let arm = 0; arm < 5; arm++) {
      const target = world.spawn([Transform, {}], [Reach, { arm, body: critter! }])
      const joints = c.joints.slice(arm * 12, arm * 12 + 12)
      world.spawn(
        [ChainIk, { root: joints[0]!, tip: joints[11]!, target, weight: 0 }],
        [ChildOf, { parent: critter! }],
      )
    }

    const actions: Record<string, () => void> = {
      ik: () => {
        demo.ikOn = !demo.ikOn
        demo.note = demo.ikOn ? 'IK fading in' : 'IK fading out: the raw animation'
      },
      retarget: () => {
        demo.retarget = !demo.retarget
        for (const rig of demo.rigs) {
          if (demo.retarget)
            world.add(rig.root, Retarget, {
              source: rig.source as never,
              mode: 'rotation-and-root',
            })
          else world.remove(rig.root, Retarget)
        }
        demo.note = demo.retarget
          ? 'retargeting on'
          : 'retargeting off: twisted binds take the source rotations raw'
      },
      sword: () => {
        demo.swordHand = demo.swordHand === 'hand_r' ? 'hand_l' : 'hand_r'
        world.set(demo.sword!, Attach, { socket: demo.swordHand })
        demo.note = `sword re-attached to socket ${demo.swordHand}`
      },
      overlay: () => {
        demo.overlay = !demo.overlay
        setOverlays(world, { ik: demo.overlay, skeleton: demo.overlay })
      },
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-ik]'))
      button.addEventListener('click', () => actions[button.dataset.ik!]?.())
    window.addEventListener('keydown', (event) => {
      const key = { Digit1: 'ik', Digit2: 'retarget', Digit3: 'sword', Digit4: 'overlay' }[
        event.code
      ]
      if (key) actions[key]!()
    })
    hudExtras.push(hudLines)
  },
})
