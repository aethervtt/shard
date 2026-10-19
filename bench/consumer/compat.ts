import { defineSystem, Update } from '@aethervtt/shard-core'
import { DICE_SKINS, DiceDie, DiceTable, dicePlugin } from '@aethervtt/shard-dice'
import { diceWorker } from '@aethervtt/shard-dice/worker'
import { createGpuContext } from '@aethervtt/shard-gpu'
import { canvasContext, createWebgl2Gpu } from '@aethervtt/shard-gpu-webgl2'
import { cube } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  DirectionalLight,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  renderPlugin,
} from '@aethervtt/shard-render'
import { App, animationFrameRunner, FrameDemand, Time } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { check, checkCodecs } from './check-codecs.mjs'

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const canvas = (id: string) => document.getElementById(id) as HTMLCanvasElement
const pixels = (c: HTMLCanvasElement) =>
  c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data

async function surfaces() {
  const native = document.createElement('canvas')
  const gl = native.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
  })!
  const api = createWebgl2Gpu({ context: gl, persist: false, checkErrors: true })
  const device = (await (await api.requestAdapter())!.requestDevice()) as unknown as GPUDevice
  const opaque = canvas('scene'),
    transparent = canvas('dice')
  const contexts = [canvasContext(opaque), canvasContext(transparent)]
  contexts.forEach((c, i) => {
    c.configure({ device, format: 'rgba8unorm', alphaMode: i ? 'premultiplied' : 'opaque' })
  })
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 2; j++) {
      const c = j ? transparent : opaque
      c.width = 70 + i * 7 + j * 23
      c.height = 60 + i * 3 + j * 17
      // A deterministic regression: default framebuffer color writes may be disabled by
      // preceding work. Present must restore BACK even when its input texture is correct.
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      gl.drawBuffers([gl.NONE])
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: contexts[j].getCurrentTexture().createView() as unknown as GPUTextureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: j ? [0, 0.5, 0, 0.5] : [1, 0, 0, 1],
          },
        ],
      })
      pass.end()
      device.queue.submit([encoder.finish()])
      const p = pixels(c)
      const at = (Math.floor(c.height / 2) * c.width + Math.floor(c.width / 2)) * 4
      check(
        j ? p[at + 1] > 245 && Math.abs(p[at + 3] - 128) <= 1 : p[at] === 255 && p[at + 3] === 255,
        `visible surface ${i}/${j}: ${Array.from(p.slice(at, at + 4))}`,
      )
      check(gl.getError() === gl.NO_ERROR, 'GL presentation state')
    }
    await frame()
  }
  contexts.forEach((c) => {
    c.unconfigure()
  })
  device.destroy()
  // New canvases: a 2D context's alpha option is fixed on first creation.
  for (const id of ['scene', 'dice']) {
    const replacement = document.createElement('canvas')
    replacement.id = id
    canvas(id).replaceWith(replacement)
  }
  return 32
}

