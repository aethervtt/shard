import {
  type AssetRef,
  ChildOf,
  Children,
  defineResource,
  defineSystem,
  type Entity,
  onAdd,
  onRemove,
  onSet,
  ShardError,
  type Table,
  type World,
} from '@shard/core'
import { Camera3d, RenderTargets, Window } from '@shard/render'
import { LogResource } from '@shard/runtime'
import { TextureAtlases } from '@shard/sprite'
import {
  type Font,
  Fonts,
  Localized,
  layoutText,
  TextLayout,
  type TextLayoutOptions,
} from '@shard/text'
import { Textures } from '@shard/texture'
import { GlobalTransform } from '@shard/transform'
import {
  UiAnchor,
  UiAnchorArrow,
  UiButton,
  UiDefaults,
  UiImage,
  UiInteraction,
  UiLayout,
  UiNode,
  UiRoot,
  UiSlider,
  UiStyle,
  UiText,
  UiTextInput,
  UiToggle,
} from './components'
import { FlexTree, LENGTHS, layoutTree } from './flex'
import { ResolvedStyle, resolveStyle, type StyleColumns } from './style'
import { type UiThemeAsset, UiThemes } from './theme'

/** Interactive node kinds. */
export const Kind = { None: 0, Button: 1, Toggle: 2, Slider: 3, TextInput: 4 } as const

export const AnchorState = { None: 0, OnScreen: 1, Clamped: 2, Hidden: 3 } as const
export const Overflow = { Visible: 0, Clip: 1, Scroll: 2 } as const

function growF(a: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
  if (a.length >= n) return a
  const out = new Float32Array(Math.max(n, a.length * 2))
  out.set(a)
  return out
}
function growI(a: Int32Array<ArrayBuffer>, n: number): Int32Array<ArrayBuffer> {
  if (a.length >= n) return a
  const out = new Int32Array(Math.max(n, a.length * 2))
  out.set(a)
  return out
}
function growU(a: Uint8Array<ArrayBuffer>, n: number): Uint8Array<ArrayBuffer> {
  if (a.length >= n) return a
  const out = new Uint8Array(Math.max(n, a.length * 2))
  out.set(a)
  return out
}

/** Text a node measures and draws, and what it was last measured with. */
export interface TextNode {
  entity: Entity
  value: string
  font: Font | undefined
  fontVersion: number
  size: number
  lineHeight: number
  wrap: boolean
  /** Two cached measurements: max width → (width, height). */
  cacheW: Float32Array
  cacheOut: Float32Array
  cacheN: number
  /** The drawn layout (at the final width), and what it was laid out with. */
  layout: TextLayout
  laidWidth: number
  laidVersion: number
}

/** One UI tree: its nodes in preorder (children in `order`), and everything computed for them. */
export class UiRootState {
  readonly entity: Entity
  readonly tree = new FlexTree()
  /** Node index → entity. Node 0 is the root. */
  entities: Entity[] = []
  parent = new Int32Array(16)
  /** Index past the node's subtree. */
  end = new Int32Array(16)
  /** Node indices in paint order (siblings by zIndex, stable). */
  paint = new Int32Array(16)
  /** Computed rect (root pixels), after scroll and anchor scale. */
  x = new Float32Array(16)
  y = new Float32Array(16)
  w = new Float32Array(16)
  h = new Float32Array(16)
  /** Clip applied to the node (x0, y0, x1, y1), and what it passes to its children. */
  clip = new Float32Array(64)
  childClip = new Float32Array(64)
  visible = new Uint8Array(16)
  scale = new Float32Array(16)
  angle = new Float32Array(16)
  anchorState = new Uint8Array(16)
  distance = new Float32Array(16)
  contentW = new Float32Array(16)
  contentH = new Float32Array(16)
  overflow = new Uint8Array(16)
  scrollX = new Float32Array(16)
  scrollY = new Float32Array(16)
  /** 1: has UiAnchor; 2: UiAnchorArrow. */
  anchorKind = new Uint8Array(16)
  /** Widget kind (Kind), disabled, and whether the node takes the pointer. */
  kind = new Uint8Array(16)
  disabled = new Uint8Array(16)
  solid = new Uint8Array(16)
  /** This frame: its flex tree is refilled and laid out; its UiLayout rows are written. */
  filling = false
  writing = false
  /** Widgets, styles, or images changed: refresh kind, disabled, and solid. */
  flagsDirty = true
  /** order and zIndex per node when the tree was built. */
  sortKeys = new Int16Array(32)
  /** Distance scale of each anchor (1 for other nodes). */
  anchorScale = new Float32Array(16)
  /** Nodes that measure text, by node index. */
  texts: (TextNode | undefined)[] = []
  /** Image intrinsic size (0 until the texture loads). */
  imageW = new Float32Array(16)
  imageH = new Float32Array(16)
  count = 0
  hasAnchors = false
  /** Root pixels → screen pixels. */
  factor = 1
  width = 0
  height = 0
  viewportW = 0
  viewportH = 0
  camera: Entity | null = null
  theme: UiThemeAsset | undefined
  themeVersion = -1
  order = 0
  dirty = true
  /** Frame counter of the last layout, for describe. */
  laidOutAt = -1
  /** Something visual changed since the renderer last built this root. */
  visualVersion = 0

  constructor(entity: Entity) {
    this.entity = entity
  }

  reserve(n: number): void {
    this.parent = growI(this.parent, n)
    this.end = growI(this.end, n)
    this.paint = growI(this.paint, n)
    this.x = growF(this.x, n)
    this.y = growF(this.y, n)
    this.w = growF(this.w, n)
    this.h = growF(this.h, n)
    this.clip = growF(this.clip, n * 4)
    this.childClip = growF(this.childClip, n * 4)
    this.visible = growU(this.visible, n)
    this.scale = growF(this.scale, n)
    this.angle = growF(this.angle, n)
    this.anchorState = growU(this.anchorState, n)
    this.distance = growF(this.distance, n)
    this.contentW = growF(this.contentW, n)
    this.contentH = growF(this.contentH, n)
    this.overflow = growU(this.overflow, n)
    this.scrollX = growF(this.scrollX, n)
    this.scrollY = growF(this.scrollY, n)
    this.anchorKind = growU(this.anchorKind, n)
    this.anchorScale = growF(this.anchorScale, n)
    this.kind = growU(this.kind, n)
    this.disabled = growU(this.disabled, n)
    this.solid = growU(this.solid, n)
    if (this.sortKeys.length < n * 2) {
      const keys = new Int16Array(n * 4)
      keys.set(this.sortKeys)
      this.sortKeys = keys
    }
    this.imageW = growF(this.imageW, n)
    this.imageH = growF(this.imageH, n)
  }
}

