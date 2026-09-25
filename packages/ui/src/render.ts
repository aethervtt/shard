import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Entity,
  Last,
  type World,
} from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import {
  cameraOf,
  DebugOverlays,
  defineOverlay,
  Gpu,
  GpuAssetsResource,
  Graph,
  isOverlayOn,
  type NodeContext,
  type NodeDescriptor,
  Picking,
  RenderDescribers,
  RenderPhase,
  RenderSet,
  type RenderView,
  Shaders,
} from '@shard/render'
import type { App } from '@shard/runtime'
import { type TextureAtlas, TextureAtlases } from '@shard/sprite'
import type { FontPage } from '@shard/text'
import { type Texture, Textures } from '@shard/texture'
import { UiImage, UiInteraction, UiNode, UiSlider, UiTextInput, UiToggle } from './components'
import { hitTest, UiPointer } from './interaction'
import { describeExtras } from './methods'
import { UI_SHADERS } from './shaders'
import { ResolvedStyle, resolveStyle, State } from './style'
import { measureTextNode, textColumns, type UiRootState, UiState } from './tree'

/** Floats per quad record: rect, uv, color, border color, radius, clip, border, kind, range, angle. */
export const QUAD_FLOATS = 28
const KIND_BOX = 0
const KIND_IMAGE = 1
const KIND_IMAGE_PREMULTIPLIED = 2
const KIND_GLYPH = 3

/** Consecutive quads drawn with one texture (boxes join any run). */
interface UiDraw {
  camera: Entity | null
  first: number
  count: number
  /** A texture or a font page; null while only boxes are in the run. */
  source: Texture | FontPage | null
  page: boolean
  /** Sample the sRGB view (color images) or the linear one (glyphs, data). */
  srgb: boolean
}

/**
 * Every UI root's quads in one storage buffer, in draw order (roots by order, nodes in paint
 * order). Rebuilt only on frames where a root's layout or look changed; otherwise nothing uploads.
 */
export class UiRenderStore {
  records = new Float32Array(QUAD_FLOATS * 256)
  recordU32 = new Uint32Array(this.records.buffer)
  count = 0
  draws: UiDraw[] = []
  drawCount = 0
  readonly buffer: GpuBuffer
  /** Root visual versions the records were built from. */
  private built = new Map<Entity, number>()
  overlay = false
  /** This frame's rebuilds and bytes uploaded, and the frame total. */
  rebuilds = 0
  uploadedBytes = 0
  totalUploads = 0

  constructor(gpu: GpuContext) {
    this.buffer = new GpuBuffer(gpu, {
      label: 'ui/quads',
      usage: GPUBufferUsage.STORAGE,
      size: QUAD_FLOATS * 4 * 64,
    })
  }

  /** Whether any root changed since the records were built. */
  stale(roots: readonly UiRootState[], overlay: boolean): boolean {
    if (overlay !== this.overlay || roots.length !== this.built.size) return true
    for (const r of roots) if (this.built.get(r.entity) !== r.visualVersion) return true
    return false
  }

  markBuilt(roots: readonly UiRootState[], overlay: boolean): void {
    this.built.clear()
    for (const r of roots) this.built.set(r.entity, r.visualVersion)
    this.overlay = overlay
  }

  push(): number {
    const n = this.count++
    if (this.records.length < this.count * QUAD_FLOATS) {
      const grown = new Float32Array(this.records.length * 2)
      grown.set(this.records)
      this.records = grown
      this.recordU32 = new Uint32Array(grown.buffer)
    }
    return n * QUAD_FLOATS
  }
}

export const UiRenderer = defineResource<UiRenderStore>('ui/UiRenderer', {
  description: 'UI quads on the GPU: records in draw order and texture runs per camera.',
})

// --- building records ------------------------------------------------------------------------

const style = new ResolvedStyle()
let opacity = new Float32Array(64)

