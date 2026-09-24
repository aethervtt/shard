/**
 * The flexbox subset UI lays out with, over a flat node array (no ECS, no allocation per layout
 * once the arrays are big enough). Sizes are border-box pixels; borders draw inside the box and
 * take no space. Follows CSS Flexbox §9 for the fields UiNode has: basis, grow and shrink with
 * min/max freezing, wrap with stretched lines, justify, align-items/align-self, absolute children
 * (static position from justify and align), relative offsets, percentages of the parent's inner
 * size, and order. Differences from a browser: an item's automatic minimum size is its min-content
 * size only for text and image leaves (containers may shrink to their padding), and there's no
 * align-content (lines stretch, as CSS's default does).
 */

/** Length slots per node, two floats each (value, unit). */
export const L = {
  width: 0,
  height: 1,
  minWidth: 2,
  maxWidth: 3,
  minHeight: 4,
  maxHeight: 5,
  left: 6,
  top: 7,
  right: 8,
  bottom: 9,
  basis: 10,
} as const
export const LENGTHS = 11

export const Dir = { Row: 0, Column: 1, RowReverse: 2, ColumnReverse: 3 } as const
export const Justify = {
  Start: 0,
  Center: 1,
  End: 2,
  SpaceBetween: 3,
  SpaceAround: 4,
  SpaceEvenly: 5,
} as const
/** alignItems values; alignSelf is these plus 1 (0 = auto). */
export const Align = { Stretch: 0, Start: 1, Center: 2, End: 3 } as const

/** Content size of a leaf (text, image): writes width and height (content box) into `out`. */
export type Measure = (node: number, maxWidth: number, out: Float32Array) => void

const PX = 0
const PERCENT = 1

function grow<T extends Float32Array | Int32Array | Uint8Array>(a: T, n: number): T {
  if (a.length >= n) return a
  let len = Math.max(64, a.length * 2)
  while (len < n) len *= 2
  const out = new (a.constructor as new (n: number) => T)(len)
  out.set(a)
  return out
}

const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b))

/**
 * Nodes and their layout inputs and outputs, as typed arrays indexed by node. Node 0 is laid out
 * at the size given to `layout`; each node's children are a linked list (firstChild, nextSibling)
 * in flow order.
 */
export class FlexTree {
  count = 0
  firstChild = new Int32Array(64)
  nextSibling = new Int32Array(64)
  /** 1: display none (skipped with its subtree). */
  hidden = new Uint8Array(64)
  absolute = new Uint8Array(64)
  direction = new Uint8Array(64)
  wrap = new Uint8Array(64)
  justify = new Uint8Array(64)
  alignItems = new Uint8Array(64)
  alignSelf = new Uint8Array(64)
  /** Per node, LENGTHS × (value, unit). */
  lengths = new Float32Array(64 * LENGTHS * 2)
  /** top, right, bottom, left. */
  padding = new Float32Array(64 * 4)
  margin = new Float32Array(64 * 4)
  /** horizontal, vertical. */
  gap = new Float32Array(64 * 2)
  flexGrow = new Float32Array(64)
  flexShrink = new Float32Array(64)
  /** 1: a leaf measured by the Measure callback (text, image). */
  measured = new Uint8Array(64)
  /** 1: positioned by `anchorX/Y` (root coordinates) minus pivot × size, ignoring its parent. */
  anchored = new Uint8Array(64)
  anchorX = new Float32Array(64)
  anchorY = new Float32Array(64)
  pivotX = new Float32Array(64)
  pivotY = new Float32Array(64)
  /** Output: position relative to the parent's border box, and border-box size. */
  x = new Float32Array(64)
  y = new Float32Array(64)
  w = new Float32Array(64)
  h = new Float32Array(64)
  /** Measure-only results, and the inputs they were measured for. */
  mw = new Float32Array(64)
  mh = new Float32Array(64)
  cache = new Float32Array(64 * 6)
  cacheValid = new Uint8Array(64)
  /** Layout calls this pass (measure and perform), for describe. */
  calls = 0

