import { unsupported } from './errors'
import { type Webgl2Buffer, Webgl2Sampler, Webgl2TextureView } from './resources'

// Bind group layouts, pipeline layouts and bind groups. A group keeps its resources by binding
// number; a pipeline maps each uniform block and combined sampler of its program to a group and
// binding (naga's reflection), and draws bind them to GL binding points and texture units.

let nextId = 1

export class Webgl2BindGroupLayout {
  readonly id = nextId++
  readonly label: string
  readonly entries: readonly GPUBindGroupLayoutEntry[]
  /** Uniform buffers with a dynamic offset, in binding order: the order dynamic offsets come in. */
  readonly dynamic: readonly number[]

  constructor(d: GPUBindGroupLayoutDescriptor) {
    this.label = d.label ?? ''
    this.entries = [...d.entries]
    for (const e of this.entries) {
      if (e.storageTexture) throw unsupported(`bind a storage texture ("${this.label}")`)
      if (e.buffer && (e.buffer.type === 'storage' || e.buffer.type === 'read-only-storage')) {
        // Storage in compute is the full tier's; the baseline tier never binds it to render stages.
        if (e.visibility & 0x3) {
          throw unsupported(
            `bind a storage buffer to a vertex or fragment shader ("${this.label}" #${e.binding})`,
            'Read engine data through a @data declaration (0064).',
          )
        }
      }
      if (e.externalTexture) throw unsupported(`bind an external texture ("${this.label}")`)
    }
    this.dynamic = this.entries
      .filter((e) => e.buffer?.hasDynamicOffset)
      .map((e) => e.binding)
      .sort((a, b) => a - b)
  }
}

export class Webgl2PipelineLayout {
  readonly id = nextId++
  readonly label: string
  readonly groups: readonly Webgl2BindGroupLayout[]
  constructor(d: GPUPipelineLayoutDescriptor) {
    this.label = d.label ?? ''
    this.groups = [...(d.bindGroupLayouts as unknown as Webgl2BindGroupLayout[])]
  }
}

export interface BoundBuffer {
  buffer: Webgl2Buffer
  offset: number
  size: number
}

export class Webgl2BindGroup {
  readonly id = nextId++
  readonly label: string
  readonly layout: Webgl2BindGroupLayout
  /** By binding number. */
  readonly buffers: (BoundBuffer | undefined)[] = []
  readonly views: (Webgl2TextureView | undefined)[] = []
  readonly samplers: (Webgl2Sampler | undefined)[] = []
  /** Where each dynamic offset applies: its binding, in the order offsets are given. */
  readonly dynamic: readonly number[]

  constructor(d: GPUBindGroupDescriptor) {
    this.label = d.label ?? ''
    this.layout = d.layout as unknown as Webgl2BindGroupLayout
    this.dynamic = this.layout.dynamic
    for (const e of d.entries) {
      const r = e.resource as unknown
      if (r instanceof Webgl2TextureView) {
        if (!r.bindable()) {
          throw unsupported(
            `bind "${r.texture.label}" as a ${r.dimension} view of layers ${r.baseArrayLayer}–${r.baseArrayLayer + r.arrayLayerCount - 1} (it binds as ${r.texture.bindingDimension})`,
            'A baseline texture binds as the one dimension it was made for (textureBindingViewDimension).',
          )
        }
        this.views[e.binding] = r
      } else if (r instanceof Webgl2Sampler) {
        this.samplers[e.binding] = r
      } else if (r && typeof r === 'object' && 'buffer' in r) {
        const b = r as { buffer: Webgl2Buffer; offset?: number; size?: number }
        const offset = b.offset ?? 0
        this.buffers[e.binding] = {
          buffer: b.buffer,
          offset,
          size: b.size ?? b.buffer.size - offset,
        }
      } else {
        throw unsupported(`bind ${String(r)} ("${this.label}" #${e.binding})`)
      }
    }
  }
}