/** Appends a quad; returns its offset. `clip` is x0, y0, x1, y1 in target pixels. */
function quad(
  store: UiRenderStore,
  camera: Entity | null,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: number,
  source: Texture | FontPage | null,
  srgb: boolean,
  clip: Float32Array,
  co: number,
): number {
  // Runs: a box joins the current run; a textured quad starts one when the texture changes.
  let d = store.drawCount > 0 ? store.draws[store.drawCount - 1] : undefined
  const needs = kind !== KIND_BOX
  if (
    !d ||
    d.camera !== camera ||
    (needs && d.source !== null && (d.source !== source || d.srgb !== srgb))
  ) {
    d = store.draws[store.drawCount]
    if (!d) {
      d = { camera, first: 0, count: 0, source: null, page: false, srgb: false }
      store.draws[store.drawCount] = d
    }
    store.drawCount++
    d.camera = camera
    d.first = store.count
    d.count = 0
    d.source = null
    d.page = false
    d.srgb = false
  }
  if (needs && d.source === null) {
    d.source = source
    d.page = kind === KIND_GLYPH
    d.srgb = srgb
  }
  d.count++
  const o = store.push()
  const f = store.records
  f[o] = x
  f[o + 1] = y
  f[o + 2] = w
  f[o + 3] = h
  for (let k = 4; k < 20; k++) f[o + k] = 0
  f[o + 20] = clip[co]!
  f[o + 21] = clip[co + 1]!
  f[o + 22] = clip[co + 2]!
  f[o + 23] = clip[co + 3]!
  f[o + 24] = 0
  store.recordU32[o + 25] = kind
  f[o + 26] = 0
  f[o + 27] = 0
  return o
}

function premultiplied(f: Float32Array, o: number, c: ArrayLike<number>, alpha: number): void {
  const a = c[3]! * alpha
  f[o] = c[0]! * a
  f[o + 1] = c[1]! * a
  f[o + 2] = c[2]! * a
  f[o + 3] = a
}

const clipPx = new Float32Array(4)

