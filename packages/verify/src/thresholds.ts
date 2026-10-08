import type { SpanStats } from '@aethervtt/shard-core'
import { valueAt } from './expect'
import type { SpanThreshold, ThresholdRule, Thresholds } from './plan'
import { type PerfRecord, rendererName } from './record'

/** One broken budget: the metric, the value, the budget, and the baseline it came from. */
export interface Breach {
  scenario: string
  metric: string
  renderer: string
  fixture: string
  /** Undefined when the record has no such metric. */
  value: number | undefined
  /** The limit that was broken, e.g. `max 16.7` or `max 1.0 × three (12.1) = 12.1`. */
  budget: string
  baseline?: { renderer: string; value: number | undefined }
  message: string
  /** A span budget's span (0074). */
  span?: string
  /**
   * Against a baseline: the spans whose p95 grew the most from its record to this one (0074), when
   * both records have a breakdown.
   */
  grew?: { span: string; p95: number; baselineP95: number }[]
}

export interface PerfCheck {
  pass: boolean
  /** Rules applied, over every record they applied to. */
  checked: number
  breaches: Breach[]
}

/**
 * Applies a plan's thresholds to the records of one run (0062). Absolute rules apply to every
 * record of the scenario whose renderer isn't a ratio baseline there. A ratio rule compares with
 * the baseline renderer's record of the same scenario and fixture, on the same device where the
 * run has one; with no baseline record, the rule fails.
 */
export function checkThresholds(records: readonly PerfRecord[], thresholds: Thresholds): PerfCheck {
  const breaches: Breach[] = []
  let checked = 0
  for (const [scenario, rules] of Object.entries(thresholds)) {
    const metrics: [string, ThresholdRule][] = []
    for (const [metric, rule] of Object.entries(rules)) {
      if (metric !== 'spans' && rule && !Array.isArray(rule))
        metrics.push([metric, rule as ThresholdRule])
    }
    const baselines = new Set(
      metrics.map(([, r]) => r.maxRatioTo).filter((r): r is string => r !== undefined),
    )
    const subjects = records.filter(
      (r) => r.scenario === scenario && !baselines.has(rendererName(r)),
    )
    for (const record of subjects) {
      for (const [metric, rule] of metrics) {
        checked++
        const breach = apply(record, metric, rule, records)
        if (breach) breaches.push(breach)
      }
      for (const rule of rules.spans ?? []) {
        checked++
        const breach = applySpan(record, rule)
        if (breach) breaches.push(breach)
      }
    }
  }
  return { pass: breaches.length === 0, checked, breaches }
}

function metricOf(record: PerfRecord, metric: string): number | undefined {
  const value = valueAt(record, metric)
  return typeof value === 'number' ? value : undefined
}

function apply(
  record: PerfRecord,
  metric: string,
  rule: ThresholdRule,
  records: readonly PerfRecord[],
): Breach | undefined {
  const value = metricOf(record, metric)
  const base = {
    scenario: record.scenario,
    metric,
    renderer: record.renderer,
    fixture: record.fixture,
    value,
  }
  const where = `${record.scenario} ${metric} (${record.renderer})`
  if (value === undefined) {
    return { ...base, budget: describe(rule), message: `${where}: the record has no ${metric}` }
  }
  if (rule.max !== undefined && value > rule.max) {
    return {
      ...base,
      budget: `max ${rule.max}`,
      message: `${where}: ${value} is over the max of ${rule.max}`,
    }
  }
  if (rule.min !== undefined && value < rule.min) {
    return {
      ...base,
      budget: `min ${rule.min}`,
      message: `${where}: ${value} is under the min of ${rule.min}`,
    }
  }
  if (rule.maxRatioTo === undefined) return undefined
  const ratio = rule.ratio ?? 1
  const baseline = findBaseline(record, rule.maxRatioTo, records)
  if (!baseline) {
    return {
      ...base,
      budget: `max ${ratio} × ${rule.maxRatioTo}`,
      message: `${where}: no ${rule.maxRatioTo} record of ${record.scenario} on ${record.fixture} to compare with`,
    }
  }
  const baseValue = metricOf(baseline, metric)
  const limit = baseValue === undefined ? undefined : baseValue * ratio
  if (limit !== undefined && value <= limit) return undefined
  const grew = spansThatGrew(record, baseline)
  const breach: Breach = {
    ...base,
    budget: `max ${ratio} × ${baseline.renderer} (${baseValue ?? 'none'})${limit === undefined ? '' : ` = ${round(limit)}`}`,
    baseline: { renderer: baseline.renderer, value: baseValue },
    message:
      limit === undefined
        ? `${where}: ${baseline.renderer}'s record has no ${metric}`
        : `${where}: ${value} is over ${ratio} × ${baseline.renderer}'s ${baseValue} (${round(limit)})${grew.length > 0 ? `; grew most: ${grew.map((g) => `${g.span} ${g.baselineP95} → ${g.p95} ms`).join(', ')}` : ''}`,
  }
  if (grew.length > 0) breach.grew = grew
  return breach
}