/** Every UI tree, which root each node is in, and this frame's work counts. */
export class UiStore {
  roots: UiRootState[] = []
  readonly rootOf = new Map<Entity, UiRootState>()
  readonly indexOf = new Map<Entity, number>()
  /** UiNode entities outside any UiRoot (ui/no-root), reported once each. */
  readonly orphans = new Set<Entity>()
  readonly reportedOrphans = new Set<Entity>()
  /** Styles nodes name that their root's theme lacks (ui/unknown-style), reported once each. */
  readonly reportedStyles = new Set<string>()
  structureDirty = true
  frame = 0
  /** This frame: roots laid out, nodes they had, anchor-only repositions, layout calls. */
  layouts = 0
  nodesLaidOut = 0
  repositions = 0
  flexCalls = 0
  totalLayouts = 0

  root(entity: Entity): UiRootState | undefined {
    return this.rootOf.get(entity)
  }
}

export const UiState = defineResource<UiStore>('ui/UiState', {
  description: 'UI trees by root: node order, computed rects, clips, and per-frame layout counts.',
  init: () => new UiStore(),
})

/** Marks trees for a rebuild when nodes appear, disappear, or move to another parent. */
export function observeUiStructure(world: World): void {
  const mark = () => {
    const store = world.tryResource(UiState)
    if (store) store.structureDirty = true
  }
  world.observe(onAdd(UiNode), mark)
  world.observe(onRemove(UiNode), mark)
  world.observe(onAdd(UiRoot), mark)
  world.observe(onRemove(UiRoot), mark)
  world.observe(onAdd(UiAnchor), mark)
  world.observe(onRemove(UiAnchor), mark)
  world.observe(onAdd(UiText), mark)
  world.observe(onRemove(UiText), mark)
  world.observe(onAdd(UiImage), mark)
  world.observe(onRemove(UiImage), mark)
  const reparent = ({ entity }: { entity: Entity }) => {
    if (world.isAlive(entity) && world.has(entity, UiNode)) mark()
  }
  world.observe(onAdd(ChildOf), reparent)
  world.observe(onSet(ChildOf), reparent)
  world.observe(onRemove(ChildOf), reparent)
}

// --- building trees ------------------------------------------------------------------------------

function nodeColumn(world: World, entity: Entity, field: 'order' | 'zIndex'): number {
  const table = world.entityTable(entity)
  return table.column(UiNode, field)[world.entityRow(entity)]!
}

/** Rebuilds every root's node list from the hierarchy. Cold: runs when structure changes. */
function rebuildTrees(world: World, store: UiStore, roots: Entity[]): void {
  const previous = new Map(store.roots.map((r) => [r.entity, r]))
  store.roots = []
  store.rootOf.clear()
  store.indexOf.clear()
  for (const rootEntity of roots) {
    const r = previous.get(rootEntity) ?? new UiRootState(rootEntity)
    const entities: Entity[] = []
    const parents: number[] = []
    const ends: number[] = []
    // Preorder with children sorted by `order` (stable): every subtree is a contiguous range.
    const visit = (e: Entity, parent: number) => {
      const index = entities.length
      entities.push(e)
      parents.push(parent)
      ends.push(0)
      const children = world.tryGet(e, Children)?.entities ?? []
      const ui = children.filter(
        (c): c is Entity =>
          c !== null && world.isAlive(c) && world.has(c, UiNode) && !world.has(c, UiRoot),
      )
      ui.sort((a, b) => nodeColumn(world, a, 'order') - nodeColumn(world, b, 'order'))
      for (const c of ui) visit(c, index)
      ends[index] = entities.length
    }
    visit(rootEntity, -1)
    const n = entities.length
    r.reserve(n)
    r.entities = entities
    r.count = n
    r.texts.length = n
    for (let i = 0; i < n; i++) {
      r.texts[i] = undefined
      r.parent[i] = parents[i]!
      r.end[i] = ends[i]!
      r.anchorScale[i] = 1
      r.anchorState[i] = 0
      r.imageW[i] = 0
      r.imageH[i] = 0
    }
    // Paint order: preorder where siblings sort by zIndex (stable in layout order).
    let p = 0
    const paintVisit = (at: number) => {
      r.paint[p++] = at
      const children: number[] = []
      for (let c = at + 1; c < r.end[at]!; c = r.end[c]!) children.push(c)
      children.sort(
        (a, b) =>
          nodeColumn(world, r.entities[a]!, 'zIndex') - nodeColumn(world, r.entities[b]!, 'zIndex'),
      )
      for (const c of children) paintVisit(c)
    }
    paintVisit(0)
    r.hasAnchors = false
    for (let i = 0; i < n; i++) {
      const e = r.entities[i]!
      r.sortKeys[i * 2] = nodeColumn(world, e, 'order')
      r.sortKeys[i * 2 + 1] = nodeColumn(world, e, 'zIndex')
      store.rootOf.set(e, r)
      store.indexOf.set(e, i)
      const kind = world.has(e, UiAnchor) ? 1 : world.has(e, UiAnchorArrow) ? 2 : 0
      r.anchorKind[i] = kind
      if (kind === 1) r.hasAnchors = true
    }
    r.dirty = true
    r.flagsDirty = true
    store.roots.push(r)
  }
}

// --- viewport and camera -------------------------------------------------------------------------

function cameraFor(world: World, wanted: Entity | null, cameras: Table[]): Entity | null {
  if (wanted !== null && world.isAlive(wanted) && world.has(wanted, Camera3d)) return wanted
  let best: Entity | null = null
  let bestOrder = Number.POSITIVE_INFINITY
  for (const table of cameras) {
    const order = table.column(Camera3d, 'order')
    for (let i = 0; i < table.count; i++) {
      if (order[i]! < bestOrder) {
        bestOrder = order[i]!
        best = table.entities[i]!
      }
    }
  }
  return best
}

