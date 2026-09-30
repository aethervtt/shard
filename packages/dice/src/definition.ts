import { ShardError } from '@aethervtt/shard-core'
import { convexFaces, type Face, pointsOf, symmetryGroup, tangentPolytope } from './hull'
import {
  cross,
  dot,
  EPSILON,
  length,
  normalize,
  type Q4,
  qKey,
  qRotate,
  round,
  scale,
  stableTangent,
  sub,
  tangentOf,
  type V3,
} from './math'

/**
 * A die's shape and numbering, as data (0054). Built-ins cover d4 to d20, the two percentile d10s
 * and a d100 ball; a host can register more with `defineDie`.
 */
export interface DieDefinition {
  version: 1
  /** 'd20', 'd10-tens', 'd100-ball'. */
  id: string
  sides: number
  /**
   * Canonical points, unit radius, in a fixed order: vertex ids are indices into it. For a ball,
   * each point is a cell's center (its normal).
   */
  vertices: Float32Array
  /** The face on top reads, or (d4) the vertex on top. */
  read: 'face' | 'vertex'
  /**
   * Value by sorted vertex ids of a face (`'0:1:4:5'`), or by a vertex id (`'3'`) for vertex dice
   * and ball cells. Keyed by ids, so the numbering doesn't depend on the order a hull returns.
   */
  values: Record<string, number>
  /** The printed mark per value, where it isn't the value: `'00'` … `'90'`, or 10 → `'0'`. */
  labels?: Record<number, string>
  /** A hull of the vertices, or a ball (every rotation is a symmetry). */
  collider: 'hull' | 'ball'
  /** Footprint diameter of a landed die, before the presentation scale. */
  sizeMm: number
  /** Chamfer: how far each face corner moves toward its face's center (0..0.3). */
  bevel: number
  /** Mark height as a fraction of a face's size (the atlas cell's inner square). */
  markScale?: number
  /** Opposite faces must sum to `sides + 1` (checked by the validator). */
  oppositesSum?: boolean
}

/** A value's reading frame on the die: where it points, and which way its mark reads up. */
export interface ValueFrame {
  value: number
  /** The direction that's up when this value shows: a face normal, or the d4's vertex. */
  normal: V3
  /** Across the mark, left to right. */
  tangent: V3
  /** The mark's up. `tangent × bitangent = normal`. */
  bitangent: V3
}

/** What the engine derives from a definition, once per content hash. */
export interface DieGeometry {
  definition: DieDefinition
  hash: number
  /** Unit-radius points (a ball's cell centers). */
  points: V3[]
  /** The polytope that's drawn and (for hulls) collided: faces with ordered vertices. */
  polytope: { points: V3[]; faces: Face[] }
  /** The value each polytope face carries (face dice), or undefined (d4: marks per corner). */
  faceValues: (number | undefined)[]
  /** d4: the value at each point (vertex id → value). */
  vertexValues: number[] | undefined
  /** Frames by value (index value − 1). */
  frames: ValueFrame[]
  /** Rotations mapping the die onto itself; empty for a ball (every rotation is one). */
  symmetries: Q4[]
  /** Landed footprint diameter at unit radius: the size a die of this definition shows. */
  footprint: number
  /** Distance from the center to the floor when resting on a face (1 for a ball). */
  restHeight: number
}

function invalid(message: string, path: string, hint?: string): ShardError {
  return new ShardError('dice/invalid-definition', message, {
    path,
    hint: hint ?? 'See DieDefinition in @aethervtt/shard-dice.',
  })
}

/** 32-bit FNV-1a over the definition's canonical content. */
export function dieHash(def: DieDefinition): number {
  const canonical = JSON.stringify([
    def.version,
    def.id,
    def.sides,
    Array.from(def.vertices),
    def.read,
    Object.keys(def.values)
      .sort()
      .map((k) => [k, def.values[k]]),
    Object.keys(def.labels ?? {})
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => [k, def.labels![k]]),
    def.collider,
    def.sizeMm,
    def.bevel,
    def.markScale ?? null,
    def.oppositesSum ?? false,
  ])
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const faceKey = (face: Face) => [...face.vertices].sort((a, b) => a - b).join(':')

