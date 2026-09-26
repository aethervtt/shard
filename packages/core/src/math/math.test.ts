import * as gl from 'gl-matrix'
import { describe, expect, it } from 'vitest'
import {
  aabb,
  affine,
  affine64,
  frustum,
  hash32,
  hashSeed,
  mat3,
  mat4,
  quat,
  Rng,
  ray,
  vec3,
} from '.'

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits)
}

const rng = new Rng(42)
const randomVec = () => [rng.range(-5, 5), rng.range(-5, 5), rng.range(-5, 5)] as const
const randomQuat = () => {
  const q = quat.fromAxisAngle(
    new Float32Array(4),
    vec3.normalize(new Float32Array(3), randomVec()),
    rng.range(-Math.PI, Math.PI),
  )
  return q
}
const randomScale = () => [rng.range(0.2, 3), rng.range(0.2, 3), rng.range(0.2, 3)] as const

describe('mat4 matches gl-matrix', () => {
  it('fromTRS, multiply, invert', () => {
    for (let i = 0; i < 50; i++) {
      const t = randomVec()
      const q = randomQuat()
      const s = randomScale()
      const ours = mat4.fromTRS(mat4.create(), t, q, s)
      const ref = gl.mat4.fromRotationTranslationScale(gl.mat4.create(), q, t, s)
      close(ours, ref)

      const other = mat4.fromTRS(mat4.create(), randomVec(), randomQuat(), randomScale())
      close(
        mat4.multiply(mat4.create(), ours, other),
        gl.mat4.multiply(gl.mat4.create(), ref, other),
        4,
      )
      close(mat4.invert(mat4.create(), ours)!, gl.mat4.invert(gl.mat4.create(), ref)!, 4)
    }
  })

  it('projections and lookAt', () => {
    close(
      mat4.perspective(mat4.create(), 1.1, 1.6, 0.1, 100),
      gl.mat4.perspectiveZO(gl.mat4.create(), 1.1, 1.6, 0.1, 100),
    )
    close(
      mat4.orthographic(mat4.create(), -4, 3, -2, 5, 0.5, 50),
      gl.mat4.orthoZO(gl.mat4.create(), -4, 3, -2, 5, 0.5, 50),
    )
    close(
      mat4.lookAt(mat4.create(), [3, 4, 5], [0, 1, 0], [0, 1, 0]),
      gl.mat4.lookAt(gl.mat4.create(), [3, 4, 5], [0, 1, 0], [0, 1, 0]),
    )
  })

  it('returns null for singular matrices', () => {
    expect(mat4.invert(mat4.create(), new Float32Array(16))).toBeNull()
  })
})

describe('reversed-Z projections', () => {
  it('perspective maps near to 1 and far toward 0', () => {
    const p = mat4.perspectiveReversedZ(mat4.create(), 1, 1, 0.1)
    expect(vec3.transformMat4(vec3.create(), [0, 0, -0.1], p)[2]).toBeCloseTo(1)
    expect(vec3.transformMat4(vec3.create(), [0, 0, -1000], p)[2]).toBeCloseTo(0.0001, 5)
  })

  it('orthographic maps near to 1 and far to 0', () => {
    const p = mat4.orthographicReversedZ(mat4.create(), -1, 1, -1, 1, 1, 11)
    expect(vec3.transformMat4(vec3.create(), [0, 0, -1], p)[2]).toBeCloseTo(1)
    expect(vec3.transformMat4(vec3.create(), [0, 0, -11], p)[2]).toBeCloseTo(0)
  })
})

describe('quat', () => {
  it('matches gl-matrix for axis-angle, multiply, slerp', () => {
    for (let i = 0; i < 50; i++) {
      const axis = vec3.normalize(vec3.create(), randomVec())
      const angle = rng.range(-3, 3)
      const a = quat.fromAxisAngle(quat.create(), axis, angle)
      close(a, gl.quat.setAxisAngle(gl.quat.create(), axis, angle))
      const b = randomQuat()
      close(quat.multiply(quat.create(), a, b), gl.quat.multiply(gl.quat.create(), a, b))
      const t = rng.float()
      close(quat.slerp(quat.create(), a, b, t), gl.quat.slerp(gl.quat.create(), a, b, t), 4)
    }
  })

  it('fromEuler applies X, then Y, then Z', () => {
    const [x, y, z] = [0.3, -1.1, 2.0]
    const qx = quat.fromAxisAngle(quat.create(), [1, 0, 0], x)
    const qy = quat.fromAxisAngle(quat.create(), [0, 1, 0], y)
    const qz = quat.fromAxisAngle(quat.create(), [0, 0, 1], z)
    const expected = quat.multiply(quat.create(), qz, quat.multiply(quat.create(), qy, qx))
    close(quat.fromEuler(quat.create(), x, y, z), expected)
  })

  it('rotates vectors like gl-matrix', () => {
    const q = randomQuat()
    const v = randomVec()
    close(vec3.transformQuat(vec3.create(), v, q), gl.vec3.transformQuat(gl.vec3.create(), v, q))
  })

  it('lookRotation points -Z at the target direction', () => {
    const forward = vec3.normalize(vec3.create(), [1, -0.5, 2])
    const q = quat.lookRotation(quat.create(), forward, [0, 1, 0])
    close(vec3.transformQuat(vec3.create(), [0, 0, -1], q), forward)
    const up = vec3.transformQuat(vec3.create(), [0, 1, 0], q)
    expect(up[1]).toBeGreaterThan(0)
  })
})

