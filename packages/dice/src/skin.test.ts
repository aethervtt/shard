import type { AssetRef } from '@aethervtt/shard-core'
import { beforeAll, describe, expect, it } from 'vitest'
import { BUILTIN_DICE, registerBuiltinDice } from './builtins'
import { dieGeometry } from './definition'
import { diceEffectRecipe, matchRecipes, recipeProblems } from './effects'
import './families'
import { cellLayout } from './cells'
import { registerBuiltinGlyphs } from './glyphs'
import {
  defaultLayoutFor,
  type FaceLayoutValue,
  NUMBERS_LAYOUT,
  PIPS_LAYOUT,
  resolveMark,
} from './layout'
import { bakeMarks, markPlacements } from './marks'
import { dieMesh } from './mesh'
import { expandRoll } from './roll'
import { BUILTIN_SKINS, diceSkin, validateDiceSkin } from './skin'

beforeAll(() => {
  registerBuiltinDice()
  registerBuiltinGlyphs()
})

const ref = (guid: string): AssetRef => ({ type: 'x', guid, path: undefined })

describe('skins', () => {
  it('validates every built-in skin', () => {
    for (const json of Object.values(BUILTIN_SKINS))
      expect(validateDiceSkin(diceSkin(json))).toEqual([])
  })

  it('fails an unknown family, a layout missing a value, and a recipe over its bounds, each with a path', () => {
    const unknown = validateDiceSkin(diceSkin({ id: 'a', family: 'dice/NoSuchDice' }))
    expect(unknown.map((e) => [e.code, e.path])).toEqual([['dice/unknown-family', '/family']])

    const params = validateDiceSkin(
      diceSkin({ id: 'b', params: { baseColor: '#ffffff', sparkle: 2, marks: null } }),
    )
    expect(params.map((e) => e.path).sort()).toEqual(['/params/marks', '/params/sparkle'])

    // Pips go up to 9: a pips layout on a d20 can't show 10 to 20.
    const layouts: Record<string, FaceLayoutValue> = { pips: PIPS_LAYOUT }
    const pips = validateDiceSkin(
      diceSkin({ id: 'c', variants: { d20: { layout: { guid: 'pips' } } } }),
      {
        layout: (r) => layouts[r.guid!],
      },
    )
    expect(pips.length).toBe(11)
    expect(pips.every((e) => e.code === 'dice/layout-missing-value')).toBe(true)
    expect(pips[0]!.path).toBe('/variants/d20/layout/default')
    expect(pips[0]!.message).toContain("can't show 10 on a d20")

    const glyphs: FaceLayoutValue = {
      ...NUMBERS_LAYOUT,
      id: 'glyphs',
      overrides: [
        { value: 4, mark: { ...NUMBERS_LAYOUT.default, kind: 'glyph', glyph: 'no-such-glyph' } },
      ],
    }
    const glyph = validateDiceSkin(
      diceSkin({ id: 'd', variants: { d6: { layout: { guid: 'g' } } } }),
      {
        layout: () => glyphs,
      },
    )
    expect(glyph.map((e) => e.path)).toEqual(['/variants/d6/layout/overrides/0/mark'])

    const recipes = {
      big: diceEffectRecipe({
        id: 'big',
        conditions: Array.from({ length: 9 }, () => ({ kind: 'die' })),
        effects: [{ kind: 'particle-burst', count: 40, colors: ['#ffffff'] }],
      }),
    }
    const bounds = validateDiceSkin(diceSkin({ id: 'e', effects: [{ guid: 'big' }] }), {
      recipe: (r) => recipes[r.guid as 'big'],
    })
    expect(bounds.map((e) => [e.code, e.path])).toEqual([
      ['dice/recipe-bounds', '/effects/0/conditions'],
      ['dice/recipe-bounds', '/effects/0/effects/0/count'],
    ])
    const tooMany = validateDiceSkin(
      diceSkin({ id: 'f', effects: [1, 2, 3, 4, 5].map((i) => ({ guid: `r${i}` })) }),
      {
        recipe: () => recipes.big,
      },
    )
    expect(tooMany[0]!.path).toBe('/effects')
  })
})