/**
 * Checks a definition and returns every problem, with a path to the field: every face (or vertex,
 * or cell) has exactly one value, values are 1..sides with no duplicates, labels name real values,
 * and opposite faces sum to `sides + 1` where the definition opts in.
 */
export function validateDieDefinition(def: DieDefinition): ShardError[] {
  const errors: ShardError[] = []
  if (def.version !== 1) errors.push(invalid(`Version ${def.version} isn't 1`, '/version'))
  if (typeof def.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(def.id))
    errors.push(invalid(`id "${def.id}" isn't a lowercase id`, '/id'))
  if (!Number.isInteger(def.sides) || def.sides < 2 || def.sides > 100)
    errors.push(invalid('sides must be an integer from 2 to 100', '/sides'))
  const v = def.vertices
  if (!(v instanceof Float32Array) || v.length < 12 || v.length % 3 !== 0) {
    errors.push(invalid('vertices needs 4 or more x y z points in a Float32Array', '/vertices'))
    return errors
  }
  const points = pointsOf(v)
  const radius = Math.max(...points.map(length))
  if (Math.abs(radius - 1) > 1e-3)
    errors.push(invalid(`vertices reach radius ${radius.toFixed(4)}, not 1`, '/vertices'))
  if (def.collider === 'ball') {
    points.forEach((p, i) => {
      if (Math.abs(length(p) - 1) > 1e-3)
        errors.push(invalid(`Ball cell ${i} isn't on the unit sphere`, `/vertices/${i * 3}`))
    })
  }
  if (!(def.sizeMm > 0)) errors.push(invalid('sizeMm must be positive', '/sizeMm'))
  if (!(def.bevel >= 0 && def.bevel <= 0.3))
    errors.push(invalid('bevel must be from 0 to 0.3', '/bevel'))
  if (errors.length > 0) return errors

  // The keys a value can have: faces of the hull, or single points.
  const keys: string[] = []
  if (def.read === 'vertex' || def.collider === 'ball') {
    for (let i = 0; i < points.length; i++) keys.push(String(i))
  } else {
    for (const face of convexFaces(points)) keys.push(faceKey(face))
  }
  if (keys.length !== def.sides) {
    errors.push(
      invalid(
        `The shape has ${keys.length} ${def.read === 'vertex' ? 'vertices' : 'faces'}, not ${def.sides}`,
        '/sides',
      ),
    )
  }
  const seen = new Map<number, string>()
  for (const key of keys) {
    const value = def.values[key]
    if (value === undefined) {
      errors.push(
        invalid(`Face ${key} has no value`, `/values/${key}`, `Give it one of 1..${def.sides}.`),
      )
      continue
    }
    if (!Number.isInteger(value) || value < 1 || value > def.sides) {
      errors.push(invalid(`Face ${key} has value ${value}, not 1..${def.sides}`, `/values/${key}`))
      continue
    }
    const other = seen.get(value)
    if (other !== undefined)
      errors.push(invalid(`Faces ${other} and ${key} both have value ${value}`, `/values/${key}`))
    seen.set(value, key)
  }
  for (const key of Object.keys(def.values)) {
    if (!keys.includes(key))
      errors.push(invalid(`values names ${key}, which isn't a face of the shape`, `/values/${key}`))
  }
  for (const key of Object.keys(def.labels ?? {})) {
    const value = Number(key)
    if (!seen.has(value))
      errors.push(invalid(`labels names value ${key}, which no face has`, `/labels/${key}`))
  }
  if (def.oppositesSum && def.read === 'face' && def.collider === 'hull') {
    const faces = convexFaces(points)
    for (const face of faces) {
      const opposite = faces.find((f) => dot(f.normal, face.normal) < -1 + 1e-4)
      if (!opposite) {
        errors.push(invalid(`Face ${faceKey(face)} has no opposite face`, '/oppositesSum'))
        continue
      }
      const a = def.values[faceKey(face)]
      const b = def.values[faceKey(opposite)]
      if (a !== undefined && b !== undefined && a + b !== def.sides + 1) {
        errors.push(
          invalid(
            `Opposite faces ${faceKey(face)} (${a}) and ${faceKey(opposite)} (${b}) don't sum to ${def.sides + 1}`,
            `/values/${faceKey(face)}`,
          ),
        )
      }
    }
  }
  return errors
}