async function renderedDice() {
  const gpu = await createGpuContext({
    backend: 'webgl2',
    webgl2: { checkErrors: true, persist: false },
  })
  const scene = canvas('scene'),
    overlay = canvas('dice')
  scene.style.width = '240px'
  scene.style.height = '160px'
  overlay.style.width = '320px'
  overlay.style.height = '180px'
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, canvas: scene, owner: 'consumer-scene' }),
    forwardPlugin({ msaa: 1 }),
  )
  let workers = 0,
    replies = 0
  const dice = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, canvas: overlay, alpha: 'premultiplied', owner: 'consumer-dice' }),
    forwardPlugin({ msaa: 1 }),
    dicePlugin({
      restMs: Infinity,
      worker: () => {
        workers++
        const worker = diceWorker()
        worker.addEventListener('message', () => replies++)
        return worker
      },
    }),
  )
  await app.init()
  await dice.init()
  const world = app.world
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
    [
      MeshMaterial,
      {
        material: world
          .resource(Materials)
          .add(new MaterialAsset({ baseColor: [0.9, 0.15, 0.1, 1] })),
      },
    ],
    Transform,
  )
  world.spawn(
    [DirectionalLight, { illuminance: 30_000 }],
    [Transform, { translation: [2, 4, 3], rotation: lookAt([2, 4, 3], [0, 0, 0]) }],
  )
  world.spawn(Camera3d, [
    Transform,
    { translation: [2, 2, 3], rotation: lookAt([2, 2, 3], [0, 0, 0]) },
  ])
  const table = dice.world.resource(DiceTable)
  const done = table.play({
    id: 'packed-worker',
    seed: '42',
    dice: [{ kind: 'd20', value: 20, skin: DICE_SKINS.teal }],
  })
  const tick = async () => {
    app.update(1 / 60)
    dice.update(1 / 60)
    await frame()
  }
  for (let i = 0; i < 1200 && table.phase !== 'rest'; i++) {
    await tick()
    if (table.lastError) throw table.lastError
  }
  check(table.phase === 'rest' && workers === 1 && replies > 0, 'packed worker completes roll')
  const entities = [...dice.world.query({ with: [DiceDie] }).entities()]
  check(
    entities.length === 1 && dice.world.get(entities[0], DiceDie).value === 20,
    'worker die result',
  )
  for (let i = 0; i < 12; i++) {
    scene.style.width = `${220 + i * 3}px`
    scene.style.height = `${150 + (i % 3) * 11}px`
    overlay.style.width = `${300 - i * 4}px`
    overlay.style.height = `${180 + (i % 4) * 9}px`
    for (let n = 0; n < 6; n++) await tick()
    const a = pixels(scene),
      b = pixels(overlay)
    let sceneInk = 0,
      diceInk = 0,
      clear = 0
    for (let k = 0; k < a.length; k += 4) if (a[k] > a[k + 1] + 15) sceneInk++
    for (let k = 0; k < b.length; k += 4) {
      if (b[k + 3] > 20) diceInk++
      else clear++
    }
    check(sceneInk > 100, `visible scene after resize ${i}: ${sceneInk}`)
    check(
      diceInk > 100 && clear > 100,
      `visible transparent dice after resize ${i}: ${diceInk}/${clear}`,
    )
  }
  check(gpu.errors.length === 0, `GPU errors: ${JSON.stringify(gpu.errors)}`)
  table.dismiss()
  await done
  await app.dispose()
  await dice.dispose()
  gpu.destroy()
  return { workers, replies, resizes: 12 }
}

async function clocks() {
  return Promise.all(
    [60, 30, 20].map(async (hz) => {
      const app = new App()
      let start = 0,
        elapsed = 0
      const system = defineSystem({
        name: `consumer/clock-${hz}`,
        run: (_, world) => {
          if (!start) start = performance.now()
          elapsed = world.resource(Time).elapsed
          if (elapsed < 4.8) {
            if (hz === 60) world.resource(FrameDemand).hold('animation')
            else world.resource(FrameDemand).after(1000 / hz)
          } else world.resource(FrameDemand).release('animation')
        },
      })
      app.addSystems(Update, system)
      app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
      const running = app.run()
      while (elapsed < 4.8) await frame()
      const wall = (performance.now() - start) / 1000
      check(wall < 5.15 && wall >= 4.7, `clock ${hz}: ${wall}`)
      await app.dispose()
      await running
      return { hz, wall, elapsed }
    }),
  )
}

async function run() {
  const codecs = await checkCodecs(async (file: string) => {
    const r = await fetch(`/${file}`)
    check(r.ok, `fetch ${file}`)
    return new Uint8Array(await r.arrayBuffer())
  })
  const switched = await surfaces()
  const dice = await renderedDice()
  const timing = await clocks()
  return { codecs, switched, dice, timing }
}

Object.assign(window, {
  consumer: run()
    .then((result) => ({ result }))
    .catch((error) => ({ error: String(error.stack ?? error) })),
})
