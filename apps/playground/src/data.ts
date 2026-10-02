import { assetServer, loadAll } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineComponent,
  defineSystem,
  type Entity,
  quat,
  t,
  Update,
} from '@aethervtt/shard-core'
import { sphere } from '@aethervtt/shard-mesh'
import type { Platform } from '@aethervtt/shard-platform'
import {
  createProjectReloader,
  defineProject,
  type ProjectReloader,
} from '@aethervtt/shard-project'
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
} from '@aethervtt/shard-render'
import { type App, definePlugin, Time } from '@aethervtt/shard-runtime'
import {
  findEntityByPath,
  loadScene,
  type SceneEntity,
  type SceneFile,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { Transform } from '@aethervtt/shard-transform'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

// --- the weapon files --------------------------------------------------------------------------
//
// Real `.weapon.json` files in an in-memory project folder (memory.ts): imported, validated,
// merged through `$extends`, and hot reloaded by the same code that runs in `shard dev`.

const LASER = 'data/weapons/laser.weapon.json'
const HEAVY = 'data/weapons/heavy-laser.weapon.json'
const SCATTER = 'data/weapons/scatter.weapon.json'
const RAIL = 'data/weapons/rail.weapon.json'
const LANES = [LASER, HEAVY, SCATTER, RAIL]

/** The base laser. "Overcharge" cycles it; its variants follow for every field they don't set. */
const laserLooks = [
  { damage: 10, fireRate: 4, bolt: { speed: 30, size: 0.12, color: '#ff4a3d' } },
  { damage: 10, fireRate: 9, bolt: { speed: 44, size: 0.12, color: '#ff2d95' } },
  { damage: 16, fireRate: 3, bolt: { speed: 22, size: 0.16, color: '#ff7a1a' } },
]
const heavyLooks = [
  { damage: 35, fireRate: 1.5, bolt: { size: 0.32, color: '#ffc040' } },
  { damage: 60, fireRate: 1, bolt: { size: 0.5, color: '#fff27a' } },
]

const files = {
  laser: (i: number) => ({ $schema: '../../.shard/schemas/weapon.schema.json', ...laserLooks[i]! }),
  heavy: (i: number) => ({ $extends: { path: LASER }, ...heavyLooks[i]! }),
  // Five pellets in a fan; speed and color come from the laser.
  scatter: (broken: boolean) => ({
    $extends: { path: LASER },
    damage: 4,
    fireRate: 2.5,
    pellets: broken ? 300 : 5,
    spread: 0.09,
  }),
  rail: () => ({ damage: 80, fireRate: 0.6, bolt: { speed: 140, size: 0.09, color: '#b98bff' } }),
}

// --- the project script, in two versions ----------------------------------------------------------

/** Bolts are pooled engine-side entities; the project's systems fire and move them. */
const Bolt = defineComponent('data-range/Bolt', {
  vx: t.f32(),
  vz: t.f32(),
  damage: t.f32(),
  lane: t.u8(),
  live: t.bool(),
})

const RANGE_START = -10
const TARGET_X = 12
const POOL = 400
const laneZ = (lane: number) => (lane - 1.5) * 3.2

interface Range {
  pool: Entity[]
  next: number
  /** Damage landed per lane, for measured DPS. */
  landed: number[]
  materials: MaterialAsset[]
  refs: AssetRef<'Material'>[]
  /** Bolt colors the lane materials were last set to. */
  colors: string[]
}

const range: Range = {
  pool: [],
  next: 0,
  landed: [0, 0, 0, 0],
  materials: [],
  refs: [],
  colors: [],
}

/**
 * What `scripts/main.ts` would be. Version 2 adds a `knockback` field to Weapon: reloading it
 * re-imports every weapon file against the new schema and the field takes its default.
 */
function script(version: 1 | 2) {
  const project = defineProject({
    name: 'data-demo',
    build(app) {
      app.addSystems(Update, fire, fly)
    },
  })
  const Weapon = project.dataAsset(
    'Weapon',
    {
      damage: t.f32({ default: 10, min: 0, unit: 'hp', description: 'Damage per bolt.' }),
      fireRate: t.f32({ default: 4, min: 0.1, max: 30, unit: 'shots/s' }),
      pellets: t.u8({ default: 1, min: 1, max: 16, description: 'Bolts per shot.' }),
      spread: t.f32({
        default: 0,
        min: 0,
        max: 0.5,
        unit: 'rad',
        description: 'Fan between pellets.',
      }),
      bolt: t.struct({
        speed: t.f32({ default: 30, min: 1, unit: 'm/s' }),
        size: t.f32({ default: 0.12, min: 0.01 }),
        color: t.color({ default: [1, 0.3, 0.2, 1] }),
      }),
      ...(version === 2
        ? { knockback: t.f32({ default: 0.12, min: 0, unit: 'm', description: 'Push per hit.' }) }
        : {}),
    },
    { extension: 'weapon', description: 'A turret weapon.' },
  )
  const Armed = project.component('Armed', {
    weapon: t.handle('data-demo/Weapon', { description: 'What this turret fires.' }),
    lane: t.u8(),
    cooldown: t.f32({ unit: 's' }),
  })
  const Target = project.component('Target', { lane: t.u8(), push: t.f32({ unit: 'm' }) })

  const fire = defineSystem({
    name: 'data-demo/fire',
    setup: (world) => ({ q: world.query({ with: [Armed] }) }),
    run: ({ q }, world) => {
      const weapons = world.resource(Weapon.store)
      const dt = world.resource(Time).delta
      for (const table of q.tables) {
        const refs = table.column(Armed, 'weapon')
        const lanes = table.column(Armed, 'lane')
        const cooldown = table.column(Armed, 'cooldown')
        for (let i = 0; i < table.count; i++) {
          // One map lookup: the value object, updated in place when its file changes.
          const w = weapons.get(refs[i])
          if (!w) continue
          const lane = lanes[i]!
          const mat = range.materials[lane]!
          const c = w.bolt.color
          const key = `${c[0]},${c[1]},${c[2]}`
          if (range.colors[lane] !== key) {
            range.colors[lane] = key
            mat.set({ baseColor: [c[0], c[1], c[2], 1], emissive: [c[0], c[1], c[2], 1] })
          }
          cooldown[i] = cooldown[i]! - dt
          if (cooldown[i]! > 0) continue
          cooldown[i] = cooldown[i]! + 1 / w.fireRate
          if (cooldown[i]! < 0) cooldown[i] = 0
          const n = w.pellets
          for (let k = 0; k < n; k++) {
            const angle = n === 1 ? 0 : w.spread * (k - (n - 1) / 2)
            const e = range.pool[range.next]!
            range.next = (range.next + 1) % POOL
            const bolt = world.get(e, Bolt)
            bolt.vx = Math.cos(angle) * w.bolt.speed
            bolt.vz = Math.sin(angle) * w.bolt.speed
            bolt.damage = w.damage
            bolt.lane = lane
            bolt.live = true
            world.set(e, Bolt, bolt)
            const s = w.bolt.size
            world.set(e, Transform, {
              translation: [RANGE_START + 1.4, 1.1, laneZ(lane)],
              scale: [s, s, s],
            })
            world.set(e, MeshMaterial, { material: range.refs[lane]! })
          }
        }
      }
    },
  })

  const fly = defineSystem({
    name: 'data-demo/fly',
    setup: (world) => ({
      bolts: world.query({ with: [Bolt, Transform] }),
      targets: world.query({ with: [Target, Transform] }),
      armed: world.query({ with: [Armed] }),
    }),
    run: ({ bolts, targets, armed }, world) => {
      const dt = world.resource(Time).delta
      const weapons = world.resource(Weapon.store)
      const push = [0, 0, 0, 0]
      for (const table of bolts.tables) {
        const vx = table.column(Bolt, 'vx')
        const vz = table.column(Bolt, 'vz')
        const damage = table.column(Bolt, 'damage')
        const lane = table.column(Bolt, 'lane')
        const live = table.column(Bolt, 'live')
        const tr = table.column(Transform, 'translation')
        for (let i = 0; i < table.count; i++) {
          if (!live[i]) continue
          tr[i * 3] = tr[i * 3]! + vx[i]! * dt
          tr[i * 3 + 2] = tr[i * 3 + 2]! + vz[i]! * dt
          if (tr[i * 3]! < TARGET_X - 0.3) continue
          live[i] = 0
          tr[i * 3 + 1] = -50
          range.landed[lane[i]!] = range.landed[lane[i]!]! + damage[i]!
          push[lane[i]!] = push[lane[i]!]! + 1
        }
        table.markChanged(Transform)
      }
      // Version 2 only: hits shove the target back, and it springs home.
      const knock = [0, 0, 0, 0]
      for (const table of armed.tables) {
        const refs = table.column(Armed, 'weapon')
        const lanes = table.column(Armed, 'lane')
        for (let i = 0; i < table.count; i++) {
          const w = weapons.get(refs[i]) as { knockback?: number } | undefined
          knock[lanes[i]!] = w?.knockback ?? 0
        }
      }
      for (const table of targets.tables) {
        const lanes = table.column(Target, 'lane')
        const offset = table.column(Target, 'push')
        const tr = table.column(Transform, 'translation')
        for (let i = 0; i < table.count; i++) {
          const l = lanes[i]!
          offset[i] = Math.min(3, offset[i]! + push[l]! * knock[l]!) * Math.exp(-3 * dt)
          tr[i * 3] = TARGET_X + 0.5 + offset[i]!
        }
        table.markChanged(Transform)
      }
    },
  })

  return { project, Weapon, Armed }
}

type Script = ReturnType<typeof script>

// --- the scene -----------------------------------------------------------------------------------

/** Turrets reference their weapon files by path: the scene loads them. */
const scene: SceneFile = {
  version: 1,
  assets: {
    floor: { type: 'Material', value: { baseColor: '#12151b', roughness: 0.9 } },
    lane: { type: 'Material', value: { baseColor: '#1c212b', roughness: 0.7 } },
    turret: { type: 'Material', value: { baseColor: '#5b6475', metallic: 0.6, roughness: 0.35 } },
    barrel: { type: 'Material', value: { baseColor: '#1b1e25', metallic: 0.5, roughness: 0.4 } },
    target: { type: 'Material', value: { baseColor: '#d7dbe3', roughness: 0.5 } },
  },
  entities: [
    {
      name: 'floor',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:plane?size=80' } },
        'render/MeshMaterial': { material: { path: '#floor' } },
      },
    },
    ...LANES.flatMap((path, lane): SceneEntity[] => [
      {
        name: `lane-${lane}`,
        components: {
          'core/Transform': { translation: [1, 0.01, laneZ(lane)] },
          'render/Mesh3d': { mesh: { path: 'procedural:box?x=24&y=0.02&z=1.6' } },
          'render/MeshMaterial': { material: { path: '#lane' } },
        },
      },
      {
        name: `turret-${lane}`,
        components: {
          'core/Transform': { translation: [RANGE_START, 0.45, laneZ(lane)] },
          'data-demo/Armed': { weapon: { path }, lane },
          'render/Mesh3d': {
            mesh: { path: 'procedural:cylinder?radius=0.55&height=0.9&segments=24' },
          },
          'render/MeshMaterial': { material: { path: '#turret' } },
        },
        children: [
          {
            name: 'barrel',
            components: {
              'core/Transform': { translation: [0.7, 0.65, 0] },
              'render/Mesh3d': { mesh: { path: 'procedural:box?x=1.4&y=0.22&z=0.22' } },
              'render/MeshMaterial': { material: { path: '#barrel' } },
            },
          },
        ],
      },
      {
        name: `target-${lane}`,
        components: {
          'core/Transform': { translation: [TARGET_X + 0.5, 1.2, laneZ(lane)] },
          'data-demo/Target': { lane },
          'render/Mesh3d': { mesh: { path: 'procedural:box?x=0.3&y=2.4&z=1.8' } },
          'render/MeshMaterial': { material: { path: '#target' } },
        },
      },
    ]),
  ],
}

