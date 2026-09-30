import { Rng, type ShardError } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_DICE,
  D6,
  D10,
  D10_TENS,
  D100_BALL,
  percentileValues,
  registerBuiltinDice,
} from './builtins'
import {
  type DieDefinition,
  defineDie,
  dieGeometry,
  findDie,
  frameOf,
  labelOf,
  validateDieDefinition,
} from './definition'
import { pointsOf } from './hull'
import { landingCorrection, markAngle, naturalValue, restRotation } from './landing'
import { length, type Q4, qAxisAngle, qMul, qNormalize, qRotate, sub, type V3 } from './math'

/** A uniformly random rotation (Shoemake). */
function randomRotation(rng: Rng): Q4 {
  const u1 = rng.float()
  const u2 = rng.float()
  const u3 = rng.float()
  const a = Math.sqrt(1 - u1)
  const b = Math.sqrt(u1)
  return [
    a * Math.sin(2 * Math.PI * u2),
    a * Math.cos(2 * Math.PI * u2),
    b * Math.sin(2 * Math.PI * u3),
    b * Math.cos(2 * Math.PI * u3),
  ]
}

/** The same die with its vertices in another order (and its value keys following them). */
function shuffled(def: DieDefinition, seed: number): DieDefinition {
  const rng = new Rng(seed)
  const n = def.vertices.length / 3
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  // New index k holds old vertex order[k].
  const newIndexOf = new Map(order.map((old, k) => [old, k]))
  const vertices = new Float32Array(n * 3)
  order.forEach((old, k) => {
    vertices.set(def.vertices.subarray(old * 3, old * 3 + 3), k * 3)
  })
  const values: Record<string, number> = {}
  for (const [key, value] of Object.entries(def.values)) {
    const ids = key.split(':').map((id) => newIndexOf.get(Number(id))!)
    values[ids.sort((a, b) => a - b).join(':')] = value
  }
  return { ...def, id: `${def.id}-shuffled`, vertices, values }
}

/** Value by direction: what a player would see, whatever the ids. */
function valueByDirection(def: DieDefinition): [V3, number][] {
  return dieGeometry(def).frames.map((f) => [f.normal, f.value])
}

/** Rotations about a value's axis that map the die onto itself: 180° / this is the best twist. */
function stabilizer(def: DieDefinition, value: number): number {
  const g = dieGeometry(def)
  const n = frameOf(g, value).normal
  return g.symmetries.filter((q) => length(sub(qRotate(q, n), n)) < 1e-4).length
}

describe('die definitions', () => {
  it('validates every built-in, with the symmetry groups of the solids', () => {
    for (const def of BUILTIN_DICE) expect(validateDieDefinition(def), def.id).toEqual([])
    const order = (id: string) =>
      dieGeometry(BUILTIN_DICE.find((d) => d.id === id)!).symmetries.length
    expect(order('d4')).toBe(12)
    expect(order('d6')).toBe(24)
    expect(order('d8')).toBe(24)
    expect(order('d10')).toBe(10)
    expect(order('d12')).toBe(60)
    expect(order('d20')).toBe(60)
    // A ball: every rotation, so none are listed.
    expect(order('d100-ball')).toBe(0)
  })

  it('numbers the same faces when the vertices come in another order', () => {
    for (const def of BUILTIN_DICE) {
      const original = valueByDirection(def)
      for (const seed of [1, 2, 3]) {
        const again = valueByDirection(shuffled(def, seed))
        for (const [dir, value] of original) {
          const match = again.find(([d]) => length(sub(d, dir)) < 1e-4)
          expect(match?.[1], `${def.id} seed ${seed}`).toBe(value)
        }
      }
    }
  })

  it("numbers the d4's vertices as Aether does: by y, then z, then x", () => {
    const points = pointsOf(BUILTIN_DICE[0]!.vertices)
    const order = points
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p[1] - b.p[1] || a.p[2] - b.p[2] || a.p[0] - b.p[0])
    const values: Record<string, number> = {}
    order.forEach(({ i }, k) => {
      values[String(i)] = k + 1
    })
    expect(BUILTIN_DICE[0]!.values).toEqual(values)
  })

  it('reports a missing value, a duplicate, and opposite faces that break the sum, by path', () => {
    const missing = { ...D6, values: { ...D6.values } }
    delete missing.values['0:1:4:5']
    expect(validateDieDefinition(missing).map((e) => [e.code, e.path])).toEqual([
      ['dice/invalid-definition', '/values/0:1:4:5'],
    ])
    const duplicate = { ...D6, values: { ...D6.values, '0:1:4:5': 2 } }
    const codes = validateDieDefinition(duplicate).map((e) => e.path)
    expect(codes).toContain('/values/0:2:4:6')
    // 1 and 6 swapped with 2 and 5 keeps every value once, but not the opposite sums.
    const unbalanced = { ...D6, values: { ...D6.values, '0:1:4:5': 2, '0:2:4:6': 1 } }
    const errors = validateDieDefinition(unbalanced)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((e) => e.message.includes("don't sum to 7"))).toBe(true)
  })

  it('registers definitions by id, and refuses a different one under a taken id', () => {
    registerBuiltinDice()
    expect(findDie('d20')?.sides).toBe(20)
    expect(defineDie(D6)).toBe(findDie('d6'))
    let err: ShardError | undefined
    try {
      defineDie({ ...D6, bevel: 0.2 })
    } catch (e) {
      err = e as ShardError
    }
    expect(err?.code).toBe('dice/registry-conflict')
  })
})

