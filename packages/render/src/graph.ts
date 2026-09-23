import { ShardError, type World } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { TexturePool } from './pool'
import type { RenderTarget } from './target'
import { GpuTimer } from './timer'

/** Each view's final output. Nodes that write it are what the graph exists to run. */
export const VIEW_TARGET = 'view-target'

/** A per-frame texture the graph allocates from its pool. */
export interface TransientTexture {
  name: string
  /** A format, or 'view' for the view target's format (e.g. an MSAA color buffer). */
  format: GPUTextureFormat | 'view'
  /** Pixel size, or 'view' to match the view's target (the default). */
  size?: 'view' | [number, number]
  sampleCount?: number
  /** Default: RENDER_ATTACHMENT | TEXTURE_BINDING. */
  usage?: GPUTextureUsageFlags
}

export type ResourceRef = string | TransientTexture

export interface ColorAttachment {
  resource: string
  /** Clears to this color (or a per-view color); omit to load existing contents. */
  clear?: GPUColor | ((view: RenderView) => GPUColor)
  /** Resolve target for MSAA. */
  resolve?: string
}

export interface DepthAttachment {
  resource: string
  /** Clears to this depth; omit to load. Reversed-Z renderers clear to 0. */
  clear?: number
}

export interface RenderView {
  /** Unique per frame, e.g. the camera entity or 'window'. */
  name: string
  target: RenderTarget
  /** Lower renders first. */
  order: number
  /** Per-view data for nodes (camera matrices, etc.). */
  data: Record<string, unknown>
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
}

export interface NodeDescriptor {
  kind: 'render' | 'compute' | 'raw'
  reads?: readonly string[]
  writes?: readonly ResourceRef[]
  /** Explicit ordering for side effects the resource lists don't capture. */
  after?: readonly string[]
  /** Runs even if nothing reads its outputs. */
  sideEffects?: boolean
  /** Render nodes: attachments, set up from resources. */
  color?: readonly ColorAttachment[]
  depth?: DepthAttachment
  run(ctx: NodeContext): void
}

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

interface PendingCapture {
  view: string
  resolve: (image: CapturedImage) => void
  reject: (error: unknown) => void
}

const resourceName = (ref: ResourceRef) => (typeof ref === 'string' ? ref : ref.name)

/**
 * Orders nodes from their resource dependencies and drops nodes whose outputs nothing needs.
 * Pure: no GPU involved, so it's testable on its own.
 *
 * Rules: writers of a resource run in registration order; readers run after every writer of what
 * they read; `after` adds explicit edges. A node is needed if it writes an output (the view target
 * or another imported resource), has `sideEffects`, or writes something a needed node reads.
 */
