import { ShardError } from '@aethervtt/shard-core'
import { MESH_ATTRIBUTE_WIDTH, MESH_ATTRIBUTES, type MeshData, type MorphTarget } from './mesh'

type Simplifier = typeof import('meshoptimizer/simplifier')['MeshoptSimplifier']

let simplifier: Simplifier | undefined
let loading: Promise<void> | undefined

/**
 * Loads meshoptimizer's simplifier (WASM, embedded in its module). `simplifyMesh` and
 * `simplifyLods` are synchronous and need this to have resolved once in the thread that calls
 * them. Only code that simplifies imports it, so it never reaches a runtime bundle that doesn't.
 */
export function loadMeshSimplifier(): Promise<void> {
  loading ??= import('meshoptimizer/simplifier').then(async (mod) => {
    await mod.MeshoptSimplifier.ready
    simplifier = mod.MeshoptSimplifier
  })
  return loading
}

/** Whether `loadMeshSimplifier` has finished in this thread. */
export function meshSimplifierLoaded(): boolean {
  return simplifier !== undefined
}

export interface SimplifyOptions {
  /** Keep border edges (open edges) in place, so neighboring pieces still meet (default false). */
  lockBorder?: boolean
  /**
   * Largest error allowed, as a fraction of the mesh's size (or metres with `absolute`). The
   * default, 1, lets the triangle target decide alone.
   */
  error?: number
  /** `error` is in mesh units, not relative to its size. */
  absolute?: boolean
  /**
   * Never collapse across UV seams or hard normal edges: no permissive or sloppy retry, so a mesh
   * that seams stop short keeps more triangles than asked (default false).
   */
  keepSeams?: boolean
  /** Let whole disconnected parts be removed when they're too small to matter (default false). */
  prune?: boolean
  /** Per vertex, 1 keeps it where it is: none of its triangles collapse into another vertex. */
  lock?: Uint8Array
}

export interface Simplified {
  mesh: MeshData
  /** The error reached, in the same units as `SimplifyOptions.error`. */
  error: number
}

function loaded(): Simplifier {
  if (!simplifier) {
    throw new ShardError('mesh/simplifier-not-loaded', 'The mesh simplifier is not loaded', {
      hint: 'await loadMeshSimplifier() once (generators get it loaded for them) before simplifying.',
    })
  }
  return simplifier
}

/**
 * About `fraction` of the mesh's triangles, chosen by meshoptimizer's quadric simplifier. Vertices
 * aren't moved, only dropped, so every attribute (joints, weights, and morph deltas too) stays the
 * source's; UV seams and borders (with `lockBorder`) are kept. If seams stop it short of the
 * target, it retries allowed to collapse across them, and then as a last resort with the
 * positions-only (sloppy) simplifier, unless `keepSeams` is set.
 */
export function simplifyMesh(
  mesh: MeshData,
  fraction: number,
  options: SimplifyOptions = {},
): Simplified {
  if (!(fraction > 0 && fraction <= 1)) {
    throw new ShardError('mesh/bad-lod', `A LOD fraction must be in (0, 1], got ${fraction}`, {
      hint: 'lods: [0.5, 0.2] keeps about half, then a fifth, of the triangles.',
    })
  }
  const source = sourceIndices(mesh)
  const target = Math.max(1, Math.floor((source.length / 3) * fraction))
  const { indices, error } = simplifyIndices(mesh, source, target, attributesOf(mesh), options)
  if (indices === source) return { mesh, error: 0 }
  return { mesh: compact(mesh, indices), error }
}

interface Attributes {
  data: Float32Array
  stride: number
  weights: number[]
}

/**
 * What a collapse costs besides moving the surface: normals and UVs, then (when present) the skin
 * as the weights times a fixed 8-D vector per joint, so collapses across a weight change cost
 * more, and morph deltas in units of the mesh's size, so moving and still regions stay apart.
 */
