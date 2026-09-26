// The noise kernel's JavaScript side: instances, memory layout, origin splits, and the point
// generators for grids and cube-sphere patches. Plain JavaScript with no imports, because worker
// threads load it directly (no bundler, no TypeScript loader). Types are in kernel.d.ts.

/** Points per block: a register's length (matches `program::BLOCK`). */
export const BLOCK = 256
/** i32 words per origin record: cell xyzw, then fraction xyzw as f32 bits. */
export const ORIGIN_WORDS = 8

// Skew factors as the f32 values the kernel uses, so the f64 origin split and the f32 local part
// apply the same matrix.
const F2 = Math.fround((Math.sqrt(3) - 1) / 2)
const F4 = Math.fround((Math.sqrt(5) - 1) / 4)
const TWO_THIRDS = Math.fround(2 / 3)
const I32_LIMIT = 2 ** 31

const bits = new Float32Array(1)
const bitsI = new Int32Array(bits.buffer)

function kernelError(code, message, hint) {
  return Object.assign(new Error(message), { code, hint })
}

/**
 * Writes one origin record per term: the lattice position of `origin` (f64: a × origin + b, then the
 * source's skew) split into an i32 cell and an f32 fraction.
 */
export function computeOrigins(terms, origin, out) {
  const { a, b, skew } = terms
  const ox = origin[0] ?? 0
  const oy = origin[1] ?? 0
  const oz = origin[2] ?? 0
  const ow = origin[3] ?? 0
  for (let j = 0; j < skew.length; j++) {
    const j4 = j * 4
    let x = a[j4] * ox + b[j4]
    let y = a[j4 + 1] * oy + b[j4 + 1]
    let z = a[j4 + 2] * oz + b[j4 + 2]
    let w = a[j4 + 3] * ow + b[j4 + 3]
    const k = skew[j]
    if (k === 2) {
      const s = (x + y) * F2
      x += s
      y += s
    } else if (k === 3) {
      const r = (x + y + z) * TWO_THIRDS
      x = r - x
      y = r - y
      z = r - z
    } else if (k === 4) {
      const s = (x + y + z + w) * F4
      x += s
      y += s
      z += s
      w += s
    }
    const o = j * ORIGIN_WORDS
    split(x, out, o)
    split(y, out, o + 1)
    split(z, out, o + 2)
    split(w, out, o + 3)
  }
  return out
}

function split(v, out, i) {
  const cell = Math.floor(v)
  if (!(cell < I32_LIMIT && cell >= -I32_LIMIT)) {
    throw kernelError(
      'noise/frequency-too-high',
      `A lattice coordinate reached ${v.toExponential(2)}, past what an i32 cell holds (2³¹)`,
      'Lower the graph’s finest frequency, or sample closer to the origin.',
    )
  }
  out[i] = cell | 0
  bits[0] = v - cell
  out[i + 4] = bitsI[0]
}

const states = new WeakMap()

/** The instance for a compiled kernel module in this thread (made on first use). */
export function instantiate(module, instance) {
  let s = states.get(module)
  if (!s) {
    const inst = instance ?? new WebAssembly.Instance(module, {})
    s = {
      x: inst.exports,
      memory: inst.exports.memory,
      base: 0,
      capacity: 0,
      f32: null,
      i32: null,
      // The last output range as a view, reused while calls keep the same size.
      outView: null,
      outAt: -1,
    }
    states.set(module, s)
  }
  return s
}

const align = (n) => (n + 15) & ~15

/**
 * Runs `program` at `count` points (`stride` floats each, local to the origin the records were
 * computed for) and writes the results into `out` from `outOffset`. Allocates nothing once the
 * instance's memory is big enough.
 */
export function evalProgram(state, program, seed, origins, pts, stride, count, out, outOffset = 0) {
  if (count === 0) return
  const codeOff = 0
  const constOff = codeOff + align(program.code.length * 4)
  const originOff = constOff + align(program.consts.length * 4)
  const ptsOff = originOff + align(origins.length * 4)
  const outOff = ptsOff + align(count * stride * 4)
  const regOff = outOff + align(count * 4)
  const total = regOff + program.registers * BLOCK * 4
  if (total > state.capacity) {
    const base = state.x.reserve(total)
    if (base === 0)
      throw kernelError('noise/out-of-memory', `The noise kernel couldn't reserve ${total} bytes`)
    state.base = base
    state.capacity = total
  }
  if (state.f32 === null || state.f32.buffer !== state.memory.buffer) {
    state.f32 = new Float32Array(state.memory.buffer)
    state.i32 = new Int32Array(state.memory.buffer)
    state.outView = null
  }
  const f32 = state.f32
  const i32 = state.i32
  const base = state.base
  i32.set(program.code, (base + codeOff) >> 2)
  f32.set(program.consts, (base + constOff) >> 2)
  i32.set(origins, (base + originOff) >> 2)
  const n = count * stride
  const p = (base + ptsOff) >> 2
  if (pts.length === n) f32.set(pts, p)
  else for (let i = 0; i < n; i++) f32[p + i] = pts[i]
  state.x.eval(
    base + codeOff,
    program.code.length / 12,
    base + constOff,
    base + originOff,
    seed >>> 0,
    base + ptsOff,
    stride,
    count,
    base + outOff,
    base + regOff,
    program.result,
  )
  const o = (base + outOff) >> 2
  if (state.outView === null || state.outAt !== o || state.outView.length !== count) {
    state.outView = f32.subarray(o, o + count)
    state.outAt = o
  }
  out.set(state.outView, outOffset)
}

