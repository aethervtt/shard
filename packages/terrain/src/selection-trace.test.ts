import { describe, expect, it } from 'vitest'
import { maxDepthFor } from './cube'
import { NodeTree } from './cube-sphere'
import { createSelection, NODE_READY, selectNodes } from './quadtree'
import { createView, perspectiveView } from './view'

/**
 * Everything selection decides over a scripted descent onto an Earth-radius planet, hashed: the
 * rendered nodes with their quadrant masks and edge locks, and the requests with their priorities,
 * every frame. Nodes become ready a few at a time (highest priority first), so partial parents,
 * prefetches, forced 2:1 splits, merges and pruning all happen. Pinned before the quadtree was
 * shared between planets and heightfields (0071): sharing it must not move a single decision.
 */
function trace(): string {
  const R = 6.371e6
  const tree = new NodeTree()
  tree.reset(R, [1, 1, 1], -600, 600)
  const maxDepth = maxDepthFor(R, 33, 0.4)
  const errors = new Float32Array(maxDepth + 2)
  // Errors halving per level from 40 km, as measured errors roughly do.
  for (let d = 0; d <= maxDepth; d++) errors[d] = 4e4 / 2 ** d
  const params = {
    maxDepth,
    errors,
    errorPixels: 2,
    occluder: R - 600,
    colliderDepth: maxDepth - 4,
    anchorPos: new Float64Array(3),
    anchorRadius: new Float64Array([96]),
    anchors: 0,
  }
  const view = createView()
  const sel = createSelection()
  let hash = 0x811c9dc5
  const word = (v: number) => {
    hash = Math.imul(hash ^ (v & 0xff), 0x01000193)
    hash = Math.imul(hash ^ ((v >>> 8) & 0xff), 0x01000193)
    hash = Math.imul(hash ^ ((v >>> 16) & 0xff), 0x01000193)
    hash = Math.imul(hash ^ (v >>> 24), 0x01000193)
  }
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  const eye = new Float64Array(3)
  for (let frame = 1; frame <= 400; frame++) {
    // From 20 000 km down to 2 m over 300 frames, then a low flight while turning.
    const t = Math.min(1, frame / 300)
    const altitude = frame <= 300 ? 2 + 2e7 * (1 - t) ** 6 : 2 + (frame - 300) * 0.5
    const a = frame <= 300 ? 0.3 : 0.3 + (frame - 300) * 2e-5
    eye[0] = Math.sin(a) * (R + altitude)
    eye[1] = Math.cos(a) * (R + altitude)
    eye[2] = 0
    const up = [Math.sin(a), Math.cos(a), 0]
    const turn = frame * 0.01
    const side = [Math.cos(a), -Math.sin(a), 0]
    const tangent = [side[0]! * Math.cos(turn), side[1]! * Math.cos(turn), Math.sin(turn)]
    // Looking down 40° along the tangent.
    const fwd = [
      tangent[0]! * 0.77 - up[0]! * 0.64,
      tangent[1]! * 0.77 - up[1]! * 0.64,
      tangent[2]! * 0.77,
    ]
    const right = [
      fwd[1]! * up[2]! - fwd[2]! * up[1]!,
      fwd[2]! * up[0]! - fwd[0]! * up[2]!,
      fwd[0]! * up[1]! - fwd[1]! * up[0]!,
    ]
    const rl = Math.hypot(right[0]!, right[1]!, right[2]!)
    const r = right.map((v) => v / rl)
    const camUp = [
      r[1]! * fwd[2]! - r[2]! * fwd[1]!,
      r[2]! * fwd[0]! - r[0]! * fwd[2]!,
      r[0]! * fwd[1]! - r[1]! * fwd[0]!,
    ]
    perspectiveView(view, eye, r, camUp, fwd, Math.PI / 3, 16 / 9, 720)
    // An anchor near the ground once the camera is low.
    params.anchors = altitude < 500 ? 1 : 0
    params.anchorPos[0] = Math.sin(a) * R
    params.anchorPos[1] = Math.cos(a) * R
    selectNodes(tree, view, params, frame, sel)
    word(sel.renderedCount)
    for (let i = 0; i < sel.renderedCount; i++) {
      const n = sel.rendered[i]!
      word(tree.face[n]! | (tree.depth[n]! << 8) | (tree.mask[n]! << 16))
      word(tree.x[n]!)
      word(tree.y[n]!)
      for (let e = 0; e < 4; e++) word(tree.locks[n * 4 + e]! + 1)
    }
    word(sel.requestedCount)
    word(sel.waiting)
    word(sel.passes)
    // The six highest-priority requests become ready (a generation budget), lowest node first on
    // ties so the order is fixed.
    const order = Array.from(sel.requested.subarray(0, sel.requestedCount))
    order.sort((x, y) => tree.priority[y]! - tree.priority[x]! || x - y)
    for (const n of order) {
      f32[0] = tree.priority[n]!
      word(u32[0]!)
    }
    for (const n of order.slice(0, 6)) tree.flags[n]! |= NODE_READY
    if (frame % 120 === 0) tree.prune(frame - 600, () => {})
  }
  word(tree.live)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

describe('selection trace', () => {
  it('makes the same decisions as when it was pinned (before the quadtree was shared)', () => {
    expect(trace()).toBe('9d40151c')
  })
})