function attributesOf(mesh: MeshData): Attributes {
  const count = mesh.positions.length / 3
  const skinned = mesh.joints !== undefined && mesh.weights !== undefined
  const targets = mesh.targets ?? []
  const groups = Math.min(targets.length, MORPH_GROUPS)
  const stride = 5 + (skinned ? SKIN_DIMS : 0) + groups * 3
  const data = new Float32Array(count * stride)
  for (let v = 0; v < count; v++) {
    const o = v * stride
    if (mesh.normals) {
      data[o] = mesh.normals[v * 3]!
      data[o + 1] = mesh.normals[v * 3 + 1]!
      data[o + 2] = mesh.normals[v * 3 + 2]!
    }
    if (mesh.uvs) {
      data[o + 3] = mesh.uvs[v * 2]!
      data[o + 4] = mesh.uvs[v * 2 + 1]!
    }
  }
  const weights = [0.25, 0.25, 0.25, mesh.uvs ? 0.5 : 0, mesh.uvs ? 0.5 : 0]
  if (skinned) {
    const j = mesh.joints!
    const w = mesh.weights!
    for (let v = 0; v < count; v++) {
      const o = v * stride + 5
      const sum = w[v * 4]! + w[v * 4 + 1]! + w[v * 4 + 2]! + w[v * 4 + 3]!
      const k = sum > 1e-6 ? 1 / sum : 0
      for (let i = 0; i < 4; i++) {
        const weight = w[v * 4 + i]! * k
        if (weight === 0) continue
        const e = jointVector(j[v * 4 + i]!)
        for (let d = 0; d < SKIN_DIMS; d++) data[o + d] = data[o + d]! + weight * e[d]!
      }
    }
    for (let d = 0; d < SKIN_DIMS; d++) weights.push(SKIN_WEIGHT)
  }
  if (groups > 0) {
    const first = 5 + (skinned ? SKIN_DIMS : 0)
    const inv = 1 / Math.max(extentOf(mesh.positions), 1e-12)
    for (const [t, target] of targets.entries()) {
      const g = first + (t % groups) * 3
      const d = target.positions
      for (let v = 0; v < count; v++) {
        for (let c = 0; c < 3; c++)
          data[v * stride + g + c] = data[v * stride + g + c]! + d[v * 3 + c]! * inv
      }
    }
    for (let k = 0; k < groups * 3; k++) weights.push(MORPH_WEIGHT)
  }
  return { data, stride, weights }
}

const SKIN_DIMS = 8
const SKIN_WEIGHT = 0.5
const MORPH_GROUPS = 4
const MORPH_WEIGHT = 1
const jointVectors: Float32Array[] = []

/** A unit vector per joint index, the same in every run (imports stay deterministic). */
function jointVector(joint: number): Float32Array {
  let e = jointVectors[joint]
  if (e) return e
  e = new Float32Array(SKIN_DIMS)
  let h = (joint + 1) * 0x9e3779b9
  let len = 0
  for (let d = 0; d < SKIN_DIMS; d++) {
    // splitmix32
    h = (h + 0x9e3779b9) | 0
    let z = h
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
    z ^= z >>> 16
    e[d] = (z >>> 0) / 2 ** 32 - 0.5
    len += e[d]! * e[d]!
  }
  len = Math.sqrt(len)
  for (let d = 0; d < SKIN_DIMS; d++) e[d] = e[d]! / len
  jointVectors[joint] = e
  return e
}

/** The largest side of the mesh's box: what meshoptimizer measures relative error against. */
function extentOf(p: Float32Array): number {
  let lx = Infinity
  let ly = Infinity
  let lz = Infinity
  let hx = -Infinity
  let hy = -Infinity
  let hz = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    lx = Math.min(lx, p[i]!)
    ly = Math.min(ly, p[i + 1]!)
    lz = Math.min(lz, p[i + 2]!)
    hx = Math.max(hx, p[i]!)
    hy = Math.max(hy, p[i + 1]!)
    hz = Math.max(hz, p[i + 2]!)
  }
  return Math.max(hx - lx, hy - ly, hz - lz)
}

