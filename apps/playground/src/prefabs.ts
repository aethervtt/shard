import { defineComponent, defineSystem, type Entity, quat, Rng, t, Update } from '@shard/core'
import { AmbientLight, Camera3d, DirectionalLight, Exposure } from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import {
  applyToPrefab,
  currentOverrides,
  findEntityByPath,
  loadScene,
  type PrefabFile,
  PrefabInstance,
  registerPrefab,
  type SceneFile,
  spawnPrefab,
} from '@shard/scene'
import { lookAt, Transform } from '@shard/transform'
import { hudExtras } from './hud'

/** Bobs an entity up and down around `height`. */
const Hover = defineComponent('prefabs-demo/Hover', {
  height: t.f32({ default: 1.5, description: 'Rest height.' }),
  amplitude: t.f32({ default: 0.15 }),
  speed: t.f32({ default: 2 }),
})
/** Turns an entity around its Y axis. */
const Spin = defineComponent('prefabs-demo/Spin', { speed: t.f32({ default: 1 }) })
/** Swarm drones despawn when this runs out. */
const Ttl = defineComponent('prefabs-demo/Ttl', { seconds: t.f32({ default: 8 }) })

const DRONE = 'prefabs/drone.prefab.json'
const HEAVY = 'prefabs/heavy-drone.prefab.json'

/** The base drone. `edit` cycles its look to show hot reload. */
function drone(edit: number): PrefabFile {
  const shells = ['#c9d1dc', '#8fb8ff', '#e8d7b0', '#b7f0c8']
  const ring = [
    { radius: 0.75, tube: 0.05 },
    { radius: 0.95, tube: 0.035 },
    { radius: 0.62, tube: 0.09 },
    { radius: 0.85, tube: 0.06 },
  ][edit % 4]!
  const thrust = [0.35, 0.6, 0.25, 0.45][edit % 4]!
  return {
    version: 1,
    assets: {
      shell: {
        type: 'Material',
        value: { baseColor: shells[edit % 4]!, metallic: 0.6, roughness: 0.35 },
      },
      visor: {
        type: 'Material',
        value: {
          baseColor: '#0b1a22',
          emissive: '#40e0ff',
          emissiveLuminance: 4000,
          roughness: 0.2,
        },
      },
      accent: { type: 'Material', value: { baseColor: '#ff8a3d', metallic: 0.2, roughness: 0.5 } },
      // A palette: unused by default, picked by overrides ("#gold") in scenes and variants.
      gold: { type: 'Material', value: { baseColor: '#e2b23c', metallic: 0.35, roughness: 0.3 } },
      dark: { type: 'Material', value: { baseColor: '#1b1e25', metallic: 0.3, roughness: 0.6 } },
    },
    root: {
      name: 'drone',
      components: {
        'core/Transform': {},
        'prefabs-demo/Hover': { height: 1.5, amplitude: 0.15, speed: 2 },
      },
      children: [
        {
          name: 'Body',
          components: {
            'render/Mesh3d': {
              mesh: { path: 'procedural:sphere?radius=0.5&segments=32&rings=16' },
            },
            'render/MeshMaterial': { material: { path: '#shell' } },
          },
        },
        {
          name: 'Visor',
          components: {
            'core/Transform': { translation: [0, 0.08, 0.42], scale: [0.55, 0.16, 0.2] },
            'render/Mesh3d': { mesh: { path: 'procedural:cube?size=1' } },
            'render/MeshMaterial': { material: { path: '#visor' } },
          },
        },
        {
          name: 'Ring',
          components: {
            'render/Mesh3d': {
              mesh: {
                path: `procedural:torus?radius=${ring.radius}&tube=${ring.tube}&radialSegments=12&tubularSegments=48`,
              },
            },
            'render/MeshMaterial': { material: { path: '#accent' } },
            'prefabs-demo/Spin': { speed: 1.2 },
          },
        },
        ...(['L', 'R'] as const).map((side) => ({
          name: `Thruster${side}`,
          components: {
            'core/Transform': {
              translation: [side === 'L' ? -0.32 : 0.32, -0.45, -0.1],
              rotationEuler: [180, 0, 0],
            },
            'render/Mesh3d': {
              mesh: { path: `procedural:cone?radius=0.12&height=${thrust}&segments=16` },
            },
            'render/MeshMaterial': { material: { path: '#accent' } },
          },
        })),
        {
          name: 'Glow',
          components: {
            'core/Transform': { translation: [0, -0.8, 0] },
            'render/PointLight': { color: '#40e0ff', intensity: 600, range: 4 },
          },
        },
      ],
    },
  }
}