/** Appends one root's quads: boxes, images, slider fills, text, carets, and debug outlines. */
function buildRoot(
  world: World,
  store: UiRenderStore,
  r: UiRootState,
  focused: Entity | null,
  outlines: boolean,
): void {
  const F = r.factor
  if (opacity.length < r.count) opacity = new Float32Array(r.count * 2)
  const cam = r.camera
  for (let p = 0; p < r.count; p++) {
    const i = r.paint[p]!
    const parent = r.parent[i]!
    const e = r.entities[i]!
    if (!r.visible[i] || !world.isAlive(e)) {
      opacity[i] = 0
      continue
    }
    const table = world.entityTable(e)
    const row = world.entityRow(e)
    let state = 0
    if (table.has(UiInteraction)) {
      const s = table.column(UiInteraction, 'state')[row]!
      if (s === 1) state |= State.Hovered
      if (s === 2) state |= State.Hovered | State.Pressed
      if (s === 3) state |= State.Disabled
      if (table.column(UiInteraction, 'focused')[row]) state |= State.Focused
    }
    if (table.has(UiToggle) && table.column(UiToggle, 'on')[row]) state |= State.On
    const styleName = table.column(UiNode, 'style')[row] ?? ''
    resolveStyle(style, textColumns(table), row, r.theme, styleName, state)
    const alpha = (parent >= 0 ? opacity[parent]! : 1) * style.opacity
    opacity[i] = alpha
    if (alpha <= 0) continue
    const x = r.x[i]! * F
    const y = r.y[i]! * F
    const w = r.w[i]! * F
    const h = r.h[i]! * F
    const s = r.scale[i]! * F
    clipPx[0] = r.clip[i * 4]! * F
    clipPx[1] = r.clip[i * 4 + 1]! * F
    clipPx[2] = r.clip[i * 4 + 2]! * F
    clipPx[3] = r.clip[i * 4 + 3]! * F
    if (clipPx[2]! <= clipPx[0]! || clipPx[3]! <= clipPx[1]!) continue
    const angle = r.angle[i]!
    // The box.
    if (style.background[3]! > 0 || (style.borderWidth > 0 && style.borderColor[3]! > 0)) {
      const o = quad(store, cam, x, y, w, h, KIND_BOX, null, false, clipPx, 0)
      premultiplied(store.records, o + 8, style.background, alpha)
      premultiplied(store.records, o + 12, style.borderColor, alpha)
      for (let k = 0; k < 4; k++) store.records[o + 16 + k] = style.radius[k]! * s
      store.records[o + 24] = style.borderWidth * s
      store.records[o + 27] = angle
    }
    // The image.
    if (table.has(UiImage)) buildImage(world, store, r, table, row, x, y, w, h, s, alpha, angle)
    // A slider's fill, inside its padding.
    if (table.has(UiSlider)) {
      const min = table.column(UiSlider, 'min')[row]!
      const max = table.column(UiSlider, 'max')[row]!
      const value = table.column(UiSlider, 'value')[row]!
      const t = max !== min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
      const pad = r.tree.padding
      const px = x + pad[i * 4 + 3]! * s
      const py = y + pad[i * 4]! * s
      const pw = Math.max(0, w - (pad[i * 4 + 1]! + pad[i * 4 + 3]!) * s)
      const ph = Math.max(0, h - (pad[i * 4]! + pad[i * 4 + 2]!) * s)
      if (t > 0 && pw > 0 && ph > 0) {
        const o = quad(store, cam, px, py, pw * t, ph, KIND_BOX, null, false, clipPx, 0)
        const fill = table.column(UiSlider, 'fill') as unknown as Float32Array
        premultiplied(store.records, o + 8, fill.subarray(row * 4, row * 4 + 4), alpha)
        const inner = Math.max(
          0,
          Math.min(style.radius[0]!, style.radius[3]!) * s - pad[i * 4 + 3]! * s,
        )
        for (let k = 0; k < 4; k++) store.records[o + 16 + k] = inner
      }
    }
    // Text.
    const text = r.texts[i]
    if (text?.font && text.value !== '') {
      const pad = r.tree.padding
      const contentW = Math.max(0, r.tree.w[i]! - pad[i * 4 + 1]! - pad[i * 4 + 3]!)
      if (text.laidWidth !== contentW || text.laidVersion !== text.fontVersion) {
        measureTextNode(text, contentW, measured, text.layout)
        text.laidWidth = contentW
        text.laidVersion = text.fontVersion
      }
      const l = text.layout
      const size = text.size
      const leading = (text.lineHeight * size - (text.font.ascent - text.font.descent) * size) / 2
      const offsetX =
        style.align === 1 ? (contentW - l.width) / 2 : style.align === 2 ? contentW - l.width : 0
      const ox = x + (pad[i * 4 + 3]! + offsetX) * s
      const oy = y + (pad[i * 4]! + leading) * s
      const dim = table.has(UiTextInput) && (table.column(UiTextInput, 'value')[row] ?? '') === ''
      const ta = alpha * (dim ? 0.45 : 1)
      for (let q = 0; q < l.count; q++) {
        const page = l.pages[l.page[q]!]!
        const qx = l.quads[q * 4]!
        const qy = l.quads[q * 4 + 1]!
        const qw = l.quads[q * 4 + 2]!
        const qh = l.quads[q * 4 + 3]!
        const o = quad(
          store,
          cam,
          ox + qx * s,
          oy - (qy + qh) * s,
          qw * s,
          qh * s,
          KIND_GLYPH,
          page,
          false,
          clipPx,
          0,
        )
        // Not a cached array: quad() may have grown the records.
        for (let k = 0; k < 4; k++) store.records[o + 4 + k] = l.uvs[q * 4 + k]!
        premultiplied(store.records, o + 8, style.color, ta)
        store.records[o + 26] = l.glyphs[q]!.font.range
      }
      // A caret after the text of a focused field.
      if (focused === e && table.has(UiTextInput)) {
        const last = Math.max(0, l.lineCount - 1)
        const lineW = dim ? 0 : l.lineWidth[last]!
        const lineOffset =
          style.align === 1 ? (l.width - lineW) / 2 : style.align === 2 ? l.width - lineW : 0
        const cx = ox + (lineOffset + lineW + 1) * s
        const cy = y + (pad[i * 4]! + last * text.lineHeight * size) * s
        const o = quad(
          store,
          cam,
          cx,
          cy,
          Math.max(1, (2 * s) / F),
          text.lineHeight * size * s,
          KIND_BOX,
          null,
          false,
          clipPx,
          0,
        )
        premultiplied(store.records, o + 8, style.color, alpha)
      }
    } else if (text && focused === e && table.has(UiTextInput)) {
      const pad = r.tree.padding
      const o = quad(
        store,
        cam,
        x + pad[i * 4 + 3]! * s,
        y + pad[i * 4]! * s,
        2,
        text.lineHeight * text.size * s,
        KIND_BOX,
        null,
        false,
        clipPx,
        0,
      )
      premultiplied(store.records, o + 8, style.color, alpha)
    }
  }
  if (outlines) buildOutlines(store, r)
}