const viewport = new Float32Array(2)

/** Pixel size of what a camera renders to, or false headless (no window or target). */
function viewportOf(world: World, camera: Entity | null): boolean {
  let target: { width: number; height: number } | undefined
  if (camera !== null) {
    const ref = world.get(camera, Camera3d).target
    if (ref) target = world.tryResource(RenderTargets)?.get(ref)
  }
  target ??= world.tryResource(Window)
  if (!target) return false
  viewport[0] = target.width
  viewport[1] = target.height
  return true
}

// --- measuring ---------------------------------------------------------------------------------

const measureOptions: TextLayoutOptions & { anchor: [number, number] } = {
  anchor: [0, 1],
  size: 16,
  align: 'left',
  maxWidth: 0,
  lineHeight: 1.2,
}
const scratchLayout = new TextLayout()

/** Lays out a text node's string at a width: block width, and lines × line height. */
export function measureTextNode(
  t: TextNode,
  maxWidth: number,
  out: Float32Array,
  into = scratchLayout,
) {
  if (!t.font) {
    out[0] = 0
    out[1] = 0
    return into
  }
  measureOptions.size = t.size
  measureOptions.lineHeight = t.lineHeight
  measureOptions.maxWidth = t.wrap && !Number.isNaN(maxWidth) ? Math.max(maxWidth, 1e-3) : 0
  layoutText(t.font, t.value, measureOptions, into)
  out[0] = into.width
  out[1] = Math.max(1, into.lineCount) * t.lineHeight * t.size
  return into
}

// --- widget flags ------------------------------------------------------------------------------

const flagStyle = new ResolvedStyle()

/**
 * Recomputes which nodes are widgets and which take the pointer (a visible background or border,
 * an image, or a widget), after anything visual changed.
 */
export function refreshFlags(world: World, r: UiRootState): void {
  for (let i = 0; i < r.count; i++) {
    const e = r.entities[i]!
    r.kind[i] = Kind.None
    r.solid[i] = 0
    r.disabled[i] = 0
    if (!world.isAlive(e)) continue
    const table = world.entityTable(e)
    const row = world.entityRow(e)
    let kind: number = Kind.None
    let disabled = 0
    if (table.has(UiButton)) {
      kind = Kind.Button
      disabled = table.column(UiButton, 'disabled')[row]!
    } else if (table.has(UiToggle)) {
      kind = Kind.Toggle
      disabled = table.column(UiToggle, 'disabled')[row]!
    } else if (table.has(UiSlider)) {
      kind = Kind.Slider
      disabled = table.column(UiSlider, 'disabled')[row]!
    } else if (table.has(UiTextInput)) {
      kind = Kind.TextInput
      disabled = table.column(UiTextInput, 'disabled')[row]!
    }
    r.kind[i] = kind
    r.disabled[i] = disabled
    let solid = kind !== Kind.None || table.has(UiImage) || r.overflow[i] === 2
    if (!solid && table.has(UiStyle)) {
      resolveStyle(
        flagStyle,
        textColumns(table),
        row,
        r.theme,
        table.column(UiNode, 'style')[row] ?? '',
        0,
      )
      solid =
        flagStyle.background[3]! > 0 || (flagStyle.borderWidth > 0 && flagStyle.borderColor[3]! > 0)
    } else if (!solid && r.theme) {
      const name = table.column(UiNode, 'style')[row] ?? ''
      if (name !== '') {
        resolveStyle(flagStyle, textColumns(table), row, r.theme, name, 0)
        solid = flagStyle.background[3]! > 0
      }
    }
    r.solid[i] = solid ? 1 : 0
    const name = table.column(UiNode, 'style')[row] ?? ''
    if (name !== '' && r.theme && !r.theme.styles.has(name)) reportStyle(world, name)
  }
}

function reportStyle(world: World, name: string): void {
  const store = world.resource(UiState)
  if (store.reportedStyles.has(name)) return
  store.reportedStyles.add(name)
  const log = world.tryResource(LogResource)
  if (!log) return
  warn(
    log,
    new ShardError('ui/unknown-style', `No style "${name}" in the UI theme`, {
      hint: "Add it to the root's *.theme.json styles, or fix UiNode.style (ui.describe shows each node's).",
    }),
  )
}

/** Logs a problem that doesn't stop anything as a warning, with its code and hint. */
function warn(log: { warn(message: string, data?: unknown): unknown }, err: ShardError): void {
  log.warn(`${err.code}: ${err.message}`, { code: err.code, hint: err.hint })
}

// --- the layout system ---------------------------------------------------------------------------

interface LayoutState {
  roots: ReturnType<World['query']>
  nodes: ReturnType<World['query']>
  texts: ReturnType<World['query']>
  images: ReturnType<World['query']>
  anchors: ReturnType<World['query']>
  cameras: ReturnType<World['query']>
  inputs: ReturnType<World['query']>
  styles: ReturnType<World['query']>
  widgets: ReturnType<World['query']>[]
  interactions: ReturnType<World['query']>
  measure: (node: number, maxWidth: number, out: Float32Array) => void
  current: UiRootState | undefined
  style: ResolvedStyle
  lastTick: number
}

/** Bumps the visual version (and with `flags`, the widget flags) of roots with changed rows. */
function markVisual(
  store: UiStore,
  tables: readonly Table[],
  def: Parameters<Table['lastChanged']>[0],
  since: number,
  flags: boolean,
): void {
  for (const table of tables) {
    if (table.lastChanged(def) <= since) continue
    const ticks = table.changedTicks(def)
    for (let i = 0; i < table.count; i++) {
      if (ticks[i]! <= since) continue
      const root = store.rootOf.get(table.entities[i]!)
      if (!root) continue
      root.visualVersion++
      if (flags) root.flagsDirty = true
    }
  }
}

/**
 * Marks roots with changed UiNode rows dirty; a changed order or zIndex (or a node no tree has)
 * needs the trees rebuilt.
 */
