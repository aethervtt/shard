import { assetServer } from '@aethervtt/shard-assets'
import type { ComponentDef } from '@aethervtt/shard-core'
import {
  cancelEffect,
  describeEffects,
  type EffectInstance,
  effectsPlugin,
  pauseEffect,
  playEffect,
  prepareEffect,
} from '@aethervtt/shard-effects'
import { box } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Beam,
  Camera3d,
  captureView,
  Decal,
  DecalGpu,
  DecalReceiver,
  describeDecals,
  describeRender,
  describeRibbons,
  Exposure,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  PointLight,
  RibbonGpu,
  Ribbons,
  renderPlugin,
  Shaders,
  Trail,
  Visibility,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { registerPrefab, ScenePlugin } from '@aethervtt/shard-scene'
import { Texture } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import sequence from '../data/vfx.effect-sequence.json?raw'
import { addBackendSelect, graphicsOptions } from './backend'

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!
const manual = new URLSearchParams(location.search).has('test')
const play = document.querySelector<HTMLButtonElement>('#play')!,
  pause = document.querySelector<HTMLButtonElement>('#pause')!,
  cancel = document.querySelector<HTMLButtonElement>('#cancel')!,
  status = document.querySelector<HTMLElement>('#status')!
const app = new App().addPlugin(
  TransformPlugin,
  ScenePlugin,
  renderPlugin({ canvas, ...graphicsOptions() }),
  forwardPlugin(),
  effectsPlugin,
)
addBackendSelect(document.querySelector<HTMLElement>('#controls')!, 'end')
function texture(scorch: boolean): Texture {
  const size = 64,
    data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1,
        v = ((y + 0.5) / size) * 2 - 1,
        radius = Math.sqrt(u * u + v * v)
      const a = scorch
        ? Math.max(0, 1 - radius) * (0.65 + 0.35 * Math.sin(x * 1.7 + y * 2.3) ** 2)
        : Math.max(0, 1 - Math.abs(v)) * (0.7 + 0.3 * Math.sin(x * 0.4) ** 2)
      const o = (y * size + x) * 4
      data[o] = scorch ? 230 : 255
      data[o + 1] = scorch ? 90 : 255
      data[o + 2] = scorch ? 24 : 255
      data[o + 3] = Math.round(a * 255)
    }
  return Texture.create({ width: size, height: size, mips: [data], usage: 'color' })
}
async function main() {
  await app.init()
  const world = app.world,
    meshes = world.resource(Meshes),
    materials = world.resource(Materials)
  world.resource(AmbientLight).brightness = 70
  const camera = world.spawn(
    [Camera3d, { fovY: 48, clearColor: [0.012, 0.018, 0.035, 1] }],
    [Exposure, { ev100: 6 }],
    [Transform, { translation: [5, 5, 13], rotation: lookAt([5, 5, 13], [0, 1, 0]) }],
  )
  const floor = world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 13, y: 0.2, z: 6 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({ baseColor: [0.025, 0.04, 0.065, 1], roughness: 0.9 }),
        ),
      },
    ],
    [Transform, { translation: [0, -0.2, 0] }],
    [DecalReceiver, { mask: 2 }],
  )
  const receiver = world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 1.6, y: 2, z: 1.6 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({ baseColor: [0.35, 0.42, 0.52, 1], roughness: 0.8 }),
        ),
      },
    ],
    [Transform, { translation: [3.2, 0.9, 0] }],
    DecalReceiver,
  )
  const blocker = world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 8, y: 5, z: 0.3 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.1, 0.15, 0.2, 1] })) },
    ],
    [Transform, { translation: [0, 2, 3] }],
    [Visibility, { mode: 'hidden' }],
  )
  const endpoint = world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 0.2, y: 0.2, z: 0.2 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.3, 0.45, 1, 1] })) },
    ],
    [Transform, { translation: [1.1, 1.5, 0] }],
  )
  world.spawn(
    [PointLight, { intensity: 6000, color: [0.6, 0.75, 1, 1] }],
    [Transform, { translation: [0, 5, 4] }],
  )
  const server = assetServer(world)
  server.virtual('vfx-ribbon-texture', 'catalog/ribbon', 'Texture', () => texture(false))
  server.virtual('vfx-scorch-texture', 'catalog/scorch', 'Texture', () => texture(true))
  registerPrefab(world, 'catalog/slash.prefab.json', {
    version: 1,
    root: {
      name: 'slash',
      components: {
        'core/Transform': { translation: [-4, 1, 0] },
        'render/Trail': {
          playing: false,
          width: 0.65,
          lifetime: 0.9,
          color: '#82ffef',
          endColor: [0.1, 0.7, 0.9, 0],
          widthCurve: [
            { at: 0, value: 1 },
            { at: 1, value: 0 },
          ],
          texture: { guid: 'vfx-ribbon-texture' },
          minDistance: 0.015,
        },
      },
    },
  })
  registerPrefab(world, 'catalog/beam.prefab.json', {
    version: 1,
    root: {
      name: 'beam',
      components: {
        'core/Transform': { translation: [-1.2, 1.3, 0] },
        'render/Beam': {
          playing: false,
          width: 0.1,
          end: [0, 0, 0],
          noise: 0.15,
          segments: 32,
          seed: 42,
          color: '#d7e5ff',
          endColor: '#7e9bff',
          texture: { guid: 'vfx-ribbon-texture' },
          blend: 'additive',
          scroll: 0.8,
        },
      },
    },
  })
  registerPrefab(world, 'catalog/scorch.prefab.json', {
    version: 1,
    root: {
      name: 'scorch',
      components: {
        'core/Transform': {
          translation: [3.2, 0.9, 0],
          rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
        },
        'render/Decal': {
          playing: false,
          size: [2.8, 2.6, 2.8],
          texture: { guid: 'vfx-scorch-texture' },
          lifetime: 3.6,
          fadeOut: 1.2,
        },
      },
    },
  })
  const prepared = await prepareEffect(world, JSON.parse(sequence))
  let instance: EffectInstance | undefined,
    stepping = false,
    disposed = false,
    orthographic = false
  function inspect() {
    return {
      backend: world.resource(Gpu).backend,
      render: describeRender(world),
      ribbons: describeRibbons(world),
      decals: describeDecals(world),
      effects: describeEffects(world),
      instance: instance ? { id: instance.id, state: instance.state, time: instance.time } : null,
      endpoint: world.get(endpoint, Transform).translation,
      gpuRecords: {
        ribbons: world.resource(RibbonGpu).renderer?.draws.length ?? 0,
        decals: world.resource(DecalGpu).renderer?.draws.length ?? 0,
      },
      geometry: world.resource(Ribbons).records.map((r) => ({
        kind: r.kind,
        points: Array.from(r.points.slice(0, r.pointsCount * 5)),
        vertices: r.count,
      })),
      receiverAlive: world.isAlive(receiver),
      floorAlive: world.isAlive(floor),
    }
  }
  function drawUi() {
    const running = instance?.state === 'playing' || instance?.state === 'paused'
    pause.disabled = !running
    cancel.disabled = !running
    pause.textContent = instance?.state === 'paused' ? 'Resume' : 'Pause'
    const ribbons = describeRibbons(world),
      decals = describeDecals(world)
    status.textContent = `${instance?.state ?? 'ready'} · ${(instance?.time ?? 0).toFixed(2)} / 5.00 s\n${ribbons.records.reduce((n, r) => n + r.points, 0)} ribbon points · ${decals.records.reduce((n, r) => n + r.triangles, 0)} projected triangles · ${world.resource(Gpu).backend}`
  }
  function toggle(kind: 'trail' | 'beam' | 'decal', enabled: boolean) {
    if (!instance) return
    const entity = instance.targets.get(
      kind === 'trail' ? 'slash' : kind === 'beam' ? 'beam' : 'scorch',
    )!
    if (world.isAlive(entity))
      world.set(
        entity,
        (kind === 'trail' ? Trail : kind === 'beam' ? Beam : Decal) as ComponentDef,
        { layers: enabled ? 1 : 0 },
      )
  }
  function cast(seed = 42) {
    if (instance) cancelEffect(world, instance.id)
    instance = playEffect(world, prepared, { bindings: { endpoint }, seed })
    world.set(instance.targets.get('beam')!, Beam, { seed })
    for (const kind of ['trail', 'beam', 'decal'] as const)
      toggle(kind, document.querySelector<HTMLInputElement>(`#${kind}`)!.checked)
    drawUi()
    return instance.id
  }
  const probe = {
    play: cast,
    inspect,
    toggle,
    occlude(value: boolean) {
      world.set(blocker, Visibility, { mode: value ? 'visible' : 'hidden' })
    },
    receiver(value: boolean) {
      world.set(receiver, DecalReceiver, { mask: value ? 1 : 4 })
    },
    async step(frames: number) {
      stepping = true
      try {
        for (let i = 0; i < frames; i++) {
          app.update(1 / 60)
          await world.resource(Shaders).whenIdle()
          await new Promise(requestAnimationFrame)
        }
      } finally {
        stepping = false
      }
      await app.whenPresented()
      drawUi()
      return inspect()
    },
    pause(value: boolean) {
      if (instance) pauseEffect(world, instance.id, value)
      app.update(0)
      drawUi()
      return inspect()
    },
    cancel() {
      if (instance) cancelEffect(world, instance.id)
      app.update(0)
      drawUi()
      return inspect()
    },
    camera() {
      orthographic = !orthographic
      world.set(camera, Camera3d, {
        projection: orthographic ? 'orthographic' : 'perspective',
        orthoHeight: 7,
      })
      return orthographic
    },
    async capture() {
      const shot = await captureView(world)
      return { width: shot.width, height: shot.height, data: Array.from(shot.data) }
    },
    async dispose() {
      disposed = true
      prepared.release()
      await app.dispose()
    },
  }
  ;(window as unknown as { vfxProbe: typeof probe }).vfxProbe = probe
  play.disabled = false
  play.onclick = () => {
    cast(Number(document.querySelector<HTMLInputElement>('#seed')!.value))
  }
  pause.onclick = () => probe.pause(instance?.state !== 'paused')
  cancel.onclick = () => probe.cancel()
  document.querySelector<HTMLButtonElement>('#camera')!.onclick = () => {
    const ortho = probe.camera()
    document.querySelector('#camera')!.textContent = ortho
      ? 'Perspective view'
      : 'Orthographic view'
  }
  for (const kind of ['trail', 'beam', 'decal'] as const)
    document.querySelector<HTMLInputElement>(`#${kind}`)!.onchange = (e) =>
      toggle(kind, (e.target as HTMLInputElement).checked)
  let previous = performance.now(),
    uiAt = 0
  const frame = (now: number) => {
    if (disposed) return
    if (!manual) app.update(Math.min(0.1, (now - previous) / 1000))
    else if (!stepping) app.update(0)
    previous = now
    if (now - uiAt > 100) {
      drawUi()
      uiAt = now
    }
    requestAnimationFrame(frame)
  }
  app.update(0)
  drawUi()
  requestAnimationFrame(frame)
  return probe
}
void main().catch((e) => {
  status.textContent = String(e)
  console.error(e)
})
export type VfxProbe = Awaited<ReturnType<typeof main>>