const measured = new Float32Array(2)

interface ImageDraw {
  camera: Entity | null
  kind: number
  texture: Texture
  srgb: boolean
  tint: Float32Array
  alpha: number
  tw: number
  th: number
  angle: number
}
const image: ImageDraw = {
  camera: null,
  kind: 0,
  texture: undefined as unknown as Texture,
  srgb: false,
  tint: new Float32Array(4),
  alpha: 1,
  tw: 1,
  th: 1,
  angle: 0,
}
const sliceX = new Float32Array(4)
const sliceY = new Float32Array(4)
const sliceU = new Float32Array(4)
const sliceV = new Float32Array(4)

/** One image quad: a rect and the source pixels it shows (radius: the node's corners). */
function imageQuad(
  store: UiRenderStore,
  qx: number,
  qy: number,
  qw: number,
  qh: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  radius: number,
): void {
  if (qw <= 0 || qh <= 0) return
  const o = quad(
    store,
    image.camera,
    qx,
    qy,
    qw,
    qh,
    image.kind,
    image.texture,
    image.srgb,
    clipPx,
    0,
  )
  const f = store.records
  f[o + 4] = u0 / image.tw
  f[o + 5] = v0 / image.th
  f[o + 6] = u1 / image.tw
  f[o + 7] = v1 / image.th
  premultiplied(f, o + 8, image.tint, image.alpha)
  for (let k = 0; k < 4; k++) f[o + 16 + k] = style.radius[k]! * radius
  f[o + 27] = image.angle
}

/** A node's image: fill, contain, or cover, or nine-sliced. */
function buildImage(
  world: World,
  store: UiRenderStore,
  r: UiRootState,
  table: ReturnType<World['entityTable']>,
  row: number,
  x: number,
  y: number,
  w: number,
  h: number,
  s: number,
  alpha: number,
  angle: number,
): void {
  const atlasRef = table.column(UiImage, 'atlas')[row]
  const region = table.column(UiImage, 'region')[row] ?? ''
  const atlas: TextureAtlas | undefined = atlasRef
    ? world.tryResource(TextureAtlases)?.get(atlasRef)
    : undefined
  const ri = atlas && region ? atlas.region(region) : -1
  const textures = world.tryResource(Textures)
  let texture: Texture | undefined
  let rx = 0
  let ry = 0
  let rw = 0
  let rh = 0
  if (atlas && ri >= 0) {
    texture = textures?.get(atlas.texture)
    rx = atlas.rects[ri * 4]!
    ry = atlas.rects[ri * 4 + 1]!
    rw = atlas.rects[ri * 4 + 2]!
    rh = atlas.rects[ri * 4 + 3]!
  } else {
    texture = textures?.get(table.column(UiImage, 'texture')[row])
    if (texture) {
      rw = texture.width
      rh = texture.height
    }
  }
  if (!texture || rw <= 0 || rh <= 0) return
  const tint = table.column(UiImage, 'tint') as unknown as Float32Array
  image.camera = r.camera
  image.kind = texture.premultiplied ? KIND_IMAGE_PREMULTIPLIED : KIND_IMAGE
  image.texture = texture
  image.srgb = texture.usage === 'color'
  for (let k = 0; k < 4; k++) image.tint[k] = tint[row * 4 + k]!
  image.alpha = alpha
  image.tw = texture.width
  image.th = texture.height
  image.angle = angle
  const slice = table.column(UiImage, 'slice') as unknown as Float32Array
  const sT = slice[row * 4]!
  const sR = slice[row * 4 + 1]!
  const sB = slice[row * 4 + 2]!
  const sL = slice[row * 4 + 3]!
  if (sT > 0 || sR > 0 || sB > 0 || sL > 0) {
    // Nine-slice: corners keep their pixel size (scaled with the UI), edges and middle stretch.
    sliceX[0] = x
    sliceX[1] = x + sL * s
    sliceX[2] = x + w - sR * s
    sliceX[3] = x + w
    sliceY[0] = y
    sliceY[1] = y + sT * s
    sliceY[2] = y + h - sB * s
    sliceY[3] = y + h
    sliceU[0] = rx
    sliceU[1] = rx + sL
    sliceU[2] = rx + rw - sR
    sliceU[3] = rx + rw
    sliceV[0] = ry
    sliceV[1] = ry + sT
    sliceV[2] = ry + rh - sB
    sliceV[3] = ry + rh
    for (let b = 0; b < 3; b++) {
      for (let a = 0; a < 3; a++) {
        imageQuad(
          store,
          sliceX[a]!,
          sliceY[b]!,
          sliceX[a + 1]! - sliceX[a]!,
          sliceY[b + 1]! - sliceY[b]!,
          sliceU[a]!,
          sliceV[b]!,
          sliceU[a + 1]!,
          sliceV[b + 1]!,
          0,
        )
      }
    }
    return
  }
  const fit = table.column(UiImage, 'fit')[row]!
  if (fit === 0) {
    imageQuad(store, x, y, w, h, rx, ry, rx + rw, ry + rh, s)
    return
  }
  const scale = fit === 1 ? Math.min(w / rw, h / rh) : Math.max(w / rw, h / rh)
  if (fit === 1) {
    const dw = rw * scale
    const dh = rh * scale
    imageQuad(store, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh, rx, ry, rx + rw, ry + rh, s)
  } else {
    // Cover: crop the region to the box's aspect.
    const cw = w / scale
    const ch = h / scale
    const cx = rx + (rw - cw) / 2
    const cy = ry + (rh - ch) / 2
    imageQuad(store, x, y, w, h, cx, cy, cx + cw, cy + ch, s)
  }
}

