import { type DieDefinition, defineDie } from './definition'

// The built-in dice, numbered as Aether's tables (packages/renderer/src/dice/numbering.ts there),
// with the same canonical vertex orders, so a roll shows the same faces during and after the
// migration. Vertices are centered and scaled to unit radius as Aether normalizes them.

const PHI = (1 + Math.sqrt(5)) / 2

function unitRadius(points: number[][]): Float32Array {
  const c = [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k]!, 0) / points.length)
  const centered = points.map((p) => p.map((v, k) => v - c[k]!))
  const r = Math.max(...centered.map((p) => Math.sqrt(p[0]! ** 2 + p[1]! ** 2 + p[2]! ** 2)))
  return Float32Array.from(centered.flatMap((p) => p.map((v) => v / r)))
}

/**
 * Aether's pentagonal trapezohedron: poles at ±1, two rings of five at ±(1 − cos 36°)/(1 + cos 36°)
 * and radius 0.78, the lower ring turned half a step. Written out as its float32 values rather than
 * computed: engines don't round Math.cos alike, and a collider point one bit off records another
 * track (0053).
 */
const R0 = 0.7799999713897705
const R1 = 0.6310332417488098
const R2 = 0.24103325605392456
const Z1 = 0.45847249031066895
const Z2 = 0.7418240904808044
const RING = 0.10557281225919724
const TRAPEZOHEDRON = Float32Array.from([
  0,
  1,
  0,
  0,
  -1,
  0,
  R0,
  RING,
  0,
  R1,
  -RING,
  Z1,
  R2,
  RING,
  Z2,
  -R2,
  -RING,
  Z2,
  -R1,
  RING,
  Z1,
  -R0,
  -RING,
  0,
  -R1,
  RING,
  -Z1,
  -R2,
  -RING,
  -Z2,
  R2,
  RING,
  -Z2,
  R1,
  -RING,
  -Z1,
])

function dodecahedron(): number[][] {
  const inverse = 1 / PHI
  const out: number[][] = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push([x, y, z])
  for (const a of [-inverse, inverse]) {
    for (const b of [-PHI, PHI]) out.push([0, a, b], [a, b, 0], [b, 0, a])
  }
  return out
}

const D10_VALUES = {
  '1:9:10:11': 8,
  '1:7:8:9': 10,
  '1:2:3:11': 2,
  '1:5:6:7': 4,
  '1:3:4:5': 6,
  '0:8:9:10': 3,
  '0:2:10:11': 5,
  '0:6:7:8': 7,
  '0:2:3:4': 9,
  '0:4:5:6': 1,
}

export const D4: DieDefinition = {
  version: 1,
  id: 'd4',
  sides: 4,
  vertices: unitRadius([
    [1, 1, 1],
    [-1, -1, 1],
    [-1, 1, -1],
    [1, -1, -1],
  ]),
  read: 'vertex',
  // Aether numbers the d4's vertices by direction: sorted by y, then z, then x.
  values: { '0': 4, '1': 2, '2': 3, '3': 1 },
  collider: 'hull',
  sizeMm: 15,
  bevel: 0.06,
  markScale: 0.31,
}

export const D6: DieDefinition = {
  version: 1,
  id: 'd6',
  sides: 6,
  vertices: unitRadius([
    [-1, -1, -1],
    [-1, -1, 1],
    [-1, 1, -1],
    [-1, 1, 1],
    [1, -1, -1],
    [1, -1, 1],
    [1, 1, -1],
    [1, 1, 1],
  ]),
  read: 'face',
  values: {
    '0:1:4:5': 1,
    '0:2:4:6': 2,
    '0:1:2:3': 3,
    '4:5:6:7': 4,
    '1:3:5:7': 5,
    '2:3:6:7': 6,
  },
  collider: 'hull',
  sizeMm: 16,
  bevel: 0.082,
  markScale: 0.5,
  oppositesSum: true,
}

export const D8: DieDefinition = {
  version: 1,
  id: 'd8',
  sides: 8,
  vertices: unitRadius([
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]),
  read: 'face',
  values: {
    '1:3:5': 2,
    '0:3:5': 6,
    '1:3:4': 8,
    '0:3:4': 4,
    '1:2:5': 5,
    '0:2:5': 1,
    '1:2:4': 3,
    '0:2:4': 7,
  },
  collider: 'hull',
  sizeMm: 16,
  bevel: 0.082,
  markScale: 0.4,
  oppositesSum: true,
}

/** A d10 printing 1–9 and 0 (the value 10). Opposite digits sum to 9, so it doesn't opt in. */
export const D10: DieDefinition = {
  version: 1,
  id: 'd10',
  sides: 10,
  vertices: TRAPEZOHEDRON,
  read: 'face',
  values: D10_VALUES,
  labels: { 10: '0' },
  collider: 'hull',
  sizeMm: 16,
  bevel: 0.13,
  markScale: 0.36,
}

