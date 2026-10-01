import { ShardError, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { DevMode, LogResource } from '@aethervtt/shard-runtime'
import { FORMAT_INFO, Texture } from '@aethervtt/shard-texture'
import type { GpuTexture } from '../gpu-assets'

// Baseline tier (0064), loaded only on a baseline device: a texture has one format and one binding
// dimension (compatibility mode and WebGL2 can't reinterpret either). The primary copy takes its
// format from the import usage (`color` sRGB, everything else linear) and its dimension from its
// shape; a slot that reads it the other way gets a twin, made when a material binds it:
//
// - from the CPU bytes, while they're kept (textures made in code; imported ones until the end of
//   the frame they uploaded in);
// - otherwise from the reloaded artifact, the path device-loss recovery uses: until it's ready the
//   slot shows its loading fallback, never the primary in the wrong color space.

/** What a baseline texture asks of the asset layer that owns it. */
export interface TwinHost {
  readonly gpu: GpuContext
  /** Reload the texture's artifact (its bytes come back, and its version bumps). */
  reload(texture: Texture): void
  /** The loading fallback's view of this kind, shown while a twin waits. */
  fallback(srgb: boolean, array: boolean): GPUTextureView
  /** A twin started waiting for its bytes (`ready` false), or was made (`ready` true). */
  twin(texture: Texture, kind: string, ready: boolean): void
  /** Development builds: the texture's usage doesn't match the slot reading it. */
  mismatch(texture: Texture, kind: string): void
}

/** A twin that waited for its bytes: which texture and view, and how long it took. */
export interface TwinWait {
  texture: string
  kind: string
  since: number
  ms: number | undefined
}

/** What the asset layer lends its baseline textures. */
export interface TwinSource {
  readonly gpu: GpuContext
  readonly world: World | undefined
  /** The asset guid of an imported texture. */
  guidOf(texture: Texture): string | undefined
  /** Reloads the texture's artifact, once at a time. */
  reload(texture: Texture): void
  /** The loading fallback: a solid white texture. */
  white(): GpuTexture
}

/**
 * The twin bookkeeping of one asset layer: reloads, the loading fallback, the waits
 * `render.describe` lists, and the dev-build `render/texture-color-space-mismatch` log.
 */
export class Twins implements TwinHost {
  readonly gpu: GpuContext
  /** Pending twins, and the last 32 finished. */
  readonly waits: TwinWait[] = []
  private readonly source: TwinSource
  private readonly mismatched = new Set<string>()

  constructor(source: TwinSource) {
    this.source = source
    this.gpu = source.gpu
  }

  reload(texture: Texture): void {
    this.source.reload(texture)
  }

  fallback(srgb: boolean, array: boolean): GPUTextureView {
    const white = this.source.white()
    return (
      array ? (srgb ? white.arraySrgb : white.arrayLinear) : srgb ? white.srgb : white.linear
    )!
  }

  twin(texture: Texture, kind: string, ready: boolean): void {
    const name = this.source.guidOf(texture) ?? texture.format
    const waits = this.waits
    const i = waits.findIndex((w) => w.texture === name && w.kind === kind && w.ms === undefined)
    if (!ready) {
      if (i === -1) waits.push({ texture: name, kind, since: performance.now(), ms: undefined })
    } else if (i !== -1) {
      waits[i]!.ms = performance.now() - waits[i]!.since
    } else if (waits.length < 256) {
      waits.push({ texture: name, kind, since: performance.now(), ms: 0 })
    }
    // The finished ones kept are the last 32.
    while (waits.filter((w) => w.ms !== undefined).length > 32) {
      waits.splice(
        waits.findIndex((w) => w.ms !== undefined),
        1,
      )
    }
  }

  mismatch(texture: Texture, kind: string): void {
    const world = this.source.world
    if (!world?.tryResource(DevMode)?.enabled) return
    // Only imported textures: their .meta can fix it. Textures made in code (the engine's solid
    // defaults among them) twin quietly.
    const name = this.source.guidOf(texture)
    if (name === undefined || this.mismatched.has(`${name}|${kind}`)) return
    this.mismatched.add(`${name}|${kind}`)
    world
      .tryResource(LogResource)
      ?.error(
        new ShardError(
          'render/texture-color-space-mismatch',
          `A ${texture.usage} texture is read as ${kind.split('/')[0]}: the baseline tier keeps a second copy of it`,
          { path: name, hint: 'Set its usage to match the slot in its .meta, and the copy goes.' },
        ),
      )
  }

  /** `render.describe → twins`: pending twins with how long they've waited, and recent ones. */
  describe() {
    const now = performance.now()
    const pending: { texture: string; kind: string; waitedMs: number }[] = []
    const recent: { texture: string; kind: string; waitedMs: number }[] = []
    for (const w of this.waits) {
      if (w.ms === undefined)
        pending.push({ texture: w.texture, kind: w.kind, waitedMs: now - w.since })
      else recent.push({ texture: w.texture, kind: w.kind, waitedMs: w.ms })
    }
    return { pending, recent }
  }
}

const DIMENSION = { plain: '2d', array: '2d-array', cube: 'cube' } as const
const DIMENSIONS: readonly GPUTextureViewDimension[] = ['2d', '2d-array', 'cube']

/** A view's key: its color space and dimension (numbers, so a lookup allocates nothing). */
function keyOf(srgb: boolean, dimension: GPUTextureViewDimension): number {
  return (srgb ? 1 : 0) + DIMENSIONS.indexOf(dimension) * 2
}

/** The key as the name reports use: `srgb/2d`. */
function kindOf(key: number): string {
  return `${key & 1 ? 'srgb' : 'linear'}/${DIMENSIONS[key >> 1]}`
}

/** One texture in one format and dimension, with its levels uploaded. */
function create(
  gpu: GpuContext,
  texture: Texture,
  format: string,
  dimension: GPUTextureViewDimension,
): GPUTexture {
  const info = FORMAT_INFO[texture.format]
  const layers = texture.faces * texture.layers
  const handle = gpu.device.createTexture({
    label: `texture/${format}${dimension === '2d' ? '' : `/${dimension}`}`,
    size: { width: texture.width, height: texture.height, depthOrArrayLayers: layers },
    format: format as GPUTextureFormat,
    mipLevelCount: texture.mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    textureBindingViewDimension: dimension,
  })
  for (let level = 0; texture.levels && level < texture.mipCount; level++) {
    const w = Math.max(1, texture.width >> level)
    const h = Math.max(1, texture.height >> level)
    const blocksWide = Math.ceil(w / info.block)
    const blocksHigh = Math.ceil(h / info.block)
    gpu.device.queue.writeTexture(
      { texture: handle, mipLevel: level },
      texture.levels[level]! as Uint8Array<ArrayBuffer>,
      { bytesPerRow: blocksWide * info.bytes, rowsPerImage: blocksHigh },
      {
        width: blocksWide * info.block,
        height: blocksHigh * info.block,
        depthOrArrayLayers: layers,
      },
    )
  }
  return handle
}

/**
 * A texture on the baseline tier: the primary copy, and the twins slots asked for. The views are
 * getters, so a twin is made (or requested) only when something binds it.
 */
export class BaselineTexture implements GpuTexture {
  readonly texture: GPUTexture
  readonly version: number
  readonly generation: number
  bytes: number
  private readonly source: Texture
  private readonly host: TwinHost
  private readonly primarySrgb: boolean
  private readonly primaryDimension: GPUTextureViewDimension
  private readonly views = new Map<number, GPUTextureView>()
  private readonly pending = new Set<number>()
  /** Twins made, destroyed with the primary. */
  readonly twins: GPUTexture[] = []

  constructor(host: TwinHost, source: Texture) {
    this.host = host
    this.source = source
    this.version = source.version
    this.generation = host.gpu.generation
    this.bytes = source.byteSize
    const info = FORMAT_INFO[source.format]
    this.primarySrgb = source.usage === 'color' && info.srgbView !== undefined
    this.primaryDimension =
      source.faces === 6 ? DIMENSION.cube : source.layers > 1 ? DIMENSION.array : DIMENSION.plain
    const format = this.primarySrgb ? info.srgbView! : source.format
    this.texture = create(host.gpu, source, format, this.primaryDimension)
    this.views.set(
      keyOf(this.primarySrgb, this.primaryDimension),
      this.texture.createView({ dimension: this.primaryDimension }),
    )
  }

  get linear(): GPUTextureView {
    return this.view(false, false)
  }

  get srgb(): GPUTextureView {
    return this.view(true, false)
  }

  get arrayLinear(): GPUTextureView | undefined {
    return this.source.faces === 1 ? this.view(false, true) : undefined
  }

  get arraySrgb(): GPUTextureView | undefined {
    return this.source.faces === 1 ? this.view(true, true) : undefined
  }

  /** The primary and every twin. */
  destroy(): void {
    this.texture.destroy()
    for (const t of this.twins) t.destroy()
  }

  /**
   * Whether a slot reading it this way waits for a twin's bytes (and shows the loading fallback).
   * Asking requests the twin, as binding it would: material preparation asks for deferred draws.
   */
  waiting(wantSrgb: boolean, array: boolean): boolean {
    this.view(wantSrgb, array)
    return this.pending.has(this.keyFor(wantSrgb, array))
  }

  private keyFor(wantSrgb: boolean, array: boolean): number {
    // A format without an sRGB form reads the same either way (as the full tier's views do).
    const srgb = wantSrgb && FORMAT_INFO[this.source.format].srgbView !== undefined
    const dimension: GPUTextureViewDimension = array
      ? DIMENSION.array
      : this.primaryDimension === DIMENSION.array
        ? DIMENSION.array
        : this.primaryDimension
    return keyOf(srgb, dimension)
  }

  private view(wantSrgb: boolean, array: boolean): GPUTextureView {
    const key = this.keyFor(wantSrgb, array)
    const ready = this.views.get(key)
    if (ready) return ready
    const srgb = (key & 1) === 1
    const dimension = DIMENSIONS[key >> 1]!
    const info = FORMAT_INFO[this.source.format]
    if (srgb !== this.primarySrgb) this.host.mismatch(this.source, kindOf(key))
    if (!this.source.levels) {
      // The bytes went after upload: reload the artifact, and show the fallback meanwhile.
      if (!this.pending.has(key)) {
        this.pending.add(key)
        this.host.twin(this.source, kindOf(key), false)
        this.host.reload(this.source)
      }
      return this.host.fallback(srgb, dimension === DIMENSION.array)
    }
    const format = srgb ? info.srgbView! : this.source.format
    const twin = create(this.host.gpu, this.source, format, dimension)
    this.twins.push(twin)
    this.bytes += this.source.byteSize
    const view = twin.createView({ dimension })
    this.views.set(key, view)
    this.pending.delete(key)
    this.host.twin(this.source, kindOf(key), true)
    return view
  }
}

/** Solid 1×1 textures for empty slots, as baseline textures that keep their bytes. */
export function solidTexture(host: TwinHost, rgba: readonly number[]): BaselineTexture {
  const texture = Texture.create({
    width: 1,
    height: 1,
    mips: [new Uint8Array(rgba)],
    cpu: true,
    usage: 'data',
  })
  return new BaselineTexture(host, texture)
}