function markNodes(store: UiStore, tables: readonly Table[], since: number): void {
  for (const table of tables) {
    if (table.lastChanged(UiNode) <= since) continue
    const ticks = table.changedTicks(UiNode)
    const order = table.column(UiNode, 'order')
    const z = table.column(UiNode, 'zIndex')
    for (let i = 0; i < table.count; i++) {
      if (ticks[i]! <= since) continue
      const e = table.entities[i]!
      const root = store.rootOf.get(e)
      if (!root) {
        store.structureDirty = true
        continue
      }
      root.dirty = true
      const k = store.indexOf.get(e)! * 2
      if (order[i] !== root.sortKeys[k] || z[i] !== root.sortKeys[k + 1])
        store.structureDirty = true
    }
  }
}

/** Whether any row of `def` in these tables changed since `since`; marks those rows' roots dirty. */
function markChanged(
  store: UiStore,
  tables: readonly Table[],
  def: Parameters<Table['lastChanged']>[0],
  since: number,
): void {
  for (const table of tables) {
    if (table.lastChanged(def) <= since) continue
    const ticks = table.changedTicks(def)
    for (let i = 0; i < table.count; i++) {
      if (ticks[i]! <= since) continue
      const root = store.rootOf.get(table.entities[i]!)
      if (root) root.dirty = true
      else store.structureDirty = true
    }
  }
}

/**
 * Lays out UI after transform propagation (anchors need world positions). Only roots with a
 * changed node, text, image, root, viewport, font, or theme lay out; anchors that only moved
 * reposition their subtree without a layout.
 */
export const layoutUi = defineSystem({
  name: 'ui/layout',
  description: 'Lays out changed UI trees (flexbox), places anchored nodes, and writes UiLayout.',
  setup: (world): LayoutState => {
    const s: LayoutState = {
      roots: world.query({ with: [UiRoot, UiNode] }),
      nodes: world.query({ with: [UiNode] }),
      texts: world.query({ with: [UiText, UiNode] }),
      images: world.query({ with: [UiImage, UiNode] }),
      anchors: world.query({ with: [UiAnchor, UiNode] }),
      cameras: world.query({ with: [Camera3d, GlobalTransform] }),
      inputs: world.query({ with: [UiTextInput, UiNode] }),
      styles: world.query({ with: [UiStyle, UiNode] }),
      widgets: [
        world.query({ with: [UiButton, UiNode] }),
        world.query({ with: [UiToggle, UiNode] }),
        world.query({ with: [UiSlider, UiNode] }),
      ],
      interactions: world.query({ with: [UiInteraction, UiNode] }),
      measure: () => {},
      current: undefined,
      style: new ResolvedStyle(),
      lastTick: 0,
    }
    s.measure = (node, maxWidth, out) => {
      const r = s.current!
      const text = r.texts[node]
      if (text) {
        measureTextNode(text, maxWidth, out)
        // A text node with an image: the larger of the two.
        if (r.imageW[node]! > out[0]!) out[0] = r.imageW[node]!
        if (r.imageH[node]! > out[1]!) out[1] = r.imageH[node]!
      } else {
        out[0] = r.imageW[node]!
        out[1] = r.imageH[node]!
      }
    }
    return s
  },
  run: (s, world, ctx) => {
    const store = world.resource(UiState)
    store.frame++
    store.layouts = 0
    store.nodesLaidOut = 0
    store.repositions = 0
    store.flexCalls = 0
    const since = s.lastTick
    s.lastTick = ctx.thisRunTick

    markNodes(store, s.nodes.tables, since)
    // Text changes relayout only when the measured string or font changed (syncTexts).
    markChanged(store, s.images.tables, UiImage, since)
    markChanged(store, s.roots.tables, UiRoot, since)
    if (store.structureDirty) {
      store.structureDirty = false
      const roots: Entity[] = []
      for (const table of s.roots.tables)
        for (let i = 0; i < table.count; i++) roots.push(table.entities[i]!)
      rebuildTrees(world, store, roots)
      findOrphans(store, s.nodes.tables)
    }

    const themes = world.tryResource(UiThemes)
    for (const r of store.roots) {
      if (!world.isAlive(r.entity)) continue
      const table = world.entityTable(r.entity)
      const row = world.entityRow(r.entity)
      const scaleMode = table.column(UiRoot, 'scale')[row]!
      const ref = table.column(UiRoot, 'referenceSize')
      const refW = ref[row * 2]!
      const refH = ref[row * 2 + 1]!
      r.order = table.column(UiRoot, 'order')[row]!
      r.camera = cameraFor(world, table.column(UiRoot, 'camera')[row] ?? null, s.cameras.tables)
      const themeRef = table.column(UiRoot, 'theme')[row] as AssetRef<'UiTheme'> | null
      const theme = themes?.get(themeRef)
      if (theme !== r.theme || (theme && theme.version !== r.themeVersion)) {
        r.theme = theme
        r.themeVersion = theme ? theme.version : -1
        r.dirty = true
        r.flagsDirty = true
        r.visualVersion++
      }
      let vw = refW
      let vh = refH
      if (viewportOf(world, r.camera)) {
        vw = viewport[0]!
        vh = viewport[1]!
      }
      const factor = scaleMode === 1 ? vh / refH : scaleMode === 2 ? vw / refW : 1
      if (vw !== r.viewportW || vh !== r.viewportH || factor !== r.factor) {
        r.viewportW = vw
        r.viewportH = vh
        r.factor = factor
        r.width = vw / factor
        r.height = vh / factor
        r.dirty = true
      }
    }

    store.roots.sort((a, b) => a.order - b.order)

    // Text and image sources: a changed font or a texture that loaded dirties its root.
    syncTexts(world, store, s)
    syncImages(world, store, s.images.tables)

    markVisual(store, s.styles.tables, UiStyle, since, true)
    markVisual(store, s.images.tables, UiImage, since, true)
    markVisual(store, s.texts.tables, UiText, since, false)
    markVisual(store, s.inputs.tables, UiTextInput, since, true)
    markVisual(store, s.interactions.tables, UiInteraction, since, false)
    for (const q of s.widgets) markVisual(store, q.tables, q.with[0]!, since, true)

    const anchorsMoved = placeAnchors(world, store, s.anchors.tables)

    let fill = false
    let write = false
    for (const r of store.roots) {
      r.filling = r.dirty
      r.writing = r.dirty || anchorsMoved.has(r)
      if (r.filling) {
        prepareTree(r)
        fill = true
      }
      if (r.writing) write = true
    }
    if (fill) fillNodes(store, s.nodes.tables)
    for (const r of store.roots) {
      if (r.filling) {
        r.dirty = false
        s.current = r
        layoutTree(r.tree, r.width, r.height, s.measure)
        s.current = undefined
        store.layouts++
        store.totalLayouts++
        store.nodesLaidOut += r.count
        store.flexCalls += r.tree.calls
        r.laidOutAt = store.frame
        derive(r)
        r.visualVersion++
      } else if (r.writing) {
        derive(r)
        store.repositions++
        r.visualVersion++
      }
    }
    if (write) writeLayouts(store, s.nodes.tables)
    for (const r of store.roots) {
      if (!r.flagsDirty) continue
      r.flagsDirty = false
      refreshFlags(world, r)
    }
    reportProblems(world, store)
  },
})

