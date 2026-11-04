/** Texels per side of the ripple map. */
export const RIPPLE_SIZE = 128

/**
 * The ripple map (0097): a tileable field of small waves, baked once on the CPU from a seed. Each
 * texel holds the height's slope along u and v (rg, 0.5 is flat), mip by mip down to 1×1. u runs
 * downwind when the shader samples it, so the waves lean that way. Deterministic.
 */
export function bakeRipples(size = RIPPLE_SIZE, seed = 0x9e3779b9): Uint8Array[] {
  let s = seed >>> 0
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  // Integer wave vectors tile. Directions spread about u (downwind), more of them short; slopes
  // fall as k^-1.5, so the short ones add detail without ruling the pattern.
  const waves: number[] = []
  for (let i = 0; i < 64; i++) {
    const k = 2 + 14 * rand() ** 2
    const angle = (rand() * 2 - 1) * (Math.PI / 3)
    const kx = Math.round(k * Math.cos(angle))
    const ky = Math.round(k * Math.sin(angle))
    if (kx === 0 && ky === 0) continue
    const len = Math.sqrt(kx * kx + ky * ky)
    waves.push(kx, ky, (0.5 + rand()) / len ** 2.5, rand() * Math.PI * 2)
  }
  const su = new Float32Array(size * size)
  const sv = new Float32Array(size * size)
  let sum = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let du = 0
      let dv = 0
      for (let w = 0; w < waves.length; w += 4) {
        const kx = waves[w]!
        const ky = waves[w + 1]!
        const a = waves[w + 2]!
        const phase = 2 * Math.PI * (kx * (x / size) + ky * (y / size)) + waves[w + 3]!
        const d = -a * 2 * Math.PI * Math.sin(phase)
        du += d * kx
        dv += d * ky
      }
      su[y * size + x] = du
      sv[y * size + x] = dv
      sum += du * du + dv * dv
    }
  }
  // Scaled so the slope's RMS is a third of the range: the shader's strength sets the real tilt.
  const scale = 1 / (3 * Math.sqrt(sum / (size * size)))
  const levels: Uint8Array[] = []
  let w = size
  let u = su
  let v = sv
  for (;;) {
    const bytes = new Uint8Array(w * w * 4)
    for (let i = 0; i < w * w; i++) {
      bytes[i * 4] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.5 * u[i]! * scale)))
      bytes[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.5 * v[i]! * scale)))
      bytes[i * 4 + 2] = 128
      bytes[i * 4 + 3] = 255
    }
    levels.push(bytes)
    if (w === 1) break
    const h = w >> 1
    const nu = new Float32Array(h * h)
    const nv = new Float32Array(h * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const o = y * 2 * w + x * 2
        nu[y * h + x] = (u[o]! + u[o + 1]! + u[o + w]! + u[o + w + 1]!) / 4
        nv[y * h + x] = (v[o]! + v[o + 1]! + v[o + w]! + v[o + w + 1]!) / 4
      }
    }
    u = nu
    v = nv
    w = h
  }
  return levels
}
