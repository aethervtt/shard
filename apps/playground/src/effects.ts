import { animationPlugin } from '@aethervtt/shard-animation'
import {
  AudioListener,
  audioEventsPlugin,
  audioPlugin,
  audioState,
  describeAudio,
  describeAudioEvents,
} from '@aethervtt/shard-audio'
import {
  cancelEffect,
  describeEffects,
  type EffectInstance,
  effectsPlugin,
  pauseEffect,
  playEffect,
  prepareEffect,
} from '@aethervtt/shard-effects'
import { describeParticles, particlesPlugin } from '@aethervtt/shard-particles'
import { createWebAudioBackend, type WebAudioBackend } from '@aethervtt/shard-platform-web'
import {
  AmbientLight,
  Camera3d,
  Exposure,
  forwardPlugin,
  Gpu,
  PointLight,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { loadScene, ScenePlugin } from '@aethervtt/shard-scene'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import spell from '../data/spell.effect-sequence.json?raw'
import { addBackendSelect, graphicsOptions } from './backend'
import { registerSpellAssets } from './effects-content'

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!
const status = document.querySelector<HTMLElement>('#status')!
const trace = document.querySelector<HTMLElement>('#trace')!
const play = document.querySelector<HTMLButtonElement>('#play')!
const pause = document.querySelector<HTMLButtonElement>('#pause')!
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!
const manual = new URLSearchParams(location.search).has('test')
const backend = createWebAudioBackend()
const app = new App().addPlugin(
  TransformPlugin,
  ScenePlugin,
  renderPlugin({ canvas, ...graphicsOptions() }),
  forwardPlugin(),
  animationPlugin,
  particlesPlugin,
  audioPlugin({ backend }),
  audioEventsPlugin(),
  effectsPlugin,
)
addBackendSelect(document.querySelector<HTMLElement>('#controls')!, 'end')

async function main() {
  await app.init()
  const world = app.world
  world.resource(AmbientLight).brightness = 60
  const camera = world.spawn(
    [Camera3d, { fovY: 50, clearColor: [0.009, 0.014, 0.026, 1] }],
    [Exposure, { ev100: 6 }],
    AudioListener,
    [Transform, { translation: [0, 6, 12] }],
  )
  world.set(camera, Transform, { rotation: lookAt([0, 6, 12], [0, 0.6, 0]) })
  await loadScene(
    world,
    {
      version: 1,
      assets: {
        floor: { type: 'Material', value: { baseColor: '#273648', roughness: 0.8, metallic: 0.2 } },
        target: {
          type: 'Material',
          value: { baseColor: '#919eb5', roughness: 0.4, metallic: 0.4 },
        },
      },
      entities: [
        {
          name: 'floor',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:box?x=14&y=0.2&z=7' } },
            'render/MeshMaterial': { material: { path: '#floor' } },
            'core/Transform': { translation: [0, -0.2, 0] },
          },
        },
        {
          name: 'target',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:box?x=0.8&y=1.6&z=0.8' } },
            'render/MeshMaterial': { material: { path: '#target' } },
            'core/Transform': { translation: [4.6, 0.7, 0] },
          },
        },
      ],
    },
    { id: 'spell-stage' },
  )
  world.spawn(
    [PointLight, { intensity: 3000, color: [0.3, 0.55, 1, 1] }],
    [Transform, { translation: [0, 5, 2] }],
  )
  registerSpellAssets(world)
  const prepared = await prepareEffect(world, JSON.parse(spell))
  const analyser = backend.context.createAnalyser()
  const session = audioState(world).backend as WebAudioBackend
  session.output.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  let disposed = false
  let instance: EffectInstance | null = null
  const inspect = () => ({
    backend: world.resource(Gpu).backend,
    effects: describeEffects(world),
    audio: describeAudioEvents(world),
    voices: describeAudio(world),
    particles: describeParticles(world),
    cameraFov: world.get(camera, Camera3d).fovY,
    targets: instance
      ? [...instance.targets].map(([name, entity]) => ({
          name,
          entity,
          alive: world.isAlive(entity),
          transform: world.tryGet(entity, Transform),
          light: world.tryGet(entity, PointLight),
        }))
      : [],
    instance: instance
      ? { id: instance.id, state: instance.state, time: instance.time, error: instance.error }
      : null,
  })
  function drawUi() {
    const running = instance?.state === 'playing' || instance?.state === 'paused'
    pause.disabled = !running
    cancel.disabled = !running
    pause.textContent = instance?.state === 'paused' ? 'Resume' : 'Pause'
    status.textContent = instance
      ? `${instance.state} · ${instance.time.toFixed(2)} / 4.00 s`
      : 'Ready to cast'
    const entries = describeEffects(world).trace.entries.slice(-7)
    trace.textContent = entries
      .map((e) => `${e.time!.toFixed(2)}  ${e.kind!.padEnd(10)} ${e.track || e.reason || ''}`)
      .join('\n')
    const phase = !running ? -1 : instance!.time < 0.6 ? 0 : instance!.time < 2.2 ? 1 : 2
    document.querySelectorAll('.timeline span').forEach((span, i) => {
      span.classList.toggle('active', i === phase)
    })
  }
  const cast = async (seed = 42, power = 1) => {
    await backend.resume()
    if (instance) cancelEffect(world, instance.id)
    instance = playEffect(world, prepared, { bindings: { camera }, seed, parameters: { power } })
    drawUi()
    return instance.id
  }
  play.disabled = false
  play.onclick = () => {
    void cast(
      Number(document.querySelector<HTMLInputElement>('#seed')!.value),
      Number(document.querySelector<HTMLInputElement>('#power')!.value),
    ).catch(failed)
  }
  pause.onclick = () => {
    if (instance) pauseEffect(world, instance.id, instance.state !== 'paused')
    drawUi()
  }
  cancel.onclick = () => {
    if (instance) cancelEffect(world, instance.id)
    drawUi()
  }
  const probe = {
    play: cast,
    inspect,
    async step(frames: number) {
      for (let i = 0; i < frames; i++) {
        app.update(1 / 60)
        await world.resource(Shaders).whenIdle()
        await new Promise(requestAnimationFrame)
      }
      drawUi()
      return inspect()
    },
    cancel() {
      if (instance) cancelEffect(world, instance.id)
      app.update(0)
      drawUi()
      return inspect()
    },
    pause(value: boolean) {
      if (instance) pauseEffect(world, instance.id, value)
      app.update(0)
      return inspect()
    },
    rms() {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i]! ** 2
      return Math.sqrt(sum / samples.length)
    },
    async dispose() {
      disposed = true
      prepared.release()
      analyser.disconnect()
      await app.dispose()
      backend.dispose?.()
    },
  }
  ;(window as unknown as { effectsProbe: typeof probe }).effectsProbe = probe
  let previous = performance.now(),
    uiAt = 0
  const frame = (now: number) => {
    if (disposed) return
    if (!manual) app.update(Math.min(0.1, (now - previous) / 1000))
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
function failed(error: unknown) {
  status.textContent = String(error)
  console.error(error)
}
void main().catch(failed)

export type EffectsProbe = Awaited<ReturnType<typeof main>>