/** A variant: bigger, armored, no ring, and a turret on top. */
const heavy = {
  version: 1,
  extends: { path: DRONE },
  assets: {
    armor: { type: 'Material', value: { baseColor: '#9b2f2f', metallic: 0.7, roughness: 0.4 } },
  },
  rootComponents: {
    'core/Transform': { scale: [1.5, 1.5, 1.5] },
    'prefabs-demo/Hover': { amplitude: 0.06, speed: 1.1 },
  },
  overrides: {
    Body: { 'render/MeshMaterial': { material: { path: '#armor' } } },
    Ring: null,
  },
  children: [
    {
      name: 'Turret',
      components: {
        'core/Transform': { translation: [0, 0.5, 0] },
        'render/Mesh3d': { mesh: { path: 'procedural:box?x=0.35&y=0.18&z=0.5' } },
        'render/MeshMaterial': { material: { path: '#dark' } },
        'prefabs-demo/Spin': { speed: 0.6 },
      },
    },
  ],
}

/** The hangar: five instances on pedestals, each changed a little. */
const hangar: SceneFile = {
  version: 1,
  assets: {
    floor: { type: 'Material', value: { baseColor: '#2a2f3a', roughness: 0.85 } },
    pedestal: { type: 'Material', value: { baseColor: '#3c4352', roughness: 0.6 } },
  },
  entities: [
    {
      name: 'floor',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:plane?size=60' } },
        'render/MeshMaterial': { material: { path: '#floor' } },
      },
    },
    ...[-6, -3, 0, 3, 6].map((x, i) => ({
      name: `pedestal-${i}`,
      components: {
        'core/Transform': { translation: [x, 0.25, 0] },
        'render/Mesh3d': {
          mesh: { path: 'procedural:cylinder?radius=0.8&height=0.5&segments=32' },
        },
        'render/MeshMaterial': { material: { path: '#pedestal' } },
      },
    })),
    {
      name: 'drone-a',
      components: {
        'core/Transform': { translation: [-6, 0, 0] },
        'scene/PrefabInstance': { prefab: { path: DRONE } },
      },
    },
    {
      // Field overrides reach any child; the root's own Hover wins over the prefab's.
      name: 'drone-b',
      components: {
        'core/Transform': { translation: [-3, 0, 0] },
        'prefabs-demo/Hover': { amplitude: 0.35, speed: 3 },
        'scene/PrefabInstance': {
          prefab: { path: DRONE },
          overrides: {
            Body: { 'render/MeshMaterial': { material: { path: '#gold' } } },
            Ring: { 'prefabs-demo/Spin': { speed: 5 } },
          },
        },
      },
      // Authored children sit next to the generated ones.
      children: [
        {
          name: 'Beacon',
          components: {
            'core/Transform': { translation: [0, 2.3, 0] },
            'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=0.08' } },
            'render/PointLight': { color: '#ffcf40', intensity: 300, range: 3 },
          },
        },
      ],
    },
    {
      // Removed entities and a removed component.
      name: 'drone-c',
      components: {
        'core/Transform': { translation: [0, 0, 0] },
        'scene/PrefabInstance': {
          prefab: { path: DRONE },
          overrides: {
            ThrusterL: null,
            ThrusterR: null,
            'Ring/prefabs-demo/Spin': null,
            Visor: { 'core/Transform': { scale: [0.8, 0.3, 0.2] } },
          },
        },
      },
    },
    {
      name: 'heavy',
      components: {
        'core/Transform': { translation: [3, 0, 0] },
        'scene/PrefabInstance': { prefab: { path: HEAVY } },
      },
    },
    {
      name: 'heavy-gold',
      components: {
        'core/Transform': { translation: [6, 0, 0] },
        'scene/PrefabInstance': {
          prefab: { path: HEAVY },
          overrides: {
            Body: { 'render/MeshMaterial': { material: { path: '#gold' } } },
            Turret: { 'prefabs-demo/Spin': { speed: 3 } },
          },
        },
      },
    },
  ],
}