  reserve(n: number): void {
    if (this.firstChild.length >= n) return
    this.firstChild = grow(this.firstChild, n)
    this.nextSibling = grow(this.nextSibling, n)
    this.hidden = grow(this.hidden, n)
    this.absolute = grow(this.absolute, n)
    this.direction = grow(this.direction, n)
    this.wrap = grow(this.wrap, n)
    this.justify = grow(this.justify, n)
    this.alignItems = grow(this.alignItems, n)
    this.alignSelf = grow(this.alignSelf, n)
    this.lengths = grow(this.lengths, n * LENGTHS * 2)
    this.padding = grow(this.padding, n * 4)
    this.margin = grow(this.margin, n * 4)
    this.gap = grow(this.gap, n * 2)
    this.flexGrow = grow(this.flexGrow, n)
    this.flexShrink = grow(this.flexShrink, n)
    this.measured = grow(this.measured, n)
    this.anchored = grow(this.anchored, n)
    this.anchorX = grow(this.anchorX, n)
    this.anchorY = grow(this.anchorY, n)
    this.pivotX = grow(this.pivotX, n)
    this.pivotY = grow(this.pivotY, n)
    this.x = grow(this.x, n)
    this.y = grow(this.y, n)
    this.w = grow(this.w, n)
    this.h = grow(this.h, n)
    this.mw = grow(this.mw, n)
    this.mh = grow(this.mh, n)
    this.cache = grow(this.cache, n * 6)
    this.cacheValid = grow(this.cacheValid, n)
  }

  /** Clears to `n` nodes with default inputs (row, stretch, auto sizes, shrink 1). */
  reset(n: number): void {
    this.reserve(n)
    this.count = n
    this.firstChild.fill(-1, 0, n)
    this.nextSibling.fill(-1, 0, n)
    this.hidden.fill(0, 0, n)
    this.absolute.fill(0, 0, n)
    this.direction.fill(0, 0, n)
    this.wrap.fill(0, 0, n)
    this.justify.fill(0, 0, n)
    this.alignItems.fill(0, 0, n)
    this.alignSelf.fill(0, 0, n)
    const len = this.lengths
    for (let i = 0; i < n * LENGTHS; i++) {
      len[i * 2] = 0
      len[i * 2 + 1] = 2
    }
    this.padding.fill(0, 0, n * 4)
    this.margin.fill(0, 0, n * 4)
    this.gap.fill(0, 0, n * 2)
    this.flexGrow.fill(0, 0, n)
    this.flexShrink.fill(1, 0, n)
    this.measured.fill(0, 0, n)
    this.anchored.fill(0, 0, n)
  }

  /** Sets a length slot: unit 0 px, 1 percent, 2 auto. */
  setLength(node: number, slot: number, value: number, unit: number): void {
    const o = (node * LENGTHS + slot) * 2
    this.lengths[o] = value
    this.lengths[o + 1] = unit
  }

  /** Appends `child` to `parent`'s children (after its last). */
  append(parent: number, child: number, last: Int32Array): void {
    if (last[parent]! < 0) this.firstChild[parent] = child
    else this.nextSibling[last[parent]!] = child
    last[parent] = child
  }
}

// --- per-call scratch, a stack: each call reserves its items before recursing -------------------

let itemNode = new Int32Array(256)
/** Per item: base, hypothetical main, target main, min main, max main, cross, main margins, own cross. */
let itemF = new Float32Array(256 * 8)
let top = 0
let lineStart = new Int32Array(64)
let lineCount = new Int32Array(64)
let lineCross = new Float32Array(64)
let lineTop = 0
const measureOut = new Float32Array(2)
/** Per item of the line being resolved: frozen, and which bound it hit (1 min, 2 max). */
let frozenFlags = new Uint8Array(256)
let violationFlags = new Uint8Array(256)

const F_BASE = 0
const F_HYP = 1
const F_TARGET = 2
const F_MIN = 3
const F_MAX = 4
const F_CROSS = 5
const F_MARGIN = 6
const F_DEFINITE_CROSS = 7

function reserveItems(n: number): number {
  const start = top
  top += n
  if (itemNode.length < top) {
    itemNode = grow(itemNode, top)
    itemF = grow(itemF, top * 8)
  }
  return start
}

function reserveLines(n: number): number {
  const start = lineTop
  lineTop += n
  if (lineStart.length < lineTop) {
    lineStart = grow(lineStart, lineTop)
    lineCount = grow(lineCount, lineTop)
    lineCross = grow(lineCross, lineTop)
  }
  return start
}

function resolve(t: FlexTree, n: number, slot: number, ref: number): number {
  const o = (n * LENGTHS + slot) * 2
  const unit = t.lengths[o + 1]!
  if (unit === PX) return t.lengths[o]!
  if (unit === PERCENT) return (ref * t.lengths[o]!) / 100
  return Number.NaN
}