function sourceIndices(mesh: MeshData): Uint32Array {
  return mesh.indices ? Uint32Array.from(mesh.indices) : sequence(mesh.positions.length / 3)
}

/**
 * About `triangles` triangles, as indices into the source's vertices (`source` itself if
 * unchanged).
 */
function simplifyIndices(
  mesh: MeshData,
  source: Uint32Array,
  triangles: number,
  attrs: Attributes,
  options: SimplifyOptions,
): { indices: Uint32Array; error: number } {
  const s = loaded()
  const target = triangles * 3
  if (target >= source.length) return { indices: source, error: 0 }
  const flags: ('LockBorder' | 'ErrorAbsolute' | 'Permissive' | 'Prune')[] = []
  if (options.lockBorder) flags.push('LockBorder')
  if (options.absolute) flags.push('ErrorAbsolute')
  if (options.prune) flags.push('Prune')
  const lock = options.lock ?? null
  const maxError = options.error ?? 1
  const slack = Math.floor((target / 3) * 1.1) * 3
  const run = (extra: 'Permissive'[]) =>
    s.simplifyWithAttributes(
      source,
      mesh.positions,
      3,
      attrs.data,
      attrs.stride,
      attrs.weights,
      lock,
      target,
      maxError,
      [...flags, ...extra],
    )
  let [indices, error] = run([])
  const retry = options.error === undefined && !options.keepSeams
  if (indices.length > slack && retry) [indices, error] = run(['Permissive'])
  if (indices.length > slack && retry && !options.lockBorder) {
    ;[indices, error] = s.simplifySloppy(source, mesh.positions, 3, lock, target, maxError)
  }
  return { indices, error }
}

/** One simplified mesh per fraction (each from the source, not from the previous level). */
export function simplifyLods(
  mesh: MeshData,
  fractions: readonly number[],
  options: SimplifyOptions = {},
): MeshData[] {
  const out: MeshData[] = []
  for (const f of fractions) {
    if (!(f > 0 && f < 1)) {
      throw new ShardError('mesh/bad-lod', `LOD fractions are in (0, 1), got ${f}`, {
        hint: 'lods: [0.5, 0.2] keeps about half, then a fifth, of the triangles.',
      })
    }
    out.push(simplifyMesh(mesh, f, options).mesh)
  }
  return out
}

export interface GeneratedLod {
  mesh: MeshData
  /** How far the level strays from the source, in mesh units (meshoptimizer's estimate). */
  error: number
}

/**
 * Levels of detail for an imported mesh, one per fraction (each from the source): seams and hard
 * edges kept, joints, weights, and morph deltas carried through. Loose parts survive every level
 * but the last, which may prune the ones smaller than its error. Stops early (fewer levels) once a level saves under 20% of
 * the previous one's triangles. The mesh should be welded first (`weldMesh`).
 */
