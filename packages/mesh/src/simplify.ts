import { ShardError } from '@aethervtt/shard-core'
import type { MeshData } from './mesh'

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
 * aren't moved, only dropped, so UVs, colors, and normals stay the source's; UV seams and borders
 * (with `lockBorder`) are kept. If seams stop it short of the target, it retries allowed to
 * collapse across them, and then as a last resort with the positions-only (sloppy) simplifier.
 */
export function simplifyMesh(
  mesh: MeshData,
  fraction: number,
  options: SimplifyOptions = {},
): Simplified {
  const s = loaded()
  if (!(fraction > 0 && fraction <= 1)) {
    throw new ShardError('mesh/bad-lod', `A LOD fraction must be in (0, 1], got ${fraction}`, {
      hint: 'lods: [0.5, 0.2] keeps about half, then a fifth, of the triangles.',
    })
  }
  const count = mesh.positions.length / 3
  const source = mesh.indices ? Uint32Array.from(mesh.indices) : sequence(count)
  const triangles = source.length / 3
  const target = Math.max(1, Math.floor(triangles * fraction)) * 3
  if (target >= source.length) return { mesh, error: 0 }
  // Normals and UVs steer which collapses look worst (weights relative to position error).
  const attrStride = 5
  const attrs = new Float32Array(count * attrStride)
  for (let v = 0; v < count; v++) {
    if (mesh.normals) {
      attrs[v * 5] = mesh.normals[v * 3]!
      attrs[v * 5 + 1] = mesh.normals[v * 3 + 1]!
      attrs[v * 5 + 2] = mesh.normals[v * 3 + 2]!
    }
    if (mesh.uvs) {
      attrs[v * 5 + 3] = mesh.uvs[v * 2]!
      attrs[v * 5 + 4] = mesh.uvs[v * 2 + 1]!
    }
  }
  const weights = [0.25, 0.25, 0.25, mesh.uvs ? 0.5 : 0, mesh.uvs ? 0.5 : 0]
  const flags: ('LockBorder' | 'ErrorAbsolute' | 'Permissive')[] = []
  if (options.lockBorder) flags.push('LockBorder')
  if (options.absolute) flags.push('ErrorAbsolute')
  const maxError = options.error ?? 1
  const slack = Math.floor((target / 3) * 1.1) * 3
  let [indices, error] = s.simplifyWithAttributes(
    source,
    mesh.positions,
    3,
    attrs,
    attrStride,
    weights,
    null,
    target,
    maxError,
    flags,
  )
  if (indices.length > slack && options.error === undefined) {
    ;[indices, error] = s.simplifyWithAttributes(
      source,
      mesh.positions,
      3,
      attrs,
      attrStride,
      weights,
      null,
      target,
      maxError,
      [...flags, 'Permissive'],
    )
  }
  if (indices.length > slack && options.error === undefined && !options.lockBorder) {
    ;[indices, error] = s.simplifySloppy(source, mesh.positions, 3, null, target, maxError)
  }
  return { mesh: compact(mesh, indices), error }
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
  const keep = new Int32Array(next)
  for (let v = 0; v < count; v++) if (remap[v]! >= 0) keep[remap[v]!] = v
  const pick = <T extends Float32Array | Uint16Array>(src: T | undefined, width: number) => {
    if (!src) return undefined
    const out = new (src.constructor as new (n: number) => T)(next * width)
    for (let i = 0; i < next; i++)
      for (let c = 0; c < width; c++) out[i * width + c] = src[keep[i]! * width + c]!
    return out
  }
  const tri = next > 65535 ? new Uint32Array(indices.length) : new Uint16Array(indices.length)
  for (let k = 0; k < indices.length; k++) tri[k] = remap[indices[k]!]!
  const out: MeshData = { positions: pick(mesh.positions, 3)!, indices: tri }
  const normals = pick(mesh.normals, 3)
  if (normals) out.normals = normals
  const uvs = pick(mesh.uvs, 2)
  if (uvs) out.uvs = uvs
  const colors = pick(mesh.colors, 4)
  if (colors) out.colors = colors
  const tangents = pick(mesh.tangents, 4)
  if (tangents) out.tangents = tangents
  const uvs1 = pick(mesh.uvs1, 2)
  if (uvs1) out.uvs1 = uvs1
  return out
}
