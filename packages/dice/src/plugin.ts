import { type AssetRef, defineSystem, type Entity, Update } from '@aethervtt/shard-core'
import type { TrackWorkerLike } from '@aethervtt/shard-physics/worker'
import {
  Camera3d,
  DirectionalLight,
  EnvironmentMap,
  Exposure,
  GpuDeviceLost,
  InstanceData,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  registerShaders,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { type DieKind, KIND_DEFINITIONS, registerBuiltinDice } from './builtins'
import { DiceDie, DiceRollRequest } from './components'
import { DieDefinitionAsset } from './definition-asset'
import { DiceEffectRecipe } from './effects'
import { BUILTIN_FAMILIES } from './families'
import { registerBuiltinGlyphs } from './glyphs'
import { FaceLayout, NUMBERS_LAYOUT, PIPS_LAYOUT } from './layout'
import { allDiceFamilies, DICE_SHADERS } from './material'
import { floorQuad } from './mesh'
import { diceMethods } from './methods'
import type { DiceRoll } from './roll'
import { BUILTIN_SKINS, DICE_SKINS, DiceSkin, diceSkin } from './skin'
import { studioEnvironment } from './studio'
import { DiceTable, DiceTableState, ENTRANCE_WAIT_MS } from './table'
import { DiceTray, TRAY_SHADERS } from './tray'

export interface DicePluginOptions {
  /** The dice camera: a top-down view of the tray, clearing to alpha 0 (0052). */
  camera?: {
    fovY?: number
    /** A RenderTargets ref; null renders into the app's surface. */
    target?: AssetRef<'RenderTarget'> | null
    order?: number
    ev100?: number
  }
  /** How long dice rest before the presentation finishes, ms. Default 60 s. */
  restMs?: number
  /** Bodies a roll may put on the table (percentile is two). Default 32. */
  maxDice?: number
  /** Makes the track worker: `diceWorker` from `@aethervtt/shard-dice/worker`, or 'inline'. */
  worker?: (() => TrackWorkerLike) | 'inline'
  /** The clock rests and releases run on, ms. Default `performance.now`. */
  now?: () => number
  /** Definitions a kind plays, when not the built-ins. */
  kinds?: Partial<Record<DieKind, readonly string[]>>
  /** The key light's illuminance, lux. Default 60,000. */
  illuminance?: number
  /** Image-based light from a small procedural studio. Default true. */
  environment?: boolean
  /**
   * How long a roll waits, past its physics, for an entrance's assets and warm-up before its die
   * drops in instead (0065). Default 1,500 ms.
   */
  entranceWaitMs?: number
}

/** Where the dice camera looks from: straight down, screen-up toward -z. */
export const TOP_DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]

const tableFrame = defineSystem({
  name: 'dice/table',
  description: 'Plays the dice presentation: samples the track, lands, accents, rests, releases.',
  run: (_, world) => world.resource(DiceTable).frame(),
})

const deviceLoss = defineSystem({
  name: 'dice/device-loss',
  description: 'Fails a playing roll when the GPU device is lost.',
  setup: (world) => world.reader(GpuDeviceLost),
  run: (reader, world) => {
    const lost = reader.read()
    if (lost.length > 0) world.resource(DiceTable).deviceLost(lost[0]!.message)
  },
})

const rollRequests = defineSystem({
  name: 'dice/roll-requests',
  description: 'Plays the roll of each new dice/RollRequest entity, then removes the request.',
  run: (_, world) => {
    const found: Entity[] = []
    for (const e of world.query({ with: [DiceRollRequest] }).entities()) found.push(e)
    if (found.length === 0) return
    const table = world.resource(DiceTable)
    for (const e of found) {
      const request = world.get(e, DiceRollRequest)
      world.remove(e, DiceRollRequest)
      void table
        .play(request.roll as unknown as DiceRoll, { replace: request.replace })
        .catch((err) => {
          table.lastError = err
        })
    }
  },
})

/**
 * Dice (0054): the table, its camera, key light, image-based light and shadow-catching tray, and
 * the systems that present rolls. Needs `forwardPlugin` (render/forward, the shadow catcher, the
 * environment). Add `particlesPlugin` for particle bursts and `audioPlugin` for sound.
 */