describe('recipes', () => {
  const skin = ref('s')
  it('matches conditions against the roll, anchoring only kept dice', () => {
    const dice = expandRoll({
      id: 'r',
      dice: [
        { kind: 'd20', value: 20, skin },
        { kind: 'd20', value: 20, skin, dropped: true },
        { kind: 'percentile', value: 100, skin },
      ],
    })
    const recipe = (json: Record<string, unknown>) =>
      diceEffectRecipe({ id: 'x', effects: [{ kind: 'sound-accent' }], ...json })
    const roll = { id: 'r', dice: [], total: 20, source: { mine: true, gm: false }, tags: ['crit'] }
    const match = (json: Record<string, unknown>) =>
      matchRecipes([recipe(json)], roll, dice).matched
    expect(match({ conditions: [{ kind: 'die', die: 'd20', value: 20 }] })[0]!.anchors).toEqual([0])
    expect(match({ conditions: [{ kind: 'die', state: 'dropped' }] })[0]!.anchors).toEqual([])
    expect(match({ conditions: [{ kind: 'die', face: '00' }] })[0]!.anchors).toEqual([2])
    expect(match({ conditions: [{ kind: 'total', compare: 'gte', total: 21 }] })).toEqual([])
    expect(
      match({
        conditions: [
          { kind: 'source', source: 'mine' },
          { kind: 'tag', tag: 'crit' },
        ],
      }),
    ).toHaveLength(1)
    expect(
      match({
        match: 'any',
        conditions: [
          { kind: 'tag', tag: 'nope' },
          { kind: 'source', source: 'gm' },
        ],
      }),
    ).toEqual([])
    // The same recipe twice plays once; at most 4 play.
    const many = Array.from({ length: 6 }, (_, i) => recipe({ id: `r${i}` }))
    const out = matchRecipes([...many, many[0]!], roll, dice)
    expect(out.matched).toHaveLength(4)
    expect(out.degraded).toBe(true)
    expect(recipeProblems(recipe({ effects: [] }))[0]!.path).toBe('/effects')
  })
})