/** Clamps a border-box size by min and max (min wins), and by the padding it must hold. */
function clampSize(
  t: FlexTree,
  n: number,
  size: number,
  minSlot: number,
  maxSlot: number,
  ref: number,
  pad: number,
): number {
  const max = resolve(t, n, maxSlot, ref)
  if (!Number.isNaN(max) && size > max) size = max
  const min = resolve(t, n, minSlot, ref)
  if (!Number.isNaN(min) && size < min) size = min
  return size < pad ? pad : size
}

const isRow = (d: number) => d === Dir.Row || d === Dir.RowReverse
const isReverse = (d: number) => d === Dir.RowReverse || d === Dir.ColumnReverse

function alignOf(t: FlexTree, parent: number, child: number): number {
  const self = t.alignSelf[child]!
  return self === 0 ? t.alignItems[parent]! : self - 1
}

/**
 * Lays out the tree from node 0 at a given size: every node's x, y (relative to its parent),
 * w, h. `measure` sizes text and image leaves.
 */
export function layoutTree(t: FlexTree, width: number, height: number, measure: Measure): void {
  t.calls = 0
  t.cacheValid.fill(0, 0, t.count)
  frozenFlags = grow(frozenFlags, t.count)
  violationFlags = grow(violationFlags, t.count)
  top = 0
  lineTop = 0
  t.x[0] = 0
  t.y[0] = 0
  layoutNode(t, measure, 0, width, height, width, height, width, height, true)
}

/**
 * Sizes node `n` (knownW/H: its border box if the parent decided it, else NaN), and with
 * `perform` places its children. Measure-only calls write `mw`/`mh` and are cached per node.
 */