/** A percentile's tens die: the d10's shape and numbering, printing 10–90 and 00 (the value 10). */
export const D10_TENS: DieDefinition = {
  version: 1,
  id: 'd10-tens',
  sides: 10,
  vertices: TRAPEZOHEDRON,
  read: 'face',
  values: D10_VALUES,
  labels: {
    1: '10',
    2: '20',
    3: '30',
    4: '40',
    5: '50',
    6: '60',
    7: '70',
    8: '80',
    9: '90',
    10: '00',
  },
  collider: 'hull',
  sizeMm: 16,
  bevel: 0.13,
  markScale: 0.32,
}

export const D12: DieDefinition = {
  version: 1,
  id: 'd12',
  sides: 12,
  vertices: unitRadius(dodecahedron()),
  read: 'face',
  values: {
    '1:5:9:11:15': 4,
    '0:4:8:9:15': 7,
    '4:5:13:15:19': 11,
    '0:1:9:10:16': 5,
    '0:2:8:10:14': 10,
    '4:6:8:13:14': 1,
    '1:3:11:16:17': 12,
    '5:7:11:17:19': 3,
    '2:3:10:12:16': 2,
    '6:7:13:18:19': 8,
    '2:6:12:14:18': 9,
    '3:7:12:17:18': 6,
  },
  collider: 'hull',
  sizeMm: 14,
  bevel: 0.082,
  markScale: 0.42,
  oppositesSum: true,
}

export const D20: DieDefinition = {
  version: 1,
  id: 'd20',
  sides: 20,
  vertices: unitRadius([
    [-1, PHI, 0],
    [1, PHI, 0],
    [-1, -PHI, 0],
    [1, -PHI, 0],
    [0, -1, PHI],
    [0, 1, PHI],
    [0, -1, -PHI],
    [0, 1, -PHI],
    [PHI, 0, -1],
    [PHI, 0, 1],
    [-PHI, 0, -1],
    [-PHI, 0, 1],
  ]),
  read: 'face',
  values: {
    '2:3:6': 1,
    '2:3:4': 19,
    '2:6:10': 13,
    '3:6:8': 7,
    '2:4:11': 10,
    '3:4:9': 3,
    '2:10:11': 12,
    '3:8:9': 17,
    '6:7:10': 6,
    '6:7:8': 16,
    '4:5:11': 5,
    '4:5:9': 15,
    '0:10:11': 4,
    '1:8:9': 9,
    '0:7:10': 18,
    '1:7:8': 11,
    '0:5:11': 14,
    '1:5:9': 8,
    '0:1:7': 2,
    '0:1:5': 20,
  },
  collider: 'hull',
  sizeMm: 18,
  bevel: 0.082,
  markScale: 0.38,
  oppositesSum: true,
}

/**
 * 100 cells on a spherical Fibonacci spiral from the top pole down, numbered 1 to 100 along it.
 * The collider is a ball, so every rotation is a symmetry and any cell can land up.
 */
function fibonacciSphere(count: number): Float32Array {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) * 2) / count
    const r = Math.sqrt(1 - y * y)
    const a = i * golden
    out[i * 3] = Math.cos(a) * r
    out[i * 3 + 1] = y
    out[i * 3 + 2] = Math.sin(a) * r
  }
  return out
}

export const D100_BALL: DieDefinition = {
  version: 1,
  id: 'd100-ball',
  sides: 100,
  vertices: fibonacciSphere(100),
  read: 'face',
  values: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), i + 1])),
  collider: 'ball',
  sizeMm: 22,
  bevel: 0.1,
  markScale: 0.3,
}

export const BUILTIN_DICE: readonly DieDefinition[] = [
  D4,
  D6,
  D8,
  D10,
  D10_TENS,
  D12,
  D20,
  D100_BALL,
]

let registered = false

/** Registers the built-ins (idempotent). The dice plugin calls it; tests and tools can too. */
export function registerBuiltinDice(): void {
  if (registered) return
  registered = true
  for (const def of BUILTIN_DICE) defineDie(def)
}

/** The kinds a roll names, and the definitions each plays (percentile plays two). */
export const DIE_KINDS = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', 'percentile'] as const
export type DieKind = (typeof DIE_KINDS)[number]

export const KIND_DEFINITIONS: Readonly<Record<DieKind, readonly string[]>> = {
  d4: ['d4'],
  d6: ['d6'],
  d8: ['d8'],
  d10: ['d10'],
  d12: ['d12'],
  d20: ['d20'],
  d100: ['d100-ball'],
  percentile: ['d10-tens', 'd10'],
}

/** The values a kind can show: percentile 1..100 over its two dice. */
export function kindSides(kind: DieKind): number {
  return kind === 'percentile' || kind === 'd100' ? 100 : Number(kind.slice(1))
}

/**
 * A percentile value as its two dice's values: tens then units. 100 shows 00 and 0, and 7 shows 00
 * and 7. Each d10 value 10 prints as its zero ('00' on the tens die, '0' on the units die).
 */
export function percentileValues(value: number): [number, number] {
  const tens = Math.floor((value % 100) / 10)
  const units = value % 10
  return [tens === 0 ? 10 : tens, units === 0 ? 10 : units]
}