describe('marks and meshes', () => {
  it('bakes a mark into every face cell, for every built-in and its default layout', () => {
    for (const def of BUILTIN_DICE) {
      const g = dieGeometry(def)
      const atlas = bakeMarks(g, defaultLayoutFor(def))
      const cells = cellLayout(g)
      expect(atlas.width).toBe(cells.cols * cells.cell)
      for (const face of cells.faces) {
        // Some texel of the cell is inside a mark (median above the outline).
        let inside = 0
        for (let y = 0; y < cells.cell; y++) {
          for (let x = 0; x < cells.cell; x++) {
            const o = ((face.row * cells.cell + y) * atlas.width + face.col * cells.cell + x) * 4
            const [r, gg, b] = [atlas.pixels[o]!, atlas.pixels[o + 1]!, atlas.pixels[o + 2]!]
            if (Math.max(Math.min(r, gg), Math.min(Math.max(r, gg), b)) > 140) inside++
          }
        }
        expect(inside, `${def.id} face ${face.face}`).toBeGreaterThan(20)
      }
      // Cached by what went into it.
      expect(bakeMarks(g, defaultLayoutFor(def))).toBe(atlas)
    }
  })

  it('keeps every mark’s ink on its flat face, at one size per die, the definition’s where it fits', () => {
    const inside = (poly: number[], x: number, y: number) => {
      let sign = 0
      for (let i = 0; i < poly.length; i += 2) {
        const j = (i + 2) % poly.length
        const cross =
          (poly[j]! - poly[i]!) * (y - poly[i + 1]!) -
          (poly[j + 1]! - poly[i + 1]!) * (x - poly[i]!)
        if (Math.abs(cross) < 1e-9) continue
        if (sign === 0) sign = Math.sign(cross)
        else if (Math.sign(cross) !== sign) return false
      }
      return true
    }
    for (const def of BUILTIN_DICE) {
      const g = dieGeometry(def)
      const layout = defaultLayoutFor(def)
      const placed = markPlacements(g, layout)
      expect(new Set(placed.flat().map((p) => p.height.toFixed(6))).size, def.id).toBe(1)
      for (const p of placed.flat()) expect(p.fit, def.id).toBeGreaterThanOrEqual(p.height - 1e-6)
      // Read back from the bake: every texel of ink lies in its face's (or corner's) region.
      const atlas = bakeMarks(g, layout)
      const cells = cellLayout(g)
      for (const face of cells.faces) {
        const regions = placed[face.face]!.map((p) => p.region)
        for (let row = 0; row < cells.cell; row++) {
          for (let x = 0; x < cells.cell; x++) {
            const o = ((face.row * cells.cell + row) * atlas.width + face.col * cells.cell + x) * 4
            const [r, gg, b] = [atlas.pixels[o]!, atlas.pixels[o + 1]!, atlas.pixels[o + 2]!]
            if (Math.max(Math.min(r, gg), Math.min(Math.max(r, gg), b)) <= 128) continue
            const y = cells.cell - 1 - row + 0.5
            expect(
              regions.some((poly) => inside(poly, x + 0.5, y)),
              `${def.id} face ${face.face} ink at ${x},${y}`,
            ).toBe(true)
          }
        }
      }
    }
    // Roomy faces keep the definition's size.
    const d6 = dieGeometry(BUILTIN_DICE.find((d) => d.id === 'd6')!)
    const cells = cellLayout(d6)
    const preferred = 0.5 * cells.cell * (1 - 2 * cells.pad)
    expect(markPlacements(d6, NUMBERS_LAYOUT)[0]![0]!.height).toBeCloseTo(preferred, 6)
  })

  it('underlines labels that read as another label upside down', () => {
    const d20 = BUILTIN_DICE.find((d) => d.id === 'd20')!
    const d8 = BUILTIN_DICE.find((d) => d.id === 'd8')!
    const ball = BUILTIN_DICE.find((d) => d.id === 'd100-ball')!
    expect(resolveMark(NUMBERS_LAYOUT, d20, 6).underline).toBe(true)
    expect(resolveMark(NUMBERS_LAYOUT, d20, 9).underline).toBe(true)
    expect(resolveMark(NUMBERS_LAYOUT, d20, 16).underline).toBe(false)
    // No 9 on a d8: its 6 can't be mistaken.
    expect(resolveMark(NUMBERS_LAYOUT, d8, 6).underline).toBe(false)
    expect(resolveMark(NUMBERS_LAYOUT, ball, 18).underline).toBe(true)
    expect(resolveMark(NUMBERS_LAYOUT, ball, 69).underline).toBe(false)
  })

  it('builds closed, outward-facing meshes whose faces map inside their cells', () => {
    for (const def of BUILTIN_DICE) {
      const g = dieGeometry(def)
      const mesh = dieMesh(g)
      const idx = mesh.indices!
      expect(idx.length % 3).toBe(0)
      const p = mesh.positions
      // Every triangle faces away from the center.
      for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
        const e1 = [
          p[b * 3]! - p[a * 3]!,
          p[b * 3 + 1]! - p[a * 3 + 1]!,
          p[b * 3 + 2]! - p[a * 3 + 2]!,
        ]
        const e2 = [
          p[c * 3]! - p[a * 3]!,
          p[c * 3 + 1]! - p[a * 3 + 1]!,
          p[c * 3 + 2]! - p[a * 3 + 2]!,
        ]
        const n = [
          e1[1]! * e2[2]! - e1[2]! * e2[1]!,
          e1[2]! * e2[0]! - e1[0]! * e2[2]!,
          e1[0]! * e2[1]! - e1[1]! * e2[0]!,
        ]
        const center = [0, 1, 2].map((k) => (p[a * 3 + k]! + p[b * 3 + k]! + p[c * 3 + k]!) / 3)
        expect(
          n[0]! * center[0]! + n[1]! * center[1]! + n[2]! * center[2]!,
          `${def.id} triangle ${t / 3}`,
        ).toBeGreaterThan(-1e-7)
      }
      // Face vertices (uv1.x = 1) sit inside their own cell.
      const cells = cellLayout(g)
      const uv = mesh.uvs!
      const uv1 = mesh.uvs1!
      for (let v = 0; v < mesh.vertexCount; v++) {
        if (uv1[v * 2] !== 1) continue
        const cell = cells.faces[uv1[v * 2 + 1]!]!
        const u = uv[v * 2]! * cells.cols - cell.col
        const w = uv[v * 2 + 1]! * cells.rows - cell.row
        expect(u).toBeGreaterThanOrEqual(0)
        expect(u).toBeLessThanOrEqual(1)
        expect(w).toBeGreaterThanOrEqual(0)
        expect(w).toBeLessThanOrEqual(1)
      }
    }
  })
})
