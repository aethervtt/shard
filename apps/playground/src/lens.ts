import { defineSystem, type Entity, Update, type World } from '@aethervtt/shard-core'
import { cube, cylinder, plane } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  clearLensFields,
  DirectionalLight,
  describeLens,
  Exposure,
  Lens,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  publishLensField,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { hudExtras } from './hud'

/**
 * Lens fields (spec 0063): a tabletop seen by a camera with Lens. A field follows the pointer; the
 * buttons (or the wheel, shift+wheel for strength) tune it, add a second field orbiting the middle
 * to overlap it, or a field covering the whole view. On a canvas over 2,097,152 pixels
 * (`?res=2560x1440`) that one is clipped to the bound, and the HUD says so.
 */

interface LensDemo {
  canvas: HTMLCanvasElement
  /** The pointer over the canvas, in its CSS pixels; undefined while it's elsewhere. */
  pointer: [number, number] | undefined
  radius: number
  strength: number
  orbit: boolean
  huge: boolean
  /** What publishes each field: the fields' `source`. */
  sources: { pointer: Entity; orbit: Entity; huge: Entity }
}

const demos = new WeakMap<World, LensDemo>()

/** Refreshed every frame they're on: a field that stops being published expires 150 ms later. */
const TTL_MS = 150

const publish = defineSystem({
  name: 'lens-demo/publish',
  run: (_, world) => {
    const d = demos.get(world)
    if (!d) return
    const { sources } = d
    if (d.pointer) {
      publishLensField(world, {
        screen: d.pointer,
        radius: d.radius,
        strength: d.strength,
        ttlMs: TTL_MS,
        source: sources.pointer,
      })
    }
    const w = d.canvas.clientWidth
    const h = d.canvas.clientHeight
    if (d.orbit) {
      const t = world.resource(Time).elapsed * 0.6
      publishLensField(world, {
        screen: [w / 2 + Math.cos(t) * w * 0.2, h / 2 + Math.sin(t) * h * 0.2],
        radius: Math.min(w, h) * 0.18,
        strength: 0.6,
        ttlMs: TTL_MS,
        source: sources.orbit,
      })
    }
    if (d.huge) {
      publishLensField(world, {
        screen: [w / 2, h / 2],
        radius: 3000,
        strength: -0.4,
        ttlMs: TTL_MS,
        source: sources.huge,
      })
    }
  },
})

type Action = 'smaller' | 'larger' | 'weaker' | 'stronger' | 'orbit' | 'huge' | 'clear'

function act(world: World, action: Action): void {
  const d = demos.get(world)
  if (!d) return
  if (action === 'smaller') d.radius = Math.max(20, d.radius / 1.25)
  if (action === 'larger') d.radius = Math.min(1500, d.radius * 1.25)
  if (action === 'weaker') d.strength = Math.max(-1, Math.round((d.strength - 0.1) * 10) / 10)
  if (action === 'stronger') d.strength = Math.min(1, Math.round((d.strength + 0.1) * 10) / 10)
  if (action === 'orbit') d.orbit = !d.orbit
  if (action === 'huge') d.huge = !d.huge
  if (action === 'clear') {
    // What a publisher does on dismissal: its fields go at once, not after their ttl.
    d.orbit = false
    d.huge = false
    clearLensFields(world)
  }
}

