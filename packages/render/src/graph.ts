import {
  defineSpan,
  ProfilerResource,
  ShardError,
  type SpanDef,
  TRACK,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { flushDataStores } from './data-store'
import { unsupportedNodes } from './features'
import { TexturePool } from './pool'
import { BYTES_PER_TEXEL, toFloats } from './readback'
import type { RenderTarget } from './target'
import { GpuTimer } from './timer'

/** Each view's final output. Nodes that write it are what the graph exists to run. */
export const VIEW_TARGET = 'view-target'

type PerView<T> = T | ((view: RenderView) => T)

/** A per-frame texture the graph allocates from its pool. */
export interface TransientTexture {
  name: string
  /** A format, or 'view' for the view target's format (e.g. an MSAA color buffer). */
  format: PerView<GPUTextureFormat | 'view'>
  /** Pixel size, 'view' to match the view's target (the default), or a divisor of it. */
  size?: PerView<'view' | [number, number] | { divide: number }>
  sampleCount?: PerView<number>
  /** Default: RENDER_ATTACHMENT | TEXTURE_BINDING. */
  usage?: GPUTextureUsageFlags
  mipLevelCount?: PerView<number>
}

export type ResourceRef = string | TransientTexture

export interface ColorAttachment {
  resource: string
  /** Clears to this color (or a per-view color); omit to load existing contents. */
  clear?: GPUColor | ((view: RenderView) => GPUColor)
  /** Resolve target for MSAA. */
  resolve?: string
  /** Mip level of the attachment (default 0). */
  mip?: number
}

export interface DepthAttachment {
  resource: string
  /** Clears to this depth; omit to load. Reversed-Z renderers clear to 0. */
  clear?: number
  /** Depth is only tested, not written: the attachment is bound read-only. */
  readOnly?: boolean
}

export interface RenderView {
  /** Unique per frame, e.g. the camera entity or 'window'. */
  name: string
  target: RenderTarget
  /**
   * Render resolution (0051): the size of 'view'-sized textures when it differs from the target's.
   * `view-target` is always the target itself.
   */
  width?: number
  height?: number
  /** Lower renders first. */
  order: number
  /** Per-view data for nodes (camera matrices, etc.). */
  data: Record<string, unknown>
  /**
   * Resource names that are another resource in this view, e.g. `scene-color → hdr` when there's
   * no MSAA. Writing an alias writes its target.
   */
  aliases?: Readonly<Record<string, string>>
}

export interface NodeContext {
  readonly gpu: GpuContext
  readonly world: World
  readonly view: RenderView
  readonly encoder: GPUCommandEncoder
  /** Set for render nodes. */
  readonly renderPass: GPURenderPassEncoder | undefined
  /** Set for compute nodes. */
  readonly computePass: GPUComputePassEncoder | undefined
  texture(name: string): GPUTexture
  /**
   * Hands later nodes `texture` as resource `name` for the rest of this view's frame, instead of a
   * pooled one: a node that keeps its output across frames (TAA's history) writes it once.
   */
  provide(name: string, texture: GPUTexture): void
  /** Timestamp writes for a pass the node begins itself (raw nodes), labeled `name`. */
  timestamps(name: string): GPURenderPassTimestampWrites | undefined
  /** Runs after the frame's commands are submitted (e.g. to map a readback buffer). */
  afterSubmit(fn: () => void): void
}

export interface NodeDescriptor {
  kind: 'render' | 'compute' | 'raw'
  reads?: readonly string[]
  writes?: readonly ResourceRef[]
  /** Explicit ordering for side effects the resource lists don't capture. */
  after?: readonly string[]
  /**
   * Ordering among writers of the same resource, and among independent nodes: lower runs first.
   * Nodes in the same phase keep registration order. See `RenderPhase`.
   */
  phase?: number
  /** Runs even if nothing reads its outputs. */
  sideEffects?: boolean
  /**
   * Whether the node runs for a view (e.g. only when the camera has the effect's component).
   * Disabled nodes are removed before resolving, so what they fed is culled too.
   */
  enabled?: (view: RenderView) => boolean
  /** Render nodes: attachments, set up from resources. */
  color?: readonly ColorAttachment[] | ((view: RenderView) => readonly ColorAttachment[])
  depth?: DepthAttachment
  run(ctx: NodeContext): void
}

/** Standard phases, spaced so plugins can slot nodes in between. */
export const RenderPhase = {
  Setup: 0,
  Shadows: 100,
  Prepass: 200,
  Opaque: 300,
  Lighting: 350,
  Sky: 400,
  /** Coplanar ground bands (0057): after the sky, which draws where no depth was written. */
  Ground: 420,
  Sprites: 450,
  Transparent: 500,
  /** Projected fog's composite (0058): after transparent objects, before the overlay band. */
  Fog: 520,
  /** Ground bands from the overlay band up, over fog (0058). */
  Overlay3d: 530,
  Effects3d: 550,
  Resolve: 600,
  Post: 700,
  Tonemap: 900,
  Display: 950,
  Overlay: 1000,
  Debug: 1100,
} as const

export interface ResolvedGraph {
  order: string[]
  culled: string[]
}

export interface CapturedImage {
  width: number
  height: number
  /** RGBA8, row by row, no padding. */
  data: Uint8Array
}

/** A captured buffer of any format: floats, 4 channels per pixel (depth in R), row by row. */
export interface CapturedBuffer {
  width: number
  height: number
  format: GPUTextureFormat
  data: Float32Array
}

interface PendingCapture {
  view: string
  buffer: string
  resolve: (image: CapturedImage | CapturedBuffer) => void
  reject: (error: unknown) => void
}

const resourceName = (ref: ResourceRef) => (typeof ref === 'string' ? ref : ref.name)

function canonicalOf(aliases: Readonly<Record<string, string>> | undefined, name: string): string {
  if (!aliases) return name
  let n = name
  for (let i = 0; i < 8 && aliases[n] !== undefined; i++) n = aliases[n]!
  return n
}

function colorOf(node: NodeDescriptor, view: RenderView | undefined): readonly ColorAttachment[] {
  const c = node.color
  if (typeof c === 'function') return view ? c(view) : []
  return c ?? []
}

/**
 * Orders nodes from their resource dependencies and drops nodes whose outputs nothing needs.
 * Pure: no GPU involved, so it's testable on its own.
 *
 * Rules: writers of a resource run in phase order, then registration order; a reader runs after
 * the writers of what it reads in its own and earlier phases, and before writers in later phases;
 * `after` adds explicit edges. A node is needed if it writes an
 * output (the view target), has `sideEffects`, or writes something a needed node reads. `aliases`
 * maps resource names to the resource they really are for this view.
 */
export function resolveGraph(
  nodes: ReadonlyMap<string, NodeDescriptor>,
  outputs: ReadonlySet<string> = new Set([VIEW_TARGET]),
  options: { aliases?: Readonly<Record<string, string>>; view?: RenderView } = {},
): ResolvedGraph {
  const canon = (name: string) => canonicalOf(options.aliases, name)
  const registration = [...nodes.keys()]
  const rank = new Map(registration.map((n, i) => [n, i]))
  const names = [...registration].sort(
    (a, b) =>
      (nodes.get(a)!.phase ?? 0) - (nodes.get(b)!.phase ?? 0) || rank.get(a)! - rank.get(b)!,
  )
  const writesOf = (node: NodeDescriptor) => (node.writes ?? []).map((r) => canon(resourceName(r)))
  const readsOf = (node: NodeDescriptor) => (node.reads ?? []).map(canon)
  const writers = new Map<string, string[]>()
  for (const name of names) {
    for (const r of writesOf(nodes.get(name)!)) writers.set(r, [...(writers.get(r) ?? []), name])
  }

  const needed = new Set<string>()
  const stack: string[] = []
  for (const name of names) {
    const node = nodes.get(name)!
    if (node.sideEffects || writesOf(node).some((r) => outputs.has(r))) stack.push(name)
  }
  while (stack.length > 0) {
    const name = stack.pop()!
    if (needed.has(name)) continue
    needed.add(name)
    const node = nodes.get(name)!
    for (const r of readsOf(node)) for (const w of writers.get(r) ?? []) stack.push(w)
    // Loading an attachment reads its previous contents.
    for (const a of colorOf(node, options.view)) {
      if (a.clear === undefined) for (const w of writers.get(canon(a.resource)) ?? []) stack.push(w)
    }
    if (node.depth && node.depth.clear === undefined) {
      for (const w of writers.get(canon(node.depth.resource)) ?? []) stack.push(w)
    }
  }

  const live = names.filter((n) => needed.has(n))
  const index = new Map(live.map((n, i) => [n, i]))
  const edges = live.map(() => new Set<number>())
  const link = (from: string, to: string) => {
    const a = index.get(from)
    const b = index.get(to)
    if (a !== undefined && b !== undefined && a !== b) edges[a]!.add(b)
  }
  const phaseOf = (name: string) => nodes.get(name)!.phase ?? 0
  for (const [resource, ws] of writers) {
    const liveWriters = ws.filter((w) => needed.has(w))
    for (let i = 1; i < liveWriters.length; i++) link(liveWriters[i - 1]!, liveWriters[i]!)
    for (const name of live) {
      const node = nodes.get(name)!
      if (!writesOf(node).includes(resource) && readsOf(node).includes(resource)) {
        // A reader sees what earlier phases wrote, and runs before later phases overwrite it.
        // Within its own phase it runs after every writer.
        for (const w of liveWriters) {
          if (phaseOf(w) > phaseOf(name)) link(name, w)
          else link(w, name)
        }
      }
    }
  }
  for (const name of live) for (const dep of nodes.get(name)!.after ?? []) link(dep, name)

  const indegree = live.map(() => 0)
  for (const set of edges) for (const to of set) indegree[to]!++
  const order: string[] = []
  const done = live.map(() => false)
  for (let step = 0; step < live.length; step++) {
    const next = indegree.findIndex((d, i) => d === 0 && !done[i])
    if (next === -1) {
      const stuck = live.filter((_, i) => !done[i])
      throw new ShardError(
        'render/graph-cycle',
        `Render graph nodes form a cycle: ${stuck.join(', ')}`,
        { hint: 'Check reads/writes and `after` on these nodes.' },
      )
    }
    done[next] = true
    order.push(live[next]!)
    for (const to of edges[next]!) indegree[to]!--
  }
  return { order, culled: registration.filter((n) => !needed.has(n)) }
}

const perView = <T>(value: PerView<T>, view: RenderView): T =>
  typeof value === 'function' ? (value as (view: RenderView) => T)(view) : value

interface Readback {
  capture: PendingCapture
  buffer: GPUBuffer
  width: number
  height: number
  format: GPUTextureFormat
  bytesPerRow: number
}

/**
 * Named passes that declare what they read and write. The graph resolves an order per view
 * configuration (enabled nodes, aliases), then runs it for every view each frame, allocating
 * transient textures from a pool.
 */
export class RenderGraph {
  readonly pool: TexturePool
  readonly timer: GpuTimer
  private readonly nodes = new Map<string, NodeDescriptor>()
  /** Transient textures any node can use by name. */
  private readonly declared = new Map<string, TransientTexture>()
  private readonly gpu: GpuContext
  private readonly resolutions = new Map<string, ResolvedGraph>()
  /** The last resolution per view name, for describe(). */
  private readonly lastByView = new Map<string, ResolvedGraph>()
  private captures: PendingCapture[] = []
  /** Views rendered in the last frame, in order. */
  private lastViews: string[] = []
  private readonly viewData = new Map<string, Record<string, unknown>>()
  /** Each node's `render/<node>` span and its CPU time this frame, summed over views (0074). */
  private readonly nodeSlots = new Map<string, number>()
  private readonly nodeSpans: SpanDef[] = []
  private nodeMs = new Float64Array(16)
  private nodeRan = new Uint8Array(16)
  /** Nodes disabled for measurement (0075): see `ablate`. */
  private readonly ablatedNodes = new Set<string>()

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.pool = new TexturePool(gpu)
    this.timer = new GpuTimer(gpu)
  }

  /** Rejects pending captures and destroys the timer's query set (the app is being disposed). */
  dispose(): void {
    const error = new ShardError('render/disposed', 'The app was disposed before the capture ran')
    for (const capture of this.captures.splice(0)) capture.reject(error)
    this.timer.destroy()
  }

  addNode(name: string, node: NodeDescriptor): void {
    if (this.nodes.has(name)) {
      throw new ShardError('render/duplicate-node', `Render graph node "${name}" already exists`)
    }
    this.nodes.set(name, node)
    this.resolutions.clear()
    if (!this.nodeSlots.has(name)) {
      const slot = this.nodeSpans.length
      this.nodeSlots.set(name, slot)
      this.nodeSpans.push(defineSpan(`render/${name}`))
      if (slot >= this.nodeMs.length) {
        const ms = new Float64Array(this.nodeMs.length * 2)
        ms.set(this.nodeMs)
        this.nodeMs = ms
        const ran = new Uint8Array(this.nodeRan.length * 2)
        ran.set(this.nodeRan)
        this.nodeRan = ran
      }
    }
  }

  removeNode(name: string): void {
    this.nodes.delete(name)
    this.resolutions.clear()
  }

  hasNode(name: string): boolean {
    return this.nodes.has(name)
  }

  /** Every node's name, in the order they were added. */
  nodeNames(): string[] {
    return [...this.nodes.keys()]
  }

  /**
   * Disables nodes for measurement (0075's ablation), replacing the previous set; `[]` restores
   * them. A disabled render or compute node still begins and ends its pass, with its attachments'
   * clears, so the textures it writes stay valid for what reads them; only its `run` (its draws and
   * dispatches) is skipped. A raw node, which begins its own passes, is skipped whole. The graph
   * resolves as before: what the node fed still runs, on whatever its textures hold. The image is
   * wrong while nodes are disabled. Throws `render/unknown-node` for a name the graph lacks.
   */
  ablate(names: Iterable<string>): void {
    const next = [...names]
    for (const name of next) {
      if (!this.nodes.has(name)) {
        throw new ShardError('render/unknown-node', `No render graph node "${name}"`, {
          hint: `Nodes: ${this.nodeNames().join(', ')}.`,
        })
      }
    }
    this.ablatedNodes.clear()
    for (const name of next) this.ablatedNodes.add(name)
  }

  /** The nodes `ablate` disabled. */
  ablated(): string[] {
    return [...this.ablatedNodes]
  }

  /** The data of a view rendered in the last frame. */
  lastViewData(view: string): Record<string, unknown> | undefined {
    return this.viewData.get(view)
  }

  /** Declares a transient texture any node can write, read, or attach by name. */
  declare(texture: TransientTexture): void {
    this.declared.set(texture.name, texture)
  }

  /** The resolution with every node enabled and no aliases. */
  resolve(): ResolvedGraph {
    return this.resolveFor(undefined)
  }

  /** `off`: nodes that don't run on this device (features the baseline tier doesn't support). */
  private resolveFor(view: RenderView | undefined, off?: ReadonlySet<string>): ResolvedGraph {
    let key = ''
    const enabled = new Map<string, NodeDescriptor>()
    for (const [name, node] of this.nodes) {
      const on = (!view || !node.enabled || node.enabled(view)) && !off?.has(name)
      key += on ? '1' : '0'
      if (on) enabled.set(name, node)
    }
    const aliases = view?.aliases
    if (aliases) for (const k in aliases) key += `|${k}>${aliases[k]}`
    // Attachment lists that depend on the view change what's loaded; key them too.
    if (view) {
      for (const node of enabled.values()) {
        if (typeof node.color === 'function') {
          for (const a of node.color(view)) key += a.clear === undefined ? 'L' : 'C'
        }
      }
    }
    let resolved = this.resolutions.get(key)
    if (!resolved) {
      resolved = resolveGraph(enabled, new Set([VIEW_TARGET]), { aliases, view })
      resolved = {
        order: resolved.order,
        culled: [...this.nodes.keys()].filter((n) => !resolved!.order.includes(n)),
      }
      this.resolutions.set(key, resolved)
    }
    return resolved
  }

  /** Whether a node after `k` loads or reads `resource` (so its contents must be stored). */
  private loadedLater(
    order: readonly string[],
    k: number,
    resource: string,
    view: RenderView,
  ): boolean {
    const canonical = canonicalOf(view.aliases, resource)
    for (let j = k + 1; j < order.length; j++) {
      const node = this.nodes.get(order[j]!)!
      for (const r of node.reads ?? []) if (canonicalOf(view.aliases, r) === canonical) return true
      for (const a of colorOf(node, view)) {
        if (canonicalOf(view.aliases, a.resource) === canonical) return a.clear === undefined
      }
    }
    return this.captures.some((c) => c.view === view.name && c.buffer === resource)
  }

  /**
   * Copies a view's image after the next frame renders it. `buffer` names any texture resource
   * (default: the view target): 8-bit color formats resolve as `CapturedImage`, others as floats.
   */
  capture(view: string): Promise<CapturedImage>
  capture(view: string, buffer: string): Promise<CapturedImage | CapturedBuffer>
  capture(view: string, buffer = VIEW_TARGET): Promise<CapturedImage | CapturedBuffer> {
    return new Promise<CapturedImage | CapturedBuffer>((resolve, reject) =>
      this.captures.push({ view, buffer, resolve, reject }),
    )
  }

  describe() {
    const { order, culled } = this.resolve()
    const describeOrder = (names: readonly string[]) =>
      names.map((name) => {
        const node = this.nodes.get(name)!
        return {
          name,
          kind: node.kind,
          reads: [...(node.reads ?? [])],
          writes: (node.writes ?? []).map(resourceName),
        }
      })
    return {
      order: describeOrder(order),
      culled,
      perView: Object.fromEntries(
        this.lastViews
          .filter((v) => this.lastByView.has(v))
          .map((v) => [
            v,
            { order: this.lastByView.get(v)!.order, culled: this.lastByView.get(v)!.culled },
          ]),
      ),
      pooledTextures: this.pool.size,
    }
  }

  /** Runs the graph for every view and submits once. */
  execute(world: World, views: readonly RenderView[]): void {
    const device = this.gpu.device
    const encoder = device.createCommandEncoder({ label: 'frame' })
    this.pool.beginFrame()
    this.timer.beginFrame()
    const readbacks: Readback[] = []
    const submitted: (() => void)[] = []
    const sorted = [...views].sort((a, b) => a.order - b.order)
    this.lastViews = sorted.map((v) => v.name)
    this.viewData.clear()
    for (const v of sorted) this.viewData.set(v.name, v.data)

    // Features the baseline tier doesn't support don't run on it (0064).
    const off = this.gpu.tier === 'baseline' ? unsupportedNodes(world) : undefined
    const profiler = world.tryResource(ProfilerResource)
    for (const view of sorted) {
      const resolved = this.resolveFor(view, off)
      const order = resolved.order
      this.lastByView.set(view.name, resolved)
      const textures = new Map<string, GPUTexture>()
      textures.set(VIEW_TARGET, view.target.texture())
      const inline = new Map<string, TransientTexture>()
      for (const name of order) {
        for (const ref of this.nodes.get(name)!.writes ?? []) {
          if (typeof ref !== 'string') inline.set(ref.name, ref)
        }
      }
      const texture = (name: string): GPUTexture => {
        const canonical = canonicalOf(view.aliases, name)
        let t = textures.get(canonical)
        if (t) return t
        const desc = inline.get(canonical) ?? this.declared.get(canonical)
        if (!desc) {
          throw new ShardError(
            'render/missing-resource',
            `Render graph resource "${name}" is not available`,
            {
              hint: "Declare it in a node's `writes` (as a transient texture) or with graph.declare.",
            },
          )
        }
        const size = perView(desc.size ?? 'view', view)
        const vw = view.width ?? view.target.width
        const vh = view.height ?? view.target.height
        const px: [number, number] =
          size === 'view'
            ? [vw, vh]
            : Array.isArray(size)
              ? size
              : [Math.max(1, Math.ceil(vw / size.divide)), Math.max(1, Math.ceil(vh / size.divide))]
        const format = perView(desc.format, view)
        const sampleCount = perView(desc.sampleCount ?? 1, view)
        let usage =
          (desc.usage ?? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING) |
          GPUTextureUsage.COPY_SRC
        // Nothing samples a multisampled target on the baseline tier (GLSL ES 3.00 can't, so
        // readers take depth from the prepass): attachments only, which WebGL2 keeps as
        // renderbuffers (0064).
        if (sampleCount > 1 && this.gpu.tier === 'baseline')
          usage &= ~GPUTextureUsage.TEXTURE_BINDING
        t = this.pool.acquire({
          label: `${view.name}/${canonical}`,
          format: format === 'view' ? view.target.format : format,
          size: px,
          sampleCount,
          mipLevelCount: perView(desc.mipLevelCount ?? 1, view),
          usage,
        })
        textures.set(canonical, t)
        return t
      }
      const provide = (name: string, t: GPUTexture) => {
        textures.set(canonicalOf(view.aliases, name), t)
      }
      const timestamps = (name: string) => this.timer.allocate(name)
      const afterSubmit = (fn: () => void) => void submitted.push(fn)

      for (let k = 0; k < order.length; k++) {
        const name = order[k]!
        const node = this.nodes.get(name)!
        const ablated = this.ablatedNodes.size > 0 && this.ablatedNodes.has(name)
        if (ablated && node.kind === 'raw') continue
        const t0 = profiler !== undefined ? profiler.now() : 0
        let renderPass: GPURenderPassEncoder | undefined
        let computePass: GPUComputePassEncoder | undefined
        if (node.kind === 'render') {
          const colors = colorOf(node, view)
          renderPass = encoder.beginRenderPass({
            label: `${view.name}/${name}`,
            colorAttachments: colors.map((a) => ({
              view: texture(a.resource).createView({ baseMipLevel: a.mip ?? 0, mipLevelCount: 1 }),
              resolveTarget: a.resolve ? texture(a.resolve).createView() : undefined,
              loadOp: a.clear === undefined ? 'load' : 'clear',
              clearValue: typeof a.clear === 'function' ? a.clear(view) : a.clear,
              // A resolved MSAA buffer that no later pass loads never needs to reach memory.
              storeOp:
                a.resolve && !this.loadedLater(order, k, a.resource, view) ? 'discard' : 'store',
            })),
            depthStencilAttachment: node.depth
              ? node.depth.readOnly
                ? { view: texture(node.depth.resource).createView(), depthReadOnly: true }
                : {
                    view: texture(node.depth.resource).createView(),
                    depthLoadOp: node.depth.clear === undefined ? 'load' : 'clear',
                    depthClearValue: node.depth.clear ?? 0,
                    depthStoreOp: 'store',
                  }
              : undefined,
            timestampWrites: this.timer.allocate(name),
          })
        } else if (node.kind === 'compute') {
          computePass = encoder.beginComputePass({
            label: `${view.name}/${name}`,
            timestampWrites: this.timer.allocate(name),
          })
        }
        if (!ablated) {
          node.run({
            gpu: this.gpu,
            world,
            view,
            encoder,
            renderPass,
            computePass,
            texture,
            provide,
            timestamps,
            afterSubmit,
          })
        }
        renderPass?.end()
        computePass?.end()
        if (profiler !== undefined) {
          const ms = profiler.now() - t0
          const slot = this.nodeSlots.get(name)!
          this.nodeMs[slot] = this.nodeMs[slot]! + ms
          this.nodeRan[slot] = 1
          profiler.event(this.nodeSpans[slot]!, TRACK.main, t0, ms)
        }
      }

      for (const capture of this.captures) {
        if (capture.view !== view.name) continue
        let source: GPUTexture
        try {
          source = texture(capture.buffer)
        } catch (err) {
          capture.reject(err)
          continue
        }
        const { width, height, format } = source
        const bpp = BYTES_PER_TEXEL[format]
        if (!bpp || source.sampleCount > 1) {
          capture.reject(
            new ShardError(
              'render/capture-format',
              `Can't capture "${capture.buffer}" (${format})`,
            ),
          )
          continue
        }
        const bytesPerRow = Math.ceil((width * bpp) / 256) * 256
        const buffer = device.createBuffer({
          label: `capture/${view.name}/${capture.buffer}`,
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        encoder.copyTextureToBuffer(
          { texture: source, aspect: format.startsWith('depth') ? 'depth-only' : 'all' },
          { buffer, bytesPerRow },
          [width, height],
        )
        readbacks.push({ capture, buffer, width, height, format, bytesPerRow })
      }
    }

    // `render/<node>`: one sample a frame per node that ran, its views summed.
    if (profiler !== undefined) {
      for (let slot = 0; slot < this.nodeSpans.length; slot++) {
        if (!this.nodeRan[slot]) continue
        profiler.sample(this.nodeSpans[slot]!, this.nodeMs[slot]!)
        this.nodeMs[slot] = 0
        this.nodeRan[slot] = 0
      }
    }
    this.captures = this.captures.filter((c) => !readbacks.some((r) => r.capture === c))
    this.timer.resolve(encoder)
    // Baseline data textures written this frame (0064): uploaded before the work that reads them.
    flushDataStores(this.gpu)
    device.queue.submit([encoder.finish()])
    this.timer.readback(world)
    for (const fn of submitted) fn()

    for (const r of readbacks) {
      const { capture, buffer, width, height, format, bytesPerRow } = r
      buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          const src = buffer.getMappedRange()
          const eightBit = BYTES_PER_TEXEL[format] === 4 && /^(rgba8|bgra8)/.test(format)
          if (eightBit) {
            const bytes = new Uint8Array(src)
            const data = new Uint8Array(width * height * 4)
            const bgra = format.startsWith('bgra')
            for (let y = 0; y < height; y++) {
              const row = bytes.subarray(y * bytesPerRow, y * bytesPerRow + width * 4)
              if (!bgra) {
                data.set(row, y * width * 4)
                continue
              }
              for (let x = 0; x < width * 4; x += 4) {
                const o = y * width * 4 + x
                data[o] = row[x + 2]!
                data[o + 1] = row[x + 1]!
                data[o + 2] = row[x]!
                data[o + 3] = row[x + 3]!
              }
            }
            buffer.unmap()
            buffer.destroy()
            capture.resolve({ width, height, data })
            return
          }
          const data = new Float32Array(width * height * 4)
          for (let y = 0; y < height; y++) {
            toFloats(
              src.slice(y * bytesPerRow, (y + 1) * bytesPerRow),
              format,
              width,
              data,
              y * width * 4,
            )
          }
          buffer.unmap()
          buffer.destroy()
          capture.resolve({ width, height, format, data })
        },
        (err: unknown) => capture.reject(err),
      )
    }
  }
}