export function generateLods(mesh: MeshData, fractions: readonly number[]): GeneratedLod[] {
  for (const f of fractions) {
    if (!(f > 0 && f < 1)) {
      throw new ShardError('mesh/bad-lod', `LOD fractions are in (0, 1), got ${f}`, {
        hint: 'lodTriangles: [0.5, 0.2, 0.05] keeps about half, a fifth, then a twentieth.',
      })
    }
  }
  const source = sourceIndices(mesh)
  const attrs = attributesOf(mesh)
  const scale = loaded().getScale(mesh.positions, 3)
  const { part, parts } = partsOf(mesh, source)
  const partTriangles = new Uint32Array(parts)
  for (let i = 0; i < source.length; i += 3) partTriangles[part[source[i]!]!]!++
  const out: GeneratedLod[] = []
  let previous = source.length
  for (const [k, f] of fractions.entries()) {
    const last = k === fractions.length - 1
    const budget = Math.max(1, Math.floor((source.length / 3) * f))
    let { indices, error } = simplifyIndices(mesh, source, budget, attrs, { keepSeams: true })
    if (last && error > 0) {
      // Prune only parts smaller than the error this level has anyway: unbounded, it would
      // remove whole bodies to reach the target.
      const pruned = simplifyIndices(mesh, source, budget, attrs, {
        keepSeams: true,
        prune: true,
        error,
      })
      if (pruned.indices.length > 0) ({ indices, error } = pruned)
    }
    // A part this level would lose keeps its full detail, on top of the level's budget. Locking
    // one makes the simplifier spend the budget on others, so lock until none is lost; the locked
    // set only grows, so this ends.
    let lock: Uint8Array | undefined
    let locked = 0
    for (let lost = last ? undefined : lostParts(part, parts, indices, source); lost; ) {
      lock ??= new Uint8Array(mesh.positions.length / 3)
      for (let v = 0; v < lock.length; v++) if (lost[part[v]!]) lock[v] = 1
      for (let p = 0; p < parts; p++) if (lost[p]) locked += partTriangles[p]!
      ;({ indices, error } = simplifyIndices(mesh, source, budget + locked, attrs, {
        keepSeams: true,
        lock,
      }))
      lost = lostParts(part, parts, indices, source)
    }
    if (indices.length === 0 || indices.length > previous * 0.8) break
    previous = indices.length
    out.push({ mesh: compact(mesh, indices), error: error * scale })
  }
  return out
}

