import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Entity,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  type CameraData,
  ComputedVisibility,
  cameraOf,
  GpuAssetsResource,
  type NodeContext,
  type NodeDescriptor,
  RenderPhase,
  type RenderView,
  Shaders,
  sceneColor,
} from '@aethervtt/shard-render'
import { type Texture, Textures } from '@aethervtt/shard-texture'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Localized, ScreenText, Text } from './components'
import type { Font, FontPage } from './font'
import { type FontStore, Fonts } from './importer'
import { layoutText, TextLayout, type TextLayoutOptions } from './layout'

/** Floats per glyph record: rect (em), uv rect, text index, em px / range, range px, pad. */
const GLYPH_FLOATS = 12
/** Floats per text record: affine rows, fill/outline/shadow colors, style, screen placement. */
const TEXT_FLOATS = 36

const SPACE_WORLD = 0
const SPACE_SCREEN = 1
const ALIGNS = ['left', 'center', 'right'] as const
/** Corner factors (x, y from the top left) for ScreenText.corner. */
const CORNERS = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [0, 0.5],
  [0.5, 0.5],
  [1, 0.5],
  [0, 1],
  [0.5, 1],
  [1, 1],
] as const

interface TextState {
  entity: Entity
  space: number
  layout: TextLayout
  /** What the layout was made from: re-lay out when any of these change. */
  value: string
  font: Font | undefined
  fontVersion: number
  size: number
  align: number
  anchorX: number
  anchorY: number
  maxWidth: number
  lineHeight: number
  /** Record index in the text buffer. */
  index: number
  seen: number
}

/** Glyphs of one atlas page in one space: one draw. */
interface GlyphGroup {
  page: FontPage
  space: number
  first: number
  count: number
}

/**
 * Laid-out text on the GPU. Each Text or ScreenText keeps its layout and relays out only when its
 * value, font, size, or layout options change (or its font gains glyphs). Glyph records are
 * rebuilt, grouped by atlas page, only on frames where some layout changed; transforms and colors
 * update the small per-text records.
 */
export class TextStore {
  readonly states = new Map<Entity, TextState>()
  glyphs = new Float32Array(GLYPH_FLOATS * 1024)
  glyphU32 = new Uint32Array(this.glyphs.buffer)
  glyphCount = 0
  texts = new Float32Array(TEXT_FLOATS * 64)
  textU32 = new Uint32Array(this.texts.buffer)
  textCount = 0
  readonly groups: GlyphGroup[] = []
  groupCount = 0
  readonly glyphBuffer: GpuBuffer
  readonly textBuffer: GpuBuffer
  /** Layouts redone this frame, and characters nothing could draw. */
  relayouts = 0
  missing = 0
  uploadedBytes = 0
  private frame = 0
  private freeIndices: number[] = []
  private nextIndex = 0
  dirtyGlyphs = true

  constructor(gpu: GpuContext) {
    const storage = GPUBufferUsage.STORAGE
    this.glyphBuffer = new GpuBuffer(gpu, { label: 'text/glyphs', usage: storage, size: 4096 })
    this.textBuffer = new GpuBuffer(gpu, { label: 'text/records', usage: storage, size: 4096 })
  }

  beginFrame(): void {
    this.frame++
    this.relayouts = 0
    this.uploadedBytes = 0
  }

  state(entity: Entity, space: number): TextState {
    let s = this.states.get(entity)
    if (!s) {
      const index = this.freeIndices.pop() ?? this.nextIndex++
      s = {
        entity,
        space,
        layout: new TextLayout(),
        value: '',
        font: undefined,
        fontVersion: -1,
        size: -1,
        align: -1,
        anchorX: 0,
        anchorY: 0,
        maxWidth: 0,
        lineHeight: 0,
        index,
        seen: 0,
      }
      this.states.set(entity, s)
      this.dirtyGlyphs = true
    }
    s.seen = this.frame
    if (this.texts.length < (s.index + 1) * TEXT_FLOATS) {
      const grown = new Float32Array(Math.max(this.texts.length * 2, (s.index + 1) * TEXT_FLOATS))
      grown.set(this.texts)
      this.texts = grown
      this.textU32 = new Uint32Array(grown.buffer)
    }
    this.textCount = Math.max(this.textCount, s.index + 1)
    return s
  }

  /** Forgets texts not seen this frame (despawned, hidden, or their component removed). */
  sweep(): void {
    for (const [entity, s] of this.states) {
      if (s.seen === this.frame) continue
      this.states.delete(entity)
      this.freeIndices.push(s.index)
      this.dirtyGlyphs = true
    }
  }

