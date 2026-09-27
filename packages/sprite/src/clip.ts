import {
  AssetStore,
  assetServer,
  defineAssetPreview,
  defineAssetType,
  defineDataAsset,
} from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineComponent,
  defineEvent,
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  ShardError,
  t,
} from '@aethervtt/shard-core'
import { LogResource, Time } from '@aethervtt/shard-runtime'
import { readKtx2 } from '@aethervtt/shard-texture'
import { TextureAtlas, TextureAtlases } from './atlas'
import { drawLabel, fitImage } from './preview'
import { Sprite } from './sprite'

export const CLIP_LOOPS = ['loop', 'once', 'ping-pong'] as const

export const SpriteClipSchema = defineSchema(
  'sprite/SpriteClip',
  {
    atlas: t.handle('TextureAtlas', { description: 'The atlas the frames come from.' }),
    frames: t.list(
      t.struct({
        region: t.string({ description: 'Atlas region name.' }),
        duration: t.f32({ default: 0.1, min: 0.001, unit: 's', description: 'How long it shows.' }),
      }),
      { description: 'Frames in order.' },
    ),
    loop: t.enum(CLIP_LOOPS, {
      description:
        'loop: from the start again; once: stop on the last frame; ping-pong: back and forth.',
    }),
    events: t.list(
      t.struct({
        frame: t.u32({ description: 'Frame index that sends it, when it starts showing.' }),
        name: t.string({ description: 'Event name, e.g. "footstep".' }),
      }),
      { description: 'Named events sent as SpriteAnimationEvent.' },
    ),
  },
  { description: 'A frame animation: atlas regions with durations, a loop mode, and events.' },
)

/** A frame animation over an atlas: regions, durations, loop mode, and named events. */
export class SpriteClip {
  atlas: AssetRef<'TextureAtlas'> | null
  regions: string[]
  /** Frame start times (s), plus the total at the end. */
  starts: Float64Array
  loop: (typeof CLIP_LOOPS)[number]
  /** Event names by frame. */
  events: Map<number, string[]>

  constructor(
    atlas: AssetRef<'TextureAtlas'> | null,
    frames: { region: string; duration: number }[],
    loop: (typeof CLIP_LOOPS)[number] = 'loop',
    events: { frame: number; name: string }[] = [],
  ) {
    this.atlas = atlas
    this.regions = frames.map((f) => f.region)
    this.starts = new Float64Array(frames.length + 1)
    for (let i = 0; i < frames.length; i++)
      this.starts[i + 1] = this.starts[i]! + frames[i]!.duration
    this.loop = loop
    this.events = new Map()
    for (const e of events) {
      const list = this.events.get(e.frame) ?? []
      list.push(e.name)
      this.events.set(e.frame, list)
    }
  }

  get duration(): number {
    return this.starts[this.regions.length]!
  }

  /**
   * The frame showing at `time` (seconds from the start). Ping-pong runs the frames forward, then
   * back over the inner ones, so the ends don't show twice.
   */
  frameAt(time: number): number {
    const n = this.regions.length
    if (n === 0) return -1
    const total = this.duration
    if (this.loop === 'once') return time >= total ? n - 1 : this.search(Math.max(0, time))
    if (this.loop === 'loop' || n < 3) return this.search(mod(time, total))
    const back = this.starts[n - 1]! - this.starts[1]!
    const t = mod(time, total + back)
    if (t < total) return this.search(t)
    let r = t - total
    for (let f = n - 2; f >= 1; f--) {
      const d = this.starts[f + 1]! - this.starts[f]!
      if (r < d) return f
      r -= d
    }
    return 1
  }

  /** Whether a `once` clip has played to its end at `time`. */
  ended(time: number): boolean {
    return this.loop === 'once' && time >= this.duration
  }

  private search(t: number): number {
    const n = this.regions.length
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid]! <= t) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  copyFrom(other: SpriteClip): void {
    this.atlas = other.atlas
    this.regions = other.regions
    this.starts = other.starts
    this.loop = other.loop
    this.events = other.events
  }
}