/** Connected parts by position (seams don't split a part), per vertex. */
function partsOf(mesh: MeshData, source: Uint32Array): { part: Int32Array; parts: number } {
  const p = mesh.positions
  const n = p.length / 3
  const parent = new Int32Array(n)
  for (let v = 0; v < n; v++) parent[v] = v
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const byPosition = new Map<string, number>()
  for (let v = 0; v < n; v++) {
    const key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`
    const first = byPosition.get(key)
    if (first === undefined) byPosition.set(key, v)
    else union(first, v)
  }
  for (let i = 0; i < source.length; i += 3) {
    union(source[i]!, source[i + 1]!)
    union(source[i]!, source[i + 2]!)
  }
  const ids = new Map<number, number>()
  const part = new Int32Array(n)
  for (let v = 0; v < n; v++) {
    const r = find(v)
    let id = ids.get(r)
    if (id === undefined) {
      id = ids.size
      ids.set(r, id)
    }
    part[v] = id
  }
  return { part, parts: ids.size }
}

/** Per part, whether the source has triangles in it and `indices` none; undefined if none lost. */
function lostParts(
  part: Int32Array,
  parts: number,
  indices: Uint32Array,
  source: Uint32Array,
): Uint8Array | undefined {
  const had = new Uint8Array(parts)
  for (let i = 0; i < source.length; i += 3) had[part[source[i]!]!] = 1
  for (let i = 0; i < indices.length; i += 3) had[part[indices[i]!]!] = 0
  return had.includes(1) ? had : undefined
}

/**
 * Merges vertices whose every attribute (morph deltas included) is bit-identical, and drops the
 * triangles that collapse. Tangent generation leaves one vertex per corner; this restores sharing
 * without touching seams or hard edges, which differ in some attribute.
 */
export function weldMesh(mesh: MeshData): MeshData {
  const n = mesh.positions.length / 3
  const arrays: { bits: Uint32Array | Uint16Array; width: number }[] = []
  const add = (a: Float32Array | Uint16Array | undefined, width: number) => {
    if (!a) return
    arrays.push({
      bits: a instanceof Float32Array ? new Uint32Array(a.buffer, a.byteOffset, a.length) : a,
      width,
    })
  }
  add(mesh.positions, 3)
  add(mesh.normals, 3)
  add(mesh.uvs, 2)
  add(mesh.colors, 4)
  add(mesh.tangents, 4)
  add(mesh.uvs1, 2)
  add(mesh.joints, 4)
  add(mesh.weights, 4)
  for (const t of mesh.targets ?? []) {
    add(t.positions, 3)
    add(t.normals, 3)
    add(t.tangents, 3)
  }
  const same = (a: number, b: number) => {
    for (const { bits, width } of arrays) {
      for (let c = 0; c < width; c++) if (bits[a * width + c] !== bits[b * width + c]) return false
    }
    return true
  }
  let size = 1
  while (size < n * 2) size *= 2
  const table = new Int32Array(size).fill(-1)
  const remap = new Uint32Array(n)
  const keep: number[] = []
  for (let v = 0; v < n; v++) {
    let h = 0x811c9dc5
    for (const { bits, width } of arrays) {
      for (let c = 0; c < width; c++) h = Math.imul(h ^ bits[v * width + c]!, 0x01000193)
    }
    let slot = (h >>> 0) & (size - 1)
    for (;;) {
      const at = table[slot]!
      if (at < 0) {
        table[slot] = keep.length
        remap[v] = keep.length
        keep.push(v)
        break
      }
      if (same(keep[at]!, v)) {
        remap[v] = at
        break
      }
      slot = (slot + 1) & (size - 1)
    }
  }
  const source = sourceIndices(mesh)
  const tri: number[] = []
  for (let i = 0; i < source.length; i += 3) {
    const a = remap[source[i]!]!
    const b = remap[source[i + 1]!]!
    const c = remap[source[i + 2]!]!
    if (a !== b && b !== c && c !== a) tri.push(a, b, c)
  }
  const welded = new Uint32Array(keep.length)
  for (let i = 0; i < keep.length; i++) welded[i] = keep[i]!
  return reindex(mesh, welded, Uint32Array.from(tri))
}

function sequence(n: number): Uint32Array {
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) out[i] = i
  return out
}

/** Keeps only the vertices `indices` use, in first-use order, with every attribute. */
function compact(mesh: MeshData, indices: Uint32Array): MeshData {
  const count = mesh.positions.length / 3
  const remap = new Int32Array(count).fill(-1)
  let next = 0
  for (let k = 0; k < indices.length; k++) {
    const v = indices[k]!
    if (remap[v] === -1) remap[v] = next++
  }
  const keep = new Uint32Array(next)
  for (let v = 0; v < count; v++) if (remap[v]! >= 0) keep[remap[v]!] = v
  const tri = new Uint32Array(indices.length)
  for (let k = 0; k < indices.length; k++) tri[k] = remap[indices[k]!]!
  return reindex(mesh, keep, tri)
}

/** The vertices `keep` lists (in that order), with every attribute, drawn by `tri` (into `keep`). */
function reindex(mesh: MeshData, keep: Uint32Array, tri: Uint32Array): MeshData {
  const next = keep.length
  const pick = <T extends Float32Array | Uint16Array>(src: T | undefined, width: number) => {
    if (!src) return undefined
    const out = new (src.constructor as new (n: number) => T)(next * width)
    for (let i = 0; i < next; i++)
      for (let c = 0; c < width; c++) out[i * width + c] = src[keep[i]! * width + c]!
    return out
  }
  const out: MeshData = {
    positions: pick(mesh.positions, 3)!,
    indices: next > 65535 ? tri : Uint16Array.from(tri),
  }
  for (const a of MESH_ATTRIBUTES) {
    const picked = pick(mesh[a], MESH_ATTRIBUTE_WIDTH[a])
    if (picked) (out as unknown as Record<string, unknown>)[a] = picked
  }
  if (mesh.targets?.length) {
    out.targets = mesh.targets.map((t) => {
      const target: MorphTarget = { positions: pick(t.positions, 3)! }
      const normals = pick(t.normals, 3)
      if (normals) target.normals = normals
      const tangents = pick(t.tangents, 3)
      if (tangents) target.tangents = tangents
      return target
    })
  }
  return out
}