  /** Group per (page, space) while rebuilding: [world, screen], -1 for none yet. */
  private readonly groupOf = new Map<FontPage, Int32Array>()

  private groupFor(page: FontPage, space: number): GlyphGroup {
    let slots = this.groupOf.get(page)
    if (!slots) {
      slots = new Int32Array([-1, -1])
      this.groupOf.set(page, slots)
    }
    let g = slots[space]!
    if (g < 0) {
      g = this.groupCount++
      slots[space] = g
      const group = this.groups[g]
      if (group) {
        group.page = page
        group.space = space
        group.first = 0
        group.count = 0
      } else {
        this.groups[g] = { page, space, first: 0, count: 0 }
      }
    }
    return this.groups[g]!
  }

  /** Rebuilds the glyph records, grouped by (page, space), from every layout. */
  rebuild(): void {
    this.dirtyGlyphs = false
    this.groupOf.clear()
    this.groupCount = 0
    for (const s of this.states.values()) {
      const l = s.layout
      for (let q = 0; q < l.count; q++) this.groupFor(l.pages[l.page[q]!]!, s.space).count++
    }
    let total = 0
    for (let g = 0; g < this.groupCount; g++) {
      const group = this.groups[g]!
      group.first = total
      total += group.count
      group.count = 0
    }
    if (this.glyphs.length < total * GLYPH_FLOATS) {
      this.glyphs = new Float32Array(Math.max(this.glyphs.length * 2, total * GLYPH_FLOATS))
      this.glyphU32 = new Uint32Array(this.glyphs.buffer)
    }
    const f = this.glyphs
    const u = this.glyphU32
    for (const s of this.states.values()) {
      const l = s.layout
      for (let q = 0; q < l.count; q++) {
        const group = this.groupFor(l.pages[l.page[q]!]!, s.space)
        const o = (group.first + group.count++) * GLYPH_FLOATS
        for (let k = 0; k < 4; k++) {
          f[o + k] = l.quads[q * 4 + k]!
          f[o + 4 + k] = l.uvs[q * 4 + k]!
        }
        u[o + 8] = s.index
        const font = l.glyphs[q]!.font
        f[o + 9] = font.size / font.range
        f[o + 10] = font.range
        f[o + 11] = 0
      }
    }
    this.glyphCount = total
    this.glyphBuffer.write(f, 0, 0, Math.max(GLYPH_FLOATS, total * GLYPH_FLOATS))
    this.uploadedBytes += total * GLYPH_FLOATS * 4
  }
}

export const TextRenderer = defineResource<TextStore>('text/Renderer', {
  description: 'Laid-out text on the GPU: glyph records by atlas page, and per-text styles.',
})

const layoutOptions: TextLayoutOptions & { anchor: [number, number] } = { anchor: [0.5, 0.5] }

interface TextColumns {
  value: string[]
  font: (AssetRef<'Font'> | null)[]
  color: Float32Array
  align: Uint8Array
  anchor: Float32Array
  maxWidth: Float32Array
  lineHeight: Float32Array
  weight: Float32Array
  outline: { width: number; color: number[] }[]
  shadow: { offset: number[]; softness: number; color: number[] }[]
  size: Float32Array
  visible: Uint8Array
}

function textColumns(table: Table, def: typeof Text | typeof ScreenText): TextColumns {
  const c = (name: string) => table.column(def as typeof Text, name as 'value') as unknown
  return {
    // A localized text shows its resolved string (0038).
    value: (table.has(Localized) ? table.column(Localized, 'value') : c('value')) as string[],
    font: c('font') as TextColumns['font'],
    color: c('color') as Float32Array,
    align: c('align') as Uint8Array,
    anchor: c('anchor') as Float32Array,
    maxWidth: c('maxWidth') as Float32Array,
    lineHeight: c('lineHeight') as Float32Array,
    weight: c('weight') as Float32Array,
    outline: c('outline') as TextColumns['outline'],
    shadow: c('shadow') as TextColumns['shadow'],
    size: c('size') as Float32Array,
    visible: table.column(ComputedVisibility, 'visible') as unknown as Uint8Array,
  }
}