const OUTLINE = [0.1, 0.9, 1, 0.9]
const PADDING = [1, 0.6, 0.1, 0.7]
const MARGIN = [1, 0.2, 0.6, 0.5]
const fullClip = new Float32Array([-1e9, -1e9, 1e9, 1e9])

function outline(
  store: UiRenderStore,
  camera: Entity | null,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly number[],
): void {
  if (w <= 0 || h <= 0) return
  const o = quad(store, camera, x, y, w, h, KIND_BOX, null, false, fullClip, 0)
  premultiplied(store.records, o + 12, color, 1)
  store.records[o + 24] = 1
}

/** The ui-layout overlay: each visible node's border box, padding box, and margin box. */
function buildOutlines(store: UiRenderStore, r: UiRootState): void {
  const F = r.factor
  const t = r.tree
  for (let i = 0; i < r.count; i++) {
    if (!r.visible[i]) continue
    const s = r.scale[i]! * F
    const x = r.x[i]! * F
    const y = r.y[i]! * F
    const w = r.w[i]! * F
    const h = r.h[i]! * F
    outline(store, r.camera, x, y, w, h, OUTLINE)
    const pT = t.padding[i * 4]! * s
    const pR = t.padding[i * 4 + 1]! * s
    const pB = t.padding[i * 4 + 2]! * s
    const pL = t.padding[i * 4 + 3]! * s
    if (pT || pR || pB || pL)
      outline(store, r.camera, x + pL, y + pT, w - pL - pR, h - pT - pB, PADDING)
    const mT = t.margin[i * 4]! * s
    const mR = t.margin[i * 4 + 1]! * s
    const mB = t.margin[i * 4 + 2]! * s
    const mL = t.margin[i * 4 + 3]! * s
    if (mT || mR || mB || mL)
      outline(store, r.camera, x - mL, y - mT, w + mL + mR, h + mT + mB, MARGIN)
  }
}

export const uiLayoutOverlay = defineOverlay({
  name: 'ui-layout',
  description: 'UI node rects: border boxes (cyan), padding (orange), and margins (pink).',
  draw: () => {},
})