const mod = (a: number, b: number) => (b > 0 ? ((a % b) + b) % b : 0)

export class SpriteClipStore extends AssetStore<SpriteClip, 'SpriteClip'> {
  constructor() {
    super('SpriteClip')
  }
}

export const SpriteClips = defineResource<SpriteClipStore>('sprite/SpriteClips', {
  description: 'Loaded sprite animation clips by guid.',
  init: () => new SpriteClipStore(),
})

export const SpriteClipAssetType = defineAssetType<SpriteClip>('SpriteClip', {
  store: SpriteClips,
  load: (artifact, ctx) => {
    const v = SpriteClipSchema.deserialize(artifact.json) as unknown as {
      atlas: { path?: string; guid?: string } | null
      frames: { region: string; duration: number }[]
      loop: (typeof CLIP_LOOPS)[number]
      events: { frame: number; name: string }[]
    }
    const atlas = v.atlas?.path ? (ctx.resolve(v.atlas.path) ?? v.atlas) : v.atlas
    return new SpriteClip((atlas as AssetRef<'TextureAtlas'>) ?? null, v.frames, v.loop, v.events)
  },
  update: (existing, next) => existing.copyFrom(next),
})

/** `*.clip.json`: a frame animation over an atlas's regions. */
export const SpriteClipImporter = defineDataAsset('SpriteClip', SpriteClipSchema, {
  extension: 'clip',
})

export const SpriteAnimation = defineComponent(
  'sprite/SpriteAnimation',
  {
    clip: t.handle('SpriteClip', { description: 'The frame animation to play.' }),
    playing: t.bool({
      default: true,
      description: 'Advances each frame. A once clip clears it at its end.',
    }),
    speed: t.f32({
      default: 1,
      description: 'Playback rate: 2 is twice as fast, negative plays backward.',
    }),
    time: t.f32({ unit: 's', description: 'Position in the clip.' }),
  },
  {
    description:
      "Plays a SpriteClip on this entity's Sprite: sets its atlas and region each frame.",
    requires: [Sprite],
  },
)

export interface SpriteAnimationEventValue {
  entity: Entity
  /** The event's name from the clip. */
  name: string
  frame: number
}

export const SpriteAnimationEvent = defineEvent<SpriteAnimationEventValue>(
  'sprite/SpriteAnimationEvent',
  { description: 'A clip frame with an event started showing: { entity, name, frame }.' },
)

/**
 * Advances every SpriteAnimation, points its Sprite at the current frame's region, and sends the
 * events of frames it passes (all of them, even when a long step skips frames).
 */
export const animateSprites = defineSystem({
  name: 'sprite/animate',
  description: 'Plays sprite animation clips: time, frame, Sprite region, events.',
  setup: (world) => ({
    q: world.query({ with: [SpriteAnimation, Sprite] }),
    warned: new Set<string>(),
    // The last frame shown per entity, so events fire once per frame change.
    lastFrames: new Map<Entity, number>(),
  }),
  run: ({ q, warned, lastFrames }, world) => {
    const clips = world.resource(SpriteClips)
    const atlases = world.resource(TextureAtlases)
    const dt = world.resource(Time).delta
    for (const table of q.tables) {
      const clipRefs = table.column(SpriteAnimation, 'clip')
      const playing = table.column(SpriteAnimation, 'playing')
      const speed = table.column(SpriteAnimation, 'speed')
      const time = table.column(SpriteAnimation, 'time')
      const atlas = table.column(Sprite, 'atlas')
      const region = table.column(Sprite, 'region')
      for (let i = 0; i < table.count; i++) {
        const clip = clips.get(clipRefs[i])
        if (!clip || clip.regions.length === 0) continue
        const entity = table.entities[i]!
        const before = time[i]!
        if (playing[i]) {
          time[i] = before + dt * speed[i]!
          table.markChanged(SpriteAnimation, i)
        }
        const frame = clip.frameAt(time[i]!)
        if (playing[i] && clip.ended(time[i]!)) playing[i] = 0
        const previous = lastFrames.get(entity)
        if (previous !== frame) {
          // Every frame passed since last time, in playback order.
          if (clip.events.size > 0)
            sendPassed(world, clip, entity, previous, before, time[i]!, frame)
          lastFrames.set(entity, frame)
          const name = clip.regions[frame]!
          if (region[i] !== name || (clip.atlas && atlas[i]?.guid !== clip.atlas.guid)) {
            region[i] = name
            if (clip.atlas) atlas[i] = clip.atlas
            table.markChanged(Sprite, i)
          }
          const a = atlases.get(clip.atlas)
          if (a && a.region(name) < 0 && !warned.has(name)) {
            warned.add(name)
            world
              .tryResource(LogResource)
              ?.warn(`Sprite clip frame "${name}" isn't a region of its atlas`)
          }
        }
      }
    }
  },
})

