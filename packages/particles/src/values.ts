import { ShardError } from '@shard/core'

/**
 * Value forms in effect files:
 * - scalar: `3` or a seeded range `[2, 5]`
 * - color: `"#9ad4ff"` (sRGB hex, optional alpha), `[r, g, b, a]` (linear), or a range of two
 * - curve: `[[t, v], …]` over normalized life, piecewise linear, or a constant number
 * - gradient: `[[t, color, alpha?], …]` over normalized life
 */

export type Scalar = number | [number, number]
export type Rgba = [number, number, number, number]

/** A problem in an effect file, with a JSON pointer to it. */
export function invalid(path: string, message: string, hint?: string): ShardError {
  return new ShardError('particles/invalid-effect', message, { path, hint })
}

export function scalar(
  json: unknown,
  path: string,
  errors: ShardError[],
  fallback: number,
): [number, number] {
  if (json === undefined) return [fallback, fallback]
  if (typeof json === 'number' && Number.isFinite(json)) return [json, json]
  if (
    Array.isArray(json) &&
    json.length === 2 &&
    json.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return [json[0] as number, json[1] as number]
  }
  errors.push(invalid(path, 'Expected a number or a [min, max] range', 'Examples: 4, [0.3, 0.6].'))
  return [fallback, fallback]
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function singleColor(json: unknown): Rgba | undefined {
  if (typeof json === 'string') {
    // #rgb and #rgba expand to #rrggbb and #rrggbbaa.
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(json)
    const hex = short
      ? `#${short
          .slice(1)
          .map((c) => (c ?? '') + (c ?? ''))
          .join('')}`
      : json
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex)
    if (!m) return undefined
    const n = Number.parseInt(m[1]!, 16)
    const a = m[2] ? Number.parseInt(m[2], 16) / 255 : 1
    return [
      toLinear(((n >> 16) & 255) / 255),
      toLinear(((n >> 8) & 255) / 255),
      toLinear((n & 255) / 255),
      a,
    ]
  }
  if (
    Array.isArray(json) &&
    (json.length === 3 || json.length === 4) &&
    json.every((v) => typeof v === 'number')
  ) {
    return [json[0], json[1], json[2], json[3] ?? 1] as Rgba
  }
  return undefined
}

/** A color or a range of two colors (each picked per particle). */
export function color(json: unknown, path: string, errors: ShardError[]): [Rgba, Rgba] {
  if (json === undefined)
    return [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]
  const one = singleColor(json)
  if (one) return [one, one]
  if (Array.isArray(json) && json.length === 2) {
    const a = singleColor(json[0])
    const b = singleColor(json[1])
    if (a && b) return [a, b]
  }
  errors.push(
    invalid(
      path,
      'Expected a color',
      'Colors: "#rrggbb" (sRGB), [r, g, b, a] (linear), or a range ["#fff", "#f80"].',
    ),
  )
  return [
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  ]
}

/** Piecewise-linear keys over normalized life: [t, v] with t increasing in [0, 1]. */
export function curve(json: unknown, path: string, errors: ShardError[]): [number, number][] {
  if (typeof json === 'number') return [[0, json]]
  if (
    Array.isArray(json) &&
    json.length > 0 &&
    json.every((k) => Array.isArray(k) && k.length === 2 && k.every((v) => typeof v === 'number'))
  ) {
    const keys = json as [number, number][]
    for (let i = 1; i < keys.length; i++) {
      if (keys[i]![0] < keys[i - 1]![0]) {
        errors.push(invalid(`${path}/${i}/0`, 'Curve keys must be in increasing time order'))
      }
    }
    return keys
  }
  errors.push(
    invalid(
      path,
      'Expected a curve: [[t, value], …] with t from 0 to 1',
      'Example: [[0, 0.5], [0.2, 1], [1, 2]].',
    ),
  )
  return [[0, 1]]
}