const hover = defineSystem({
  name: 'prefabs-demo/hover',
  setup: (world) => ({ q: world.query({ with: [Hover, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const height = table.column(Hover, 'height')
      const amplitude = table.column(Hover, 'amplitude')
      const speed = table.column(Hover, 'speed')
      const tr = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        const phase = (table.entities[i]! % 97) * 0.37
        tr[i * 3 + 1] = height[i]! + Math.sin(time * speed[i]! + phase) * amplitude[i]!
      }
      table.markChanged(Transform)
    }
  },
})

const spin = defineSystem({
  name: 'prefabs-demo/spin',
  setup: (world) => ({ q: world.query({ with: [Spin, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const speed = table.column(Spin, 'speed')
      const rot = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++)
        quat.fromEuler(rot.subarray(i * 4, i * 4 + 4), 0, time * speed[i]!, 0)
      table.markChanged(Transform)
    }
  },
})

interface Demo {
  /** Swarm drones to spawn on the next frame. */
  pending: number
  swarm: number
  lastSpawn: string
  edit: number
  note: string
  rng: Rng
}

const demo: Demo = { pending: 0, swarm: 0, lastSpawn: '', edit: 0, note: '', rng: new Rng(3) }

/** Spawns the swarm from a system, through Commands (applied right after it runs). */
const swarm = defineSystem({
  name: 'prefabs-demo/swarm',
  setup: (world) => ({ q: world.query({ with: [Ttl] }) }),
  run: ({ q }, world, ctx) => {
    const dt = world.resource(Time).delta
    for (const table of q.tables) {
      const seconds = table.column(Ttl, 'seconds')
      for (let i = 0; i < table.count; i++) {
        seconds[i] = seconds[i]! - dt
        if (seconds[i]! <= 0) {
          ctx.commands.despawn(table.entities[i]! as Entity)
          demo.swarm--
        }
      }
    }
    if (demo.pending === 0) return
    const n = demo.pending
    demo.pending = 0
    const start = performance.now()
    for (let i = 0; i < n; i++) {
      // Behind the hangar: a band 4 to 30 m back, 44 m wide.
      const x = (demo.rng.float() - 0.5) * 44
      const z = -4 - demo.rng.float() * 26
      const root = spawnPrefab(ctx.commands, i % 5 === 0 ? HEAVY : DRONE, {
        transform: { translation: [x, 0, z] },
        // Runtime overrides: no light per swarm drone, and a random spin.
        overrides: {
          Glow: null,
          ...(i % 5 === 0 ? {} : { Ring: { 'prefabs-demo/Spin': { speed: 1 + (i % 7) } } }),
        },
      })
      ctx.commands.add(root, Hover, {
        height: 2.5 + demo.rng.float() * 6,
        speed: 1 + demo.rng.float() * 2,
      })
      ctx.commands.add(root, Ttl, { seconds: 8 + demo.rng.float() * 4 })
    }
    demo.swarm += n
    ctx.commands.run(() => {
      demo.lastSpawn = `${n} drones (${n * 7} entities) in ${(performance.now() - start).toFixed(1)} ms`
    })
  },
})

/** Prefab instances (hangar, variants, runtime swarm): overrides, variants, hot reload, apply. */
export const prefabsDemoPlugin = definePlugin({
  name: 'prefabs-demo',
  dependencies: ['scene'],
  build(app) {
    app.addSystems(Update, hover, spin, swarm)
  },
  ready(app) {
    const world = app.world
    world.resource(AmbientLight).brightness = 700
    world.spawn(
      [DirectionalLight, { illuminance: 40_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.8, 0.6, 0) as never }],
    )
    const eye = [0, 5.5, 11] as [number, number, number]
    world.spawn(
      [Camera3d, { fovY: 55, clearColor: [0.02, 0.025, 0.035, 1] }],
      [Exposure, { ev100: 12.5 }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 1, -1]) }],
    )
    registerPrefab(world, DRONE, drone(0))
    registerPrefab(world, HEAVY, heavy)
    loadScene(world, hangar)

    const actions: Record<string, () => void> = {
      spawn: () => {
        demo.pending += 500
      },
      edit: () => {
        demo.edit++
        registerPrefab(world, DRONE, drone(demo.edit))
        demo.note = `edited ${DRONE} (look ${demo.edit % 4}): every instance updated, overrides kept`
      },
      apply: () => {
        const b = findEntityByPath(world, 'drone-b')
        if (b === undefined) return
        void applyToPrefab(world, b).then((r) => {
          demo.note = `applied drone-b's overrides to the prefab: ${Object.keys(r.applied).join(', ') || 'none'}`
        })
      },
      reset: () => {
        demo.edit = 0
        registerPrefab(world, DRONE, drone(0))
        const b = findEntityByPath(world, 'drone-b')
        const authored = hangar.entities.find((e) => e.name === 'drone-b')!.components!
        if (b !== undefined)
          world.set(b, PrefabInstance, { overrides: authored['scene/PrefabInstance']!.overrides! })
        demo.note = 'reset the prefab and drone-b'
      },
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-prefab]')) {
      button.addEventListener('click', () => actions[button.dataset.prefab!]?.())
    }
    window.addEventListener('keydown', (event) => {
      const key = { Digit1: 'spawn', Digit2: 'edit', Digit3: 'apply', Digit4: 'reset' }[event.code]
      if (key) actions[key]!()
    })

    hudExtras.push((w) => {
      const b = findEntityByPath(w, 'drone-b')
      const overrides = (b === undefined ? undefined : currentOverrides(w, b)) ?? {}
      const lines = Object.entries(overrides).flatMap(([path, value]) => {
        if (value === null) return [`  ${path}: removed`]
        return Object.entries(value).flatMap(([name, fields]) => {
          // Spin animates rotations; that's a real change, but noise here.
          const shown = { ...(fields ?? {}) }
          if (name === 'core/Transform') delete shown.rotation
          if (fields && Object.keys(shown).length === 0) return []
          const text = fields === null ? 'removed' : JSON.stringify(shown).replace(/"/g, '')
          return [`  ${path} ${name} ${text}`.slice(0, 72)]
        })
      })
      return [
        '',
        `swarm     ${demo.swarm} alive${demo.lastSpawn ? `  (last: ${demo.lastSpawn})` : ''}`,
        'drone-b overrides (what a save writes):',
        ...(lines.length ? lines : ['  none']),
        demo.note ? `> ${demo.note}` : '1 spawn 500 · 2 edit prefab · 3 apply drone-b · 4 reset',
      ]
    })
  },
})
