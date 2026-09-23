import { PerformanceObserver } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { aabb, affine, frustum, mat3, mat4, quat, ray, vec3 } from '../src'

describe('math allocation (spec 0004)', () => {
  // Scalar-returning functions (dot, length, ray.intersectAabb, rng.float) are left out on purpose:
  // V8 boxes a non-integer number returned from a call it didn't inline, which is a calling
  // convention cost, not an allocation in the function. Everything here writes into `out`.
  it('out-parameter math allocates nothing (no GC over 2M iterations)', async () => {
    const gc = (globalThis as { gc?: () => void }).gc!
    const t = vec3.create(1, 2, 3)
    const q = quat.fromEuler(quat.create(), 0.1, 0.2, 0.3)
    const q2 = quat.fromEuler(quat.create(), 1, -0.5, 0.25)
    const s = vec3.create(1, 1, 1)
    const a = affine.create()
    const b = affine.create()
    const m = mat4.create()
    const m2 = mat4.create()
    const n = mat3.create()
    const v = vec3.create()
    const box = aabb.set(aabb.create(), [-1, -1, -1], [1, 1, 1])
    const out = aabb.create()
    const f = frustum.fromViewProjection(
      frustum.create(),
      mat4.perspectiveReversedZ(mat4.create(), 1, 1, 0.1),
    )
    const r = ray.create()
    // Results go into a typed array: a plain `let sink` double gets boxed on the heap until the
    // loop is optimized, which would count the harness's allocations against the math.
    const sink = new Float64Array(1)
    const run = (iterations: number) => {
      for (let i = 0; i < iterations; i++) {
        affine.fromTRSAt(a, 0, t, 0, q, 0, s, 0)
        affine.multiplyAt(b, 0, a, 0, a, 0)
        affine.invert(b, a)
        affine.toMat4At(m, a, 0)
        mat4.multiply(m2, m, m)
        mat4.invert(m2, m)
        mat3.normalFromAffineAt(n, a, 0)
        quat.slerp(q2, q, q2, 0.5)
        quat.multiply(q2, q, q2)
        vec3.transformQuat(v, t, q)
        vec3.transformMat4(v, v, m)
        aabb.transformAffineAt(out, box, a, 0)
        sink[0]! += frustum.intersectsAabbAt(f, out, 0) ? 1 : 0
        ray.fromScreen(r, 10, 10, 100, 100, m2)
      }
    }
    run(100_000) // warm up: let V8 optimize run() before measuring
    let collections = 0
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length
    })
    gc()
    observer.observe({ entryTypes: ['gc'] })
    run(2_000_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    observer.disconnect()
    console.log(`math GC events over 2M iterations: ${collections}`)
    expect(collections).toBe(0)
  })
})
