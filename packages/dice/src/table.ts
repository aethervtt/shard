import { assetServer } from '@aethervtt/shard-assets'
import { AudioState, playSound, preloadSound, stopSound } from '@aethervtt/shard-audio'
import {
  type AssetRef,
  defineResource,
  type Entity,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { ParticleEffect, ParticleEffects, ParticleSystem } from '@aethervtt/shard-particles'
import { sampleTrack, type Track, trackHash } from '@aethervtt/shard-physics/track'
import {
  createTrackClient,
  type TrackClient,
  type TrackWorkerLike,
} from '@aethervtt/shard-physics/worker'
import {
  Camera3d,
  Cameras,
  captureView,
  clearLensFields,
  clearScreenEffects,
  DirectionalLight,
  EnvironmentMap,
  Exposure,
  Gpu,
  InstanceData,
  LensFields,
  Materials,
  Mesh3d,
  MeshMaterial,
  NotShadowCaster,
  NotShadowReceiver,
  OffscreenTarget,
  PointLight,
  publishLensField,
  publishScreenEffect,
  RenderStats,
  RenderTargets,
  renderOwner,
  ScreenEffects,
  Visibility,
  Window,
} from '@aethervtt/shard-render'
import { FrameDemand, LogResource, Time } from '@aethervtt/shard-runtime'
import { Fonts } from '@aethervtt/shard-text'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import {
  type DiceAttachmentContext,
  type DiceSceneContext,
  findDiceAttachment,
  MAX_ATTACHMENTS,
} from './attachments'
import type { DieKind } from './builtins'
import { DiceDie } from './components'
import { type DieGeometry, dieGeometry, requireDie } from './definition'
import {
  type DiceEffect,
  DiceEffectRecipe,
  type DiceEffectRecipeValue,
  type MatchedRecipe,
  matchRecipes,
} from './effects'
import {
  type DiceEntranceContext,
  type DiceEntranceDef,
  findDiceEntrance,
  MAX_ENTRANCES,
} from './entrances'
import { floorUp, landingCorrection, naturalValue, restingHeight, restRotation } from './landing'
import { FaceLayout, type FaceLayoutValue } from './layout'
import { DICE_FIELDS } from './material'
import { hashString, type V3 } from './math'
import { type DiceQualityChoice, resolveDiceQuality } from './quality'
import { type DiceResourceEntry, DiceResources, RELEASE_AFTER_MS } from './resources'
import { type DiceRoll, expandRoll, type PhysicalDie, rollTrackRequest, viewportTray } from './roll'
import { DICE_SETTLE_RULE, type DiceTray, diceSettle } from './settle'
import { DiceSkin, type DiceSkinValue, validateDiceSkin } from './skin'
import {
  type AccentCue,
  DiceSoundBank,
  IMPACT_VARIATIONS,
  impactLayer,
  impactStrength,
} from './sound'
import {
  DICE_CONTACTS,
  type DiceTrackRequest,
  diceSettleParams,
  diceTrackScene,
  entranceSpots,
  laneLayout,
  placeDie,
  placedFrom,
  placementSpots,
  type UnlandedReason,
  unlandedDice,
} from './track'
import { meshVertices } from './windows'

// The dice table (0054): one presentation at a time, from a host's roll to dice resting on the
// tray. The package never decides a result; it shows one.

export type DicePhase = 'idle' | 'simulating' | 'tumble' | 'entrance' | 'accent' | 'rest'
export type DiceOutcome = 'finished' | 'dismissed' | 'cancelled' | 'failed'

export interface DicePlayOptions {
  /** Aborting it, in any phase, cancels the roll: `'cancelled'`. */
  signal?: AbortSignal
  /** Dismiss a roll that's playing instead of rejecting with `dice/busy`. */
  replace?: boolean
}

export interface DiceTableOptions {
  restMs: number
  maxDice: number
  /** Wall clock, ms: rests and releases run on it (tests pass their own). */
  now: () => number
  kinds: Readonly<Record<DieKind, readonly string[]>>
  worker: (() => TrackWorkerLike) | 'inline'
  /** The dice camera's vertical field of view, degrees. */
  fovY: number
  /** How long a roll waits for an entrance's assets and warm-up past the physics (0065). */
  entranceWaitMs: number
}

/** The frame demand a presentation holds while it moves. */
export const PRESENTATION_DEMAND = 'dice/presentation'
const ATTACHMENT_DEMAND = 'dice/attachments'
/** Held while dice of an animated family (at the display's rate) are shown. */
export const ANIMATED_DEMAND = 'dice/animated'
/** Held while an entrance's scene is alive (0065). */
export const ENTRANCE_DEMAND = 'dice/entrance'
/** How long a roll waits for an entrance's assets past the physics being ready, by default. */
export const ENTRANCE_WAIT_MS = 1500
/** A skipped scene's time to wind down. */
const SKIP_WIND_DOWN_MS = 400
/** An entrance that can't play drops its die into its spot this fast. */
const ENTRANCE_DROP_MS = 300
/** Steps faster than this are clamped, so a hitch doesn't skip contacts. */
const MAX_STEP_S = 1 / 15
const RESULT_RAMP_MS = 350
const FADE_MS = 150
/** A fixed tray and seed for skin pickers. */
export const PREVIEW_TRAY: DiceTray = { halfWidth: 2.6, halfDepth: 1.8 }

interface EffectRun {
  kind: DiceEffect['kind']
  effect: DiceEffect
  /** World position the effect plays at. */
  at: [number, number, number]
  source: Entity
  entity: Entity | undefined
  started: number
}

interface ActiveAttachment {
  name: string
  die: number
  entities: Entity[]
  started: number
  ctx: DiceAttachmentContext
  update:
    | ((ctx: DiceAttachmentContext, seconds: number, entities: readonly Entity[]) => boolean)
    | undefined
}

/** One die coming in through a scene instead of the tumble (0065). */
interface EntranceRun {
  name: string
  die: number
  def: DiceEntranceDef | undefined
  params: Record<string, unknown>
  /** The recipe that chose it: its other effects play when the die lands. */
  recipe: MatchedRecipe
  rest: { position: [number, number, number]; rotation: [number, number, number, number] }
  /** waiting: its turn hasn't come (or its assets); playing; landed: the scene winds down. */
  state: 'waiting' | 'playing' | 'landed' | 'done'
  /** Why it drops into its spot instead of playing its scene; null while it plays. */
  fallback: string | null
  /** Its assets are loaded and its scene drawn once (so its first frame compiles nothing). */
  ready: boolean
  started: number
  landedAt: number
  windDownUntil: number
  skipped: boolean
  entities: Entity[]
  ctx: DiceEntranceContext | undefined
  material: AssetRef<'Material'> | undefined
}

interface Presentation {
  id: number
  roll: DiceRoll
  dice: PhysicalDie[]
  skins: DiceSkinValue[]
  skinKeys: string[]
  quality: DiceQualityChoice
  reduced: boolean
  effects: boolean
  attachments: boolean
  lens: boolean
  soundGain: number
  phase: DicePhase
  resolve: (outcome: DiceOutcome) => void
  done: boolean
  abort: AbortController
  unlisten: (() => void) | undefined
  tray: DiceTray
  request: DiceTrackRequest | undefined
  track: Track | undefined
  hash: number | undefined
  corrections: Float64Array
  natural: number[]
  placed: (UnlandedReason | null)[]
  entries: DiceResourceEntry[]
  blended: boolean[]
  entities: Entity[]
  blobs: Entity[]
  time: number
  nextContact: number
  /** Per die: track time of its last impact sound, and its pitch (bigger dice ring lower). */
  lastImpact: Float64Array
  pitch: Float32Array
  /** Picks impact variations, from the roll's seed. */
  soundSeed: number
  landedAt: number
  fadeFrom: number
  restEndsAt: number
  restMs: number | undefined
  accentEndsAt: number
  runs: EffectRun[]
  matched: MatchedRecipe[]
  degraded: boolean
  live: ActiveAttachment[]
  voices: number[]
  shadowsBefore: boolean | undefined
  /** The tray's shadow opacity while a large pool's landing fades it in (NaN otherwise). */
  trayShadow: number
  /** The fastest animated family among the dice (0: none move once they rest). */
  fps: number
  /** The dice in the physics, in body order, and each die's body (−1 for entrance dice, 0065). */
  physical: number[]
  bodyOf: Int32Array
  entrances: EntranceRun[]
  /** Matched entrances that didn't play, and why (for describe). */
  entranceSkips: { die: number; name: string; reason: string }[]
  /** Recipes whose effects played as their entrance die landed: the accent skips them. */
  playedRecipes: Set<string>
  /** When the physics was ready: entrance assets get ENTRANCE_WAIT_MS past it. */
  readyAt: number
}

/** Where entrance scenes warm up, far from everything: each gets its own spot. */
let warmSlot = 0

// Scratch for playback: nothing per frame allocates.
const POS = new Float64Array(3)
const ROT = new Float64Array(4)
const SCREEN = new Float64Array(2)

/** Impacts one frame plays at most, the strongest: a pool's first bounce shouldn't roar. */
const IMPACTS_PER_FRAME = 4
/** The shortest gap between two impacts of one die, in seconds of the track. */
const IMPACT_GAP_S = 0.045
const PICK = new Int32Array(IMPACTS_PER_FRAME)
const POWER = new Float32Array(IMPACTS_PER_FRAME)
const IMPACT_VOLUME: [number, number] = [0, 0]
const IMPACT_PITCH: [number, number] = [0, 0]
const IMPACT_SOUND = { bus: 'sfx', volume: IMPACT_VOLUME, pitch: IMPACT_PITCH }
/** Accent cues play at this times their gain. */
const ACCENT_LEVEL = 0.4

/** A die's resting pose on screen, for lens fields: false when it's behind the camera. */
function screenOf(
  world: World,
  camera: Entity,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): boolean {
  const cam = world.resource(Cameras).get(camera)
  if (!cam) return false
  const m = cam.viewProj
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  if (w <= 0) return false
  const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w
  const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w
  out[0] = ((cx + 1) / 2) * (cam.displayWidth / cam.pixelRatio)
  out[1] = ((1 - cy) / 2) * (cam.displayHeight / cam.pixelRatio)
  return true
}

export class DiceTableState {
  /** The last failure's error (`'failed'` outcomes). */
  lastError: ShardError | undefined = undefined
  /** Recordings sent to the track worker (reduced motion sends none). */
  recordings = 0
  readonly resources: DiceResources
  readonly sounds = new DiceSoundBank()
  readonly options: DiceTableOptions
  camera: Entity = -1 as Entity
  light: Entity = -1 as Entity
  floor: Entity = -1 as Entity
  /** Where shadows fall on the floor (x, z), from the key light: blobs lean that way. */
  shadowDir: [number, number] = [0.63, -0.78]
  /** The tray material and quad, for the floor and contact blobs. */
  trayMaterial: AssetRef<'Material'> | undefined
  quad: AssetRef<'Mesh'> | undefined
  private readonly world: World
  private client: TrackClient | undefined
  private current: Presentation | undefined
  private nextId = 1
  private disposed = false
  private fitted = { aspect: 0, halfWidth: 0, halfDepth: 0 }
  private warned = new Set<string>()

  constructor(world: World, options: DiceTableOptions) {
    this.world = world
    this.options = options
    this.resources = new DiceResources(world)
  }

  /** Where the presentation is: `'idle'` with none. */
  get phase(): DicePhase {
    return this.current?.phase ?? 'idle'
  }

  /** The track client, started on first use; call early to have the worker warm. */
  tracks(): TrackClient {
    this.client ??= createTrackClient({
      spawn: this.options.worker,
      rules: { [DICE_SETTLE_RULE]: diceSettle },
    })
    return this.client
  }

  // --- the host's calls ---------------------------------------------------------------------------

  /**
   * Presents a roll the host decided. Resolves once it's over: `'finished'` after the rest,
   * `'dismissed'`, `'cancelled'` (the signal aborted), or `'failed'` (with the error in
   * `lastError`; never a half-played roll). Rejects with `dice/busy` while another plays, unless
   * `replace`.
   */
  play(roll: DiceRoll, options: DicePlayOptions = {}): Promise<DiceOutcome> {
    if (this.disposed) {
      this.lastError = new ShardError('dice/disposed', 'The dice table was disposed')
      return Promise.resolve('failed')
    }
    if (this.current) {
      if (!options.replace) {
        return Promise.reject(
          new ShardError('dice/busy', 'A roll is already playing', {
            hint: 'Queue rolls in the host, dismiss this one, or pass { replace: true }.',
          }),
        )
      }
      this.finish(this.current, 'dismissed')
    }
    let resolve!: (outcome: DiceOutcome) => void
    const done = new Promise<DiceOutcome>((r) => {
      resolve = r
    })
    const p: Presentation = {
      id: this.nextId++,
      roll,
      dice: [],
      skins: [],
      skinKeys: [],
      quality: { tier: 'full', reason: '' },
      reduced: roll.motion === 'reduced',
      effects: false,
      attachments: false,
      lens: false,
      soundGain: Math.max(0, Math.min(1, roll.soundGain ?? 1)),
      phase: 'simulating',
      resolve,
      done: false,
      abort: new AbortController(),
      unlisten: undefined,
      tray: roll.tray ?? viewportTray(this.aspect()),
      request: undefined,
      track: undefined,
      hash: undefined,
      corrections: new Float64Array(0),
      natural: [],
      placed: [],
      entries: [],
      blended: [],
      entities: [],
      blobs: [],
      time: 0,
      nextContact: 0,
      lastImpact: new Float64Array(0),
      pitch: new Float32Array(0),
      soundSeed: hashString(`${roll.seed ?? roll.id}:sound`),
      landedAt: Number.NaN,
      fadeFrom: Number.NaN,
      restEndsAt: Number.POSITIVE_INFINITY,
      restMs: undefined,
      accentEndsAt: 0,
      runs: [],
      matched: [],
      degraded: false,
      live: [],
      voices: [],
      shadowsBefore: undefined,
      trayShadow: Number.NaN,
      fps: 0,
      physical: [],
      bodyOf: new Int32Array(0),
      entrances: [],
      entranceSkips: [],
      playedRecipes: new Set(),
      readyAt: Number.NaN,
    }
    this.current = p
    const signal = options.signal
    if (signal?.aborted) {
      this.finish(p, 'cancelled')
      return done
    }
    if (signal) {
      const onAbort = () => this.finish(p, 'cancelled')
      signal.addEventListener('abort', onAbort, { once: true })
      p.unlisten = () => signal.removeEventListener('abort', onAbort)
    }
    try {
      this.check(p)
    } catch (err) {
      this.fail(p, err)
      return done
    }
    this.world.resource(FrameDemand).hold(PRESENTATION_DEMAND)
    void this.prepare(p)
    return done
  }

  /** Plays a roll on a fixed seed and tray, for skin pickers. Replaces what's playing. */
  preview(roll: DiceRoll, options: Omit<DicePlayOptions, 'replace'> = {}): Promise<DiceOutcome> {
    return this.play(
      { ...roll, seed: 'preview', tray: PREVIEW_TRAY },
      { ...options, replace: true },
    )
  }

  /** Ends the presentation now: `'dismissed'`. False when nothing plays. */
  dismiss(): boolean {
    if (!this.current) return false
    this.finish(this.current, 'dismissed')
    return true
  }

  /** Shortens the rest to at most `ms` from now (or from when the dice land, if they haven't). */
  shortenRest(ms: number): void {
    const p = this.current
    if (!p) return
    const wait = Math.max(0, ms)
    p.restMs = Math.min(p.restMs ?? Number.POSITIVE_INFINITY, wait)
    if (p.phase === 'rest') {
      p.restEndsAt = Math.min(p.restEndsAt, this.options.now() + wait)
      this.world.resource(FrameDemand).after(wait)
    }
  }

  // --- presentation -------------------------------------------------------------------------------

  /** Everything that can fail before anything plays: the roll's values, its skins and layouts. */
  private check(p: Presentation): void {
    const roll = p.roll
    p.dice = expandRoll(roll, this.options.kinds)
    if (p.dice.length > this.options.maxDice) {
      throw new ShardError(
        'dice/invalid-roll',
        `The table shows at most ${this.options.maxDice} dice`,
        {
          path: 'dice',
        },
      )
    }
    p.quality = resolveDiceQuality(p.dice.length, roll.quality)
    const large = p.quality.tier === 'large-pool'
    p.effects = !p.reduced && roll.effects !== false && !large
    p.attachments = p.effects && p.quality.tier === 'full'
    p.lens = p.attachments
    const store = this.world.resource(DiceSkin.store)
    const cache = new Map<string, DiceSkinValue>()
    for (const d of p.dice) {
      const key = d.skin.guid ?? d.skin.path ?? ''
      let skin = cache.get(key)
      if (!skin) {
        skin = store.get(d.skin) as DiceSkinValue | undefined
        if (!skin) {
          throw new ShardError('dice/unknown-skin', `No dice skin ${key}`, {
            path: `dice[${d.source}].skin`,
            hint: 'Add skins to DiceSkin.store (or load their .dice-skin.json files) before rolling them.',
          })
        }
        cache.set(key, skin)
      }
      p.skins.push(skin)
      p.skinKeys.push(key)
    }
  }

  /**
   * Loads what the roll's skins reference (layouts, recipes, the layouts' fonts), then checks the
   * skins: an unknown family, a layout that can't show a value, a recipe over its bounds.
   */
  private async loadSkins(p: Presentation): Promise<void> {
    const pending = new Map<string, AssetRef>()
    const want = (ref: AssetRef | null, have: unknown) => {
      if (ref && !have) pending.set(ref.guid ?? ref.path ?? '', ref)
    }
    const skins = new Set(p.skins)
    for (const skin of skins) {
      for (const kind of Object.keys(skin.variants) as DieKind[]) {
        const l = skin.variants[kind].layout
        want(l, l && this.layout(l))
      }
      for (const r of skin.effects) want(r, r && this.recipe(r))
    }
    if (pending.size > 0)
      await Promise.all([...pending.values()].map((r) => assetServer(this.world).load(r)))
    if (p.done) return
    await this.loadFonts(p)
    if (p.done) return
    for (const skin of skins) {
      const errors = validateDiceSkin(skin, {
        layout: (r) => this.layout(r),
        recipe: (r) => this.recipe(r),
      })
      if (errors.length > 0) throw errors[0]!
    }
  }

  layout(ref: AssetRef): FaceLayoutValue | undefined {
    return this.world.resource(FaceLayout.store).get(ref) as FaceLayoutValue | undefined
  }

  recipe(ref: AssetRef): DiceEffectRecipeValue | undefined {
    return this.world.resource(DiceEffectRecipe.store).get(ref) as DiceEffectRecipeValue | undefined
  }

  /** Loads what the roll's layouts need (fonts), makes the dice's resources, then records or places. */
  private async prepare(p: Presentation): Promise<void> {
    try {
      await this.loadSkins(p)
      if (p.done) return
      // Entrances first (0065): their dice stay out of the physics.
      this.chooseEntrances(p)
      this.acquire(p)
      p.request = rollTrackRequest(
        p.roll,
        p.physical.map((i) => p.dice[i]!),
        p.tray,
      )
      if (p.reduced) {
        this.placeReduced(p)
        return
      }
      const request = p.request
      const recording =
        p.physical.length > 0
          ? this.tracks().record(diceTrackScene(request), {
              signal: p.abort.signal,
              settle: { rule: DICE_SETTLE_RULE, params: diceSettleParams(request) },
              contacts: DICE_CONTACTS,
            })
          : undefined
      if (recording) this.recordings++
      // While the worker records: bake the impacts the tumble will play, have them decoded, and
      // get the entrances ready (assets loaded, scenes drawn once).
      if (p.soundGain > 0 && this.world.tryResource(AudioState)) {
        for (const skin of new Set(p.skins)) {
          this.sounds.prepare(skin.sounds.impact, (clip) => preloadSound(this.world, clip))
        }
      }
      for (const run of p.entrances) void this.readyEntrance(p, run)
      const track = recording ? await recording : undefined
      if (p.done) return
      p.readyAt = this.options.now()
      this.land(p, track)
      this.spawnDice(p)
      // Every die entering: nothing tumbles; the entrances start now.
      if (track) p.phase = 'tumble'
      else this.landed(p)
    } catch (err) {
      if (p.done) return
      const code = (err as ShardError).code
      if (code === 'physics/track-cancelled' && p.abort.signal.aborted) this.finish(p, 'cancelled')
      else this.fail(p, err)
    }
  }

  private async loadFonts(p: Presentation): Promise<void> {
    const fonts = this.world.tryResource(Fonts)
    const wanted = new Map<string, AssetRef>()
    for (let i = 0; i < p.dice.length; i++) {
      const variant = p.skins[i]!.variants[p.dice[i]!.kind]
      const layout = variant.layout ? this.layout(variant.layout) : undefined
      if (!layout) continue
      for (const m of [layout.default, ...layout.overrides.map((o) => o.mark)]) {
        if (m.kind === 'text' && m.font && !fonts?.get(m.font))
          wanted.set(m.font.guid ?? m.font.path ?? '', m.font)
      }
    }
    if (wanted.size === 0) return
    await Promise.all([...wanted.values()].map((ref) => assetServer(this.world).load(ref)))
  }

  private acquire(p: Presentation): void {
    const fonts = this.world.tryResource(Fonts)
    const large = p.quality.tier === 'large-pool'
    for (let i = 0; i < p.dice.length; i++) {
      const d = p.dice[i]!
      const g = dieGeometry(requireDie(d.definition))
      const entry = this.resources.acquire(
        g,
        p.skinKeys[i]!,
        p.skins[i]!,
        d.kind,
        (r) => this.layout(r),
        {
          font: (r) => fonts?.get(r),
        },
      )
      p.entries.push(entry)
      p.fps = Math.max(p.fps, entry.family.fps)
      // Large pools draw see-through families opaque, so they batch (a fixed blend can't).
      const see = large ? this.resources.fixedBlend(entry) : this.resources.blendedByNature(entry)
      p.blended.push(p.reduced || d.dropped || see)
    }
  }

  private screenUp(): [number, number, number] {
    const t = this.world.tryGet(this.camera, Transform)
    if (!t) return [0, 0, -1]
    const q = t.rotation
    // The camera's up (its local +y), flattened onto the floor.
    const x = 2 * (q[0]! * q[1]! - q[3]! * q[2]!)
    const z = 2 * (q[1]! * q[2]! + q[3]! * q[0]!)
    return floorUp([x, 0, z])
  }

  /**
   * The track is in (or there's none: every die enters): which dice land, where the rest go, each
   * die's correction, and where entrance dice will land (0065).
   */
  private land(p: Presentation, track: Track | undefined): void {
    const up = this.screenUp()
    const n = p.dice.length
    p.corrections = new Float64Array(n * 4)
    for (let i = 0; i < n; i++) p.corrections[i * 4 + 3] = 1
    p.placed = p.dice.map(() => null)
    p.natural = p.dice.map((d) => d.value)
    if (track) {
      p.track = track
      p.hash = trackHash(track)
      const request = p.request!
      const unlanded = unlandedDice(track, request)
      const spots = placementSpots(track, request, unlanded)
      const o = track.steps * track.bodyCount
      for (let b = 0; b < p.physical.length; b++) {
        const i = p.physical[b]!
        const d = p.dice[i]!
        const g = dieGeometry(requireDie(d.definition))
        p.placed[i] = unlanded[b]!
        if (unlanded[b]) {
          placeDie(track, b, spots[b]!, restRotation(g, d.value, up), g, d.scale)
          continue
        }
        const final = track.rotations.subarray((o + b) * 4, (o + b) * 4 + 4)
        p.natural[i] = naturalValue(g, final)
        p.corrections.set(landingCorrection(g, final, d.value, up), i * 4)
      }
    }
    this.placeEntrances(p, up)
  }

  /**
   * Rest poses for entrance dice: free spots near what each entrance wants (the tray's center by
   * default), clear of where the physical dice ended, target up with the readable twist.
   */
  private placeEntrances(p: Presentation, up: [number, number, number]): void {
    if (p.entrances.length === 0) return
    const taken: V3[] = []
    const track = p.track
    if (track) {
      const o = track.steps * track.bodyCount
      for (let b = 0; b < track.bodyCount; b++) {
        taken.push([track.positions[(o + b) * 3]!, 0, track.positions[(o + b) * 3 + 2]!])
      }
    }
    const wants: V3[] = p.entrances.map((run) => {
      const spot = run.def?.spot
      return spot && spot !== 'center'
        ? [spot[0] * p.tray.halfWidth, 0, spot[1] * p.tray.halfDepth]
        : [0, 0, 0]
    })
    const all = p.dice.map((d) => ({
      definition: d.definition,
      scale: d.scale,
      dropped: d.dropped,
    }))
    const spots = entranceSpots(p.tray, all, taken, wants)
    p.entrances.forEach((run, k) => {
      const d = p.dice[run.die]!
      const g = dieGeometry(requireDie(d.definition))
      const rotation = restRotation(g, d.value, up)
      run.rest = {
        position: [spots[k]![0], restingHeight(g, rotation, d.scale), spots[k]![2]],
        rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
      }
    })
  }

  /** Reduced motion: no physics. Each die rests in its lane, target up and upright, fading in. */
  private placeReduced(p: Presentation): void {
    const up = this.screenUp()
    const lanes = laneLayout(p.request!)
    p.corrections = new Float64Array(p.dice.length * 4)
    for (let i = 0; i < p.dice.length; i++) p.corrections[i * 4 + 3] = 1
    p.placed = p.dice.map(() => null)
    p.natural = p.dice.map((d) => d.value)
    this.spawnDice(p, (i, pos, rot) => {
      const d = p.dice[i]!
      const g = dieGeometry(requireDie(d.definition))
      const q = restRotation(g, d.value, up)
      rot.set(q)
      pos[0] = lanes[i]![0]
      pos[1] = restingHeight(g, q, d.scale)
      pos[2] = lanes[i]![2]
    })
    p.fadeFrom = this.options.now()
    this.resources.setAll(p.entries, 'fade', 0)
    this.resources.setAll(p.entries, 'result', 1)
    this.resources.setAll(p.entries, 'resultTime', this.world.resource(Time).elapsed)
    this.rest(p)
  }

  private geometryOf(d: PhysicalDie): DieGeometry {
    return dieGeometry(requireDie(d.definition))
  }

  /** Spawns the dice (and contact blobs) at their first pose. */
  private spawnDice(
    p: Presentation,
    pose?: (i: number, pos: Float64Array, rot: Float64Array) => void,
  ): void {
    const world = this.world
    const large = p.quality.tier === 'large-pool'
    p.lastImpact = new Float64Array(p.dice.length).fill(Number.NEGATIVE_INFINITY)
    // A die rings lower the bigger it is: pitch by the square root of size, 16 mm at 1.
    p.pitch = Float32Array.from(p.dice, (d) => Math.sqrt(16 / requireDie(d.definition).sizeMm))
    if (large && world.isAlive(this.light)) {
      // Large pools don't cast moving shadows: blobs while they tumble, one shadow once they land.
      const light = world.get(this.light, DirectionalLight)
      p.shadowsBefore = light.shadows
      if (light.shadows) world.set(this.light, DirectionalLight, { shadows: false })
    }
    for (let i = 0; i < p.dice.length; i++) {
      const d = p.dice[i]!
      const entry = p.entries[i]!
      // An entrance die waits at its rest pose, hidden, with a material of its own (0065).
      const run = p.entrances.find((r) => r.die === i)
      if (pose) pose(i, POS, ROT)
      else if (run) {
        POS.set(run.rest.position)
        ROT.set(run.rest.rotation)
      } else this.samplePose(p, i, 0, POS, ROT)
      const material = this.resources.material(entry, {
        blended: p.blended[i]!,
        dropped: d.dropped,
        entrance: run ? i : undefined,
      })
      if (run) {
        run.material = material
        world.resource(Materials).get(material)?.set({ result: 0, resultTime: 0 })
      }
      const s = d.scale
      p.entities.push(
        world.spawn(
          // Large pools switch shadows on as they land: dice that caught them would darken at once.
          ...(large ? [NotShadowReceiver] : []),
          ...(run ? [[Visibility, { mode: 'hidden' as const }] as const] : []),
          [Mesh3d, { mesh: entry.mesh }],
          [MeshMaterial, { material }],
          [
            Transform,
            {
              translation: [POS[0]!, POS[1]!, POS[2]!],
              rotation: [ROT[0]!, ROT[1]!, ROT[2]!, ROT[3]!],
              scale: [s, s, s],
            },
          ],
          [InstanceData, { x: d.value, y: 0 }],
          [
            DiceDie,
            {
              index: i,
              kind: d.kind,
              definition: d.definition,
              value: d.value,
              label: d.label,
              dropped: d.dropped,
            },
          ],
        ),
      )
      const blob = p.blended[i]! || large
      p.blobs.push(blob ? this.spawnBlob(d, POS) : (-1 as Entity))
    }
  }

  private spawnBlob(d: PhysicalDie, pos: Float64Array): Entity {
    const r = this.blobRadius(d)
    const lean = this.blobLean(d, pos[1]!)
    return this.world.spawn(
      [Mesh3d, { mesh: this.quad! }],
      [MeshMaterial, { material: this.trayMaterial! }],
      [
        Transform,
        {
          translation: [
            pos[0]! + this.shadowDir[0] * lean,
            0.003,
            pos[2]! + this.shadowDir[1] * lean,
          ],
          scale: [r, 1, r],
        },
      ],
      [InstanceData, { x: this.blobStrength(d, pos[1]!), y: 0 }],
      NotShadowCaster,
      NotShadowReceiver,
    )
  }

  private blobRadius(d: PhysicalDie): number {
    return this.geometryOf(d).footprint * d.scale * 0.95
  }

  /** How far a blob sits from under its die, toward the shadows: more as the die rises. */
  private blobLean(d: PhysicalDie, y: number): number {
    const rest = this.geometryOf(d).restHeight * d.scale
    return this.blobRadius(d) * 0.28 + Math.max(0, y - rest) * 0.35
  }

  private blobStrength(d: PhysicalDie, y: number): number {
    const rest = this.geometryOf(d).restHeight * d.scale
    return Math.max(0.02, 1 - Math.max(0, y - rest) / 1.6)
  }

  /** A die's pose at `time`, with its correction: rotation · C. Allocates nothing. */
  private samplePose(
    p: Presentation,
    i: number,
    time: number,
    pos: Float64Array,
    rot: Float64Array,
  ): void {
    sampleTrack(p.track!, time, p.bodyOf[i]!, pos, rot)
    const c = p.corrections
    const o = i * 4
    const ax = rot[0]!
    const ay = rot[1]!
    const az = rot[2]!
    const aw = rot[3]!
    const bx = c[o]!
    const by = c[o + 1]!
    const bz = c[o + 2]!
    const bw = c[o + 3]!
    rot[0] = aw * bx + ax * bw + ay * bz - az * by
    rot[1] = aw * by - ax * bz + ay * bw + az * bx
    rot[2] = aw * bz + ax * by - ay * bx + az * bw
    rot[3] = aw * bw - ax * bx - ay * by - az * bz
  }

  // --- frames -------------------------------------------------------------------------------------

  /** One frame of the table: the systems call it in Update. */
  frame(): void {
    const world = this.world
    const now = this.options.now()
    this.fitCamera()
    if (this.resources.nextRelease() <= now) this.resources.sweep(now)
    const p = this.current
    if (!p || p.done) return
    const dt = Math.min(world.resource(Time).delta, MAX_STEP_S)
    if (p.phase === 'tumble') this.tumble(p, dt)
    if (!Number.isNaN(p.landedAt)) this.settleLook(p, now)
    if (!Number.isNaN(p.fadeFrom)) this.fade(p, now)
    if (p.entrances.length > 0) this.entrancesFrame(p, now)
    // Effects run from the accent, and from an entrance die's landing before it.
    if (p.runs.length > 0) this.accent(p, now)
    if (p.phase === 'accent' && now >= p.accentEndsAt) this.rest(p)
    this.attachmentsFrame(p, now)
    // Animated families keep frames coming while their dice are on the table.
    if (p.fps > 0 && !p.reduced && p.entities.length > 0 && !p.done) {
      const demand = world.resource(FrameDemand)
      if (p.fps === Number.POSITIVE_INFINITY) demand.hold(ANIMATED_DEMAND)
      else demand.after(1000 / p.fps)
    }
    if (p.phase === 'rest' && now >= p.restEndsAt) this.finish(p, 'finished')
  }

  private tumble(p: Presentation, dt: number): void {
    const world = this.world
    const track = p.track!
    p.time += dt
    // The dice in the physics; entrance dice wait for their scene (0065).
    const n = p.physical.length
    for (let b = 0; b < n; b++) {
      const i = p.physical[b]!
      const e = p.entities[i]!
      this.samplePose(p, i, p.time, POS, ROT)
      const table = world.entityTableUnchecked(e)
      const row = world.entityRowUnchecked(e)
      const tr = table.column(Transform, 'translation')
      const rt = table.column(Transform, 'rotation')
      tr[row * 3] = POS[0]!
      tr[row * 3 + 1] = POS[1]!
      tr[row * 3 + 2] = POS[2]!
      rt[row * 4] = ROT[0]!
      rt[row * 4 + 1] = ROT[1]!
      rt[row * 4 + 2] = ROT[2]!
      rt[row * 4 + 3] = ROT[3]!
      table.markChanged(Transform, row)
      const blob = p.blobs[i]!
      if (blob >= 0) {
        const bt = world.entityTableUnchecked(blob)
        const br = world.entityRowUnchecked(blob)
        const btr = bt.column(Transform, 'translation')
        const lean = this.blobLean(p.dice[i]!, POS[1]!)
        btr[br * 3] = POS[0]! + this.shadowDir[0] * lean
        btr[br * 3 + 2] = POS[2]! + this.shadowDir[1] * lean
        bt.markChanged(Transform, br)
        bt.column(InstanceData, 'x')[br] = this.blobStrength(p.dice[i]!, POS[1]!)
        bt.markChanged(InstanceData, br)
      }
    }
    this.contacts(p)
    if (p.time >= track.steps * track.step) this.landed(p)
  }

  /**
   * Impact sounds up to the current step, as the track recorded them: at most one per die every
   * 45 ms, and the strongest four in a frame. Allocates nothing without audio.
   */
  private contacts(p: Presentation): void {
    const track = p.track!
    const c = track.contacts
    const step = Math.floor(p.time / track.step)
    const placedStep = placedFrom(track)
    const audio = this.world.tryResource(AudioState)
    let picked = 0
    while (p.nextContact < c.steps.length && c.steps[p.nextContact]! <= step) {
      const k = p.nextContact++
      const s = c.steps[k]!
      // Bodies to dice (entrance dice aren't bodies, 0065).
      const a = p.physical[c.a[k]!]!
      const b = c.b[k]! >= 0 ? p.physical[c.b[k]!]! : -1
      // A placed die isn't where the physics was once it drops in.
      if (s >= placedStep && (p.placed[a] || (b >= 0 && p.placed[b]))) continue
      if (!audio || p.soundGain <= 0) continue
      const t = s * track.step
      if (t - p.lastImpact[a]! < IMPACT_GAP_S) continue
      if (b >= 0 && t - p.lastImpact[b]! < IMPACT_GAP_S) continue
      const strength = impactStrength(c.force[k]!)
      if (strength < 0.03) continue
      if (picked < IMPACTS_PER_FRAME) {
        PICK[picked] = k
        POWER[picked++] = strength
        continue
      }
      let weakest = 0
      for (let j = 1; j < IMPACTS_PER_FRAME; j++) if (POWER[j]! < POWER[weakest]!) weakest = j
      if (strength > POWER[weakest]!) {
        PICK[weakest] = k
        POWER[weakest] = strength
      }
    }
    for (let j = 0; j < picked; j++) this.impact(p, PICK[j]!, POWER[j]!, picked)
  }

  /**
   * One impact: a variation of its strength layer, louder faster than strength (light touches stay
   * light), at a pitch and level picked around the contact's (0035's ranges).
   */
  private impact(p: Presentation, k: number, strength: number, together: number): void {
    const track = p.track!
    const c = track.contacts
    const a = p.physical[c.a[k]!]!
    const b = c.b[k]! >= 0 ? p.physical[c.b[k]!]! : -1
    const t = c.steps[k]! * track.step
    p.lastImpact[a] = t
    if (b >= 0) p.lastImpact[b] = t
    const tray = b < 0
    const variation = ((Math.imul(k + 1, 0x9e3779b1) ^ p.soundSeed) >>> 0) % IMPACT_VARIATIONS
    const clip = this.sounds.impact(
      p.skins[a]!.sounds.impact,
      tray ? 'tray' : 'dice',
      impactLayer(strength),
      variation,
    )
    const level = strength ** 1.5 * (tray ? 0.24 : 0.16) * p.soundGain * (together > 2 ? 0.8 : 1)
    const pitch = tray ? p.pitch[a]! : Math.sqrt(p.pitch[a]! * p.pitch[b]!)
    IMPACT_VOLUME[0] = level * 0.8
    IMPACT_VOLUME[1] = level
    IMPACT_PITCH[0] = pitch * 0.94
    IMPACT_PITCH[1] = pitch * 1.06
    p.voices.push(playSound(this.world, clip, IMPACT_SOUND))
  }

  /** The tumble ended: results light up, large pools get their shadow, effects or the rest begin. */
  private landed(p: Presentation): void {
    const world = this.world
    const now = this.options.now()
    p.landedAt = now
    // Families react from here, on the shader clock.
    this.resources.setAll(p.entries, 'resultTime', world.resource(Time).elapsed)
    if (p.quality.tier === 'large-pool' && p.shadowsBefore && world.isAlive(this.light)) {
      // Opaque dice cast their shadow now: it fades in on the tray as their blobs fade out, over
      // the result ramp (blended dice keep their blob).
      const tray = world.resource(Materials).get(this.trayMaterial!)
      if (tray) {
        p.trayShadow = tray.value.shadowOpacity as number
        tray.set({ shadowOpacity: 0 })
      }
      world.set(this.light, DirectionalLight, { shadows: true })
    }
    // Placed dice land with a knock of their own.
    const audio = world.tryResource(AudioState)
    if (audio && p.soundGain > 0) {
      const i = p.placed.findIndex(Boolean)
      if (i >= 0) {
        const clip = this.sounds.impact(p.skins[i]!.sounds.impact, 'tray', 1, 0)
        const level = 0.14 * p.soundGain
        p.voices.push(
          playSound(world, clip, {
            volume: [level * 0.8, level],
            pitch: [p.pitch[i]! * 0.9, p.pitch[i]! * 0.98],
          }),
        )
      }
    }
    // Then the entrances, one after another (0065); the accent waits for their dice.
    if (p.entrances.length > 0) {
      p.phase = 'entrance'
      world.resource(FrameDemand).hold(ENTRANCE_DEMAND)
      this.nextEntrance(p, now)
      return
    }
    this.afterLanding(p, now)
  }

  /** Every die is down: the accent if anything plays in it, else the rest. */
  private afterLanding(p: Presentation, now: number): void {
    if (p.effects && this.startAccent(p, now)) return
    this.rest(p)
  }

  /** The result ramp, over 350 ms from landing. */
  private settleLook(p: Presentation, now: number): void {
    const t = Math.min(1, (now - p.landedAt) / RESULT_RAMP_MS)
    this.resources.setAll(p.entries, 'result', t)
    if (!Number.isNaN(p.trayShadow)) this.crossfadeShadows(p, t)
    if (t >= 1) {
      p.landedAt = Number.NaN
      if (p.phase === 'rest' && p.live.every((a) => !a.update)) {
        this.world.resource(FrameDemand).release(PRESENTATION_DEMAND)
      }
    }
  }

  /**
   * A large pool's landing, t from 0 to 1: the tray's shadow in, the opaque dice's blobs out
   * (despawned at 1). Allocates nothing.
   */
  private crossfadeShadows(p: Presentation, t: number): void {
    const world = this.world
    world
      .resource(Materials)
      .get(this.trayMaterial!)
      ?.set({ shadowOpacity: p.trayShadow * t })
    for (let i = 0; i < p.blobs.length; i++) {
      const blob = p.blobs[i]!
      if (blob < 0 || p.blended[i]) continue
      if (t >= 1) {
        world.despawn(blob)
        p.blobs[i] = -1 as Entity
        continue
      }
      const bt = world.entityTableUnchecked(blob)
      const br = world.entityRowUnchecked(blob)
      const y = world.entityTableUnchecked(p.entities[i]!).column(Transform, 'translation')
      const dy = y[world.entityRowUnchecked(p.entities[i]!) * 3 + 1]!
      bt.column(InstanceData, 'x')[br] = Math.max(1e-3, this.blobStrength(p.dice[i]!, dy) * (1 - t))
      bt.markChanged(InstanceData, br)
    }
    if (t >= 1) p.trayShadow = Number.NaN
  }

  /** Reduced motion's fade in, over 150 ms. */
  private fade(p: Presentation, now: number): void {
    const t = Math.min(1, (now - p.fadeFrom) / FADE_MS)
    this.resources.setAll(p.entries, 'fade', t)
    if (t >= 1) {
      p.fadeFrom = Number.NaN
      this.world.resource(FrameDemand).release(PRESENTATION_DEMAND)
    }
  }

  private rest(p: Presentation): void {
    p.phase = 'rest'
    const wait = p.restMs ?? this.options.restMs
    p.restEndsAt = this.options.now() + wait
    const demand = this.world.resource(FrameDemand)
    demand.after(wait)
    // Still moving: the result ramp or the fade hold frames until they end.
    if (Number.isNaN(p.landedAt) && Number.isNaN(p.fadeFrom)) demand.release(PRESENTATION_DEMAND)
  }

  // --- effects ------------------------------------------------------------------------------------

  /**
   * The roll's recipes, once each, and which dice carry each one (their skin names it): a
   * recipe's conditions read the whole roll, but its effects play on its own skin's dice.
   */
  private recipesOf(p: Presentation): {
    recipes: DiceEffectRecipeValue[]
    carriers: Map<string, Set<number>>
  } {
    const recipes: DiceEffectRecipeValue[] = []
    const carriers = new Map<string, Set<number>>()
    p.skins.forEach((skin, i) => {
      for (const ref of skin.effects) {
        if (!ref) continue
        const r = this.recipe(ref)
        if (!r) continue
        let set = carriers.get(r.id)
        if (!set) {
          set = new Set()
          carriers.set(r.id, set)
          recipes.push(r)
        }
        set.add(i)
      }
    })
    return { recipes, carriers }
  }

  private centroid(
    p: Presentation,
    anchors: readonly number[],
  ): [number, number, number] | undefined {
    if (anchors.length === 0) return undefined
    let x = 0
    let z = 0
    for (const i of anchors) {
      const t = this.world.get(p.entities[i]!, Transform).translation
      x += t[0]!
      z += t[2]!
    }
    return [x / anchors.length, 0.6, z / anchors.length]
  }

  /**
   * The roll's recipes, matched once (the conditions read only the roll), and the entrance dice they
   * choose (0065): at most 2, in the full tier, with effects on and full motion.
   */
  private chooseEntrances(p: Presentation): void {
    const { recipes, carriers } = this.recipesOf(p)
    const { matched, degraded } = matchRecipes(recipes, p.roll, p.dice)
    for (const m of matched) m.anchors = m.anchors.filter((i) => carriers.get(m.recipe.id)?.has(i))
    p.matched = matched
    p.degraded = degraded
    // The tier before effects: a large pool turns effects off itself.
    const barred = p.reduced
      ? 'reduced motion'
      : p.quality.tier !== 'full'
        ? `the ${p.quality.tier} tier`
        : !p.effects
          ? 'effects off'
          : null
    const chosen = new Set<number>()
    for (const m of matched) {
      for (const effect of m.recipe.effects) {
        if (effect.kind !== 'entrance') continue
        for (const i of m.anchors) {
          if (chosen.has(i)) continue
          const name = effect.entrance
          if (barred || p.entrances.length >= MAX_ENTRANCES) {
            p.entranceSkips.push({ die: i, name, reason: barred ?? `over ${MAX_ENTRANCES}` })
            continue
          }
          chosen.add(i)
          const def = findDiceEntrance(name)
          if (!def) this.entranceUnavailable(name, `no entrance "${name}" is defined`)
          p.entrances.push({
            name,
            die: i,
            def,
            params: (effect.params as Record<string, unknown> | null) ?? {},
            recipe: m,
            rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
            state: 'waiting',
            fallback: def ? null : 'undefined',
            ready: !def,
            started: Number.NaN,
            landedAt: Number.NaN,
            windDownUntil: Number.POSITIVE_INFINITY,
            skipped: false,
            entities: [],
            ctx: undefined,
            material: undefined,
          })
        }
      }
    }
    p.physical = []
    p.bodyOf = new Int32Array(p.dice.length).fill(-1)
    for (let i = 0; i < p.dice.length; i++) {
      if (chosen.has(i)) continue
      p.bodyOf[i] = p.physical.length
      p.physical.push(i)
    }
  }

  /** Budgets for one burst of effects: one light, one cue, 32 particles. */
  private static budget(): { light: boolean; cue: boolean; particles: number } {
    return { light: false, cue: false, particles: 0 }
  }

  /** Starts a matched recipe's effects on `anchors`. Returns how long the longest runs, ms. */
  private playRecipe(
    p: Presentation,
    m: MatchedRecipe,
    anchors: readonly number[],
    now: number,
    budget: { light: boolean; cue: boolean; particles: number },
  ): number {
    let longest = 0
    const at = this.centroid(p, anchors)
    for (const effect of m.recipe.effects) {
      if (effect.kind === 'entrance') continue
      if (effect.kind === 'attachment') {
        for (const i of anchors) this.attach(p, effect, i, now)
        continue
      }
      if (effect.kind === 'sound-accent') {
        if (budget.cue) continue
        budget.cue = true
        this.accentSound(p, effect.cue, effect.gain)
        continue
      }
      if (!at) continue
      if (effect.kind === 'light-pulse') {
        if (budget.light) continue
        budget.light = true
      }
      if (effect.kind === 'particle-burst') {
        if (budget.particles >= 32) continue
        budget.particles += effect.count
      }
      if (effect.kind === 'lens-pulse' && !p.lens) continue
      longest = Math.max(longest, effect.durationMs)
      const run: EffectRun = {
        kind: effect.kind,
        effect,
        at,
        source: p.entities[anchors[0]!]!,
        entity: undefined,
        started: now,
      }
      this.startRun(p, run)
      p.runs.push(run)
    }
    return longest
  }

  /** Starts the accent phase if anything plays in it. */
  private startAccent(p: Presentation, now: number): boolean {
    let longest = 0
    const budget = DiceTableState.budget()
    for (const m of p.matched) {
      // Played as its entrance die landed.
      if (p.playedRecipes.has(m.recipe.id)) continue
      longest = Math.max(longest, this.playRecipe(p, m, m.anchors, now, budget))
    }
    // The skin's own landing cue, for kept dice.
    if (!budget.cue) {
      const i = p.dice.findIndex((d, k) => !d.dropped && p.skins[k]!.sounds.accent)
      if (i >= 0) this.accentSound(p, p.skins[i]!.sounds.accent as AccentCue, 0.6)
    }
    if (longest === 0 && p.live.length === 0) return false
    p.phase = 'accent'
    p.accentEndsAt = now + longest
    return true
  }

  /** An accent cue, a little above the hardest impact at full gain. */
  private accentSound(p: Presentation, cue: AccentCue, gain: number): void {
    if (!this.world.tryResource(AudioState) || p.soundGain <= 0) return
    const level = ACCENT_LEVEL * gain * p.soundGain
    p.voices.push(playSound(this.world, this.sounds.accent(cue), { volume: level }))
  }

  private startRun(p: Presentation, run: EffectRun): void {
    const world = this.world
    const e = run.effect
    if (run.kind === 'light-pulse') {
      run.entity = world.spawn(
        [
          PointLight,
          {
            color: [e.color[0]!, e.color[1]!, e.color[2]!, 1],
            intensity: 0,
            range: 5,
            shadows: false,
          },
        ],
        [Transform, { translation: run.at }],
      )
    } else if (run.kind === 'particle-burst') {
      const effects = world.tryResource(ParticleEffects)
      if (!effects) {
        this.warnOnce(
          'particles',
          'dice/feature-missing',
          'A dice particle burst needs particlesPlugin; it was skipped.',
        )
        return
      }
      const colors = e.colors.length > 0 ? e.colors : [e.color]
      const seconds = e.durationMs / 1000
      const effect = ParticleEffect.fromJson({
        emitters: [
          {
            name: 'burst',
            capacity: 32,
            spawn: { rate: 0, bursts: [{ time: 0, count: Math.min(32, e.count) }] },
            shape: { type: 'sphere', radius: 0.15 },
            init: {
              lifetime: [seconds * 0.6, seconds],
              speed: [0.8, 1.9],
              size: [0.03, 0.07],
              color: colors[0],
            },
            update: [
              { module: 'gravity', acceleration: [0, -0.9, 0] },
              { module: 'drag', coefficient: 0.6 },
              {
                module: 'color-over-life',
                gradient: colors
                  .map((c, k) => [
                    colors.length === 1 ? 0 : k / (colors.length - 1),
                    c,
                    1 - (k / colors.length) * 0.5,
                  ])
                  .concat([[1, colors[colors.length - 1]!, 0]]),
              },
            ],
            render: { blend: 'additive', emissive: 30_000 },
          },
        ],
      })
      run.entity = world.spawn(
        [
          ParticleSystem,
          {
            effect: effects.add(effect) as never,
            seed: hashString(`${p.roll.id}:burst`),
            backend: 'cpu',
          },
        ],
        [Transform, { translation: run.at }],
      )
    }
  }

  private accent(p: Presentation, now: number): void {
    const world = this.world
    for (const run of p.runs) {
      const t = Math.min(1, (now - run.started) / Math.max(1, run.effect.durationMs))
      const envelope = Math.sin(Math.PI * Math.max(0, Math.min(1, t)))
      if (run.kind === 'light-pulse' && run.entity !== undefined && world.isAlive(run.entity)) {
        world.set(run.entity, PointLight, { intensity: envelope * run.effect.intensity * 180 })
      } else if (run.kind === 'lens-pulse' && p.lens && t < 1) {
        if (screenOf(world, this.camera, run.at[0], 0.4, run.at[2], SCREEN)) {
          publishLensField(world, {
            screen: [SCREEN[0]!, SCREEN[1]!],
            radius: run.effect.radius,
            strength: run.effect.strength * envelope,
            ttlMs: 120,
            source: run.source,
          })
        }
      }
    }
  }

  // --- attachments ------------------------------------------------------------------------------

  private attach(p: Presentation, effect: DiceEffect, die: number, now: number): void {
    if (!p.attachments) return
    const d = p.dice[die]!
    if (d.dropped) return
    if (p.live.length >= MAX_ATTACHMENTS) return
    const name = effect.attachment
    const def = findDiceAttachment(name)
    if (!def) {
      this.warnOnce(
        `attachment:${name}`,
        'dice/unknown-attachment',
        `No dice attachment "${name}"; a recipe names it.`,
      )
      return
    }
    const world = this.world
    const params = (effect.params as Record<string, unknown> | null) ?? {}
    const ctx: DiceAttachmentContext = this.sceneContext(p, die, params)
    const entities = def.spawn(ctx)
    // Held to what it declared.
    if (meshVertices(world, entities) > def.vertices) {
      for (const e of entities) if (world.isAlive(e)) world.despawn(e)
      this.warnOnce(
        `attachment-budget:${name}`,
        'dice/attachment-budget',
        `Attachment "${name}" spawned more than its ${def.vertices} vertices; it was ended.`,
      )
      return
    }
    p.live.push({ name, die, entities, started: now, ctx, update: def.update })
    if (def.update) world.resource(FrameDemand).hold(ATTACHMENT_DEMAND)
  }

  /**
   * What a scene on a die can reach and do (attachments, and entrances, 0065): the die, the camera,
   * its screen point, lens fields and screen effects on it, sound at the roll's gain.
   */
  private sceneContext(
    p: Presentation,
    die: number,
    params: Record<string, unknown>,
  ): DiceSceneContext {
    const world = this.world
    const entity = p.entities[die]!
    const d = p.dice[die]!
    const where = (at: ArrayLike<number> | undefined) =>
      at ?? world.get(entity, Transform).translation
    return {
      world,
      die: entity,
      kind: d.kind,
      value: d.rolled,
      label: d.label,
      scale: d.scale,
      params,
      camera: this.camera,
      seed: hashString(`${p.roll.seed ?? p.roll.id}:scene:${die}`),
      soundGain: p.soundGain,
      screen: (point) => {
        const t = where(point)
        return screenOf(world, this.camera, t[0]!, t[1]!, t[2]!, SCREEN)
          ? [SCREEN[0]!, SCREEN[1]!]
          : null
      },
      lens: (field) => {
        if (!p.lens || p.done) return false
        const t = world.get(entity, Transform).translation
        if (!screenOf(world, this.camera, t[0]!, t[1]!, t[2]!, SCREEN)) return false
        return publishLensField(world, {
          screen: [SCREEN[0]!, SCREEN[1]!],
          radius: field.radius,
          strength: field.strength,
          ttlMs: field.ttlMs ?? 250,
          source: entity,
        })
      },
      effect: (e) => {
        if (!p.lens || p.done) return false
        const t = where(e.at)
        if (!screenOf(world, this.camera, t[0]!, t[1]!, t[2]!, SCREEN)) return false
        return publishScreenEffect(world, {
          kind: e.kind,
          screen: [SCREEN[0]!, SCREEN[1]!],
          radius: e.radius,
          ttlMs: e.ttlMs ?? 250,
          source: entity,
          params: e.params ?? {},
        })
      },
      sound: (clip, options = {}) => {
        if (p.done || p.soundGain <= 0 || !world.tryResource(AudioState)) return -1
        const g = p.soundGain
        const v = options.volume ?? 1
        const volume = typeof v === 'number' ? v * g : ([v[0] * g, v[1] * g] as const)
        const voice = playSound(world, clip, { ...options, volume })
        p.voices.push(voice)
        return voice
      },
      cue: (cue, gain = 1) => {
        if (!p.done) this.accentSound(p, cue, gain)
      },
    }
  }

  private attachmentsFrame(p: Presentation, now: number): void {
    if (p.live.length === 0) return
    const world = this.world
    for (let k = p.live.length - 1; k >= 0; k--) {
      const a = p.live[k]!
      if (!a.update) continue
      if (a.update(a.ctx, (now - a.started) / 1000, a.entities) === false) {
        for (const e of a.entities) if (world.isAlive(e)) world.despawn(e)
        clearLensFields(world, p.entities[a.die]!)
        p.live.splice(k, 1)
      }
    }
    if (!p.live.some((a) => a.update)) world.resource(FrameDemand).release(ATTACHMENT_DEMAND)
  }

  // --- entrances (0065) ---------------------------------------------------------------------------

  /**
   * Lands every entrance still to come or playing, now: each die snaps to its rest pose, and scenes
   * get 400 ms to wind down (`ctx.skipped`). False when no entrance is left to skip.
   */
  skip(): boolean {
    const p = this.current
    if (!p || p.done) return false
    const now = this.options.now()
    const left = p.entrances.filter((r) => r.state === 'waiting' || r.state === 'playing')
    if (left.length === 0) return false
    for (const run of left) {
      run.skipped = true
      run.windDownUntil = now + SKIP_WIND_DOWN_MS
    }
    for (const run of left) {
      if (run.state === 'waiting') {
        run.state = 'playing'
        run.started = now
      }
      this.landEntrance(p, run, now)
    }
    return true
  }

  private entranceUnavailable(name: string, why: string): void {
    this.warnOnce(
      `entrance:${name}`,
      'dice/entrance-unavailable',
      `Entrance "${name}" can't play (${why}); its die drops into its spot instead.`,
    )
  }

  /** While the physics records: the entrance's assets, then its scene drawn once. */
  private async readyEntrance(p: Presentation, run: EntranceRun): Promise<void> {
    const def = run.def
    if (!def) return
    try {
      const assets = def.assets ?? []
      if (assets.length > 0) await Promise.all(assets.map((r) => assetServer(this.world).load(r)))
      if (p.done) return
      await this.warmEntrance(p, run, def)
    } catch (err) {
      if (p.done) return
      run.fallback ??= 'assets failed'
      this.entranceUnavailable(run.name, `its assets failed: ${(err as Error).message}`)
    }
    run.ready = true
  }

  /**
   * Draws an entrance's scene once, away from everything, to an offscreen target on the app's
   * device (as thumbnails are), so its uploads are done and its pipelines compiled before it plays.
   * The warm copy's lens fields, screen effects and sounds go nowhere.
   */
  private async warmEntrance(
    p: Presentation,
    run: EntranceRun,
    def: DiceEntranceDef,
  ): Promise<void> {
    const world = this.world
    const d = p.dice[run.die]!
    const entry = p.entries[run.die]!
    const g = dieGeometry(requireDie(d.definition))
    const rotation = restRotation(g, d.value)
    const x = 30_000 + (warmSlot++ % 16) * 50
    const rest = {
      position: [x, restingHeight(g, rotation, d.scale), 0] as [number, number, number],
      rotation: [rotation[0], rotation[1], rotation[2], rotation[3]] as [
        number,
        number,
        number,
        number,
      ],
    }
    const target = new OffscreenTarget(world.resource(Gpu), {
      label: 'dice-entrance-warm',
      width: 64,
      height: 64,
    })
    const targetRef = world
      .resource(RenderTargets)
      .add(target, `dice:warm/${x}`) as AssetRef<'RenderTarget'>
    const material = this.resources.material(entry, {
      blended: p.blended[run.die]!,
      dropped: false,
      entrance: run.die,
    })
    const s = d.scale
    const die = world.spawn(
      [Mesh3d, { mesh: entry.mesh }],
      [MeshMaterial, { material }],
      [Transform, { translation: rest.position, rotation: rest.rotation, scale: [s, s, s] }],
      [InstanceData, { x: d.value, y: 0 }],
    )
    // Looking down on it as the dice camera does, far enough to take in a scene around it.
    const eye: [number, number, number] = [x, rest.position[1] + 30 * s, 0]
    const camera = world.spawn(
      [Camera3d, { fovY: 35, clearColor: [0, 0, 0, 0], target: targetRef, order: 49 }],
      [Exposure, { ev100: 13 }],
      [Transform, { translation: eye, rotation: lookAt(eye, rest.position, [0, 0, -1]) }],
    )
    const env = world.tryGet(this.camera, EnvironmentMap)
    if (env) world.add(camera, EnvironmentMap, { texture: env.texture, intensity: env.intensity })
    let entities: Entity[] = []
    try {
      const ctx = this.entranceContext(p, run, die, camera, rest, false)
      entities = def.spawn(ctx)
      if (meshVertices(world, entities) > def.vertices) {
        run.fallback = 'over budget'
        this.warnOnce(
          `entrance-budget:${run.name}`,
          'dice/entrance-budget',
          `Entrance "${run.name}" spawned more than its ${def.vertices} vertices; its die drops in instead.`,
        )
        return
      }
      def.update?.(ctx, 0, entities)
      // Complete frames of it: drawn, no draw skipped (for an upload, a shader still linking or a
      // pipeline compiling), nothing compiling. Three in a row: new entities upload in their first
      // frame and draw from the next, compiling as they do. `skipped` counts the whole last frame,
      // which drew this view: skips elsewhere only make it wait longer.
      const view = `camera:${camera}`
      const pipelines = world.resource(Gpu).pipelines
      let complete = 0
      for (let i = 0; i < 240 && !p.done && complete < 3; i++) {
        await captureView(world, view)
        const stats = world.resource(RenderStats).get(view)
        const done =
          stats &&
          stats.drawCalls > 0 &&
          stats.pending === 0 &&
          pipelines.pending === 0 &&
          pipelines.skipped === 0
        complete = done ? complete + 1 : 0
        if (!done) await pipelines.whenIdle()
      }
    } finally {
      for (const e of entities) if (world.isAlive(e)) world.despawn(e)
      world.despawn(die)
      world.despawn(camera)
      world.resource(RenderTargets).delete(targetRef.guid!)
      target.destroy()
    }
  }

  /** An entrance's context: live on its die, or (warming up) on a stand-in, going nowhere. */
  private entranceContext(
    p: Presentation,
    run: EntranceRun,
    die: Entity,
    camera: Entity,
    rest: EntranceRun['rest'],
    live: boolean,
  ): DiceEntranceContext {
    const world = this.world
    const base = this.sceneContext(p, run.die, run.params)
    const s = p.dice[run.die]!.scale
    return {
      ...base,
      die,
      camera,
      screen: live ? base.screen : () => null,
      lens: live ? base.lens : () => false,
      effect: live ? base.effect : () => false,
      sound: live ? base.sound : () => -1,
      cue: live ? base.cue : () => {},
      rest,
      landAt: (run.def?.landAtMs ?? 0) / 1000,
      get skipped() {
        return run.skipped
      },
      pose: (position, rotation, scale) => {
        if (live && run.state !== 'playing') return
        const table = world.entityTableUnchecked(die)
        const row = world.entityRowUnchecked(die)
        const tr = table.column(Transform, 'translation')
        const rt = table.column(Transform, 'rotation')
        const sc = table.column(Transform, 'scale')
        for (let k = 0; k < 3; k++) tr[row * 3 + k] = position[k]!
        for (let k = 0; k < 4; k++) rt[row * 4 + k] = rotation[k]!
        const z = scale ?? s
        for (let k = 0; k < 3; k++) sc[row * 3 + k] = z
        table.markChanged(Transform, row)
      },
      show: (visible) => {
        if (live && run.state !== 'playing') return
        world.set(die, Visibility, { mode: visible ? 'visible' : 'hidden' })
      },
      material: (fields) => {
        for (const key of Object.keys(fields)) {
          if (key in DICE_FIELDS || key === 'alphaMode') {
            throw new ShardError(
              'dice/reserved-param',
              `An entrance can't set the dice field "${key}"`,
              {
                path: key,
                hint: "Set the family's own fields; the table sets the dice fields.",
              },
            )
          }
        }
        if (run.material) world.resource(Materials).get(run.material)?.set(fields)
      },
    }
  }

  /** Starts the next entrance whose turn it is; with every die down, the accent (or the rest). */
  private nextEntrance(p: Presentation, now: number): void {
    for (const run of p.entrances) {
      if (run.state === 'playing') return
      if (run.state === 'waiting') {
        this.startEntrance(p, run, now)
        return
      }
    }
    if (p.phase === 'entrance') this.afterLanding(p, now)
  }

  private startEntrance(p: Presentation, run: EntranceRun, now: number): void {
    // Its assets (and warm-up) have until ENTRANCE_WAIT_MS past the physics.
    if (!run.ready && !run.skipped) {
      const wait = this.options.entranceWaitMs
      if (now < p.readyAt + wait) return
      run.fallback ??= 'assets late'
      this.entranceUnavailable(
        run.name,
        `it wasn't ready ${this.options.entranceWaitMs} ms after the physics`,
      )
    }
    run.state = 'playing'
    run.started = now
    const def = run.def
    if (run.skipped || run.fallback || !def) {
      if (!run.skipped) this.world.set(p.entities[run.die]!, Visibility, { mode: 'visible' })
      return
    }
    const world = this.world
    run.ctx = this.entranceContext(p, run, p.entities[run.die]!, this.camera, run.rest, true)
    run.entities = def.spawn(run.ctx)
    if (meshVertices(world, run.entities) > def.vertices) {
      for (const e of run.entities) if (world.isAlive(e)) world.despawn(e)
      run.entities = []
      run.ctx = undefined
      run.fallback = 'over budget'
      this.warnOnce(
        `entrance-budget:${run.name}`,
        'dice/entrance-budget',
        `Entrance "${run.name}" spawned more than its ${def.vertices} vertices; its die drops in instead.`,
      )
      world.set(p.entities[run.die]!, Visibility, { mode: 'visible' })
    }
  }

  /** Each frame while an entrance is alive: scenes, the die's landing, its result ramp. */
  private entrancesFrame(p: Presentation, now: number): void {
    const world = this.world
    if (p.phase === 'entrance' && !p.entrances.some((r) => r.state === 'playing'))
      this.nextEntrance(p, now)
    for (const run of p.entrances) {
      if (run.state === 'done' || run.state === 'waiting') continue
      const ms = now - run.started
      const def = run.def
      const scene = run.ctx !== undefined && def !== undefined
      if (run.state === 'playing') {
        if (!scene) {
          // The placed drop (0054): straight down into its spot.
          const t = run.skipped ? 1 : Math.min(1, ms / ENTRANCE_DROP_MS)
          this.dropPose(p, run, t)
          if (t >= 1) this.landEntrance(p, run, now)
        } else if (run.skipped || ms >= def.landAtMs) this.landEntrance(p, run, now)
      }
      let over = true
      if (scene) {
        const keep = def.update ? def.update(run.ctx!, ms / 1000, run.entities) !== false : true
        over = !keep || ms >= def.durationMs || now >= run.windDownUntil
        // A scene that ends before its landing lands its die as it ends.
        if (over && run.state === 'playing') this.landEntrance(p, run, now)
      }
      if (run.state === 'landed') {
        const t = Math.min(1, (now - run.landedAt) / RESULT_RAMP_MS)
        if (run.material) world.resource(Materials).get(run.material)?.set({ result: t })
        if (over && t >= 1) this.endEntrance(run)
      }
    }
    // Frames stop being held the frame the last scene ends.
    let alive = false
    for (const run of p.entrances) if (run.state !== 'done') alive = true
    if (!alive) world.resource(FrameDemand).release(ENTRANCE_DEMAND)
  }

  /** The placed drop, t from 0 to 1: from above its spot down onto it, easing in. */
  private dropPose(p: Presentation, run: EntranceRun, t: number): void {
    const world = this.world
    const e = p.entities[run.die]!
    const table = world.entityTableUnchecked(e)
    const row = world.entityRowUnchecked(e)
    const tr = table.column(Transform, 'translation')
    const rt = table.column(Transform, 'rotation')
    const fall = (1 - t * t) * 2.2 * p.dice[run.die]!.scale
    tr[row * 3] = run.rest.position[0]
    tr[row * 3 + 1] = run.rest.position[1] + fall
    tr[row * 3 + 2] = run.rest.position[2]
    for (let k = 0; k < 4; k++) rt[row * 4 + k] = run.rest.rotation[k]!
    table.markChanged(Transform, row)
  }

  /**
   * The die lands: its rest pose, shown, its result from now (its own material), its impact, and
   * the effects of the recipe that chose it, on it. Then the next entrance's turn.
   */
  private landEntrance(p: Presentation, run: EntranceRun, now: number): void {
    if (run.state !== 'playing') return
    const world = this.world
    run.state = 'landed'
    run.landedAt = now
    const e = p.entities[run.die]!
    const s = p.dice[run.die]!.scale
    world.set(e, Transform, {
      translation: run.rest.position,
      rotation: run.rest.rotation,
      scale: [s, s, s],
    })
    world.set(e, Visibility, { mode: 'visible' })
    if (run.material) {
      world
        .resource(Materials)
        .get(run.material)
        ?.set({ result: 0, resultTime: world.resource(Time).elapsed })
    }
    this.entranceImpact(p, run)
    p.playedRecipes.add(run.recipe.recipe.id)
    if (p.effects) this.playRecipe(p, run.recipe, [run.die], now, DiceTableState.budget())
    if (p.phase === 'entrance') this.nextEntrance(p, now)
  }

  /** The skin's impact as the die lands, as hard as the entrance says (default 0.8). */
  private entranceImpact(p: Presentation, run: EntranceRun): void {
    const strength = run.def?.impact ?? 0.8
    if (strength <= 0 || p.soundGain <= 0 || !this.world.tryResource(AudioState)) return
    const variation = ((p.soundSeed ^ Math.imul(run.die + 7, 0x9e3779b1)) >>> 0) % IMPACT_VARIATIONS
    const clip = this.sounds.impact(
      p.skins[run.die]!.sounds.impact,
      'tray',
      impactLayer(strength),
      variation,
    )
    const level = strength ** 1.5 * 0.24 * p.soundGain
    const pitch = p.pitch[run.die] ?? 1
    p.voices.push(
      playSound(this.world, clip, {
        volume: [level * 0.8, level],
        pitch: [pitch * 0.94, pitch * 1.06],
      }),
    )
  }

  private endEntrance(run: EntranceRun): void {
    run.state = 'done'
    for (const e of run.entities) if (this.world.isAlive(e)) this.world.despawn(e)
    run.entities = []
  }

  // --- the end --------------------------------------------------------------------------------------

  private fail(p: Presentation, err: unknown): void {
    this.lastError =
      err instanceof ShardError
        ? err
        : new ShardError('dice/failed', err instanceof Error ? err.message : String(err), {
            cause: err,
          })
    this.world.tryResource(LogResource)?.error(this.lastError)
    this.finish(p, 'failed')
  }

  /** Ends a presentation: despawns what it spawned, lets go of frames, sounds and resources. */
  private finish(p: Presentation, outcome: DiceOutcome): void {
    if (p.done) return
    p.done = true
    p.unlisten?.()
    p.abort.abort()
    const world = this.world
    const now = this.options.now()
    {
      for (const a of p.live) for (const e of a.entities) if (world.isAlive(e)) world.despawn(e)
      for (const run of p.entrances)
        for (const e of run.entities) if (world.isAlive(e)) world.despawn(e)
      for (const run of p.runs)
        if (run.entity !== undefined && world.isAlive(run.entity)) world.despawn(run.entity)
      if (world.hasResource(LensFields)) for (const e of p.entities) clearLensFields(world, e)
      if (world.hasResource(ScreenEffects)) for (const e of p.entities) clearScreenEffects(world, e)
      for (const e of p.entities) if (world.isAlive(e)) world.despawn(e)
      for (const e of p.blobs) if (e >= 0 && world.isAlive(e)) world.despawn(e)
      if (p.shadowsBefore && world.isAlive(this.light)) {
        world.set(this.light, DirectionalLight, { shadows: true })
      }
      // Ended mid-crossfade: the tray gets its full shadow back.
      if (!Number.isNaN(p.trayShadow)) {
        world.resource(Materials).get(this.trayMaterial!)?.set({ shadowOpacity: p.trayShadow })
      }
      if (world.tryResource(AudioState)) for (const v of p.voices) stopSound(world, v)
      const demand = world.resource(FrameDemand)
      demand.release(PRESENTATION_DEMAND)
      demand.release(ATTACHMENT_DEMAND)
      demand.release(ANIMATED_DEMAND)
      demand.release(ENTRANCE_DEMAND)
    }
    for (const entry of p.entries) this.resources.release(entry, now)
    if (p.entries.length > 0) world.resource(FrameDemand).after(RELEASE_AFTER_MS + 16)
    p.live.length = 0
    p.runs.length = 0
    p.phase = 'idle'
    if (this.current === p) this.current = undefined
    p.resolve(outcome)
  }

  private warnOnce(key: string, code: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.world.tryResource(LogResource)?.log('warn', message, { code })
  }

  // --- the camera -------------------------------------------------------------------------------

  /** The dice view's aspect: its camera's target, or the window. */
  aspect(): number {
    const cam = this.world.resource(Cameras).get(this.camera)
    if (cam && cam.displayHeight > 0) return cam.displayWidth / cam.displayHeight
    const window = this.world.tryResource(Window)
    return window && window.height > 0 ? window.width / window.height : 16 / 9
  }

  /** The tray the camera frames: the roll's, or the viewport's while idle. */
  private fitCamera(): void {
    const world = this.world
    if (!world.isAlive(this.camera)) return
    const aspect = this.aspect()
    const f = this.fitted
    const tray = this.current?.tray
    if (
      Math.abs(f.aspect - aspect) < 1e-4 &&
      (tray ? f.halfWidth === tray.halfWidth && f.halfDepth === tray.halfDepth : f.halfWidth === 0)
    )
      return
    const fit = tray ?? viewportTray(aspect)
    f.aspect = aspect
    // Idle, the camera frames the viewport's tray; 0 marks that.
    f.halfWidth = tray ? tray.halfWidth : 0
    f.halfDepth = tray ? tray.halfDepth : 0
    const cam = world.get(this.camera, Transform)
    const fov = (this.fovY() * Math.PI) / 180 / 2
    const tan = Math.tan(fov)
    const h = Math.max(fit.halfDepth / tan, fit.halfWidth / (tan * aspect)) * 1.12 + 1.2
    world.set(this.camera, Transform, {
      translation: [cam.translation[0]!, h, cam.translation[2]!],
    })
    if (world.isAlive(this.floor)) {
      world.set(this.floor, Transform, { scale: [fit.halfWidth * 1.4, 1, fit.halfDepth * 1.4] })
    }
  }

  private fovY(): number {
    return this.options.fovY
  }

  /** The GPU device was lost: a playing roll fails (it would show nothing), fields cleared. */
  deviceLost(message: string): void {
    if (!this.current) return
    this.fail(
      this.current,
      new ShardError('dice/device-lost', `The GPU device was lost mid-roll: ${message}`, {
        hint: 'The renderer recreates the device; roll again.',
      }),
    )
  }

  // --- teardown and inspection --------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return
    if (this.current) this.finish(this.current, 'dismissed')
    this.disposed = true
    this.client?.dispose()
    this.resources.dispose()
  }

  describe(): Record<string, unknown> {
    const world = this.world
    const p = this.current
    const track = p?.track
    const stats = world.tryResource(RenderStats)?.get(`camera:${this.camera}`)
    const gpu = world.tryResource(Gpu)
    const fields = world.tryResource(LensFields)?.fields ?? []
    const mine = new Set<number>(p?.entities ?? [])
    return {
      phase: this.phase,
      quality: p ? p.quality : null,
      motion: p ? (p.reduced ? 'reduced' : 'full') : null,
      effects: p ? p.effects : null,
      // Animated families: the rate their dice keep frames coming at while shown.
      animated: p && p.fps > 0 && !p.reduced ? (Number.isFinite(p.fps) ? p.fps : 'display') : null,
      roll: p ? { id: p.roll.id, seed: p.roll.seed ?? p.roll.id, tray: p.tray } : null,
      dice: (p?.dice ?? []).map((d, i) => ({
        index: i,
        kind: d.kind,
        definition: d.definition,
        value: d.value,
        label: d.label,
        natural: p?.natural[i] ?? null,
        // What's on top right now, read from the die as drawn.
        shown:
          p && p.entities[i] !== undefined && world.isAlive(p.entities[i]!)
            ? naturalValue(this.geometryOf(d), world.get(p.entities[i]!, Transform).rotation)
            : null,
        correction:
          p && p.corrections.length > i * 4
            ? Array.from(p.corrections.subarray(i * 4, i * 4 + 4))
            : null,
        placed: p?.placed[i] ?? null,
        dropped: d.dropped,
        scale: d.scale,
        skin: d.skin.guid ?? d.skin.path ?? null,
        entity: p?.entities[i] ?? null,
      })),
      track: track
        ? {
            hash: p!.hash!.toString(16).padStart(8, '0'),
            sceneHash: track.sceneHash.toString(16).padStart(8, '0'),
            steps: track.steps,
            // The dice in the physics (entrance dice are not, 0065).
            bodies: track.bodyCount,
            settled: track.settled,
            maxStepsHit: track.maxStepsHit,
            simulationMs: Math.round(track.simulationMs * 10) / 10,
            contacts: track.contacts.steps.length,
            time: p!.time,
          }
        : null,
      placed: (p?.placed ?? []).flatMap((r, i) => (r ? [{ index: i, reason: r }] : [])),
      recipes: (p?.matched ?? []).map((m) => ({ id: m.recipe.id, anchors: m.anchors })),
      recipesDegraded: p?.degraded ?? false,
      drawCalls: stats?.drawCalls ?? null,
      attachments: (p?.live ?? []).map((a) => ({
        name: a.name,
        die: a.die,
        entities: a.entities.length,
      })),
      lensFields: fields
        .filter((f) => mine.has(f.source))
        .map((f) => ({ ...f, screen: [...f.screen] })),
      // Entrances (0065): each playing die's scene, and matches that didn't play, with why.
      entrances: (p?.entrances ?? []).map((r) => ({
        name: r.name,
        die: r.die,
        state: r.state,
        ready: r.ready,
        seconds: Number.isNaN(r.started) ? null : (this.options.now() - r.started) / 1000,
        landAtMs: r.def?.landAtMs ?? null,
        durationMs: r.def?.durationMs ?? null,
        rest: r.rest,
        fallback: r.fallback,
        skipped: r.skipped,
      })),
      entranceSkips: p?.entranceSkips ?? [],
      screenEffects: (world.tryResource(ScreenEffects)?.effects ?? [])
        .filter((e) => mine.has(e.source))
        .map((e) => ({ ...e, screen: [...e.screen] })),
      resources: { ...this.resources.stats(), list: this.resources.describe() },
      gpu: gpu ? gpu.stats(renderOwner(world)) : null,
      worker: { recordings: this.recordings, spawns: this.client?.spawns ?? 0 },
      lastError: this.lastError
        ? {
            code: this.lastError.code,
            message: this.lastError.message,
            path: this.lastError.path ?? null,
          }
        : null,
    }
  }
}

/** The dice table: `world.resource(DiceTable).play(roll)`. */
export const DiceTable = defineResource<DiceTableState>('dice/DiceTable', {
  description:
    'The dice table (0054): play(roll, { signal, replace }), dismiss(), shortenRest(ms), preview(roll), phase, lastError, describe().',
})