function sendPassed(
  world: import('@aethervtt/shard-core').World,
  clip: SpriteClip,
  entity: Entity,
  previous: number | undefined,
  from: number,
  to: number,
  frame: number,
): void {
  const n = clip.regions.length
  if (previous === undefined || clip.loop === 'ping-pong' || n === 1) {
    for (const name of clip.events.get(frame) ?? []) {
      world.send(SpriteAnimationEvent, { entity, name, frame })
    }
    return
  }
  // Forward (or backward) through the frames between, wrapping for loops.
  const step = to >= from ? 1 : -1
  let f = previous
  for (let guard = 0; guard < n * 4 && f !== frame; guard++) {
    f = (((f + step) % n) + n) % n
    for (const name of clip.events.get(f) ?? []) {
      world.send(SpriteAnimationEvent, { entity, name, frame: f })
    }
  }
}

/** A clip's frames side by side, in order, each labeled with its index. */
export const spriteClipPreview = defineAssetPreview(
  'SpriteClip',
  async (world, path, width, height) => {
    const server = assetServer(world)
    const clip = SpriteClipSchema.deserialize((await server.artifact(path)).json) as unknown as {
      atlas: { path?: string } | null
      frames: { region: string }[]
    }
    const atlasPath = clip.atlas?.path
    if (!atlasPath)
      throw new ShardError('sprite/no-atlas', `${path} has no atlas`, { path: '/atlas' })
    const atlas = TextureAtlas.fromJson((await server.artifact(atlasPath)).json)
    const texturePath = atlas.texture?.path?.startsWith('#')
      ? `${atlasPath.split('#')[0]}${atlas.texture.path}`
      : atlas.texture?.path
    if (!texturePath) throw new ShardError('sprite/no-texture', `${atlasPath} has no texture`)
    const ktx = readKtx2((await server.artifact(texturePath)).bytes!)
    const src = ktx.levels[0]!
    // Frames in a row, each in a cell as big as the largest frame.
    const rects = clip.frames.map((f) => {
      const r = atlas.region(f.region)
      return r < 0 ? [0, 0, 1, 1] : [...atlas.rects.subarray(r * 4, r * 4 + 4)]
    })
    const cw = Math.max(1, ...rects.map((r) => r[2]!))
    const ch = Math.max(1, ...rects.map((r) => r[3]!))
    const sheetW = cw * rects.length
    const sheet = new Uint8Array(sheetW * ch * 4)
    rects.forEach(([x, y, w, h], k) => {
      for (let j = 0; j < h!; j++) {
        for (let i = 0; i < w!; i++) {
          const s = ((y! + j) * ktx.width + x! + i) * 4
          sheet.set(src.subarray(s, s + 4), (j * sheetW + k * cw + i) * 4)
        }
      }
    })
    const image = fitImage(sheet, sheetW, ch, width, height)
    const scale = image.width / sheetW
    for (let k = 0; k < rects.length; k++)
      drawLabel(image, String(k), Math.round(k * cw * scale) + 1, 1)
    return image
  },
)