// --- cube sphere -------------------------------------------------------------------------------

/** Per face: normal, right, and up axes (right × up = normal). Faces are +X, −X, +Y, −Y, +Z, −Z. */
const FACES = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
]

const QUARTER_PI = Math.PI / 4

/**
 * The unit direction for face coordinates (u, v) in [-1, 1], with the tangent-adjusted mapping
 * (each coordinate goes through tan(π/4 · u)), which keeps cells within 1.4× of each other in area.
 */
export function faceToDirection(face, u, v, out, offset = 0) {
  const f = FACES[face]
  const tu = Math.tan(QUARTER_PI * u)
  const tv = Math.tan(QUARTER_PI * v)
  const x = f[0] + tu * f[3] + tv * f[6]
  const y = f[1] + tu * f[4] + tv * f[7]
  const z = f[2] + tu * f[5] + tv * f[8]
  const inv = 1 / Math.sqrt(x * x + y * y + z * z)
  out[offset] = x * inv
  out[offset + 1] = y * inv
  out[offset + 2] = z * inv
  return out
}

/** The face a direction lands on, with its face coordinates written to `out` as [u, v]. */
export function directionToFace(x, y, z, out) {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  const face =
    ax >= ay && ax >= az ? (x >= 0 ? 0 : 1) : ay >= az ? (y >= 0 ? 2 : 3) : z >= 0 ? 4 : 5
  const f = FACES[face]
  const n = x * f[0] + y * f[1] + z * f[2]
  out[0] = Math.atan((x * f[3] + y * f[4] + z * f[5]) / n) / QUARTER_PI
  out[1] = Math.atan((x * f[6] + y * f[7] + z * f[8]) / n) / QUARTER_PI
  return face
}

const dir = new Float64Array(3)

/** The f64 center of a sphere patch: its middle direction × radius. */
export function patchOrigin(p, out) {
  const half = p.extent / 2
  faceToDirection(p.face, p.x0 + half, p.y0 + half, dir)
  out[0] = dir[0] * p.radius
  out[1] = dir[1] * p.radius
  out[2] = dir[2] * p.radius
  out[3] = 0
  return out
}

/**
 * Local points (xyz, relative to `origin`) for rows [row0, row1) of a sphere patch: `resolution`
 * vertices per side spanning [x0, x0 + extent] × [y0, y0 + extent] of the face.
 */
export function patchPoints(p, origin, row0, row1, out) {
  const last = p.resolution - 1
  let k = 0
  for (let j = row0; j < row1; j++) {
    const v = p.y0 + (p.extent * j) / last
    for (let i = 0; i <= last; i++) {
      faceToDirection(p.face, p.x0 + (p.extent * i) / last, v, dir)
      out[k++] = dir[0] * p.radius - origin[0]
      out[k++] = dir[1] * p.radius - origin[1]
      out[k++] = dir[2] * p.radius - origin[2]
    }
  }
  return out
}

/** The f64 center of a grid. */
export function gridOrigin(g, out) {
  out[0] = g.origin[0] + g.size[0] / 2
  out[1] = g.origin[1] + g.size[1] / 2
  out[2] = g.z ?? 0
  out[3] = 0
  return out
}

/** Local points for rows [row0, row1) of a grid on the z = `g.z` plane. */
export function gridPoints(g, origin, row0, row1, out) {
  const [nx, ny] = g.resolution
  let k = 0
  for (let j = row0; j < row1; j++) {
    const y = g.origin[1] + (ny > 1 ? (g.size[1] * j) / (ny - 1) : 0)
    for (let i = 0; i < nx; i++) {
      const x = g.origin[0] + (nx > 1 ? (g.size[0] * i) / (nx - 1) : 0)
      out[k++] = x - origin[0]
      out[k++] = y - origin[1]
      out[k++] = 0
    }
  }
  return out
}
