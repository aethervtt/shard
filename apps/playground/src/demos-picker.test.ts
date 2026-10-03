import { describe, expect, it } from 'vitest'
import { DEMO_GROUPS, DEMOS } from './demos'

describe('demo picker', () => {
  it('lists every demo exactly once', () => {
    const listed = DEMO_GROUPS.flatMap((g) => g.demos.map(([demo]) => demo))
    expect([...listed].sort()).toEqual([...DEMOS].sort())
  })
})