/** Lays out one text if anything it depends on changed; writes its style record. */
function prepareText(
  store: TextStore,
  fonts: FontStore,
  s: TextState,
  c: TextColumns,
  i: number,
  world: Float32Array | undefined,
  screen: { corner: number; x: number; y: number } | undefined,
): void {
  const font = fonts.get(c.font[i])
  const size = c.size[i]!
  const value = c.value[i] ?? ''
  if (
    font &&
    (s.value !== value ||
      s.font !== font ||
      s.fontVersion !== font.version ||
      s.size !== size ||
      s.align !== c.align[i] ||
      s.anchorX !== c.anchor[i * 2] ||
      s.anchorY !== c.anchor[i * 2 + 1] ||
      s.maxWidth !== c.maxWidth[i] ||
      s.lineHeight !== c.lineHeight[i])
  ) {
    layoutOptions.size = 1
    layoutOptions.align = ALIGNS[c.align[i]!] ?? 'left'
    layoutOptions.anchor[0] = c.anchor[i * 2]!
    layoutOptions.anchor[1] = c.anchor[i * 2 + 1]!
    layoutOptions.maxWidth = size > 0 ? c.maxWidth[i]! / size : 0
    layoutOptions.lineHeight = c.lineHeight[i]!
    layoutText(font, value, layoutOptions, s.layout)
    // Layout may have generated glyphs (and bumped the version): remember what it saw after.
    s.value = value
    s.font = font
    s.fontVersion = font.version
    s.size = size
    s.align = c.align[i]!
    s.anchorX = c.anchor[i * 2]!
    s.anchorY = c.anchor[i * 2 + 1]!
    s.maxWidth = c.maxWidth[i]!
    s.lineHeight = c.lineHeight[i]!
    store.relayouts++
    store.dirtyGlyphs = true
  } else if (!font && s.layout.count > 0) {
    s.layout.count = 0
    s.font = undefined
    store.dirtyGlyphs = true
  }
  if (!c.visible[i] && s.layout.count > 0) {
    s.layout.count = 0
    s.value = ''
    store.dirtyGlyphs = true
  }
  store.missing += s.layout.missing
  const f = store.texts
  const u = store.textU32
  const o = s.index * TEXT_FLOATS
  if (world) for (let k = 0; k < 12; k++) f[o + k] = world[k]!
  else for (let k = 0; k < 12; k++) f[o + k] = k === 0 || k === 5 || k === 10 ? 1 : 0
  for (let k = 0; k < 4; k++) f[o + 12 + k] = c.color[i * 4 + k]!
  const outline = c.outline[i]!
  const shadow = c.shadow[i]!
  for (let k = 0; k < 4; k++) f[o + 16 + k] = outline.color[k]!
  for (let k = 0; k < 4; k++) f[o + 20 + k] = shadow.color[k]!
  f[o + 24] = size
  f[o + 25] = outline.width
  f[o + 26] = shadow.softness
  f[o + 27] = c.weight[i]!
  f[o + 28] = shadow.offset[0]!
  f[o + 29] = shadow.offset[1]!
  u[o + 30] = 0
  u[o + 31] = 0
  f[o + 32] = screen ? CORNERS[screen.corner]![0] : 0
  f[o + 33] = screen ? CORNERS[screen.corner]![1] : 0
  f[o + 34] = screen ? screen.x : 0
  f[o + 35] = screen ? screen.y : 0
}

/**
 * Lays out changed text (Text in the world, ScreenText on screen), writes per-text style and
 * placement records, and rebuilds glyph records on frames where a layout changed.
 */
export const prepareTexts = defineSystem({
  name: 'text/prepare',
  description: 'Lays out changed text and uploads glyphs and styles.',
  setup: (world) => ({
    worldQ: world.query({ with: [Text, GlobalTransform, ComputedVisibility] }),
    screenQ: world.query({ with: [ScreenText, ComputedVisibility] }),
    screen: { corner: 0, x: 0, y: 0 },
  }),
  run: ({ worldQ, screenQ, screen }, world) => {
    const store = world.resource(TextRenderer)
    const fonts = world.resource(Fonts)
    store.beginFrame()
    store.missing = 0
    for (const table of worldQ.tables) {
      const c = textColumns(table, Text)
      const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
      const billboard = table.column(Text, 'billboard')
      for (let i = 0; i < table.count; i++) {
        const s = store.state(table.entities[i]!, SPACE_WORLD)
        prepareText(store, fonts, s, c, i, g.subarray(i * 12, i * 12 + 12), undefined)
        store.textU32[s.index * TEXT_FLOATS + 30] = billboard[i] ? 1 : 0
      }
    }
    for (const table of screenQ.tables) {
      const c = textColumns(table, ScreenText)
      const corner = table.column(ScreenText, 'corner')
      const position = table.column(ScreenText, 'position') as unknown as Float32Array
      for (let i = 0; i < table.count; i++) {
        const s = store.state(table.entities[i]!, SPACE_SCREEN)
        screen.corner = corner[i]!
        screen.x = position[i * 2]!
        screen.y = position[i * 2 + 1]!
        prepareText(store, fonts, s, c, i, undefined, screen)
        store.textU32[s.index * TEXT_FLOATS + 31] = 1
      }
    }
    store.sweep()
    if (store.dirtyGlyphs) store.rebuild()
    if (store.textCount > 0) {
      store.textBuffer.write(store.texts, 0, 0, store.textCount * TEXT_FLOATS)
      store.uploadedBytes += store.textCount * TEXT_FLOATS * 4
    }
  },
})

