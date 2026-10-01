import { describe, expect, it } from 'vitest'
import { checkExpectations } from './expect'
import { clientUrl } from './node/capture'
import { parsePlan } from './plan'

describe('parsePlan (0062)', () => {
  it('fills in defaults', () => {
    const plan = parsePlan({ url: 'http://localhost:5180/verify.html#table' })
    expect(plan).toMatchObject({
      browsers: ['chromium'],
      dpr: [1],
      viewport: [1280, 720],
      scope: 'canvas',
      canvas: 'canvas',
      fixture: '/verify.html#table',
      clients: [{ name: 'main' }],
      shots: [],
      steps: [],
      timeoutMs: 60_000,
    })
  })

  it('lists every problem with its path', () => {
    let error: unknown
    try {
      parsePlan(
        {
          url: 'http://x/',
          dpr: [0],
          shots: [{ name: 'a' }, { name: 'a' }],
          extra: true,
        },
        'plan.json',
      )
    } catch (err) {
      error = err
    }
    expect(error).toMatchObject({ code: 'verify/invalid-plan', path: 'plan.json' })
    const details = (error as { details: { path: string }[] }).details.map((d) => d.path)
    expect(details).toEqual(['/dpr/0', '/extra'])
  })

  it('refuses steps that name clients the plan lacks, and names used twice', () => {
    expect(() =>
      parsePlan({
        url: 'http://x/',
        clients: [{ name: 'gm' }, { name: 'player' }],
        steps: [
          { name: 'move', clients: ['gm'], expect: { spectator: { entities: { includes: [] } } } },
        ],
        shots: [{ name: 'a' }, { name: 'a' }],
      }),
    ).toThrow(
      expect.objectContaining({
        details: [
          expect.objectContaining({ message: 'Two shots are named "a"', path: '/shots/1/name' }),
          expect.objectContaining({
            message: 'No client is named "spectator"',
            path: '/steps/0/expect/0',
          }),
        ],
      }),
    )
  })
})

describe('backends in plans (0064)', () => {
  it("asks the page for the plan's backend, and accepts only known ones", () => {
    const plan = parsePlan({ url: 'http://localhost:5180/verify.html#table', backend: 'webgl2' })
    expect(plan.backend).toBe('webgl2')
    expect(clientUrl(plan.url, { name: 'gm', role: 'gm' }, plan.backend)).toBe(
      'http://localhost:5180/verify.html?backend=webgl2&role=gm#table',
    )
    // Unset, the page picks.
    expect(parsePlan({ url: 'http://x/' }).backend).toBeUndefined()
    expect(clientUrl('http://x/', { name: 'main' })).toBe('http://x/')
    expect(() => parsePlan({ url: 'http://x/', backend: 'vulkan' })).toThrow(
      expect.objectContaining({ code: 'verify/invalid-plan' }),
    )
  })
})

describe('checkExpectations (0062)', () => {
  const probe = {
    entities: ['token:goblin', 'token:hero'],
    fresh: { entities: ['token:goblin', 'token:hero'] },
    owners: { scene: 0 },
    step: { latencyMs: 21 },
  }

  it('passes matchers that hold', () => {
    expect(
      checkExpectations('move-in', 'player', probe, {
        entities: {
          includes: ['token:goblin'],
          excludes: ['token:dragon'],
          sameAs: 'fresh.entities',
        },
        'owners.scene': { equals: 0 },
        'step.latencyMs': { max: 50 },
      }),
    ).toEqual([])
  })

  it('names the step, the client, the path, and what was wrong', () => {
    expect(
      checkExpectations('move-out', 'player', probe, {
        entities: { excludes: ['token:goblin'] },
        'owners.scene': { max: -1 },
        'mirror.applied': { equals: 1 },
      }),
    ).toEqual([
      {
        step: 'move-out',
        client: 'player',
        path: 'entities',
        message: 'expected it not to include "token:goblin"',
      },
      {
        step: 'move-out',
        client: 'player',
        path: 'owners.scene',
        message: 'expected at most -1, got 0',
      },
      {
        step: 'move-out',
        client: 'player',
        path: 'mirror.applied',
        message: 'expected 1, got nothing',
      },
    ])
  })
})