/** Rebuilds the quad records when any root changed, and uploads them. */
export const prepareUi = defineSystem({
  name: 'ui/prepare',
  description: 'Builds and uploads UI quads when layout or looks changed.',
  run: (_, world) => {
    const store = world.tryResource(UiRenderer)
    const ui = world.tryResource(UiState)
    if (!store || !ui) return
    store.rebuilds = 0
    store.uploadedBytes = 0
    const overlays = world.tryResource(DebugOverlays)
    const outlines = overlays ? isOverlayOn(overlays, 'ui-layout') : false
    if (!store.stale(ui.roots, outlines)) return
    store.count = 0
    store.drawCount = 0
    const focused = world.tryResource(UiPointer)?.focused ?? null
    for (const r of ui.roots) buildRoot(world, store, r, focused, outlines)
    store.markBuilt(ui.roots, outlines)
    store.rebuilds++
    const floats = Math.max(QUAD_FLOATS, store.count * QUAD_FLOATS)
    store.buffer.write(store.records, 0, 0, floats)
    store.uploadedBytes = store.count * QUAD_FLOATS * 4
    store.totalUploads++
  },
})

// --- drawing -----------------------------------------------------------------------------------

interface UiCaches {
  generation: number
  layouts?: { view: GPUBindGroupLayout; texture: GPUBindGroupLayout }
  pipelines: Map<string, GPURenderPipeline>
  groups: Map<string, { key: string; group: GPUBindGroup }>
  views: Map<string, GpuBuffer>
  sampler?: GPUSampler
  white?: GPUTextureView
}