// --- drawing -----------------------------------------------------------------------------------

interface TextCaches {
  generation: number
  layouts?: { view: GPUBindGroupLayout; data: GPUBindGroupLayout; page: GPUBindGroupLayout }
  pipelines: Map<string, GPURenderPipeline>
  groups: Map<string, { key: string; group: GPUBindGroup }>
  views: Map<string, GpuBuffer>
  sampler?: GPUSampler
}

export const TextCachesResource = defineResource<TextCaches>('text/DrawCaches', {
  description: 'GPU objects of the text passes.',
  init: () => ({ generation: -1, pipelines: new Map(), groups: new Map(), views: new Map() }),
})

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

function caches(ctx: NodeContext): TextCaches {
  const gpu = ctx.gpu
  const c = ctx.world.initResource(TextCachesResource)
  if (c.generation !== gpu.generation) {
    c.generation = gpu.generation
    c.layouts = undefined
    c.pipelines.clear()
    c.groups.clear()
    c.views.clear()
    c.sampler = undefined
  }
  if (!c.layouts) {
    const V = GPUShaderStage.VERTEX
    const F = GPUShaderStage.FRAGMENT
    c.layouts = {
      view: gpu.layouts.bindGroupLayout({
        label: 'text/view',
        entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }],
      }),
      data: gpu.layouts.bindGroupLayout({
        label: 'text/data',
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
        ],
      }),
      page: gpu.layouts.bindGroupLayout({
        label: 'text/page',
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        ],
      }),
    }
  }
  c.sampler ??= gpu.device.createSampler({
    label: 'text/msdf',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })
  return c
}