const movedRoots = new Set<UiRootState>()

/** UiNode entities no root reaches: invisible, and reported as ui/no-root. */
function findOrphans(store: UiStore, tables: readonly Table[]): void {
  store.orphans.clear()
  for (const table of tables) {
    const visible = table.column(UiLayout, 'visible')
    for (let i = 0; i < table.count; i++) {
      const e = table.entities[i]!
      if (store.rootOf.has(e)) continue
      store.orphans.add(e)
      visible[i] = 0
    }
    table.markChanged(UiLayout)
  }
}

function reportProblems(world: World, store: UiStore): void {
  const log = world.tryResource(LogResource)
  if (!log) return
  for (const e of store.orphans) {
    if (store.reportedOrphans.has(e) || !world.isAlive(e)) continue
    store.reportedOrphans.add(e)
    warn(
      log,
      new ShardError(
        'ui/no-root',
        `UI node ${e} isn't under a UiRoot, so it's not laid out or drawn`,
        {
          hint: 'Parent it (ChildOf) under an entity with ui/UiRoot, or add UiRoot to the top node.',
        },
      ),
    )
  }
}

/** Updates each text node's source (string, font, size); a real change dirties the root. */
function syncTexts(world: World, store: UiStore, s: LayoutState): void {
  const fonts = world.tryResource(Fonts)
  const defaults = world.tryResource(UiDefaults)
  for (const table of s.texts.tables) {
    const c = textColumns(table)
    const styleName = table.column(UiNode, 'style')
    const input = table.has(UiTextInput) ? table.column(UiTextInput, 'value') : undefined
    const placeholder = table.has(UiTextInput)
      ? table.column(UiTextInput, 'placeholder')
      : undefined
    // A localized text shows its resolved string (0038).
    const text = table.has(Localized)
      ? table.column(Localized, 'value')
      : table.column(UiText, 'text')
    for (let i = 0; i < table.count; i++) {
      const e = table.entities[i]!
      const r = store.rootOf.get(e)
      if (!r) continue
      const node = store.indexOf.get(e)!
      resolveStyle(s.style, c, i, r.theme, styleName[i] ?? '', 0)
      const ref = s.style.font ?? defaults?.font ?? null
      const font = fonts?.get(ref)
      let value = text[i] ?? ''
      if (input) value = input[i] || placeholder![i] || ''
      let t = r.texts[node]
      // A respawned tree puts other entities at the same indices: their text starts over.
      if (!t || t.entity !== e) {
        t = {
          entity: e,
          value: '',
          font: undefined,
          fontVersion: -2,
          size: -1,
          lineHeight: 0,
          wrap: true,
          cacheW: new Float32Array(2),
          cacheOut: new Float32Array(4),
          cacheN: 0,
          layout: new TextLayout(),
          laidWidth: -1,
          laidVersion: -1,
        }
        r.texts[node] = t
        r.dirty = true
      }
      const version = font ? font.version : -1
      if (
        t.value !== value ||
        t.font !== font ||
        t.fontVersion !== version ||
        t.size !== s.style.size ||
        t.lineHeight !== s.style.lineHeight ||
        t.wrap !== s.style.wrap
      ) {
        t.value = value
        t.font = font
        t.fontVersion = version
        t.size = s.style.size
        t.lineHeight = s.style.lineHeight
        t.wrap = s.style.wrap
        t.laidVersion = -1
        r.dirty = true
      }
    }
  }
}

/** Intrinsic image sizes: the region's or texture's pixels, once loaded. */
function syncImages(world: World, store: UiStore, tables: readonly Table[]): void {
  const textures = world.tryResource(Textures)
  const atlases = world.tryResource(TextureAtlases)
  for (const table of tables) {
    const texture = table.column(UiImage, 'texture')
    const atlas = table.column(UiImage, 'atlas')
    const region = table.column(UiImage, 'region')
    for (let i = 0; i < table.count; i++) {
      const e = table.entities[i]!
      const r = store.rootOf.get(e)
      if (!r) continue
      const node = store.indexOf.get(e)!
      let w = 0
      let h = 0
      const a = atlas[i] ? atlases?.get(atlas[i]) : undefined
      const ri = a && region[i] ? a.region(region[i]!) : -1
      if (a && ri >= 0) {
        w = a.rects[ri * 4 + 2]!
        h = a.rects[ri * 4 + 3]!
      } else {
        const tex = textures?.get(texture[i])
        if (tex) {
          w = tex.width
          h = tex.height
        }
      }
      if (w !== r.imageW[node] || h !== r.imageH[node]) {
        r.imageW[node] = w
        r.imageH[node] = h
        r.dirty = true
      }
    }
  }
}

interface TextColumnsCache extends StyleColumns {
  table: Table
}
const columnsCache = new WeakMap<Table, TextColumnsCache>()