describe('landing on a supplied result', () => {
  const EPS = 1e-6
  it('shows the target from any final rotation', () => {
    for (const def of BUILTIN_DICE) {
      const g = dieGeometry(def)
      const rng = new Rng(def.sides * 7)
      for (let seed = 0; seed < 50; seed++) {
        const rotation = randomRotation(rng)
        for (let value = 1; value <= def.sides; value++) {
          const shown = qMul(rotation, landingCorrection(g, rotation, value))
          expect(naturalValue(g, shown), `${def.id} ${value} seed ${seed}`).toBe(value)
        }
      }
    }
  })

  it('reads as close to screen-up as the symmetry allows, for every definition, value and 50 landings', () => {
    const screenUp: V3 = [0, 0, -1]
    for (const def of BUILTIN_DICE) {
      const g = dieGeometry(def)
      const rng = new Rng(def.sides)
      for (let seed = 0; seed < 50; seed++) {
        // A landed die: some value flat on top, turned any way about the vertical.
        const landed = restRotation(g, rng.int(1, def.sides))
        const rotation = qNormalize(qMul(qAxisAngle([0, 1, 0], rng.range(0, Math.PI * 2)), landed))
        for (let value = 1; value <= def.sides; value++) {
          const c = landingCorrection(g, rotation, value, screenUp)
          const shown = qNormalize(qMul(rotation, c))
          expect(naturalValue(g, shown), `${def.id} ${value} seed ${seed}`).toBe(value)
          const angle = markAngle(g, shown, value, screenUp)
          if (def.collider === 'ball') {
            expect(angle).toBeLessThan(1e-4)
            continue
          }
          // The best of the symmetries that keep the target on top: within half their step.
          const k = stabilizer(def, value)
          expect(angle, `${def.id} ${value} seed ${seed}`).toBeLessThanOrEqual(Math.PI / k + EPS)
          if (k >= 4) expect(angle).toBeLessThanOrEqual(Math.PI / 4 + EPS)
          // Nothing else would do better.
          for (const s of g.symmetries) {
            const alt = qNormalize(qMul(rotation, s))
            if (naturalValue(g, alt) !== value) continue
            expect(angle).toBeLessThanOrEqual(markAngle(g, alt, value, screenUp) + EPS)
          }
        }
      }
    }
  })

  it('rests a value exactly on top and upright', () => {
    for (const def of BUILTIN_DICE) {
      const g = dieGeometry(def)
      for (let value = 1; value <= def.sides; value++) {
        const r = restRotation(g, value)
        expect(naturalValue(g, r)).toBe(value)
        expect(markAngle(g, r, value)).toBeLessThan(1e-4)
        expect(qRotate(r, frameOf(g, value).normal)[1]).toBeCloseTo(1, 6)
      }
    }
  })

  it('fails a value the die cannot show with dice/invalid-value', () => {
    const g = dieGeometry(D6)
    for (const bad of [0, 7, 2.5]) {
      let err: ShardError | undefined
      try {
        landingCorrection(g, [0, 0, 0, 1], bad)
      } catch (e) {
        err = e as ShardError
      }
      expect(err?.code).toBe('dice/invalid-value')
    }
  })

  it('shows percentile 100 as 00 and 0, and 7 as 00 and 7; the d100 shows every value', () => {
    const shows = (value: number) => {
      const [tens, units] = percentileValues(value)
      const r = randomRotation(new Rng(value))
      const t = qMul(r, landingCorrection(D10_TENS, r, tens))
      const u = qMul(r, landingCorrection(D10, r, units))
      return [labelOf(D10_TENS, naturalValue(D10_TENS, t)), labelOf(D10, naturalValue(D10, u))]
    }
    expect(shows(100)).toEqual(['00', '0'])
    expect(shows(7)).toEqual(['00', '7'])
    expect(shows(10)).toEqual(['10', '0'])
    expect(shows(95)).toEqual(['90', '5'])
    const rng = new Rng(100)
    const seen = new Set<number>()
    for (let value = 1; value <= 100; value++) {
      const r = randomRotation(rng)
      seen.add(naturalValue(D100_BALL, qMul(r, landingCorrection(D100_BALL, r, value))))
    }
    expect(seen.size).toBe(100)
  })
})