export function resolveGraph(
  nodes: ReadonlyMap<string, NodeDescriptor>,
  outputs: ReadonlySet<string> = new Set([VIEW_TARGET]),
): ResolvedGraph {
  const names = [...nodes.keys()]
  const writers = new Map<string, string[]>()
  for (const name of names) {
    for (const ref of nodes.get(name)!.writes ?? []) {
      const r = resourceName(ref)
      writers.set(r, [...(writers.get(r) ?? []), name])
    }
  }

  const needed = new Set<string>()
  const stack: string[] = []
  for (const name of names) {
    const node = nodes.get(name)!
    if (node.sideEffects || (node.writes ?? []).some((ref) => outputs.has(resourceName(ref)))) {
      stack.push(name)
    }
  }
  while (stack.length > 0) {
    const name = stack.pop()!
    if (needed.has(name)) continue
    needed.add(name)
    const node = nodes.get(name)!
    for (const r of node.reads ?? []) for (const w of writers.get(r) ?? []) stack.push(w)
    // Loading an attachment reads its previous contents.
    for (const a of node.color ?? []) {
      if (a.clear === undefined) for (const w of writers.get(a.resource) ?? []) stack.push(w)
    }
    if (node.depth && node.depth.clear === undefined) {
      for (const w of writers.get(node.depth.resource) ?? []) stack.push(w)
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
  for (const [resource, ws] of writers) {
    const liveWriters = ws.filter((w) => needed.has(w))
    for (let i = 1; i < liveWriters.length; i++) link(liveWriters[i - 1]!, liveWriters[i]!)
    for (const name of live) {
      const node = nodes.get(name)!
      const writesIt = (node.writes ?? []).some((ref) => resourceName(ref) === resource)
      if (!writesIt && (node.reads ?? []).includes(resource)) {
        for (const w of liveWriters) link(w, name)
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
        {
          hint: 'Check reads/writes and `after` on these nodes.',
        },
      )
    }
    done[next] = true
    order.push(live[next]!)
    for (const to of edges[next]!) indegree[to]!--
  }
  return { order, culled: names.filter((n) => !needed.has(n)) }
}

/**
 * Named passes that declare what they read and write. The graph resolves an order once per change,
 * then runs it for every view each frame, allocating transient textures from a pool.
 */
export class RenderGraph {
  readonly pool: TexturePool
  readonly timer: GpuTimer
  private readonly nodes = new Map<string, NodeDescriptor>()
  private readonly gpu: GpuContext
  private resolved: ResolvedGraph | undefined
  private captures: PendingCapture[] = []

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.pool = new TexturePool(gpu)
    this.timer = new GpuTimer(gpu)
  }

  addNode(name: string, node: NodeDescriptor): void {
    if (this.nodes.has(name)) {
      throw new ShardError('render/duplicate-node', `Render graph node "${name}" already exists`)
    }
    this.nodes.set(name, node)
    this.resolved = undefined
  }

  removeNode(name: string): void {
    this.nodes.delete(name)
    this.resolved = undefined
  }

  resolve(): ResolvedGraph {
    this.resolved ??= resolveGraph(this.nodes)
    return this.resolved
  }

  /** Copies a view's final image after the next frame renders it. */
  capture(view: string): Promise<CapturedImage> {
    return new Promise((resolve, reject) => this.captures.push({ view, resolve, reject }))
  }

  describe() {
    const { order, culled } = this.resolve()
    return {
      order: order.map((name) => {
        const node = this.nodes.get(name)!
        return {
          name,
          kind: node.kind,
          reads: [...(node.reads ?? [])],
          writes: (node.writes ?? []).map(resourceName),
        }
      }),
      culled,
      pooledTextures: this.pool.size,
    }
  }

  /** Runs the graph for every view and submits once. */
  execute(world: World, views: readonly RenderView[]): void {
    const { order } = this.resolve()
    const device = this.gpu.device
    const encoder = device.createCommandEncoder({ label: 'frame' })
    this.pool.beginFrame()
    this.timer.beginFrame()
    const readbacks: {
      capture: PendingCapture
      buffer: GPUBuffer
      target: RenderTarget
      bytesPerRow: number
    }[] = []
    const sorted = [...views].sort((a, b) => a.order - b.order)

    for (const view of sorted) {
      const textures = new Map<string, GPUTexture>()
      textures.set(VIEW_TARGET, view.target.texture())
      const texture = (name: string): GPUTexture => {
        const t = textures.get(name)
        if (!t) {
          throw new ShardError(
            'render/missing-resource',
            `Render graph resource "${name}" is not available`,
            {
              hint: "Declare it in a node's `writes` (as a transient texture) or import it.",
            },
          )
        }
        return t
      }

      for (const name of order) {
        const node = this.nodes.get(name)!
        for (const ref of node.writes ?? []) {
          if (typeof ref === 'string' || textures.has(ref.name)) continue
          const size: [number, number] =
            ref.size === undefined || ref.size === 'view'
              ? [view.target.width, view.target.height]
              : ref.size
          textures.set(
            ref.name,
            this.pool.acquire({
              label: `${view.name}/${ref.name}`,
              format: ref.format === 'view' ? view.target.format : ref.format,
              size,
              sampleCount: ref.sampleCount ?? 1,
              usage:
                ref.usage ?? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            }),
          )
        }

        let renderPass: GPURenderPassEncoder | undefined
        let computePass: GPUComputePassEncoder | undefined
        const timestampWrites = this.timer.allocate(name)
        if (node.kind === 'render') {
          renderPass = encoder.beginRenderPass({
            label: `${view.name}/${name}`,
            colorAttachments: (node.color ?? []).map((a) => ({
              view: texture(a.resource).createView(),
              resolveTarget: a.resolve ? texture(a.resolve).createView() : undefined,
              loadOp: a.clear === undefined ? 'load' : 'clear',
              clearValue: typeof a.clear === 'function' ? a.clear(view) : a.clear,
              storeOp: 'store',
            })),
            depthStencilAttachment: node.depth
              ? {
                  view: texture(node.depth.resource).createView(),
                  depthLoadOp: node.depth.clear === undefined ? 'load' : 'clear',
                  depthClearValue: node.depth.clear ?? 0,
                  depthStoreOp: 'store',
                }
              : undefined,
            timestampWrites,
          })
        } else if (node.kind === 'compute') {
          computePass = encoder.beginComputePass({ label: `${view.name}/${name}`, timestampWrites })
        }
        node.run({ gpu: this.gpu, world, view, encoder, renderPass, computePass, texture })
        renderPass?.end()
        computePass?.end()
      }

      for (const capture of this.captures) {
        if (capture.view !== view.name) continue
        const { width, height } = view.target
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256
        const buffer = device.createBuffer({
          label: `capture/${view.name}`,
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        encoder.copyTextureToBuffer(
          { texture: textures.get(VIEW_TARGET)! },
          { buffer, bytesPerRow },
          [width, height],
        )
        readbacks.push({ capture, buffer, target: view.target, bytesPerRow })
      }
    }

    this.captures = this.captures.filter((c) => !readbacks.some((r) => r.capture === c))
    this.timer.resolve(encoder)
    device.queue.submit([encoder.finish()])
    this.timer.readback(world)

    for (const { capture, buffer, target, bytesPerRow } of readbacks) {
      const { width, height, format } = target
      buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          const src = new Uint8Array(buffer.getMappedRange())
          const data = new Uint8Array(width * height * 4)
          const bgra = format.startsWith('bgra')
          for (let y = 0; y < height; y++) {
            const row = src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4)
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
        },
        (err: unknown) => capture.reject(err),
      )
    }
  }
}