/** UiStyle and UiText columns of a table (either may be missing). Cached per table. */
export function textColumns(table: Table): StyleColumns {
  let c = columnsCache.get(table)
  // Columns are replaced when a table grows: refresh when the first one moved.
  const text = table.has(UiText)
  const style = table.has(UiStyle)
  if (
    c &&
    (!text || c.size === table.column(UiText, 'size')) &&
    (!style || c.background === table.column(UiStyle, 'background'))
  )
    return c
  c = { table }
  if (style) {
    c.background = table.column(UiStyle, 'background') as unknown as Float32Array
    c.borderColor = table.column(UiStyle, 'borderColor') as unknown as Float32Array
    c.borderWidth = table.column(UiStyle, 'borderWidth')
    c.radius = table.column(UiStyle, 'radius') as unknown as Float32Array
    c.opacity = table.column(UiStyle, 'opacity')
  }
  if (text) {
    c.size = table.column(UiText, 'size')
    c.color = table.column(UiText, 'color') as unknown as Float32Array
    c.font = table.column(UiText, 'font') as (AssetRef<'Font'> | null)[]
    c.align = table.column(UiText, 'align')
    c.wrap = table.column(UiText, 'wrap')
    c.lineHeight = table.column(UiText, 'lineHeight')
  }
  columnsCache.set(table, c)
  return c
}

/** Resets a root's flex tree to its node list, linked parent to children. */
function prepareTree(r: UiRootState): void {
  const t = r.tree
  const n = r.count
  t.reset(n)
  const last = scratchLast(n)
  for (let i = 1; i < n; i++) t.append(r.parent[i]!, i, last)
}

/** Copies UiNode fields into the flex trees of roots being laid out, table by table. */
function fillNodes(store: UiStore, tables: readonly Table[]): void {
  for (const table of tables) {
    const c = nodeColumns(table)
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]!
      const r = store.rootOf.get(e)
      if (!r?.filling) continue
      writeNode(r.tree, r, store.indexOf.get(e)!, c, row)
    }
  }
  // Roots fill the screen, whatever their own sizes say.
  for (const r of store.roots) {
    if (!r.filling) continue
    r.tree.absolute[0] = 0
    r.tree.hidden[0] = 0
  }
}

interface NodeColumns {
  display: Uint8Array
  position: Uint8Array
  direction: Uint8Array
  wrap: Uint8Array
  justify: Uint8Array
  alignItems: Uint8Array
  alignSelf: Uint8Array
  lengths: Float32Array[]
  padding: Float32Array
  margin: Float32Array
  gap: Float32Array
  grow: Float32Array
  shrink: Float32Array
  overflow: Uint8Array
  scroll: Float32Array
  image: boolean
  pivot: Float32Array | undefined
}
const nodeColumnCache = new WeakMap<Table, NodeColumns>()

/** UiNode columns of a table, cached until the table grows (its columns are replaced). */
function nodeColumns(table: Table): NodeColumns {
  const cached = nodeColumnCache.get(table)
  if (cached && cached.display === table.column(UiNode, 'display')) return cached
  const f = (name: string) => table.column(UiNode, name as 'padding') as unknown as Float32Array
  const c: NodeColumns = {
    display: table.column(UiNode, 'display'),
    position: table.column(UiNode, 'position'),
    direction: table.column(UiNode, 'direction'),
    wrap: table.column(UiNode, 'wrap'),
    justify: table.column(UiNode, 'justify'),
    alignItems: table.column(UiNode, 'alignItems'),
    alignSelf: table.column(UiNode, 'alignSelf'),
    lengths: LENGTH_FIELDS.map(f),
    padding: f('padding'),
    margin: f('margin'),
    gap: f('gap'),
    grow: table.column(UiNode, 'grow'),
    shrink: table.column(UiNode, 'shrink'),
    overflow: table.column(UiNode, 'overflow'),
    scroll: f('scroll'),
    image: table.has(UiImage),
    pivot: table.has(UiAnchor)
      ? (table.column(UiAnchor, 'pivot') as unknown as Float32Array)
      : undefined,
  }
  nodeColumnCache.set(table, c)
  return c
}

let lastScratch = new Int32Array(64)
function scratchLast(n: number): Int32Array {
  if (lastScratch.length < n) lastScratch = new Int32Array(n * 2)
  lastScratch.fill(-1, 0, n)
  return lastScratch
}

/** UiNode length fields in flex slot order (L). */
const LENGTH_FIELDS = [
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'left',
  'top',
  'right',
  'bottom',
  'basis',
] as const

function writeNode(t: FlexTree, r: UiRootState, i: number, c: NodeColumns, row: number): void {
  t.hidden[i] = c.display[row]!
  t.absolute[i] = c.position[row]!
  t.direction[i] = c.direction[row]!
  t.wrap[i] = c.wrap[row]!
  t.justify[i] = c.justify[row]!
  t.alignItems[i] = c.alignItems[row]!
  t.alignSelf[i] = c.alignSelf[row]!
  for (let slot = 0; slot < LENGTHS; slot++) {
    const col = c.lengths[slot]!
    const o = (i * LENGTHS + slot) * 2
    t.lengths[o] = col[row * 2]!
    t.lengths[o + 1] = col[row * 2 + 1]!
  }
  for (let k = 0; k < 4; k++) {
    t.padding[i * 4 + k] = c.padding[row * 4 + k]!
    t.margin[i * 4 + k] = c.margin[row * 4 + k]!
  }
  t.gap[i * 2] = c.gap[row * 2]!
  t.gap[i * 2 + 1] = c.gap[row * 2 + 1]!
  t.flexGrow[i] = c.grow[row]!
  t.flexShrink[i] = c.shrink[row]!
  r.overflow[i] = c.overflow[row]!
  r.scrollX[i] = c.scroll[row * 2]!
  r.scrollY[i] = c.scroll[row * 2 + 1]!
  t.measured[i] = r.texts[i] !== undefined || c.image ? 1 : 0
  if (r.anchorKind[i] === 1 && c.pivot) {
    t.anchored[i] = 1
    t.pivotX[i] = c.pivot[row * 2]!
    t.pivotY[i] = c.pivot[row * 2 + 1]!
  }
}

// --- anchors -----------------------------------------------------------------------------------

/**
 * Projects each anchor's target through its root's camera: the point (root pixels), whether it's
 * clamped or hidden, the arrow angle, and the distance scale. Returns the roots whose anchors
 * moved (without anything else changing, they reposition instead of laying out).
 */