function layoutNode(
  t: FlexTree,
  measure: Measure,
  n: number,
  knownW: number,
  knownH: number,
  availW: number,
  availH: number,
  ownerW: number,
  ownerH: number,
  perform: boolean,
): void {
  if (!perform && t.cacheValid[n]) {
    const c = t.cache
    const o = n * 6
    if (
      same(c[o]!, knownW) &&
      same(c[o + 1]!, knownH) &&
      same(c[o + 2]!, availW) &&
      same(c[o + 3]!, availH) &&
      same(c[o + 4]!, ownerW) &&
      same(c[o + 5]!, ownerH)
    )
      return
  }
  t.calls++
  const p = t.padding
  const padT = p[n * 4]!
  const padR = p[n * 4 + 1]!
  const padB = p[n * 4 + 2]!
  const padL = p[n * 4 + 3]!
  const padH = padL + padR
  const padV = padT + padB
  let w = knownW
  let h = knownH
  if (Number.isNaN(w)) {
    w = resolve(t, n, L.width, ownerW)
    if (!Number.isNaN(w)) w = clampSize(t, n, w, L.minWidth, L.maxWidth, ownerW, padH)
  }
  if (Number.isNaN(h)) {
    h = resolve(t, n, L.height, ownerH)
    if (!Number.isNaN(h)) h = clampSize(t, n, h, L.minHeight, L.maxHeight, ownerH, padV)
  }
  if (!perform && !Number.isNaN(w) && !Number.isNaN(h)) {
    finishMeasure(t, n, w, h, knownW, knownH, availW, availH, ownerW, ownerH)
    return
  }
  if (!Number.isNaN(availW)) {
    const max = resolve(t, n, L.maxWidth, ownerW)
    if (!Number.isNaN(max) && availW > max) availW = max
  }
  const dir = t.direction[n]!
  const row = isRow(dir)
  const gapMain = row ? t.gap[n * 2]! : t.gap[n * 2 + 1]!
  const gapCross = row ? t.gap[n * 2 + 1]! : t.gap[n * 2]!

  // In-flow children, in order; absolute ones are placed after.
  let k = 0
  let absolutes = 0
  for (let c = t.firstChild[n]!; c >= 0; c = t.nextSibling[c]!) {
    if (t.hidden[c]) continue
    if (t.absolute[c] || t.anchored[c]) absolutes++
    else k++
  }

  if (k === 0 && t.measured[n] && (Number.isNaN(w) || Number.isNaN(h))) {
    // A leaf: its content (text wraps at the width it gets).
    const innerW = !Number.isNaN(w)
      ? w - padH
      : !Number.isNaN(availW)
        ? Math.max(0, availW - padH)
        : Number.NaN
    measure(n, innerW, measureOut)
    if (Number.isNaN(w)) {
      w = clampSize(t, n, measureOut[0]! + padH, L.minWidth, L.maxWidth, ownerW, padH)
      // Clamped narrower or wider than its text: the height is the text's at that width.
      if (measureOut[0]! + padH !== w) measure(n, w - padH, measureOut)
    }
    if (Number.isNaN(h))
      h = clampSize(t, n, measureOut[1]! + padV, L.minHeight, L.maxHeight, ownerH, padV)
    if (!perform) {
      finishMeasure(t, n, w, h, knownW, knownH, availW, availH, ownerW, ownerH)
      return
    }
    t.w[n] = w
    t.h[n] = h
    if (absolutes > 0) placeAbsolutes(t, measure, n, w, h)
    return
  }

  let innerW = !Number.isNaN(w) ? w - padH : Number.NaN
  let innerH = !Number.isNaN(h) ? h - padV : Number.NaN
  let mainInner = row ? innerW : innerH
  let crossInner = row ? innerH : innerW
  const availCrossInner = row
    ? !Number.isNaN(availH)
      ? availH - padV
      : Number.NaN
    : !Number.isNaN(availW)
      ? availW - padH
      : Number.NaN
  const _availMainInner = row
    ? !Number.isNaN(availW)
      ? availW - padH
      : Number.NaN
    : !Number.isNaN(availH)
      ? availH - padV
      : Number.NaN

  const start = reserveItems(k)
  const f = itemF
  {
    let i = start
    for (let c = t.firstChild[n]!; c >= 0; c = t.nextSibling[c]!) {
      if (t.hidden[c] || t.absolute[c] || t.anchored[c]) continue
      itemNode[i++] = c
    }
  }
  const wrap = t.wrap[n] !== 0

  // Base and hypothetical main sizes.
  for (let i = start; i < start + k; i++) {
    const c = itemNode[i]!
    const m = t.margin
    const mMain = row ? m[c * 4 + 3]! + m[c * 4 + 1]! : m[c * 4]! + m[c * 4 + 2]!
    const mCross = row ? m[c * 4]! + m[c * 4 + 2]! : m[c * 4 + 3]! + m[c * 4 + 1]!
    const cp = t.padding
    const cPadMain = row ? cp[c * 4 + 3]! + cp[c * 4 + 1]! : cp[c * 4]! + cp[c * 4 + 2]!
    const cPadCross = row ? cp[c * 4]! + cp[c * 4 + 2]! : cp[c * 4 + 3]! + cp[c * 4 + 1]!
    // The cross size it will have, if definite: its own, or stretched in a single line.
    let crossKnown = resolve(t, c, row ? L.height : L.width, crossInner)
    if (!Number.isNaN(crossKnown)) {
      crossKnown = clampSize(
        t,
        c,
        crossKnown,
        row ? L.minHeight : L.minWidth,
        row ? L.maxHeight : L.maxWidth,
        crossInner,
        cPadCross,
      )
    }
    f[i * 8 + F_DEFINITE_CROSS] = crossKnown
    if (
      Number.isNaN(crossKnown) &&
      !wrap &&
      !Number.isNaN(crossInner) &&
      alignOf(t, n, c) === Align.Stretch
    ) {
      crossKnown = clampSize(
        t,
        c,
        Math.max(0, crossInner - mCross),
        row ? L.minHeight : L.minWidth,
        row ? L.maxHeight : L.maxWidth,
        crossInner,
        cPadCross,
      )
    }
    let base = resolve(t, c, L.basis, mainInner)
    if (Number.isNaN(base)) base = resolve(t, c, row ? L.width : L.height, mainInner)
    let content = Number.NaN
    if (Number.isNaN(base)) {
      // Content size: measured at max-content along the main axis.
      if (row) {
        layoutNode(
          t,
          measure,
          c,
          Number.NaN,
          crossKnown,
          Number.NaN,
          availCrossInner - mCross,
          innerW,
          innerH,
          false,
        )
        base = t.mw[c]!
      } else {
        const aw = !Number.isNaN(crossKnown) ? crossKnown : availCrossInner - mCross
        layoutNode(t, measure, c, crossKnown, Number.NaN, aw, Number.NaN, innerW, innerH, false)
        base = t.mh[c]!
      }
      content = base
    }
    let min = resolve(t, c, row ? L.minWidth : L.minHeight, mainInner)
    if (Number.isNaN(min)) {
      // Automatic minimum: text and images don't shrink below their min-content size.
      min = 0
      if (t.measured[c] && t.firstChild[c]! < 0) {
        if (row) {
          measure(c, 0, measureOut)
          min = measureOut[0]! + cPadMain
        } else {
          if (Number.isNaN(content)) {
            const aw = !Number.isNaN(crossKnown) ? crossKnown : availCrossInner - mCross
            layoutNode(t, measure, c, crossKnown, Number.NaN, aw, Number.NaN, innerW, innerH, false)
            content = t.mh[c]!
          }
          min = content
        }
        const specified = resolve(t, c, row ? L.width : L.height, mainInner)
        if (!Number.isNaN(specified) && specified < min) min = specified
        const max = resolve(t, c, row ? L.maxWidth : L.maxHeight, mainInner)
        if (!Number.isNaN(max) && max < min) min = max
      }
    }
    if (min < cPadMain) min = cPadMain
    let max = resolve(t, c, row ? L.maxWidth : L.maxHeight, mainInner)
    if (Number.isNaN(max)) max = Number.POSITIVE_INFINITY
    let hyp = base
    if (hyp > max) hyp = max
    if (hyp < min) hyp = min
    f[i * 8 + F_BASE] = base
    f[i * 8 + F_HYP] = hyp
    f[i * 8 + F_TARGET] = hyp
    f[i * 8 + F_MIN] = min
    f[i * 8 + F_MAX] = max
    f[i * 8 + F_CROSS] = crossKnown
    f[i * 8 + F_MARGIN] = mMain
  }

  // The container's main size, when it's sized by its content: its max-content size, every item
  // on one line (then lines break at that size).
  if (Number.isNaN(mainInner)) {
    let content = gapMain * Math.max(0, k - 1)
    for (let i = start; i < start + k; i++) content += f[i * 8 + F_HYP]! + f[i * 8 + F_MARGIN]!
    if (row) {
      w = clampSize(t, n, content + padH, L.minWidth, L.maxWidth, ownerW, padH)
      innerW = w - padH
      mainInner = innerW
    } else {
      h = clampSize(t, n, content + padV, L.minHeight, L.maxHeight, ownerH, padV)
      innerH = h - padV
      mainInner = innerH
    }
  }

  // Lines: wrap at the inner main size (or the space available when measuring).
  const lines = reserveLines(Math.max(1, k))
  let lineN = 0
  const limit = mainInner
  {
    let used = 0
    let inLine = 0
    for (let i = start; i < start + k; i++) {
      const outer = f[i * 8 + F_HYP]! + f[i * 8 + F_MARGIN]!
      if (wrap && inLine > 0 && !Number.isNaN(limit) && used + gapMain + outer > limit + 1e-3) {
        lineN++
        used = 0
        inLine = 0
      }
      if (inLine === 0) {
        lineStart[lines + lineN] = i
        lineCount[lines + lineN] = 0
      }
      used += (inLine > 0 ? gapMain : 0) + outer
      lineCount[lines + lineN]!++
      inLine++
    }
    if (k > 0) lineN++
  }

  // Flexible lengths, per line (CSS Flexbox §9.7).
  for (let l = lines; l < lines + lineN; l++)
    resolveFlexible(t, lineStart[l]!, lineCount[l]!, mainInner, gapMain)

  // Hypothetical cross sizes: definite, or measured at the resolved main size.
  for (let i = start; i < start + k; i++) {
    const c = itemNode[i]!
    let cross = f[i * 8 + F_DEFINITE_CROSS]!
    if (Number.isNaN(cross)) {
      const m = t.margin
      const mCross = row ? m[c * 4]! + m[c * 4 + 2]! : m[c * 4 + 3]! + m[c * 4 + 1]!
      const main = f[i * 8 + F_TARGET]!
      if (row) {
        layoutNode(
          t,
          measure,
          c,
          main,
          Number.NaN,
          main,
          availCrossInner - mCross,
          innerW,
          innerH,
          false,
        )
        cross = t.mh[c]!
      } else {
        const aw = !Number.isNaN(crossInner) ? crossInner - mCross : availCrossInner - mCross
        layoutNode(t, measure, c, Number.NaN, main, aw, main, innerW, innerH, false)
        cross = t.mw[c]!
      }
    }
    f[i * 8 + F_CROSS] = cross
  }
  let crossSum = 0
  for (let l = lines; l < lines + lineN; l++) {
    let lc = 0
    for (let i = lineStart[l]!; i < lineStart[l]! + lineCount[l]!; i++) {
      const c = itemNode[i]!
      const m = t.margin
      const mCross = row ? m[c * 4]! + m[c * 4 + 2]! : m[c * 4 + 3]! + m[c * 4 + 1]!
      const outer = f[i * 8 + F_CROSS]! + mCross
      if (outer > lc) lc = outer
    }
    lineCross[l] = lc
    crossSum += lc
  }
  crossSum += gapCross * Math.max(0, lineN - 1)
  if (Number.isNaN(crossInner)) {
    if (row) {
      h = clampSize(t, n, crossSum + padV, L.minHeight, L.maxHeight, ownerH, padV)
      innerH = h - padV
      crossInner = innerH
    } else {
      w = clampSize(t, n, crossSum + padH, L.minWidth, L.maxWidth, ownerW, padH)
      innerW = w - padH
      crossInner = innerW
    }
  }
  if (!wrap && lineN === 1) lineCross[lines] = crossInner
  else if (lineN > 0 && crossInner > crossSum) {
    // Lines stretch to fill the container (align-content: normal).
    const extra = (crossInner - crossSum) / lineN
    for (let l = lines; l < lines + lineN; l++) lineCross[l] = lineCross[l]! + extra
  }

  if (!perform) {
    top = start
    lineTop = lines
    finishMeasure(t, n, w, h, knownW, knownH, availW, availH, ownerW, ownerH)
    return
  }
  t.w[n] = w
  t.h[n] = h

  // Positions: justify along the main axis, align on the cross axis.
  const reverse = isReverse(dir)
  const justify = t.justify[n]!
  let lineOffset = 0
  for (let l = lines; l < lines + lineN; l++) {
    const first = lineStart[l]!
    const count = lineCount[l]!
    let used = gapMain * Math.max(0, count - 1)
    for (let i = first; i < first + count; i++) {
      const c = itemNode[i]!
      const m = t.margin
      used +=
        f[i * 8 + F_TARGET]! + (row ? m[c * 4 + 3]! + m[c * 4 + 1]! : m[c * 4]! + m[c * 4 + 2]!)
    }
    const free = mainInner - used
    let pos = 0
    let between = gapMain
    let mode: number = justify
    // Distributions fall back to start when the items overflow (a safe alignment).
    if (free < 0 && mode >= Justify.SpaceBetween) mode = Justify.Start
    if (mode === Justify.Center) pos = free / 2
    else if (mode === Justify.End) pos = free
    else if (mode === Justify.SpaceBetween) between += count > 1 ? free / (count - 1) : 0
    else if (mode === Justify.SpaceAround) {
      pos = free / count / 2
      between += free / count
    } else if (mode === Justify.SpaceEvenly) {
      pos = free / (count + 1)
      between += free / (count + 1)
    }
    const lc = lineCross[l]!
    for (let i = first; i < first + count; i++) {
      const c = itemNode[i]!
      const m = t.margin
      // Margins on the main-start and main-end sides (swapped when the direction runs backward).
      const mA = row ? m[c * 4 + 3]! : m[c * 4]!
      const mB = row ? m[c * 4 + 1]! : m[c * 4 + 2]!
      const mStart = reverse ? mB : mA
      const mEnd = reverse ? mA : mB
      const mCrossStart = row ? m[c * 4]! : m[c * 4 + 3]!
      const mCrossEnd = row ? m[c * 4 + 2]! : m[c * 4 + 1]!
      const main = f[i * 8 + F_TARGET]!
      let cross = f[i * 8 + F_CROSS]!
      const align = alignOf(t, n, c)
      if (align === Align.Stretch && Number.isNaN(f[i * 8 + F_DEFINITE_CROSS]!)) {
        const cp = t.padding
        const cPadCross = row ? cp[c * 4]! + cp[c * 4 + 2]! : cp[c * 4 + 3]! + cp[c * 4 + 1]!
        cross = clampSize(
          t,
          c,
          Math.max(0, lc - mCrossStart - mCrossEnd),
          row ? L.minHeight : L.minWidth,
          row ? L.maxHeight : L.maxWidth,
          crossInner,
          cPadCross,
        )
      }
      const free = lc - cross - mCrossStart - mCrossEnd
      const crossPos =
        lineOffset +
        mCrossStart +
        (align === Align.Center ? free / 2 : align === Align.End ? free : 0)
      let mainPos = pos + mStart
      if (reverse) mainPos = mainInner - mainPos - main
      pos += mStart + main + mEnd + between
      let x: number
      let y: number
      let cw: number
      let ch: number
      if (row) {
        x = padL + mainPos
        y = padT + crossPos
        cw = main
        ch = cross
      } else {
        x = padL + crossPos
        y = padT + mainPos
        cw = cross
        ch = main
      }
      // Relative offsets nudge without affecting siblings.
      const left = resolve(t, c, L.left, innerW)
      const right = resolve(t, c, L.right, innerW)
      const topO = resolve(t, c, L.top, innerH)
      const bottom = resolve(t, c, L.bottom, innerH)
      if (!Number.isNaN(left)) x += left
      else if (!Number.isNaN(right)) x -= right
      if (!Number.isNaN(topO)) y += topO
      else if (!Number.isNaN(bottom)) y -= bottom
      t.x[c] = x
      t.y[c] = y
      layoutNode(t, measure, c, cw, ch, Number.NaN, Number.NaN, innerW, innerH, true)
    }
    lineOffset += lc + gapCross
  }
  top = start
  lineTop = lines
  if (absolutes > 0) placeAbsolutes(t, measure, n, w, h)
}

