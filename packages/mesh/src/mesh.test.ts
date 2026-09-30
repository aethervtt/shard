import { describe, expect, it } from 'vitest'
import { decodeMesh, encodeMesh } from './codec'
import { Mesh } from './mesh'
import { bevelBox, box, capsule, cone, cube, cylinder, plane, sphere, torus } from './primitives'

const primitives: [string, Mesh][] = [
  ['cube', cube()],
  ['box', box({ x: 2, y: 1, z: 0.5 })],
  ['sphere', sphere({ radius: 1, segments: 24 })],
  ['plane', plane({ size: 4, subdivisions: 3 })],
  ['cylinder', cylinder({ radius: 0.5, height: 2 })],
  ['cone', cone({ radius: 0.5, height: 1 })],
  ['capsule', capsule({ radius: 0.5, height: 2 })],
  ['torus', torus()],
  ['bevelBox', bevelBox({ x: 1, y: 1, z: 1 })],
]

describe('primitives', () => {
  it.each(primitives)(
    '%s has unit normals, UVs, and CCW faces that agree with the normals',
    (_, mesh) => {
      const { positions: p, normals: n, uvs, indices } = mesh
      expect(n).toBeDefined()
      expect(uvs!.length).toBe(mesh.vertexCount * 2)
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(Math.hypot(n![i * 3]!, n![i * 3 + 1]!, n![i * 3 + 2]!)).toBeCloseTo(1, 4)
      }
      let degenerate = 0
      for (let t = 0; t < indices!.length; t += 3) {
        const [a, b, c] = [indices![t]!, indices![t + 1]!, indices![t + 2]!]
        const e1 = [0, 1, 2].map((k) => p[b * 3 + k]! - p[a * 3 + k]!)
        const e2 = [0, 1, 2].map((k) => p[c * 3 + k]! - p[a * 3 + k]!)
        const face = [
          e1[1]! * e2[2]! - e1[2]! * e2[1]!,
          e1[2]! * e2[0]! - e1[0]! * e2[2]!,
          e1[0]! * e2[1]! - e1[1]! * e2[0]!,
        ]
        const area = Math.hypot(face[0]!, face[1]!, face[2]!)
        if (area < 1e-9) {
          degenerate++
          continue
        }
        // Average vertex normal of the triangle must point the same way as the face.
        const avg = [0, 1, 2].map((k) => n![a * 3 + k]! + n![b * 3 + k]! + n![c * 3 + k]!)
        expect(face[0]! * avg[0]! + face[1]! * avg[1]! + face[2]! * avg[2]!).toBeGreaterThan(0)
      }
      expect(degenerate).toBe(0)
    },
  )

  it('computes bounds', () => {
    expect([...box({ x: 2, y: 4, z: 6 }).bounds]).toEqual([-1, -2, -3, 1, 2, 3])
    const s = sphere({ radius: 2 })
    expect(s.bounds[1]).toBeCloseTo(-2)
    expect(s.bounds[4]).toBeCloseTo(2)
    expect(capsule({ radius: 0.5, height: 3 }).bounds[4]).toBeCloseTo(1.5)
  })

  it('sphere normals are continuous across the UV seam (no lighting seam)', () => {
    const s = sphere({ segments: 16, rings: 8 })
    const row = 17
    for (let r = 0; r <= 8; r++) {
      const first = r * row
      const last = first + 16
      for (let k = 0; k < 3; k++) {
        expect(s.normals![first * 3 + k]).toBeCloseTo(s.normals![last * 3 + k]!, 5)
        expect(s.positions[first * 3 + k]).toBeCloseTo(s.positions[last * 3 + k]!, 5)
      }
    }
  })

  it('sphere normals point outward from the center', () => {
    const s = sphere({ radius: 3 })
    for (let i = 0; i < s.vertexCount; i++) {
      for (let k = 0; k < 3; k++)
        expect(s.normals![i * 3 + k]).toBeCloseTo(s.positions[i * 3 + k]! / 3, 5)
    }
  })
})

describe('Mesh', () => {
  it('rejects malformed data with mesh/invalid', () => {
    expect(() => Mesh.create({ positions: new Float32Array(4) })).toThrow(
      expect.objectContaining({ code: 'mesh/invalid' }),
    )
    expect(() =>
      Mesh.create({ positions: new Float32Array(9), indices: new Uint16Array([0, 1, 5]) }),
    ).toThrow(expect.objectContaining({ code: 'mesh/invalid' }))
    expect(() => Mesh.create({ positions: new Float32Array(9), uvs: new Float32Array(2) })).toThrow(
      expect.objectContaining({ code: 'mesh/invalid' }),
    )
  })

  it('bumps its version and bounds on update', () => {
    const m = cube()
    m.update({ positions: new Float32Array([0, 0, 0, 5, 0, 0, 0, 5, 0]) })
    expect(m.version).toBe(1)
    expect([...m.bounds]).toEqual([0, 0, 0, 5, 5, 0])
    expect(m.drawCount).toBe(3)
  })
})

describe('morph targets', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const target = { positions: new Float32Array([0, 0, 0, 0, 0, 2, 0, -1, 0]) }

  it('bounds cover every blend of weights in [0, 1]', () => {
    const m = Mesh.create({ positions, targets: [target] })
    expect([...m.bounds]).toEqual([0, -1, 0, 1, 1, 2])
  })

  it('round-trips through the artifact; meshes without targets stay version 1', () => {
    const m = Mesh.create({
      positions,
      targets: [target, { positions: target.positions, normals: new Float32Array(9).fill(1) }],
    })
    const bytes = encodeMesh(m)
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(2)
    const back = decodeMesh(bytes)
    expect(back.targets!.length).toBe(2)
    expect([...back.targets![1]!.normals!]).toEqual(new Array(9).fill(1))
    // A target without normals gets zeros, so both decode alike.
    expect([...back.targets![0]!.normals!]).toEqual(new Array(9).fill(0))
    expect([...back.targets![0]!.positions]).toEqual([...target.positions])
    expect(new DataView(encodeMesh(cube()).buffer).getUint32(4, true)).toBe(1)
  })

  it('rejects targets of the wrong length', () => {
    expect(() => Mesh.create({ positions, targets: [{ positions: new Float32Array(6) }] })).toThrow(
      expect.objectContaining({ code: 'mesh/invalid' }),
    )
  })
})