function placeAnchors(world: World, store: UiStore, tables: readonly Table[]): Set<UiRootState> {
  movedRoots.clear()
  for (const table of tables) {
    const target = table.column(UiAnchor, 'target')
    const offset = table.column(UiAnchor, 'offset') as unknown as Float32Array
    const screenOffset = table.column(UiAnchor, 'screenOffset') as unknown as Float32Array
    const clamp = table.column(UiAnchor, 'clamp')
    const margin = table.column(UiAnchor, 'margin')
    const hideBehind = table.column(UiAnchor, 'hideBehind')
    const scaleDistance = table.column(UiAnchor, 'scaleDistance')
    const minScale = table.column(UiAnchor, 'minScale')
    const maxScale = table.column(UiAnchor, 'maxScale')
    for (let i = 0; i < table.count; i++) {
      const e = table.entities[i]!
      const r = store.rootOf.get(e)
      if (!r) continue
      const node = store.indexOf.get(e)!
      const t = r.tree
      let state: number = AnchorState.Hidden
      let ax = -1e6
      let ay = -1e6
      let angle = 0
      let distance = 0
      let scale = 1
      const cam = r.camera
      const te = target[i]
      if (
        cam !== null &&
        te !== null &&
        te !== undefined &&
        world.isAlive(te) &&
        world.has(te, GlobalTransform)
      ) {
        const g = world.entityTable(te).column(GlobalTransform, 'matrix') as unknown as Float32Array
        const go = world.entityRow(te) * 12
        const px = g[go + 3]! + offset[i * 3]!
        const py = g[go + 7]! + offset[i * 3 + 1]!
        const pz = g[go + 11]! + offset[i * 3 + 2]!
        const ct = world.entityTable(cam)
        const cr = world.entityRow(cam)
        const m = ct.column(GlobalTransform, 'matrix') as unknown as Float32Array
        const o = cr * 12
        const dx = px - m[o + 3]!
        const dy = py - m[o + 7]!
        const dz = pz - m[o + 11]!
        // Camera axes (columns of its world matrix), unit length.
        const rx = m[o]!,
          ry = m[o + 4]!,
          rz = m[o + 8]!
        const ux = m[o + 1]!,
          uy = m[o + 5]!,
          uz = m[o + 9]!
        const bx = m[o + 2]!,
          by = m[o + 6]!,
          bz = m[o + 10]!
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
        const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1
        const xv = (dx * rx + dy * ry + dz * rz) / rl
        const yv = (dx * ux + dy * uy + dz * uz) / ul
        const zv = (dx * bx + dy * by + dz * bz) / bl
        distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const W = r.width
        const H = r.height
        const aspect = W / Math.max(1e-6, H)
        const ortho = ct.column(Camera3d, 'projection')[cr] !== 0
        let nx: number
        let ny: number
        const behind = ortho ? false : zv >= -1e-6
        if (ortho) {
          const half = ct.column(Camera3d, 'orthoHeight')[cr]! / 2
          nx = xv / (half * aspect)
          ny = yv / half
        } else {
          const f = 1 / Math.tan((ct.column(Camera3d, 'fovY')[cr]! * Math.PI) / 360)
          const depth = Math.max(1e-6, -zv)
          nx = (xv * f) / aspect / depth
          ny = (yv * f) / depth
        }
        const sx = (nx * 0.5 + 0.5) * W + screenOffset[i * 2]!
        const sy = (0.5 - ny * 0.5) * H + screenOffset[i * 2 + 1]!
        const mg = margin[i]!
        const inside = !behind && sx >= mg && sx <= W - mg && sy >= mg && sy <= H - mg
        if (behind && hideBehind[i]) state = AnchorState.Hidden
        else if (inside || (!behind && !clamp[i])) {
          state = AnchorState.OnScreen
          ax = sx
          ay = sy
        } else if (clamp[i]) {
          // From the center toward the target (behind: its side in view space), to the edge.
          let dirX = behind ? xv : sx - W / 2
          let dirY = behind ? -yv : sy - H / 2
          const len = Math.sqrt(dirX * dirX + dirY * dirY)
          if (len < 1e-6) {
            dirX = 0
            dirY = 1
          } else {
            dirX /= len
            dirY /= len
          }
          const hw = Math.max(0, W / 2 - mg)
          const hh = Math.max(0, H / 2 - mg)
          const tx = Math.abs(dirX) > 1e-6 ? hw / Math.abs(dirX) : Number.POSITIVE_INFINITY
          const ty = Math.abs(dirY) > 1e-6 ? hh / Math.abs(dirY) : Number.POSITIVE_INFINITY
          const k = Math.min(tx, ty)
          ax = W / 2 + dirX * k
          ay = H / 2 + dirY * k
          angle = Math.atan2(dirY, dirX)
          state = AnchorState.Clamped
        }
        if (scaleDistance[i]! > 0) {
          scale = scaleDistance[i]! / Math.max(1e-3, distance)
          if (scale < minScale[i]!) scale = minScale[i]!
          if (scale > maxScale[i]!) scale = maxScale[i]!
        }
      }
      if (
        t.anchorX[node] !== ax ||
        t.anchorY[node] !== ay ||
        r.anchorState[node] !== state ||
        r.angle[node] !== angle ||
        r.anchorScale[node] !== scale ||
        r.distance[node] !== distance
      ) {
        t.anchorX[node] = ax
        t.anchorY[node] = ay
        r.anchorState[node] = state
        r.angle[node] = angle
        r.distance[node] = distance
        r.anchorScale[node] = scale
        movedRoots.add(r)
      }
    }
  }
  return movedRoots
}

// --- derived rects -----------------------------------------------------------------------------

/**
 * Absolute rects from the flex tree: parents' positions, scroll offsets, anchor points and
 * scales; clips from ancestors that clip or scroll; visibility (display none, hidden anchors,
 * arrows of anchors that aren't clamped); content size for scrolling.
 */
