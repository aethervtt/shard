/**
 * Kerning pairs straight from the font's bytes: GPOS pair adjustment (lookup type 2, also inside
 * type 9 extension lookups, which opentype.js doesn't read) under the `kern` feature. Only pairs
 * between the given glyphs are collected. Values are in font units.
 */

function tableOffset(view: DataView, tag: string): number {
  if (view.byteLength < 12) return -1
  const count = view.getUint16(4)
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16
    if (rec + 16 > view.byteLength) return -1
    let name = ''
    for (let c = 0; c < 4; c++) name += String.fromCharCode(view.getUint8(rec + c))
    if (name === tag) return view.getUint32(rec + 8)
  }
  return -1
}

/** Coverage table → glyph → coverage index. */
function readCoverage(view: DataView, offset: number): Map<number, number> {
  const out = new Map<number, number>()
  const format = view.getUint16(offset)
  if (format === 1) {
    const count = view.getUint16(offset + 2)
    for (let i = 0; i < count; i++) out.set(view.getUint16(offset + 4 + i * 2), i)
  } else if (format === 2) {
    const count = view.getUint16(offset + 2)
    for (let i = 0; i < count; i++) {
      const rec = offset + 4 + i * 6
      const start = view.getUint16(rec)
      const end = view.getUint16(rec + 2)
      const index = view.getUint16(rec + 4)
      for (let g = start; g <= end; g++) out.set(g, index + g - start)
    }
  }
  return out
}

/** Class definition table → glyph → class (absent means class 0). */
function readClassDef(view: DataView, offset: number): Map<number, number> {
  const out = new Map<number, number>()
  const format = view.getUint16(offset)
  if (format === 1) {
    const start = view.getUint16(offset + 2)
    const count = view.getUint16(offset + 4)
    for (let i = 0; i < count; i++) out.set(start + i, view.getUint16(offset + 6 + i * 2))
  } else if (format === 2) {
    const count = view.getUint16(offset + 2)
    for (let i = 0; i < count; i++) {
      const rec = offset + 4 + i * 6
      const start = view.getUint16(rec)
      const end = view.getUint16(rec + 2)
      const cls = view.getUint16(rec + 4)
      for (let g = start; g <= end; g++) out.set(g, cls)
    }
  }
  return out
}

function popcount(v: number): number {
  let n = 0
  for (let x = v; x; x >>= 1) n += x & 1
  return n
}

/**
 * The horizontal kerning a pair value record pair contributes: the first glyph's x advance plus
 * the second glyph's x placement (both move the second glyph right).
 */
function pairValue(view: DataView, rec: number, format1: number, format2: number): number {
  let v = 0
  if (format1 & 0x4) v += view.getInt16(rec + 2 * popcount(format1 & 0x3))
  if (format2 & 0x1) v += view.getInt16(rec + 2 * popcount(format1))
  return v
}

const pairKey = (a: number, b: number) => a * 65536 + b

export function readGposKerning(bytes: Uint8Array, glyphs: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const gpos = tableOffset(view, 'GPOS')
  if (gpos < 0) return out
  const wanted = [...new Set(glyphs)]
  const featureList = gpos + view.getUint16(gpos + 6)
  const lookupList = gpos + view.getUint16(gpos + 8)
  const lookupIndices = new Set<number>()
  const featureCount = view.getUint16(featureList)
  for (let i = 0; i < featureCount; i++) {
    const rec = featureList + 2 + i * 6
    let tag = ''
    for (let c = 0; c < 4; c++) tag += String.fromCharCode(view.getUint8(rec + c))
    if (tag !== 'kern') continue
    const feature = featureList + view.getUint16(rec + 4)
    const count = view.getUint16(feature + 2)
    for (let j = 0; j < count; j++) lookupIndices.add(view.getUint16(feature + 4 + j * 2))
  }
  const lookupCount = view.getUint16(lookupList)
  for (const index of [...lookupIndices].sort((a, b) => a - b)) {
    if (index >= lookupCount) continue
    const lookup = lookupList + view.getUint16(lookupList + 2 + index * 2)
    const type = view.getUint16(lookup)
    const subCount = view.getUint16(lookup + 4)
    // Within a lookup, the first subtable that matches a pair wins; lookups add up.
    const matched = new Set<number>()
    for (let s = 0; s < subCount; s++) {
      let sub = lookup + view.getUint16(lookup + 6 + s * 2)
      let subType = type
      if (type === 9) {
        subType = view.getUint16(sub + 2)
        sub += view.getUint32(sub + 4)
      }
      if (subType !== 2) continue
      readPairPos(view, sub, wanted, matched, out)
    }
  }
  for (const [k, v] of out) if (v === 0) out.delete(k)
  return out
}

function readPairPos(
  view: DataView,
  sub: number,
  wanted: number[],
  matched: Set<number>,
  out: Map<number, number>,
): void {
  const format = view.getUint16(sub)
  const coverage = readCoverage(view, sub + view.getUint16(sub + 2))
  const format1 = view.getUint16(sub + 4)
  const format2 = view.getUint16(sub + 6)
  const recordSize = 2 * (popcount(format1) + popcount(format2))
  if (format === 1) {
    const setOffsets = sub + 10
    for (const g1 of wanted) {
      const ci = coverage.get(g1)
      if (ci === undefined) continue
      const set = sub + view.getUint16(setOffsets + ci * 2)
      const count = view.getUint16(set)
      const seconds = new Map<number, number>()
      for (let i = 0; i < count; i++) {
        const rec = set + 2 + i * (2 + recordSize)
        seconds.set(view.getUint16(rec), rec + 2)
      }
      for (const g2 of wanted) {
        const rec = seconds.get(g2)
        const key = pairKey(g1, g2)
        if (rec === undefined || matched.has(key)) continue
        matched.add(key)
        out.set(key, (out.get(key) ?? 0) + pairValue(view, rec, format1, format2))
      }
    }
  } else if (format === 2) {
    const class1 = readClassDef(view, sub + view.getUint16(sub + 8))
    const class2 = readClassDef(view, sub + view.getUint16(sub + 10))
    const class1Count = view.getUint16(sub + 12)
    const class2Count = view.getUint16(sub + 14)
    const records = sub + 16
    for (const g1 of wanted) {
      if (!coverage.has(g1)) continue
      const c1 = class1.get(g1) ?? 0
      if (c1 >= class1Count) continue
      for (const g2 of wanted) {
        const key = pairKey(g1, g2)
        if (matched.has(key)) continue
        const c2 = class2.get(g2) ?? 0
        if (c2 >= class2Count) continue
        matched.add(key)
        const rec = records + (c1 * class2Count + c2) * recordSize
        const v = pairValue(view, rec, format1, format2)
        if (v !== 0) out.set(key, (out.get(key) ?? 0) + v)
      }
    }
  }
}

/** Whether the font has a GPOS `kern` feature (then the legacy `kern` table is ignored). */
export function hasGposKerning(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const gpos = tableOffset(view, 'GPOS')
  if (gpos < 0) return false
  const featureList = gpos + view.getUint16(gpos + 6)
  const count = view.getUint16(featureList)
  for (let i = 0; i < count; i++) {
    const rec = featureList + 2 + i * 6
    let tag = ''
    for (let c = 0; c < 4; c++) tag += String.fromCharCode(view.getUint8(rec + c))
    if (tag === 'kern') return true
  }
  return false
}