function group(
  ctx: NodeContext,
  slot: string,
  key: string,
  layout: GPUBindGroupLayout,
  entries: () => GPUBindGroupEntry[],
): GPUBindGroup {
  const c = caches(ctx)
  let g = c.groups.get(slot)
  if (!g || g.key !== key) {
    g = { key, group: ctx.gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
    c.groups.set(slot, g)
  }
  return g.group
}

const BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

function pipeline(ctx: NodeContext, screen: boolean, format: GPUTextureFormat, msaa: number) {
  const gpu = ctx.gpu
  const c = caches(ctx)
  const key = `${screen ? 's' : 'w'}/${format}/${msaa}`
  const cached = c.pipelines.get(key)
  if (cached) return cached
  const module = ctx.world.resource(Shaders).module(gpu, {
    root: 'shard::text',
    defines: { SCREEN: screen, SRGB_TARGET: format.endsWith('-srgb') },
  })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const l = c.layouts!
  const p = gpu.pipelines.render({
    label: `text/${key}`,
    layout: gpu.layouts.pipelineLayout({
      label: 'text',
      bindGroupLayouts: [l.view, l.data, l.page],
    }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: BLEND }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: screen
      ? undefined
      : { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
    multisample: { count: msaa },
  })
  if (p) c.pipelines.set(key, p)
  return p
}

const viewScratch = new Float32Array(28)

function pageTexture(ctx: NodeContext, page: FontPage): Texture | undefined {
  return (
    page.texture ??
    (page.ref ? ctx.world.resource(Textures).get(page.ref as AssetRef<'Texture'>) : undefined)
  )
}

function drawText(ctx: NodeContext, space: number): void {
  const cam = cameraOf(ctx.view)
  const store = ctx.world.tryResource(TextRenderer)
  if (!cam || !store) return
  const gpu = ctx.gpu
  const c = caches(ctx)
  const screen = space === SPACE_SCREEN
  const format = screen ? ctx.texture('view-target').format : 'rgba16float'
  const p = pipeline(ctx, screen, format, screen ? 1 : cam.msaa)
  if (!p) return
  let uniform = c.views.get(ctx.view.name)
  if (!uniform) {
    uniform = new GpuBuffer(gpu, {
      label: `${ctx.view.name}/text`,
      usage: GPUBufferUsage.UNIFORM,
      size: 112,
    })
    c.views.set(ctx.view.name, uniform)
  }
  writeView(cam)
  uniform.write(viewScratch)
  const u = uniform
  const pass = ctx.renderPass!
  pass.setPipeline(p)
  pass.setBindGroup(
    0,
    group(ctx, `${ctx.view.name}/text-view`, `${idOf(u.buffer)}`, c.layouts!.view, () => [
      { binding: 0, resource: { buffer: u.buffer } },
    ]),
  )
  pass.setBindGroup(
    1,
    group(
      ctx,
      'text/data',
      `${idOf(store.glyphBuffer.buffer)}/${idOf(store.textBuffer.buffer)}`,
      c.layouts!.data,
      () => [
        { binding: 0, resource: { buffer: store.glyphBuffer.buffer } },
        { binding: 1, resource: { buffer: store.textBuffer.buffer } },
      ],
    ),
  )
  const assets = ctx.world.resource(GpuAssetsResource)
  for (let g = 0; g < store.groupCount; g++) {
    const grp = store.groups[g]!
    if (grp.space !== space || grp.count === 0) continue
    const texture = pageTexture(ctx, grp.page)
    const gt = texture ? assets.texture(texture) : undefined
    if (!gt) continue
    const sampler = c.sampler!
    pass.setBindGroup(
      2,
      group(ctx, `text/page/${idOf(grp.page)}`, `${idOf(gt.texture)}`, c.layouts!.page, () => [
        { binding: 0, resource: gt.linear },
        { binding: 1, resource: sampler },
      ]),
    )
    pass.draw(6, grp.count, 0, grp.first)
  }
}

/** Per view: view-projection, the camera's right and up (billboards), viewport. */
function writeView(cam: CameraData): void {
  viewScratch.set(cam.viewProj, 0)
  // Rows of the view matrix (world → view) are the camera's axes in world space.
  const v = cam.view
  viewScratch[16] = v[0]!
  viewScratch[17] = v[4]!
  viewScratch[18] = v[8]!
  viewScratch[19] = 0
  viewScratch[20] = v[1]!
  viewScratch[21] = v[5]!
  viewScratch[22] = v[9]!
  viewScratch[23] = 0
  // Only screen text reads the viewport, and it draws after the upscale: display size (0051).
  viewScratch[24] = cam.displayWidth
  viewScratch[25] = cam.displayHeight
  viewScratch[26] = 1 / cam.displayWidth
  viewScratch[27] = 1 / cam.displayHeight
}

function hasSpace(world: World, space: number): boolean {
  const store = world.tryResource(TextRenderer)
  if (!store) return false
  for (let g = 0; g < store.groupCount; g++) {
    const grp = store.groups[g]!
    if (grp.space === space && grp.count > 0) return true
  }
  return false
}

/** World text: after transparent 3D, depth-tested against the scene. */
export function textNode(world: World): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Transparent + 10,
    enabled: (view: RenderView) => cameraOf(view) !== undefined && hasSpace(world, SPACE_WORLD),
    writes: ['scene-color', 'scene-depth', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    run: (ctx) => drawText(ctx, SPACE_WORLD),
  }
}

/** Screen text: over the finished image, after screen sprites. */
export function screenTextNode(world: World): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Overlay + 10,
    enabled: (view: RenderView) => cameraOf(view) !== undefined && hasSpace(world, SPACE_SCREEN),
    writes: ['view-target'],
    color: [{ resource: 'view-target' }],
    run: (ctx) => drawText(ctx, SPACE_SCREEN),
  }
}

/** The text section of `render.describe`. */
export function describeText(world: World) {
  const store = world.tryResource(TextRenderer)
  if (!store) return undefined
  const fonts = new Set<Font>()
  for (const s of store.states.values()) if (s.font) fonts.add(s.font)
  let pages = 0
  let runtimePages = 0
  let runtimeGlyphs = 0
  const missing: string[] = []
  for (const f of fonts) {
    pages += f.pages.length
    runtimePages += f.pages.filter((p) => p.runtime).length
    runtimeGlyphs += f.runtimeGlyphs
    for (const cp of f.missing) missing.push(String.fromCodePoint(cp))
  }
  return {
    texts: store.states.size,
    glyphs: store.glyphCount,
    drawCalls: store.groupCount,
    atlasPages: pages,
    runtimePages,
    runtimeGlyphs,
    missing: missing.slice(0, 50),
    relayouts: store.relayouts,
    uploadedBytes: store.uploadedBytes,
  }
}