describe('affine 3x4', () => {
  it('matches mat4 for TRS, multiply, invert, and points', () => {
    for (let i = 0; i < 50; i++) {
      const t = randomVec()
      const q = randomQuat()
      const s = randomScale()
      const a = affine.fromTRS(affine.create(), t, q, s)
      const m = mat4.fromTRS(mat4.create(), t, q, s)
      close(affine.toMat4(mat4.create(), a), m)
      close(affine.fromMat4(affine.create(), m), a)

      const b = affine.fromTRS(affine.create(), randomVec(), randomQuat(), randomScale())
      const ab = affine.toMat4(mat4.create(), affine.multiply(affine.create(), a, b))
      close(ab, mat4.multiply(mat4.create(), m, affine.toMat4(mat4.create(), b)), 4)

      const inv = affine.toMat4(mat4.create(), affine.invert(affine.create(), a)!)
      close(inv, mat4.invert(mat4.create(), m)!, 4)

      const p = randomVec()
      close(affine.transformPoint(vec3.create(), a, p), vec3.transformMat4(vec3.create(), p, m), 4)
    }
  })

  it('works at column offsets', () => {
    const column = new Float32Array(36)
    const ts = new Float32Array([0, 0, 0, 1, 2, 3, 0, 0, 0])
    const qs = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
    const ss = new Float32Array(9).fill(1)
    affine.fromTRSAt(column, 12, ts, 3, qs, 4, ss, 3)
    expect([...column.slice(12, 24)]).toEqual([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3])
    expect(column[0]).toBe(0)
  })

  it('normal matrix matches gl-matrix normalFromMat4', () => {
    const t = randomVec()
    const q = randomQuat()
    const s = randomScale()
    const a = affine.fromTRS(affine.create(), t, q, s)
    const m = mat4.fromTRS(mat4.create(), t, q, s)
    close(
      mat3.normalFromAffineAt(mat3.create(), a, 0)!,
      gl.mat3.normalFromMat4(gl.mat3.create(), m)!,
      4,
    )
  })
})