function finishMeasure(
  t: FlexTree,
  n: number,
  w: number,
  h: number,
  knownW: number,
  knownH: number,
  availW: number,
  availH: number,
  ownerW: number,
  ownerH: number,
): void {
  t.mw[n] = w
  t.mh[n] = h
  const c = t.cache
  const o = n * 6
  c[o] = knownW
  c[o + 1] = knownH
  c[o + 2] = availW
  c[o + 3] = availH
  c[o + 4] = ownerW
  c[o + 5] = ownerH
  t.cacheValid[n] = 1
}

/** Grows or shrinks one line's items to fill `inner` (§9.7, with min/max violations frozen). */
function resolveFlexible(
  t: FlexTree,
  first: number,
  count: number,
  inner: number,
  gap: number,
): void {
  const f = itemF
  let sumHyp = gap * Math.max(0, count - 1)
  for (let i = first; i < first + count; i++) sumHyp += f[i * 8 + F_HYP]! + f[i * 8 + F_MARGIN]!
  const growing = sumHyp < inner
  let unfrozen = 0
  for (let i = first; i < first + count; i++) {
    const c = itemNode[i]!
    const factor = growing ? t.flexGrow[c]! : t.flexShrink[c]!
    const base = f[i * 8 + F_BASE]!
    const hyp = f[i * 8 + F_HYP]!
    const frozen = factor === 0 || (growing && base > hyp) || (!growing && base < hyp)
    frozenFlags[i - first] = frozen ? 1 : 0
    f[i * 8 + F_TARGET] = hyp
    if (!frozen) unfrozen++
  }
  if (unfrozen === 0) return
  let initialFree = inner - gap * Math.max(0, count - 1)
  for (let i = first; i < first + count; i++) {
    const margin = f[i * 8 + F_MARGIN]!
    initialFree -= margin + (frozenFlags[i - first] ? f[i * 8 + F_TARGET]! : f[i * 8 + F_BASE]!)
  }
  for (let iteration = 0; iteration < count + 1 && unfrozen > 0; iteration++) {
    let free = inner - gap * Math.max(0, count - 1)
    let sumFactor = 0
    let sumScaled = 0
    for (let i = first; i < first + count; i++) {
      const c = itemNode[i]!
      const margin = f[i * 8 + F_MARGIN]!
      if (frozenFlags[i - first]) free -= margin + f[i * 8 + F_TARGET]!
      else {
        free -= margin + f[i * 8 + F_BASE]!
        sumFactor += growing ? t.flexGrow[c]! : t.flexShrink[c]!
        sumScaled += t.flexShrink[c]! * f[i * 8 + F_BASE]!
      }
    }
    if (sumFactor < 1) {
      const scaled = initialFree * sumFactor
      if (Math.abs(scaled) < Math.abs(free)) free = scaled
    }
    let violation = 0
    for (let i = first; i < first + count; i++) {
      if (frozenFlags[i - first]) continue
      const c = itemNode[i]!
      const base = f[i * 8 + F_BASE]!
      let target = base
      if (growing) {
        if (sumFactor > 0) target = base + (free * t.flexGrow[c]!) / sumFactor
      } else if (sumScaled > 0) {
        target = base + (free * t.flexShrink[c]! * base) / sumScaled
      }
      const min = f[i * 8 + F_MIN]!
      const max = f[i * 8 + F_MAX]!
      let clamped = target
      if (clamped > max) clamped = max
      if (clamped < min) clamped = min
      violation += clamped - target
      f[i * 8 + F_TARGET] = clamped
      violationFlags[i - first] = clamped > target ? 1 : clamped < target ? 2 : 0
    }
    // Freeze: all (no violation), the min violators (positive), or the max violators (negative).
    for (let i = first; i < first + count; i++) {
      if (frozenFlags[i - first]) continue
      const v = violationFlags[i - first]!
      if (Math.abs(violation) < 1e-6 || (violation > 0 && v === 1) || (violation < 0 && v === 2)) {
        frozenFlags[i - first] = 1
        unfrozen--
      }
    }
  }
}

