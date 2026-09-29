import { valueAt } from './expect'
import type { ThresholdRule, Thresholds } from './plan'
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
    const baselines = new Set(
      Object.values(rules)
        .map((r) => r.maxRatioTo)
        .filter((r): r is string => r !== undefined),
    )
    const subjects = records.filter(
      (r) => r.scenario === scenario && !baselines.has(rendererName(r)),
    )
    for (const record of subjects) {
      for (const [metric, rule] of Object.entries(rules)) {
        checked++
        const breach = apply(record, metric, rule, records)
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
  return {
    ...base,
    budget: `max ${ratio} × ${baseline.renderer} (${baseValue ?? 'none'})${limit === undefined ? '' : ` = ${round(limit)}`}`,
    baseline: { renderer: baseline.renderer, value: baseValue },
    message:
      limit === undefined
        ? `${where}: ${baseline.renderer}'s record has no ${metric}`
        : `${where}: ${value} is over ${ratio} × ${baseline.renderer}'s ${baseValue} (${round(limit)})`,
  }
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