export function derive(r: UiRootState): void {
  const t = r.tree
  const n = r.count
  for (let i = 0; i < n; i++) {
    const p = r.parent[i]!
    let x: number
    let y: number
    let s: number
    let visible: boolean
    if (p < 0) {
      x = 0
      y = 0
      s = 1
      visible = true
      r.clip[0] = 0
      r.clip[1] = 0
      r.clip[2] = r.width
      r.clip[3] = r.height
    } else {
      visible = r.visible[p] !== 0 && t.hidden[i] === 0
      if (t.anchored[i]) {
        s = r.scale[p]! * r.anchorScale[i]!
        const w = t.w[i]! * s
        const h = t.h[i]! * s
        x = t.anchorX[i]! - t.pivotX[i]! * w
        y = t.anchorY[i]! - t.pivotY[i]! * h
        if (r.anchorState[i] === AnchorState.Hidden) visible = false
      } else {
        s = r.scale[p]!
        x = r.x[p]! + (t.x[i]! - r.scrollX[p]!) * s
        y = r.y[p]! + (t.y[i]! - r.scrollY[p]!) * s
        if (r.anchorKind[i] === 2 && r.anchorState[p] !== AnchorState.Clamped) visible = false
      }
      for (let k = 0; k < 4; k++) r.clip[i * 4 + k] = r.childClip[p * 4 + k]!
    }
    r.w[i] = t.w[i]! * s
    r.h[i] = t.h[i]! * s
    if (r.anchorKind[i] === 2 && p >= 0) {
      // An arrow sits just outside its marker's edge, toward the target, pointing at it.
      const a = r.angle[p]!
      r.angle[i] = a
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const hw = r.w[p]! / 2
      const hh = r.h[p]! / 2
      const k = Math.min(
        Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY,
        Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY,
      )
      const reach = k + 4 * s + r.w[i]! / 2
      x = r.x[p]! + hw + dx * reach - r.w[i]! / 2
      y = r.y[p]! + hh + dy * reach - r.h[i]! / 2
    }
    r.x[i] = x
    r.y[i] = y
    r.scale[i] = s
    r.visible[i] = visible && t.hidden[i] === 0 ? 1 : 0
    // Content extent (for scroll limits): the far edges of in-flow children, plus padding.
    let cw = 0
    let ch = 0
    for (let c = i + 1; c < r.end[i]!; c = r.end[c]!) {
      if (t.hidden[c] || t.anchored[c]) continue
      const right = t.x[c]! + t.w[c]! + t.margin[c * 4 + 1]!
      const bottom = t.y[c]! + t.h[c]! + t.margin[c * 4 + 2]!
      if (right > cw) cw = right
      if (bottom > ch) ch = bottom
    }
    cw += t.padding[i * 4 + 1]!
    ch += t.padding[i * 4 + 2]!
    r.contentW[i] = cw
    r.contentH[i] = ch
    if (r.overflow[i] === Overflow.Scroll) {
      const maxX = Math.max(0, cw - t.w[i]!)
      const maxY = Math.max(0, ch - t.h[i]!)
      r.scrollX[i] = Math.min(Math.max(0, r.scrollX[i]!), maxX)
      r.scrollY[i] = Math.min(Math.max(0, r.scrollY[i]!), maxY)
    } else {
      r.scrollX[i] = 0
      r.scrollY[i] = 0
    }
    const o = i * 4
    if (r.overflow[i] !== Overflow.Visible) {
      r.childClip[o] = Math.max(r.clip[o]!, x)
      r.childClip[o + 1] = Math.max(r.clip[o + 1]!, y)
      r.childClip[o + 2] = Math.min(r.clip[o + 2]!, x + r.w[i]!)
      r.childClip[o + 3] = Math.min(r.clip[o + 3]!, y + r.h[i]!)
    } else {
      for (let k = 0; k < 4; k++) r.childClip[o + k] = r.clip[o + k]!
    }
  }
}

interface LayoutColumns {
  x: Float32Array
  y: Float32Array
  width: Float32Array
  height: Float32Array
  clip: Float32Array
  content: Float32Array
  scale: Float32Array
  angle: Float32Array
  visible: Uint8Array
  anchor: Uint8Array
  distance: Float32Array
}
const layoutColumnCache = new WeakMap<Table, LayoutColumns>()

function layoutColumns(table: Table): LayoutColumns {
  const cached = layoutColumnCache.get(table)
  if (cached && cached.x === table.column(UiLayout, 'x')) return cached
  const c: LayoutColumns = {
    x: table.column(UiLayout, 'x'),
    y: table.column(UiLayout, 'y'),
    width: table.column(UiLayout, 'width'),
    height: table.column(UiLayout, 'height'),
    clip: table.column(UiLayout, 'clip') as unknown as Float32Array,
    content: table.column(UiLayout, 'content') as unknown as Float32Array,
    scale: table.column(UiLayout, 'scale'),
    angle: table.column(UiLayout, 'angle'),
    visible: table.column(UiLayout, 'visible'),
    anchor: table.column(UiLayout, 'anchor'),
    distance: table.column(UiLayout, 'distance'),
  }
  layoutColumnCache.set(table, c)
  return c
}

/** Writes UiLayout for the nodes of roots laid out or repositioned this frame. */
function writeLayouts(store: UiStore, tables: readonly Table[]): void {
  for (const table of tables) {
    const c = layoutColumns(table)
    let wrote = false
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]!
      const r = store.rootOf.get(e)
      if (!r?.writing) continue
      const i = store.indexOf.get(e)!
      wrote = true
      const x = r.x[i]!
      const y = r.y[i]!
      const w = r.w[i]!
      const h = r.h[i]!
      c.x[row] = x
      c.y[row] = y
      c.width[row] = w
      c.height[row] = h
      // The visible part of the node itself.
      const vx0 = Math.max(r.clip[i * 4]!, x)
      const vy0 = Math.max(r.clip[i * 4 + 1]!, y)
      const vx1 = Math.min(r.clip[i * 4 + 2]!, x + w)
      const vy1 = Math.min(r.clip[i * 4 + 3]!, y + h)
      c.clip[row * 4] = vx0
      c.clip[row * 4 + 1] = vy0
      c.clip[row * 4 + 2] = Math.max(0, vx1 - vx0)
      c.clip[row * 4 + 3] = Math.max(0, vy1 - vy0)
      c.content[row * 2] = r.contentW[i]!
      c.content[row * 2 + 1] = r.contentH[i]!
      c.scale[row] = r.scale[i]!
      c.angle[row] = r.angle[i]!
      c.visible[row] = r.visible[i]!
      c.anchor[row] = r.anchorKind[i] === 1 ? r.anchorState[i]! : 0
      c.distance[row] = r.anchorKind[i] === 1 ? r.distance[i]! : 0
    }
    if (wrote) table.markChanged(UiLayout)
  }
}
