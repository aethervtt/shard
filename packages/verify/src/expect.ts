import type { Expectations, Matcher } from './plan'

/** A check that failed: which step, which client, which probe path, and what was wrong. */
export interface CheckFailure {
  step: string
  client: string
  path: string
  message: string
}

/** The value at a dotted path (`owners.scene`, `entities.0`); undefined where it stops. */
export function valueAt(value: unknown, path: string): unknown {
  let at = value
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** Structural equality over JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((item, i) => deepEqual(item, other[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

const show = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value))

/** Checks one client's probe after a step. Every failed matcher is its own failure. */
export function checkExpectations(
  step: string,
  client: string,
  probe: unknown,
  expectations: Expectations,
): CheckFailure[] {
  const failures: CheckFailure[] = []
  for (const [path, matcher] of Object.entries(expectations)) {
    for (const message of match(valueAt(probe, path), matcher, probe)) {
      failures.push({ step, client, path, message })
    }
  }
  return failures
}

function match(value: unknown, m: Matcher, probe: unknown): string[] {
  const out: string[] = []
  if ('equals' in m && !deepEqual(value, m.equals)) {
    out.push(`expected ${show(m.equals)}, got ${show(value)}`)
  }
  if (m.includes || m.excludes) {
    if (!Array.isArray(value)) out.push(`expected a list, got ${show(value)}`)
    else {
      for (const item of m.includes ?? []) {
        if (!value.some((v) => deepEqual(v, item))) out.push(`expected it to include ${show(item)}`)
      }
      for (const item of m.excludes ?? []) {
        if (value.some((v) => deepEqual(v, item)))
          out.push(`expected it not to include ${show(item)}`)
      }
    }
  }
  if (m.min !== undefined || m.max !== undefined) {
    if (typeof value !== 'number') out.push(`expected a number, got ${show(value)}`)
    else {
      if (m.min !== undefined && value < m.min) out.push(`expected at least ${m.min}, got ${value}`)
      if (m.max !== undefined && value > m.max) out.push(`expected at most ${m.max}, got ${value}`)
    }
  }
  if (m.sameAs !== undefined) {
    const other = valueAt(probe, m.sameAs)
    if (!deepEqual(value, other)) {
      out.push(`expected the same as ${m.sameAs} (${show(other)}), got ${show(value)}`)
    }
  }
  return out
}
