import { describe, expect, it } from 'vitest'
import { type NodeDescriptor, resolveGraph } from './graph'

const node = (partial: Partial<NodeDescriptor>): NodeDescriptor => ({
  kind: 'raw',
  run() {},
  ...partial,
})

describe('resolveGraph', () => {
  it('orders nodes by resource dependencies, whatever the registration order', () => {
    const nodes = new Map<string, NodeDescriptor>([
      ['tonemap', node({ reads: ['hdr'], writes: ['view-target'] })],
      ['opaque', node({ reads: ['shadows'], writes: ['hdr', 'depth'] })],
      ['shadows', node({ writes: ['shadows'] })],
      ['transparent', node({ reads: ['depth'], writes: ['hdr'] })],
    ])
    expect(resolveGraph(nodes).order).toEqual(['shadows', 'opaque', 'transparent', 'tonemap'])
  })

  it('culls nodes whose outputs nothing needs', () => {
    const nodes = new Map<string, NodeDescriptor>([
      ['debug-overlay', node({ writes: ['debug'] })],
      ['main', node({ writes: ['view-target'] })],
      ['analytics', node({ sideEffects: true })],
    ])
    const { order, culled } = resolveGraph(nodes)
    expect(order).toEqual(['main', 'analytics'])
    expect(culled).toEqual(['debug-overlay'])
  })

  it('keeps writers of loaded attachments', () => {
    const nodes = new Map<string, NodeDescriptor>([
      [
        'sky',
        node({
          kind: 'render',
          writes: ['view-target'],
          color: [{ resource: 'view-target', clear: [0, 0, 0, 1] }],
        }),
      ],
      [
        'ui',
        node({ kind: 'render', writes: ['view-target'], color: [{ resource: 'view-target' }] }),
      ],
    ])
    expect(resolveGraph(nodes).order).toEqual(['sky', 'ui'])
  })

  it('honors explicit after', () => {
    const nodes = new Map<string, NodeDescriptor>([
      ['b', node({ writes: ['view-target'], after: ['a'] })],
      ['a', node({ sideEffects: true })],
    ])
    expect(resolveGraph(nodes).order).toEqual(['a', 'b'])
  })

  it('throws render/graph-cycle naming the nodes', () => {
    const nodes = new Map<string, NodeDescriptor>([
      ['a', node({ reads: ['y'], writes: ['x', 'view-target'] })],
      ['b', node({ reads: ['x'], writes: ['y'] })],
    ])
    expect(() => resolveGraph(nodes)).toThrow(
      expect.objectContaining({
        code: 'render/graph-cycle',
        message: expect.stringMatching(/a, b/),
      }),
    )
  })
})