export function dicePlugin(options: DicePluginOptions = {}): Plugin {
  return definePlugin({
    name: 'dice',
    dependencies: ['render/forward', 'render/shadow-catcher'],
    provides: [
      DiceTable,
      DiceDie,
      DiceRollRequest,
      DiceSkin,
      FaceLayout,
      DiceEffectRecipe,
      DieDefinitionAsset,
      DiceTray,
      BUILTIN_FAMILIES,
      tableFrame,
      rollRequests,
    ],
    build(app) {
      registerBuiltinDice()
      registerBuiltinGlyphs()
      const world = app.world
      world.initResource(DiceSkin.store)
      world.initResource(FaceLayout.store)
      world.initResource(DiceEffectRecipe.store)
      const skins = world.resource(DiceSkin.store)
      for (const [name, json] of Object.entries(BUILTIN_SKINS)) {
        skins.set(DICE_SKINS[name as keyof typeof DICE_SKINS].guid!, diceSkin(json))
      }
      const layouts = world.resource(FaceLayout.store)
      layouts.set('dice:layout/numbers', NUMBERS_LAYOUT)
      layouts.set('dice:layout/pips', PIPS_LAYOUT)
      world.insertResource(
        DiceTable,
        new DiceTableState(world, {
          restMs: options.restMs ?? 60_000,
          maxDice: options.maxDice ?? 32,
          now: options.now ?? (() => performance.now()),
          kinds: { ...KIND_DEFINITIONS, ...options.kinds },
          worker: options.worker ?? 'inline',
          fovY: options.camera?.fovY ?? 35,
          entranceWaitMs: options.entranceWaitMs ?? ENTRANCE_WAIT_MS,
        }),
      )
      app.addSystems(Update, tableFrame, rollRequests, deviceLoss)
      app.addMethod(...diceMethods)
    },
    ready(app) {
      const world = app.world
      const shaders: Record<string, string> = { ...DICE_SHADERS, ...TRAY_SHADERS }
      for (const family of allDiceFamilies())
        if (family.module) shaders[family.module.path] = family.module.source
      registerShaders(world.resource(Shaders), shaders)
      const table = world.resource(DiceTable)
      const quad = world.resource(Meshes).add(floorQuad(), 'dice:tray') as AssetRef<'Mesh'>
      const trayMaterial = world
        .resource(Materials)
        .add(new MaterialAsset({}, DiceTray), 'dice:tray') as AssetRef<'Material'>
      table.quad = quad
      table.trayMaterial = trayMaterial
      table.floor = world.spawn(
        [Mesh3d, { mesh: quad }],
        [MeshMaterial, { material: trayMaterial }],
        [InstanceData, { x: 0, y: 0 }],
        NotShadowCaster,
        [Transform, { scale: [7.5, 1, 4.4] }],
      )
      table.light = world.spawn(
        [
          DirectionalLight,
          { illuminance: options.illuminance ?? 60_000, shadows: true, color: [1, 0.97, 0.91, 1] },
        ],
        [Transform, { rotation: lightRotation() }],
      )
      // The light's forward (its local -z), flattened: where shadows fall.
      const q = lightRotation()
      const fx = -2 * (q[0] * q[2] + q[3] * q[1])
      const fz = -(1 - 2 * (q[0] * q[0] + q[1] * q[1]))
      const fl = Math.sqrt(fx * fx + fz * fz) || 1
      table.shadowDir = [fx / fl, fz / fl]
      const cam = options.camera ?? {}
      table.camera = world.spawn(
        [
          Camera3d,
          {
            fovY: cam.fovY ?? 35,
            clearColor: [0, 0, 0, 0],
            ...(cam.target ? { target: cam.target } : {}),
            ...(cam.order !== undefined ? { order: cam.order } : {}),
          },
        ],
        [Exposure, { ev100: cam.ev100 ?? 13 }],
        [Transform, { translation: [0, 14, 0], rotation: TOP_DOWN }],
      )
      if (options.environment !== false) {
        const texture = world.resource(Textures).add(studioEnvironment(), 'dice:studio')
        world.add(table.camera, EnvironmentMap, { texture, intensity: 2600 })
      }
    },
    dispose(app) {
      app.world.tryResource(DiceTable)?.dispose()
    },
  })
}

/** The key light: from high up, to the left and toward the viewer, so shadows fall up and right. */
const lightRotation = () => lookAt([-3.4, 10, 4.2], [0, 0, 0])