function spansOf(record: PerfRecord): SpanStats[] {
  return record.breakdown ? [...record.breakdown.cpu, ...record.breakdown.gpu] : []
}

/**
 * The spans whose p95 grew the most from `baseline` to `record` (0074), largest growth first: a
 * span missing from the baseline's breakdown counts from 0. Empty unless both have a breakdown.
 */
export function spansThatGrew(
  record: PerfRecord,
  baseline: PerfRecord,
  limit = 3,
): { span: string; p95: number; baselineP95: number }[] {
  if (!record.breakdown || !baseline.breakdown) return []
  const before = new Map(spansOf(baseline).map((s) => [s.span, s.p95]))
  return spansOf(record)
    .map((s) => ({ span: s.span, p95: s.p95, baselineP95: before.get(s.span) ?? 0 }))
    .filter((g) => g.p95 > g.baselineP95)
    .sort((a, b) => b.p95 - b.baselineP95 - (a.p95 - a.baselineP95) || (a.span < b.span ? -1 : 1))
    .slice(0, limit)
}

/** A span budget (0074) against the record's breakdown. */
function applySpan(record: PerfRecord, rule: SpanThreshold): Breach | undefined {
  const stats = spansOf(record).find((s) => s.span === rule.span)
  const where = `${record.scenario} span ${rule.span} (${record.renderer})`
  const base = {
    scenario: record.scenario,
    renderer: record.renderer,
    fixture: record.fixture,
    span: rule.span,
  }
  if (!stats) {
    const metric = `span:${rule.span}`
    return {
      ...base,
      metric,
      value: undefined,
      budget: describeSpan(rule),
      message: record.breakdown
        ? `${where}: the record's breakdown has no ${rule.span}`
        : `${where}: the record has no breakdown (version 1)`,
    }
  }
  for (const key of ['p50', 'p95', 'max'] as const) {
    const limit = rule[key]
    if (limit === undefined || stats[key] <= limit) continue
    return {
      ...base,
      metric: `span:${rule.span}.${key}`,
      value: stats[key],
      budget: `${key} ${limit}`,
      message: `${where}: ${key} ${stats[key]} ms is over ${limit} ms`,
    }
  }
  return undefined
}

function describeSpan(rule: SpanThreshold): string {
  const parts: string[] = []
  for (const key of ['p50', 'p95', 'max'] as const) {
    if (rule[key] !== undefined) parts.push(`${key} ${rule[key]}`)
  }
  return parts.join(', ')
}

/** The baseline's record of the same scenario and fixture: the same device if there is one. */
function findBaseline(
  record: PerfRecord,
  renderer: string,
  records: readonly PerfRecord[],
): PerfRecord | undefined {
  const candidates = records.filter(
    (r) =>
      rendererName(r) === renderer &&
      r.scenario === record.scenario &&
      r.fixture === record.fixture,
  )
  const sameDevice = candidates.find(
    (r) =>
      r.device.ua === record.device.ua &&
      r.device.dpr === record.device.dpr &&
      r.device.viewport[0] === record.device.viewport[0] &&
      r.device.viewport[1] === record.device.viewport[1],
  )
  return sameDevice ?? candidates[0]
}

function describe(rule: ThresholdRule): string {
  const parts: string[] = []
  if (rule.max !== undefined) parts.push(`max ${rule.max}`)
  if (rule.min !== undefined) parts.push(`min ${rule.min}`)
  if (rule.maxRatioTo !== undefined) parts.push(`max ${rule.ratio ?? 1} × ${rule.maxRatioTo}`)
  return parts.join(', ')
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