export const UiCachesResource = defineResource<UiCaches>('ui/DrawCaches', {
  description: 'GPU objects of the UI pass.',
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

function caches(ctx: NodeContext): UiCaches {
  const gpu = ctx.gpu
  const c = ctx.world.initResource(UiCachesResource)
  if (c.generation !== gpu.generation) {
    c.generation = gpu.generation
    c.layouts = undefined
    c.pipelines.clear()
    c.groups.clear()
    c.views.clear()
    c.sampler = undefined
    c.white = undefined
  }
  if (!c.layouts) {
    const V = GPUShaderStage.VERTEX
    const F = GPUShaderStage.FRAGMENT
    c.layouts = {
      view: gpu.layouts.bindGroupLayout({
        label: 'ui/view',
        entries: [
          { binding: 0, visibility: V, buffer: { type: 'uniform' } },
          { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
        ],
      }),
      texture: gpu.layouts.bindGroupLayout({
        label: 'ui/texture',
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        ],
      }),
    }
  }
  c.sampler ??= gpu.device.createSampler({
    label: 'ui/linear',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })
  if (!c.white) {
    const texture = gpu.device.createTexture({
      label: 'ui/white',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    gpu.device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    )
    c.white = texture.createView()
  }
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

function pipeline(ctx: NodeContext, format: GPUTextureFormat): GPURenderPipeline | undefined {
  const gpu = ctx.gpu
  const c = caches(ctx)
  const cached = c.pipelines.get(format)
  if (cached) return cached
  const module = ctx.world.resource(Shaders).module(gpu, {
    root: 'shard::ui',
    defines: { SRGB_TARGET: format.endsWith('-srgb') },
  })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const l = c.layouts!
  const p = gpu.pipelines.render({
    label: `ui/${format}`,
    layout: gpu.layouts.pipelineLayout({ label: 'ui', bindGroupLayouts: [l.view, l.texture] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: BLEND }] },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  })
  if (p) c.pipelines.set(format, p)
  return p
}

function pageTexture(world: World, page: FontPage): Texture | undefined {
  return (
    page.texture ??
    (page.ref ? world.resource(Textures).get(page.ref as AssetRef<'Texture'>) : undefined)
  )
}

const viewScratch = new Float32Array(4)

/** Draws the runs of roots over this view's camera. */
function drawUi(ctx: NodeContext): void {
  const cam = cameraOf(ctx.view)
  const store = ctx.world.tryResource(UiRenderer)
  if (!cam || !store || store.drawCount === 0) return
  const gpu = ctx.gpu
  const c = caches(ctx)
  const p = pipeline(ctx, ctx.texture('view-target').format)
  if (!p) return
  let uniform = c.views.get(ctx.view.name)
  if (!uniform) {
    uniform = new GpuBuffer(gpu, {
      label: `${ctx.view.name}/ui`,
      usage: GPUBufferUsage.UNIFORM,
      size: 16,
    })
    c.views.set(ctx.view.name, uniform)
  }
  viewScratch[0] = cam.width
  viewScratch[1] = cam.height
  viewScratch[2] = 1 / cam.width
  viewScratch[3] = 1 / cam.height
  uniform.write(viewScratch)
  const u = uniform
  const pass = ctx.renderPass!
  pass.setPipeline(p)
  pass.setBindGroup(
    0,
    group(
      ctx,
      `${ctx.view.name}/ui-view`,
      `${idOf(u.buffer)}/${idOf(store.buffer.buffer)}`,
      c.layouts!.view,
      () => [
        { binding: 0, resource: { buffer: u.buffer } },
        { binding: 1, resource: { buffer: store.buffer.buffer } },
      ],
    ),
  )
  const assets = ctx.world.resource(GpuAssetsResource)
  const sampler = c.sampler!
  for (let d = 0; d < store.drawCount; d++) {
    const draw = store.draws[d]!
    if (draw.count === 0 || (draw.camera !== null && draw.camera !== cam.entity)) continue
    let view: GPUTextureView = c.white!
    let key = 'white'
    if (draw.source) {
      const texture = draw.page
        ? pageTexture(ctx.world, draw.source as FontPage)
        : (draw.source as Texture)
      const gt = texture ? assets.texture(texture) : undefined
      if (!gt) continue
      view = draw.srgb ? gt.srgb : gt.linear
      key = `${idOf(gt.texture)}/${draw.srgb ? 's' : 'l'}`
    }
    const v = view
    pass.setBindGroup(
      1,
      group(ctx, `ui/tex/${d}`, key, c.layouts!.texture, () => [
        { binding: 0, resource: v },
        { binding: 1, resource: sampler },
      ]),
    )
    pass.draw(6, draw.count, 0, draw.first)
  }
}

/** UI: over the finished image, after screen sprites and screen text. */
export function uiNode(world: World): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Overlay + 20,
    enabled: (view: RenderView) => {
      const cam = cameraOf(view)
      const store = world.tryResource(UiRenderer)
      if (!cam || !store || store.drawCount === 0) return false
      for (let d = 0; d < store.drawCount; d++) {
        const draw = store.draws[d]!
        if (draw.count > 0 && (draw.camera === null || draw.camera === cam.entity)) return true
      }
      return false
    },
    writes: ['view-target'],
    color: [{ resource: 'view-target' }],
    run: (ctx) => drawUi(ctx),
  }
}

/** The ui section of `render.describe`, and the upload counts ui.describe reports. */
export function describeUiRender(world: World) {
  const store = world.tryResource(UiRenderer)
  if (!store) return undefined
  let draws = 0
  for (let d = 0; d < store.drawCount; d++) if (store.draws[d]!.count > 0) draws++
  return {
    quads: store.count,
    drawCalls: draws,
    rebuilds: store.rebuilds,
    uploadedBytes: store.uploadedBytes,
  }
}

/** Adds drawing when a renderer is present: the pass, the prepare system, and the pick blocker. */
export function installUiRenderer(app: App): void {
  const world = app.world
  const graph = world.tryResource(Graph)
  const gpu = world.tryResource(Gpu)
  if (!graph || !gpu) return
  app.insertResource(UiRenderer, new UiRenderStore(gpu))
  const shaders = world.resource(Shaders)
  for (const [path, source] of Object.entries(UI_SHADERS))
    shaders.register(path, source, `engine:${path}`)
  graph.addNode('ui', uiNode(world))
  app.addSystems(Last, prepareUi.inSet(RenderSet.Prepare))
  world.initResource(RenderDescribers).set('ui', (w) => describeUiRender(w))
  describeExtras.set('render', (w) => describeUiRender(w) ?? null)
  // A pick over UI that takes the pointer hits the UI, not the world.
  world.initResource(Picking).blockers.set('ui', (w, view, x, y) => {
    const ui = w.tryResource(UiState)
    if (!ui) return false
    const camera = view.startsWith('camera:') ? Number(view.slice(7)) : undefined
    return hitTest(ui, x, y, camera).node >= 0
  })
}