/** The tabletop: a checkerboard with grid gaps, tokens, and a few blocks, so any bend shows. */
function spawnTable(world: World): void {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const mat = (baseColor: [number, number, number, number], roughness = 0.8) =>
    materials.add(new MaterialAsset({ baseColor, roughness }))
  world.resource(AmbientLight).brightness = 400
  world.spawn(
    [DirectionalLight, { illuminance: 30_000, shadows: true }],
    [Transform, { rotation: lookAt([-4, 10, 5], [0, 0, 0]) }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 40 })) }],
    [MeshMaterial, { material: mat([0.05, 0.05, 0.06, 1]) }],
    [Transform, { translation: [0, -0.01, 0] }],
  )
  const tile = meshes.add(plane({ size: 0.94 }))
  const light = mat([0.62, 0.55, 0.42, 1])
  const dark = mat([0.3, 0.36, 0.26, 1])
  for (let x = -8; x < 8; x++) {
    for (let z = -5; z < 5; z++) {
      world.spawn(
        [Mesh3d, { mesh: tile }],
        [MeshMaterial, { material: (x + z) & 1 ? light : dark }],
        [Transform, { translation: [x + 0.5, 0, z + 0.5] }],
      )
    }
  }
  const token = meshes.add(cylinder({ radius: 0.38, height: 0.2 }))
  const colors: [number, number, number, number][] = [
    [0.8, 0.25, 0.2, 1],
    [0.25, 0.45, 0.85, 1],
    [0.9, 0.75, 0.3, 1],
    [0.4, 0.75, 0.45, 1],
  ]
  for (let i = 0; i < 10; i++) {
    world.spawn(
      [Mesh3d, { mesh: token }],
      [MeshMaterial, { material: mat(colors[i % 4]!, 0.4) }],
      [Transform, { translation: [((i * 5) % 14) - 6.5, 0.1, ((i * 3) % 8) - 3.5] }],
    )
  }
  const block = meshes.add(cube({ size: 1 }))
  const stone = mat([0.55, 0.53, 0.5, 1])
  for (const [x, z, sx, sz] of [
    [-3, -2, 3, 0.4],
    [4, 1, 0.4, 3],
    [0, 3, 2, 0.4],
  ] as const) {
    world.spawn(
      [Mesh3d, { mesh: block }],
      [MeshMaterial, { material: stone }],
      [Transform, { translation: [x, 0.4, z], scale: [sx, 0.8, sz] }],
    )
  }
}

export const lensDemoPlugin = definePlugin({
  name: 'lens-demo',
  dependencies: ['render/lens'],
  build(app) {
    app.addSystems(Update, publish)
  },
  ready(app) {
    const world = app.world
    spawnTable(world)
    const eye: [number, number, number] = [0, 11, 7]
    world.spawn(
      [Camera3d, { fovY: 50, clearColor: [0.05, 0.06, 0.08, 1] }],
      [Exposure, { ev100: 13 }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0.5]) }],
      Lens,
    )
    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    const d: LensDemo = {
      canvas,
      pointer: undefined,
      radius: 140,
      strength: -0.7,
      orbit: false,
      huge: false,
      sources: {
        pointer: world.spawn(Transform),
        orbit: world.spawn(Transform),
        huge: world.spawn(Transform),
      },
    }
    demos.set(world, d)
    canvas.addEventListener('pointermove', (event) => {
      d.pointer = [event.offsetX, event.offsetY]
    })
    canvas.addEventListener('pointerleave', () => {
      d.pointer = undefined
    })
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const up = event.deltaY < 0
        act(world, event.shiftKey ? (up ? 'stronger' : 'weaker') : up ? 'larger' : 'smaller')
      },
      { passive: false },
    )
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lens]')) {
      button.addEventListener('click', () => act(world, button.dataset.lens as Action))
    }
    hudExtras.push((w) => {
      const lens = describeLens(w)
      const lines = [
        `lens: radius ${d.radius.toFixed(0)} px, strength ${d.strength.toFixed(1)}   live fields ${lens.fields.length}`,
      ]
      for (const [name, v] of Object.entries(lens.views)) {
        const view = v as {
          fields: unknown[]
          ran: boolean
          region: number[] | null
          target: number[] | null
          clipped: boolean
        }
        const size = (s: number[] | null) => (s ? `${s[s.length - 2]}x${s[s.length - 1]}` : '—')
        lines.push(
          `${name}: ${view.fields.length} bending, post/lens ${view.ran ? 'ran' : 'off'}, region ${size(view.region)}, target ${size(view.target)}${view.clipped ? ' (clipped to 2,097,152 px)' : ''}`,
        )
      }
      return lines
    })
  },
})
