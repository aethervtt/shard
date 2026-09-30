import { type AssetRef, ShardError } from '@aethervtt/shard-core'
import { encodePng } from '@aethervtt/shard-protocol'
import {
  Camera3d,
  captureView,
  EnvironmentMap,
  Exposure,
  Gpu,
  InstanceData,
  Mesh3d,
  MeshMaterial,
  OffscreenTarget,
  RenderStats,
  RenderTargets,
  Shaders,
} from '@aethervtt/shard-render'
import { type App, FrameDemand, LOADING_DEMAND } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import type { DieKind } from './builtins'
import { dieGeometry, requireDie } from './definition'
import { restingHeight, restRotation } from './landing'
import { expandRoll } from './roll'
import { DiceSkin, type DiceSkinValue } from './skin'
import { DiceTable } from './table'

export interface DiceThumbnailOptions {
  skin: AssetRef
  kind: DieKind
  /** The value on top (a percentile's 1..100 shows its tens die unless `part` says units). */
  value: number
  part?: 'tens' | 'units'
  /** Pixels, square. Default 128. */
  size?: number
  /** PNG bytes (straight alpha), or the GPU texture itself (yours to destroy). Default 'png'. */
  output?: 'png' | 'texture'
}

export interface DiceThumbnail {
  width: number
  height: number
  png: Uint8Array | undefined
  texture: GPUTexture | undefined
}

let slot = 0

/**
 * Renders one landed die of a skin into an offscreen target on the app's own device (no new
 * device, no canvas): its value on top, reading upright, seen from above at an angle. The app
 * needs `dicePlugin`. In an app a runner drives, the frames come by themselves; a manual app
 * (tests, tools) is stepped here.
 */
export async function renderDiceThumbnail(
  app: App,
  options: DiceThumbnailOptions,
): Promise<DiceThumbnail> {
  const world = app.world
  const table = world.resource(DiceTable)
  const size = options.size ?? 128
  const all = expandRoll({
    id: 'thumbnail',
    dice: [{ kind: options.kind, value: options.value, skin: options.skin }],
  })
  const die = all[options.part === 'units' ? all.length - 1 : 0]!
  const skin = world.resource(DiceSkin.store).get(options.skin) as DiceSkinValue | undefined
  if (!skin) {
    throw new ShardError(
      'dice/unknown-skin',
      `No dice skin ${options.skin.guid ?? options.skin.path}`,
      {
        hint: 'Load the skin (or add it to DiceSkin.store) first.',
      },
    )
  }
  const g = dieGeometry(requireDie(die.definition))
  const skinKey = options.skin.guid ?? options.skin.path ?? ''
  const entry = table.resources.acquire(g, skinKey, skin, die.kind, (r) => table.layout(r), {})
  const material = table.resources.material(entry, {
    blended: table.resources.blendedByNature(entry),
    dropped: false,
  })
  // Somewhere nothing else is: every thumbnail in flight gets its own spot.
  const x = 10_000 + (slot++ % 64) * 20
  const scale = 1
  const rotation = restRotation(g, die.value)
  const y = restingHeight(g, rotation, scale)
  const gpu = world.resource(Gpu)
  const target = new OffscreenTarget(gpu, { label: 'dice-thumbnail', width: size, height: size })
  const targetRef = world
    .resource(RenderTargets)
    .add(target, `dice:thumbnail/${x}`) as AssetRef<'RenderTarget'>
  const dieEntity = world.spawn(
    [Mesh3d, { mesh: entry.mesh }],
    [MeshMaterial, { material }],
    [Transform, { translation: [x, y, 0], rotation, scale: [scale, scale, scale] }],
    [InstanceData, { x: die.value, y: 0 }],
  )
  const reach = g.footprint * 0.5 * scale
  const fov = 30
  const distance = (reach / Math.tan(((fov / 2) * Math.PI) / 180)) * 1.45
  const eye: [number, number, number] = [x, y + distance * 0.82, distance * 0.57]
  const camera = world.spawn(
    [Camera3d, { fovY: fov, clearColor: [0, 0, 0, 0], target: targetRef, order: 50 }],
    [Exposure, { ev100: 13 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [x, y * 0.6, 0], [0, 0, -1]) }],
  )
  const env = world.tryGet(table.camera, EnvironmentMap)
  if (env) world.add(camera, EnvironmentMap, { texture: env.texture, intensity: env.intensity })
  const view = `camera:${camera}`
  const manual = world.resource(FrameDemand).mode === 'manual'
  try {
    // A complete frame: nothing skipped (pipelines compiling, textures loading), the die drawn.
    const demand = world.resource(FrameDemand)
    let image: Awaited<ReturnType<typeof captureView>> | undefined
    for (let i = 0; i < 240; i++) {
      const shot = captureView(world, view)
      if (manual) {
        app.update(1 / 60)
        await world.resource(Shaders).whenIdle()
        await gpu.pipelines.whenIdle()
      }
      const frame = await shot
      const stats = world.resource(RenderStats).get(view)
      if (stats && stats.drawCalls > 0 && stats.pending === 0 && !demand.isHeld(LOADING_DEMAND)) {
        image = frame
        break
      }
      if (!manual) await gpu.pipelines.whenIdle()
    }
    if (!image)
      throw new ShardError('dice/thumbnail-failed', 'The thumbnail never finished rendering')
    if (options.output === 'texture') {
      return { width: size, height: size, png: undefined, texture: target.texture() }
    }
    // Straight alpha for the PNG: the view's output is premultiplied.
    const data = new Uint8Array(image.data)
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a === 0 || a === 255) continue
      for (let k = 0; k < 3; k++) data[i + k] = Math.min(255, Math.round((data[i + k]! * 255) / a))
    }
    return {
      width: size,
      height: size,
      png: await encodePng(data, image.width, image.height),
      texture: undefined,
    }
  } finally {
    world.despawn(dieEntity)
    world.despawn(camera)
    world.resource(RenderTargets).delete(targetRef.guid!)
    if (options.output !== 'texture') target.destroy()
    table.resources.release(entry, table.options.now())
    world.resource(FrameDemand).after(8016)
  }
}