/** Color keys over normalized life: [t, color, alpha?]. */
export function gradient(json: unknown, path: string, errors: ShardError[]): [number, Rgba][] {
  if (Array.isArray(json) && json.length > 0) {
    const out: [number, Rgba][] = []
    json.forEach((k, i) => {
      const c = Array.isArray(k) ? singleColor(k[1]) : undefined
      if (!Array.isArray(k) || typeof k[0] !== 'number' || !c) {
        errors.push(
          invalid(
            `${path}/${i}`,
            'Expected a gradient key: [t, color, alpha?]',
            'Example: [0.4, "#4aa3ff", 0.7].',
          ),
        )
        return
      }
      if (typeof k[2] === 'number') c[3] = k[2]
      out.push([k[0], c])
    })
    if (out.length > 0) return out
  }
  errors.push(invalid(path, 'Expected a gradient: [[t, color, alpha?], …]'))
  return [[0, [1, 1, 1, 1]]]
}

// --- evaluation, on the CPU and as WGSL --------------------------------------------------------

/** PCG hash (u32 → u32): the same bits on the CPU and in the shaders. */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  return ((word >>> 22) ^ word) >>> 0
}

/** The k-th random number in [0, 1) of a particle's stream. */
export function rand(seed: number, k: number): number {
  return pcg((seed ^ pcg(k)) >>> 0) / 4294967296
}

export const WGSL_RANDOM = `
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand(seed: u32, k: u32) -> f32 {
  return f32(pcg(seed ^ pcg(k))) / 4294967296.0;
}`

export function evalCurve(keys: readonly [number, number][], t: number): number {
  if (t <= keys[0]![0]) return keys[0]![1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]!
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]!
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(t1 - t0, 1e-9)
    }
  }
  return keys[keys.length - 1]![1]
}

const f = (v: number) => {
  const s = Number.isInteger(v) ? `${v}.0` : `${v}`
  return s.includes('e') ? v.toFixed(9) : s
}

/** A WGSL function `fn <name>(t: f32) -> f32` for a curve, keys inlined. */
export function wgslCurve(name: string, keys: readonly [number, number][]): string {
  const lines = [
    `fn ${name}(t: f32) -> f32 {`,
    `  if (t <= ${f(keys[0]![0])}) { return ${f(keys[0]![1])}; }`,
  ]
  for (let i = 1; i < keys.length; i++) {
    const [t0, v0] = keys[i - 1]!
    const [t1, v1] = keys[i]!
    lines.push(
      `  if (t <= ${f(t1)}) { return mix(${f(v0)}, ${f(v1)}, (t - ${f(t0)}) / ${f(Math.max(t1 - t0, 1e-9))}); }`,
    )
  }
  lines.push(`  return ${f(keys[keys.length - 1]![1])};`, '}')
  return lines.join('\n')
}

/** A WGSL function `fn <name>(t: f32) -> vec4f` for a gradient. */
export function wgslGradient(name: string, keys: readonly [number, Rgba][]): string {
  const v = (c: Rgba) => `vec4f(${c.map(f).join(', ')})`
  const lines = [
    `fn ${name}(t: f32) -> vec4f {`,
    `  if (t <= ${f(keys[0]![0])}) { return ${v(keys[0]![1])}; }`,
  ]
  for (let i = 1; i < keys.length; i++) {
    const [t0, c0] = keys[i - 1]!
    const [t1, c1] = keys[i]!
    lines.push(
      `  if (t <= ${f(t1)}) { return mix(${v(c0)}, ${v(c1)}, (t - ${f(t0)}) / ${f(Math.max(t1 - t0, 1e-9))}); }`,
    )
  }
  lines.push(`  return ${v(keys[keys.length - 1]![1])};`, '}')
  return lines.join('\n')
}

export function evalGradient(keys: readonly [number, Rgba][], t: number, out: Rgba): Rgba {
  if (t <= keys[0]![0]) {
    out.splice(0, 4, ...keys[0]![1])
    return out
  }
  for (let i = 1; i < keys.length; i++) {
    const [t1, c1] = keys[i]!
    if (t <= t1) {
      const [t0, c0] = keys[i - 1]!
      const u = (t - t0) / Math.max(t1 - t0, 1e-9)
      for (let k = 0; k < 4; k++) out[k] = c0[k]! + (c1[k]! - c0[k]!) * u
      return out
    }
  }
  out.splice(0, 4, ...keys[keys.length - 1]![1])
  return out
}

export const wgslFloat = f
