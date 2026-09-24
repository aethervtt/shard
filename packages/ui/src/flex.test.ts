import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CASES, type FlexCaseNode } from '../fixtures/flex-cases.mjs'
import { Align, Dir, FlexTree, Justify, L, layoutTree } from './flex'
import { parseLength } from './length'

const here = dirname(fileURLToPath(import.meta.url))
const chrome = JSON.parse(readFileSync(resolve(here, '../fixtures/flex.chrome.json'), 'utf8')) as {
  cases: Record<string, ([number, number, number, number] | null)[]>
}

const DIRS = {
  row: Dir.Row,
  column: Dir.Column,
  'row-reverse': Dir.RowReverse,
  'column-reverse': Dir.ColumnReverse,
}
const JUSTIFY = {
  start: Justify.Start,
  center: Justify.Center,
  end: Justify.End,
  'space-between': Justify.SpaceBetween,
  'space-around': Justify.SpaceAround,
  'space-evenly': Justify.SpaceEvenly,
}
const ALIGN = { stretch: Align.Stretch, start: Align.Start, center: Align.Center, end: Align.End }

/** Builds a FlexTree from a case, in preorder; returns each node's parent. */
function build(root: FlexCaseNode) {
  const nodes: { node: FlexCaseNode; parent: number }[] = []
  const walk = (node: FlexCaseNode, parent: number) => {
    nodes.push({ node, parent })
    const self = nodes.length - 1
    for (const child of node.children ?? []) walk(child, self)
  }
  walk(root, -1)
  const t = new FlexTree()
  t.reset(nodes.length)
  const last = new Int32Array(nodes.length).fill(-1)
  // Children in order (stable), as the ECS tree builder sorts them.
  const byParent = new Map<number, number[]>()
  nodes.forEach(({ parent }, i) => {
    if (parent >= 0) byParent.set(parent, [...(byParent.get(parent) ?? []), i])
  })
  for (const [parent, kids] of byParent) {
    const order = (i: number) => (nodes[i]!.node.style?.order as number | undefined) ?? 0
    for (const k of [...kids].sort((a, b) => order(a) - order(b))) t.append(parent, k, last)
  }
  nodes.forEach(({ node }, i) => {
    const s = node.style ?? {}
    if (s.display === 'none') t.hidden[i] = 1
    if (s.position === 'absolute') t.absolute[i] = 1
    t.direction[i] = DIRS[(s.direction as keyof typeof DIRS) ?? 'row']
    t.wrap[i] = s.wrap ? 1 : 0
    t.justify[i] = JUSTIFY[(s.justify as keyof typeof JUSTIFY) ?? 'start']
    t.alignItems[i] = ALIGN[(s.alignItems as keyof typeof ALIGN) ?? 'stretch']
    t.alignSelf[i] = s.alignSelf ? ALIGN[s.alignSelf as keyof typeof ALIGN] + 1 : 0
    for (const [key, slot] of Object.entries(L)) {
      if (s[key] === undefined) continue
      const [v, unit] = parseLength(s[key])!
      t.setLength(i, slot, v, unit)
    }
    if (s.padding) t.padding.set(s.padding as number[], i * 4)
    if (s.margin) t.margin.set(s.margin as number[], i * 4)
    if (s.gap) t.gap.set(s.gap as number[], i * 2)
    t.flexGrow[i] = (s.grow as number | undefined) ?? 0
    t.flexShrink[i] = (s.shrink as number | undefined) ?? 1
  })
  return { t, parents: nodes.map((n) => n.parent), rootStyle: root.style ?? {} }
}

function rects(root: FlexCaseNode) {
  const { t, parents, rootStyle } = build(root)
  layoutTree(t, rootStyle.width as number, rootStyle.height as number, () => {})
  const abs: [number, number, number, number][] = []
  parents.forEach((parent, i) => {
    const px = parent >= 0 ? abs[parent]![0] : 0
    const py = parent >= 0 ? abs[parent]![1] : 0
    abs.push([px + t.x[i]!, py + t.y[i]!, t.w[i]!, t.h[i]!])
  })
  return { abs, t }
}

describe('flexbox layout', () => {
  it('has a Chrome measurement for every case', () => {
    expect(Object.keys(chrome.cases).sort()).toEqual(CASES.map((c) => c.name).sort())
  })

  for (const c of CASES) {
    it(`matches Chrome: ${c.name}`, () => {
      const { abs } = rects(c.root)
      const expected = chrome.cases[c.name]!
      expect(abs.length).toBe(expected.length)
      expected.forEach((rect, i) => {
        if (rect === null) return
        for (let k = 0; k < 4; k++) {
          expect(
            abs[i]![k],
            `node ${i} [${'xywh'[k]}]: got ${abs[i]!.map((v) => +v.toFixed(2))}, chrome ${rect}`,
          ).toBeCloseTo(rect[k]!, 1)
        }
      })
    })
  }
})