describe('bounds, rays, frustums', () => {
  const corners = (box: ArrayLike<number>) => {
    const out: number[][] = []
    for (let i = 0; i < 8; i++) {
      out.push([i & 1 ? box[3]! : box[0]!, i & 2 ? box[4]! : box[1]!, i & 4 ? box[5]! : box[2]!])
    }
    return out
  }

  it('transforms boxes exactly (Arvo) against a corner brute force', () => {
    const box = aabb.set(aabb.create(), [-1, -2, -0.5], [2, 1, 3])
    const m = affine.fromTRS(affine.create(), randomVec(), randomQuat(), randomScale())
    const expected = aabb.empty(aabb.create())
    for (const c of corners(box)) {
      const p = affine.transformPoint(vec3.create(), m, c)
      for (let k = 0; k < 3; k++) {
        expected[k] = Math.min(expected[k]!, p[k]!)
        expected[k + 3] = Math.max(expected[k + 3]!, p[k]!)
      }
    }
    close(aabb.transformAffineAt(aabb.create(), box, m, 0), expected, 4)
  })

  it('frustum test agrees with a corner brute force on 10k random boxes', () => {
    const view = mat4.lookAt(mat4.create(), [0, 2, 10], [0, 0, 0], [0, 1, 0])
    const proj = mat4.perspectiveReversedZ(mat4.create(), 1, 1.5, 0.1)
    const vp = mat4.multiply(mat4.create(), proj, view)
    const f = frustum.fromViewProjection(frustum.create(), vp)
    let visible = 0
    for (let i = 0; i < 10_000; i++) {
      const c = [rng.range(-60, 60), rng.range(-60, 60), rng.range(-60, 60)]
      const h = [rng.range(0.1, 3), rng.range(0.1, 3), rng.range(0.1, 3)]
      const box = aabb.set(
        aabb.create(),
        [c[0]! - h[0]!, c[1]! - h[1]!, c[2]! - h[2]!],
        [c[0]! + h[0]!, c[1]! + h[1]!, c[2]! + h[2]!],
      )
      // Brute force: rejected iff all 8 corners are outside some plane.
      let brute = true
      for (let p = 0; p < 24; p += 4) {
        if (
          corners(box).every(
            (q) => f[p]! * q[0]! + f[p + 1]! * q[1]! + f[p + 2]! * q[2]! + f[p + 3]! < 0,
          )
        ) {
          brute = false
          break
        }
      }
      const ours = frustum.intersectsAabb(f, box)
      expect(ours).toBe(brute)
      if (ours) visible++
    }
    expect(visible).toBeGreaterThan(100)
    expect(visible).toBeLessThan(9_000)
  })

  it('culls boxes behind the camera and keeps boxes in front', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0])
    const proj = mat4.perspectiveReversedZ(mat4.create(), 1, 1, 0.1)
    const f = frustum.fromViewProjection(frustum.create(), mat4.multiply(mat4.create(), proj, view))
    expect(frustum.intersectsAabb(f, aabb.set(aabb.create(), [-1, -1, -11], [1, 1, -9]))).toBe(true)
    expect(frustum.intersectsAabb(f, aabb.set(aabb.create(), [-1, -1, 9], [1, 1, 11]))).toBe(false)
    expect(
      frustum.intersectsAabb(f, aabb.set(aabb.create(), [-1, -1, -1e6], [1, 1, -1e6 + 1])),
    ).toBe(true)
  })

  it('casts screen rays and hits boxes', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0])
    const proj = mat4.perspectiveReversedZ(mat4.create(), 1, 1, 0.1)
    const inv = mat4.invert(mat4.create(), mat4.multiply(mat4.create(), proj, view))!
    const r = ray.fromScreen(ray.create(), 50, 50, 100, 100, inv)
    close(r.slice(3), [0, 0, -1])
    expect(ray.intersectAabb(r, aabb.set(aabb.create(), [-1, -1, -1], [1, 1, 1]))).toBeCloseTo(
      4 - (5 - r[2]!),
      3,
    )
    const miss = ray.fromScreen(ray.create(), 0, 0, 100, 100, inv)
    expect(
      ray.intersectAabb(miss, aabb.set(aabb.create(), [-0.1, -0.1, -0.1], [0.1, 0.1, 0.1])),
    ).toBe(-1)
  })
})

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(7)
    const b = new Rng(7)
    const c = new Rng(8)
    const seqA = Array.from({ length: 5 }, () => a.nextU32())
    expect(Array.from({ length: 5 }, () => b.nextU32())).toEqual(seqA)
    expect(Array.from({ length: 5 }, () => c.nextU32())).not.toEqual(seqA)
  })

  it('stays in range and is roughly uniform', () => {
    const r = new Rng(1)
    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 100_000; i++) {
      const v = r.float()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      buckets[Math.floor(v * 10)]++
    }
    for (const n of buckets) expect(Math.abs(n - 10_000)).toBeLessThan(500)
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 5)
      expect([3, 4, 5]).toContain(n)
    }
  })

  it('forks are independent of draws made elsewhere', () => {
    const a = new Rng(99)
    const b = new Rng(99)
    for (let i = 0; i < 1000; i++) b.float() // extra draws on the parent
    const fa = a.fork('terrain')
    const fb = b.fork('terrain')
    expect(Array.from({ length: 5 }, () => fa.float())).toEqual(
      Array.from({ length: 5 }, () => fb.float()),
    )
    expect(a.fork('terrain').float()).not.toBe(a.fork('props').float())
  })

  it('forks with hashSeed, and numeric labels hash as bytes', () => {
    expect(new Rng(99).fork('terrain').seed).toBe(hashSeed(99, 'terrain'))
    // The value fork has always produced for this seed and label (kept across the refactor).
    expect(hashSeed(99, 'terrain')).toBe(568329866)
    expect(hashSeed(7, 1)).not.toBe(hashSeed(7, 2))
    expect(hashSeed(7, 1)).not.toBe(hashSeed(8, 1))
    expect(hashSeed(7, 1)).toBeGreaterThanOrEqual(0)
    expect(hash32(1, 2, 3, 4)).toBe(hash32(1, 2, 3, 4, 0))
    expect(hash32(1, 2, 3, 4)).not.toBe(hash32(1, 2, 3, 5))
    expect(hash32(-5 >>> 0, -1, -2)).toBeGreaterThanOrEqual(0)
  })
})

describe('affine64', () => {
  it('keeps f64 precision where affine on f32 would not', () => {
    const a = affine64.create()
    affine64.translateAt(a, 0, a, 0, 1e12, 0, 0)
    const b = affine64.create()
    affine64.translateAt(b, 0, b, 0, 0.001, 0, 0)
    const out = affine64.multiply(affine64.create(), a, b)
    // f64 spacing at 1e12 is ~1.2e-4 m; f32 would be ~65 km.
    expect(Math.abs(out[3]! - 1e12 - 0.001)).toBeLessThan(2e-4)
    const inv = affine64.invert(affine64.create(), out)!
    expect(inv[3]).toBeCloseTo(-(1e12 + 0.001), 3)
    expect(affine64.transformVectorAt([0, 0, 0], out, 0, [1, 2, 3])).toEqual([1, 2, 3])
  })
})