/** Absolute children: offsets in the padding box, or the static position from justify/align. */
function placeAbsolutes(t: FlexTree, measure: Measure, n: number, w: number, h: number): void {
  const p = t.padding
  const padT = p[n * 4]!
  const padR = p[n * 4 + 1]!
  const padB = p[n * 4 + 2]!
  const padL = p[n * 4 + 3]!
  const dir = t.direction[n]!
  const row = isRow(dir)
  const reverse = isReverse(dir)
  for (let c = t.firstChild[n]!; c >= 0; c = t.nextSibling[c]!) {
    if (t.hidden[c] || !(t.absolute[c] || t.anchored[c])) continue
    const m = t.margin
    const mT = m[c * 4]!
    const mR = m[c * 4 + 1]!
    const mB = m[c * 4 + 2]!
    const mL = m[c * 4 + 3]!
    const anchored = t.anchored[c] !== 0
    const left = anchored ? Number.NaN : resolve(t, c, L.left, w)
    const right = anchored ? Number.NaN : resolve(t, c, L.right, w)
    const topO = anchored ? Number.NaN : resolve(t, c, L.top, h)
    const bottom = anchored ? Number.NaN : resolve(t, c, L.bottom, h)
    const cp = t.padding
    const cPadH = cp[c * 4 + 1]! + cp[c * 4 + 3]!
    const cPadV = cp[c * 4]! + cp[c * 4 + 2]!
    let cw = resolve(t, c, L.width, w)
    if (Number.isNaN(cw) && !Number.isNaN(left) && !Number.isNaN(right))
      cw = Math.max(0, w - left - right - mL - mR)
    if (!Number.isNaN(cw)) cw = clampSize(t, c, cw, L.minWidth, L.maxWidth, w, cPadH)
    let ch = resolve(t, c, L.height, h)
    if (Number.isNaN(ch) && !Number.isNaN(topO) && !Number.isNaN(bottom))
      ch = Math.max(0, h - topO - bottom - mT - mB)
    if (!Number.isNaN(ch)) ch = clampSize(t, c, ch, L.minHeight, L.maxHeight, h, cPadV)
    if (Number.isNaN(cw) || Number.isNaN(ch)) {
      const aw = w - (!Number.isNaN(left) ? left : 0) - (!Number.isNaN(right) ? right : 0) - mL - mR
      layoutNode(t, measure, c, cw, ch, aw, Number.NaN, w, h, false)
      if (Number.isNaN(cw)) cw = t.mw[c]!
      if (Number.isNaN(ch)) {
        // Height at the width it settled on.
        layoutNode(t, measure, c, cw, Number.NaN, cw, Number.NaN, w, h, false)
        ch = t.mh[c]!
      }
    }
    let x: number
    let y: number
    if (anchored) {
      // Root coordinates; the tree pass doesn't add the parent's position for anchored nodes.
      x = t.anchorX[c]! - t.pivotX[c]! * cw
      y = t.anchorY[c]! - t.pivotY[c]! * ch
    } else {
      const innerW = w - padL - padR
      const innerH = h - padT - padB
      // Static position: as if it were the only item (justify on the main axis, align on cross).
      let justify: number = t.justify[n]!
      if (justify === Justify.SpaceBetween) justify = Justify.Start
      else if (justify >= Justify.SpaceAround) justify = Justify.Center
      if (reverse)
        justify =
          justify === Justify.Start
            ? Justify.End
            : justify === Justify.End
              ? Justify.Start
              : justify
      let align = alignOf(t, n, c)
      if (align === Align.Stretch) align = Align.Start
      const mainMode = justify === Justify.Start ? 0 : justify === Justify.Center ? 1 : 2
      const crossMode = align === Align.Start ? 0 : align === Align.Center ? 1 : 2
      const xMode = row ? mainMode : crossMode
      const yMode = row ? crossMode : mainMode
      if (!Number.isNaN(left)) x = left + mL
      else if (!Number.isNaN(right)) x = w - right - mR - cw
      else {
        const free = innerW - cw - mL - mR
        x = padL + mL + (xMode === 1 ? free / 2 : xMode === 2 ? free : 0)
      }
      if (!Number.isNaN(topO)) y = topO + mT
      else if (!Number.isNaN(bottom)) y = h - bottom - mB - ch
      else {
        const free = innerH - ch - mT - mB
        y = padT + mT + (yMode === 1 ? free / 2 : yMode === 2 ? free : 0)
      }
    }
    t.x[c] = x
    t.y[c] = y
    layoutNode(t, measure, c, cw, ch, Number.NaN, Number.NaN, w, h, true)
  }
}