// --- analysis -------------------------------------------------------------------------------------

/**
 * Where a value's mark reads up on its face: toward the one vertex farthest from the center (a
 * kite's apex), else toward a vertex (odd polygons), else toward the middle of an edge (squares).
 * It's chosen for the reference face only; every other face gets the reference's frame carried by
 * a symmetry, so all marks sit the same way on their faces.
 */
function markUp(points: readonly V3[], face: Face): V3 {
  const d = face.vertices.map((i) => length(sub(points[i]!, face.center)))
  const far = Math.max(...d)
  const farthest = face.vertices.filter((_, k) => d[k]! > far - 1e-4)
  let toward: V3
  if (farthest.length === 1) toward = points[farthest[0]!]!
  else if (face.vertices.length % 2 === 1) toward = points[Math.min(...face.vertices)]!
  else {
    // The edge between the two lowest ids that are neighbours on the face.
    const vs = face.vertices
    let best: [number, number] = [vs[0]!, vs[1]!]
    let bestKey = Number.POSITIVE_INFINITY
    for (let k = 0; k < vs.length; k++) {
      const a = vs[k]!
      const b = vs[(k + 1) % vs.length]!
      const key = Math.min(a, b) * 1000 + Math.max(a, b)
      if (key < bestKey) {
        bestKey = key
        best = [a, b]
      }
    }
    toward = scale(add3(points[best[0]]!, points[best[1]]!), 0.5)
  }
  return tangentOf(sub(toward, face.center), face.normal)
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

function footprintOf(points: readonly V3[], down: V3): number {
  // Diameter of the points' shadow on the floor when `down` points at it.
  let r = 0
  for (const p of points) {
    const along = dot(p, down)
    const x = sub(p, scale(down, along))
    r = Math.max(r, length(x))
  }
  return r * 2
}

const cache = new Map<number, DieGeometry>()
/** By object too, so per-frame lookups don't hash the definition again. */
const byObject = new WeakMap<DieDefinition, DieGeometry>()

/**
 * Derives a definition's faces, value frames and symmetry group, cached by its content hash.
 * Throws `dice/invalid-definition` naming the first problem.
 */
export function dieGeometry(def: DieDefinition): DieGeometry {
  const known = byObject.get(def)
  if (known) return known
  const hash = dieHash(def)
  const cached = cache.get(hash)
  if (cached) {
    byObject.set(def, cached)
    return cached
  }
  const errors = validateDieDefinition(def)
  if (errors.length > 0) throw errors[0]!
  const points = pointsOf(def.vertices).map((p) => p.map(round) as V3)
  const ball = def.collider === 'ball'
  const polytope = ball
    ? tangentPolytope(points.map(normalize))
    : { points, faces: convexFaces(points) }
  const symmetries = ball ? [] : symmetryGroup(points)

  // Directions by value.
  const directions: { value: number; normal: V3; face: Face | undefined }[] = []
  let faceValues: (number | undefined)[]
  let vertexValues: number[] | undefined
  if (def.read === 'vertex') {
    vertexValues = points.map((_, i) => def.values[String(i)]!)
    faceValues = polytope.faces.map(() => undefined)
    points.forEach((p, i) => {
      directions.push({ value: vertexValues![i]!, normal: normalize(p), face: undefined })
    })
  } else if (ball) {
    faceValues = points.map((_, i) => def.values[String(i)]!)
    polytope.faces.forEach((face, i) => {
      directions.push({ value: faceValues[i]!, normal: face.normal, face })
    })
  } else {
    faceValues = polytope.faces.map((f) => def.values[faceKey(f)]!)
    polytope.faces.forEach((face, i) => {
      directions.push({ value: faceValues[i]!, normal: face.normal, face })
    })
  }
  directions.sort((a, b) => a.value - b.value)

  const frames: ValueFrame[] = []
  if (ball) {
    // Cells read upright around the pole: up is toward +Y (toward -Z right at the poles).
    for (const d of directions) {
      const n = d.normal
      const pole: V3 = Math.abs(n[1]) > 0.999 ? [0, 0, n[1] > 0 ? -1 : 1] : [0, 1, 0]
      const b = tangentOf(pole, n)
      frames.push({ value: d.value, normal: n, tangent: cross(b, n), bitangent: b })
    }
  } else {
    const ref = directions[0]!
    let refUp: V3
    if (def.read === 'vertex') {
      // A d4 reads its top vertex: up points from an adjacent face's center toward it.
      const vertex = points.findIndex((_, i) => vertexValues![i] === ref.value)
      const adjacent = polytope.faces
        .filter((f) => f.vertices.includes(vertex))
        .sort((a, b) => Math.min(...a.vertices) - Math.min(...b.vertices))[0]
      refUp = adjacent
        ? tangentOf(sub(points[vertex]!, adjacent.center), ref.normal)
        : stableTangent(ref.normal)
    } else {
      refUp = markUp(points, ref.face!)
    }
    for (const d of directions) {
      const candidates = symmetries
        .filter((q) => length(sub(qRotate(q, ref.normal), d.normal)) < EPSILON * 10)
        .sort((a, b) => qKey(a).localeCompare(qKey(b)))
      const q = candidates[0]
      if (!q) {
        throw invalid(
          `No symmetry of ${def.id} carries value ${ref.value}'s face to value ${d.value}'s`,
          '/vertices',
          'Dice need a symmetry group that moves every face to every other (fair dice have one).',
        )
      }
      const b = normalize(qRotate(q, refUp))
      frames.push({ value: d.value, normal: d.normal, tangent: cross(b, d.normal), bitangent: b })
    }
  }

  // Resting on the face opposite value 1: its footprint, and the center's height above the floor.
  const up = frames[0]!.normal
  const down = scale(up, -1)
  let rest = 0
  for (const p of polytope.points) rest = Math.max(rest, dot(p, down))
  const geometry: DieGeometry = {
    definition: def,
    hash,
    points,
    polytope,
    faceValues,
    vertexValues,
    frames,
    symmetries,
    footprint: footprintOf(ball ? polytope.points : points, down),
    restHeight: ball ? 1 : rest,
  }
  cache.set(hash, geometry)
  byObject.set(def, geometry)
  return geometry
}

/** The value's frame, or `dice/invalid-value` if the die can't show it. */
export function frameOf(geometry: DieGeometry, value: number): ValueFrame {
  const frame = Number.isInteger(value) ? geometry.frames[value - 1] : undefined
  if (!frame || frame.value !== value) {
    throw new ShardError(
      'dice/invalid-value',
      `A ${geometry.definition.id} can't show ${value}: its values are 1 to ${geometry.frames.length}`,
      { hint: 'The host decides the result; pass one the die has.' },
    )
  }
  return frame
}

/** The printed mark of a value: its label, or the value itself. */
export function labelOf(def: DieDefinition, value: number): string {
  return def.labels?.[value] ?? String(value)
}

// --- registry -------------------------------------------------------------------------------------

const definitions = new Map<string, DieDefinition>()

/**
 * Registers a definition by id so skins and rolls can name it. Registering the same content again
 * is a no-op; a different definition under a taken id throws `dice/registry-conflict`.
 */
export function defineDie(def: DieDefinition): DieDefinition {
  const existing = definitions.get(def.id)
  if (existing) {
    if (dieHash(existing) === dieHash(def)) return existing
    throw new ShardError(
      'dice/registry-conflict',
      `Die "${def.id}" is already defined, differently`,
      {
        hint: 'Give the new definition its own id.',
      },
    )
  }
  const errors = validateDieDefinition(def)
  if (errors.length > 0) throw errors[0]!
  definitions.set(def.id, def)
  return def
}

export function findDie(id: string): DieDefinition | undefined {
  return definitions.get(id)
}

export function requireDie(id: string): DieDefinition {
  const def = definitions.get(id)
  if (!def) {
    throw new ShardError('dice/unknown-die', `No die definition "${id}"`, {
      hint: `Defined: ${[...definitions.keys()].join(', ')}. Register others with defineDie.`,
    })
  }
  return def
}

export function allDice(): DieDefinition[] {
  return [...definitions.values()]
}

/** Scale of a die of `def` at presentation scale 1: its footprint is `sizeMm` relative to the d20's 18 mm. */
export function physicalScale(geometry: DieGeometry, reference: DieGeometry): number {
  return (
    (geometry.definition.sizeMm / reference.definition.sizeMm) *
    (reference.footprint / geometry.footprint)
  )
}