// --- the demo ------------------------------------------------------------------------------------

interface DemoState {
  live: Script
  version: 1 | 2
  reloader: ProjectReloader | undefined
  laser: number
  heavy: number
  broken: boolean
  note: string
  busy: boolean
  /** (time, landed) samples per lane for measured DPS. */
  samples: { t: number; landed: number[] }[]
  catalog: string[]
}

const demo: DemoState = {
  live: undefined as unknown as Script,
  version: 1,
  reloader: undefined,
  laser: 0,
  heavy: 0,
  broken: false,
  note: '',
  busy: false,
  samples: [],
  catalog: [],
}

const name = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace('.weapon.json', '')

async function writeJson(platform: Platform, path: string, json: unknown): Promise<void> {
  await platform.fs.writeText(path, `${JSON.stringify(json, null, 2)}\n`)
}

/** Data assets (Unity's ScriptableObjects): turret weapons as `.weapon.json` files and variants. */
export const dataDemoPlugin = definePlugin({
  name: 'data-demo-host',
  dependencies: ['scene'],
  build() {},
  async ready(app: App) {
    const world = app.world
    world.resource(AmbientLight).brightness = 600
    world.spawn(
      [DirectionalLight, { illuminance: 30_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.5, 0) as never }],
    )
    const eye = [7, 14, 27] as [number, number, number]
    world.spawn(
      [Camera3d, { fovY: 50, clearColor: [0.02, 0.025, 0.035, 1] }],
      [Exposure, { ev100: 13.5 }],
      Transform,
      orbitFrom(eye, [-1, 6, -6]),
    )

    // The bolt pool and one glowing material per lane.
    const boltMesh = world.resource(Meshes).add(sphere({ radius: 1, segments: 12, rings: 8 }))
    const materials = world.resource(Materials)
    for (let lane = 0; lane < 4; lane++) {
      const mat = new MaterialAsset({ emissiveLuminance: 60_000, roughness: 0.3 })
      range.refs.push(materials.add(mat))
      range.materials.push(mat)
      range.colors.push('')
    }
    for (let i = 0; i < POOL; i++) {
      range.pool.push(
        world.spawn(
          [Bolt, {}],
          [Transform, { translation: [0, -50, 0] }],
          [Mesh3d, { mesh: boltMesh }],
          [MeshMaterial, { material: range.refs[0]! }],
        ),
      )
    }

    // The project folder: four weapon files, two of them variants of the laser.
    const platform = memoryPlatform()
    await writeJson(platform, LASER, files.laser(0))
    await writeJson(platform, HEAVY, files.heavy(0))
    await writeJson(platform, SCATTER, files.scatter(false))
    await writeJson(platform, RAIL, files.rail())
    const assets = assetServer(world).configure({ platform, roots: ['data'] })

    demo.live = script(1)
    await app.loadPlugin(demo.live.project)
    demo.reloader = createProjectReloader(app, {
      namespace: 'data-demo',
      current: demo.live.project,
    })
    await assets.scan()
    loadScene(world, scene, { id: 'range' })
    await whenSceneReady(world, 'range')
    const all = await loadAll(world, demo.live.Weapon)
    demo.catalog = assets.all(demo.live.Weapon).map((e) => e.path)
    demo.note = `loadAll found ${all.length} weapons; the scene's turrets loaded theirs by handle`

    const rescan = async (note: string) => {
      const report = await assets.scan()
      demo.note = report.failed.length
        ? `${note}: ${report.failed.map((f) => `${name(f.path)} failed at ${f.error.path}`).join(', ')}; last good value kept`
        : `${note}: re-imported ${report.imported.map(name).join(', ')}`
    }
    const actions: Record<string, () => Promise<void>> = {
      overcharge: async () => {
        demo.laser = (demo.laser + 1) % laserLooks.length
        await writeJson(platform, LASER, files.laser(demo.laser))
        await rescan('edited laser.weapon.json (heavy-laser and scatter extend it)')
      },
      heavy: async () => {
        demo.heavy = (demo.heavy + 1) % heavyLooks.length
        await writeJson(platform, HEAVY, files.heavy(demo.heavy))
        await rescan('edited heavy-laser.weapon.json')
      },
      script: async () => {
        const version = demo.version === 1 ? 2 : 1
        let next: Script | undefined
        const report = await demo.reloader!.reload(async () => {
          next = script(version)
          return { default: next.project }
        })
        if (!report.ok || !next) {
          demo.note = `reload failed: ${report.error?.message}`
          return
        }
        demo.live = next
        demo.version = version
        demo.note = `script v${version} (${version === 2 ? '+knockback' : 'no knockback'}): re-imported ${report.assets.imported.length} weapon files`
      },
      break: async () => {
        demo.broken = !demo.broken
        await writeJson(platform, SCATTER, files.scatter(demo.broken))
        await rescan(demo.broken ? 'scatter: pellets 300 (max 16)' : 'fixed scatter')
      },
      reset: async () => {
        demo.laser = 0
        demo.heavy = 0
        demo.broken = false
        await writeJson(platform, LASER, files.laser(0))
        await writeJson(platform, HEAVY, files.heavy(0))
        await writeJson(platform, SCATTER, files.scatter(false))
        await rescan('reset the files')
      },
    }
    const run = (key: string) => {
      if (demo.busy || !actions[key]) return
      demo.busy = true
      void actions[key]!().finally(() => {
        demo.busy = false
      })
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-weapon]')) {
      button.addEventListener('click', () => run(button.dataset.weapon!))
    }
    window.addEventListener('keydown', (event) => {
      const key = {
        Digit1: 'overcharge',
        Digit2: 'heavy',
        Digit3: 'script',
        Digit4: 'break',
        Digit5: 'reset',
      }[event.code]
      if (key) run(key)
    })

    hudExtras.push((w) => {
      const now = w.resource(Time).elapsed
      demo.samples.push({ t: now, landed: [...range.landed] })
      while (demo.samples.length > 2 && now - demo.samples[0]!.t > 4) demo.samples.shift()
      const first = demo.samples[0]!
      const span = Math.max(0.001, now - first.t)
      const weapons = w.resource(demo.live.Weapon.store)
      const rows = LANES.map((path, lane) => {
        const turret = findEntityByPath(w, `turret-${lane}`)
        const ref = turret === undefined ? undefined : w.get(turret, demo.live.Armed).weapon
        const v = weapons.get(ref) as
          | { damage: number; fireRate: number; pellets: number; knockback?: number }
          | undefined
        const info = assets.info(path)
        const base = (info.info?.extends as string[] | undefined)?.map(name).join(' → ')
        if (!v) return `  ${name(path).padEnd(12)} not loaded`
        const dps = v.damage * v.pellets * v.fireRate
        const measured = (range.landed[lane]! - first.landed[lane]!) / span
        const knock = v.knockback === undefined ? '' : ` knock ${v.knockback}`
        return [
          `  ${name(path).padEnd(12)}`,
          `dmg ${String(v.damage).padStart(3)}`,
          `×${v.pellets}`,
          `@ ${v.fireRate.toFixed(1)}/s`,
          `dps ${dps.toFixed(0).padStart(3)} (hit ${measured.toFixed(0).padStart(3)})${knock}`,
          base ? `extends ${base}` : '',
          info.error ? `✗ ${info.error.path}` : '',
        ].join(' ')
      })
      const setBy = (assets.info(HEAVY).info?.setBy ?? {}) as Record<string, string>
      const byFile = new Map<string, string[]>()
      for (const [field, file] of Object.entries(setBy)) {
        byFile.set(name(file), [...(byFile.get(name(file)) ?? []), field.slice(1)])
      }
      return [
        '',
        `data-demo/Weapon · script v${demo.version} · ${demo.catalog.length} files under data/weapons/`,
        ...rows,
        'heavy-laser fields, by the file that set them:',
        ...[...byFile].map(([file, fields]) => `  ${file.padEnd(12)} ${fields.join(', ')}`),
        '  defaults     the rest',
        demo.note ? `> ${demo.note}` : '',
        '1 overcharge laser · 2 edit heavy · 3 reload script · 4 break scatter · 5 reset',
      ]
    })
  },
})
