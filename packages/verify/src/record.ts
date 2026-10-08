import type { JsonSchema, SpanStats } from '@aethervtt/shard-core'
import { ShardError } from '@aethervtt/shard-core'

/**
 * One measured run of one scenario on one renderer (0062). Shard's `metrics.record` writes it, and
 * so can any other renderer's page (Aether's three.js path) by the same definitions. Times are ms,
 * sizes bytes.
 */
export interface PerfRecord {
  /** 2 adds `breakdown` (0074); version 1 records still read. */
  version: 1 | 2
  /** `shard@<sha>`, `three@0.160.1`: the part before `@` names the renderer in thresholds. */
  renderer: string
  fixture: string
  scenario: string
  device: PerfDevice
  /** The render scale every frame of the window ran at (0051). A pinned run has min = max. */
  renderScale: { mode: 'fixed' | 'auto' | 'none'; min: number; max: number }
  /**
   * `total`: navigation start to `app.init()` resolved; `modules`: navigation start to `init()`
   * called. The rest are wall time that kind of work was in flight until the first usable frame:
   * the GPU device request, pipeline compiles, asset loads. They overlap each other.
   */
  coldStart: { total: number; modules: number; device: number; pipelines: number; assets: number }
  /** Navigation start to the first frame presented after `app.markUsable()`. */
  firstUsableFrame: number
  /** A host write (`app.trace`) to the frame that shows it being presented. */
  patchToFrame: { p50: number; p95: number; n: number }
  /** Intervals between consecutive frames over the window; GPU time where timestamps exist. */
  frameTime: { p50: number; p95: number; p99: number; n: number; gpuP95?: number }
  longTasks: { count: number; totalMs: number; maxMs: number }
  /** Every buffer and texture the renderer made, by what it's for. */
  gpuMemory: { bytes: number; byCategory: Record<string, number> }
  /** The page's downloads: the document, scripts, WASM, and assets. */
  download: { transferred: number; decoded: number }
  /**
   * Where the time went (0074, version 2): the 10 spans with the highest p95, CPU (systems,
   * schedules, render encodes, workers) and GPU passes, over the profiler's window.
   */
  breakdown?: { cpu: SpanStats[]; gpu: SpanStats[] }
}

export interface PerfDevice {
  ua: string
  /** The adapter: vendor, architecture, description, whichever the browser reports. */
  gpu: string
  dpr: number
  /** CSS pixels. */
  viewport: [number, number]
}

const ms = { type: 'number', minimum: 0 }
const count = { type: 'integer', minimum: 0 }
const spanStats = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['span', 'track', 'calls', 'total', 'p50', 'p95', 'max'],
    properties: {
      span: { type: 'string', minLength: 1 },
      track: { enum: ['main', 'gpu', 'async', 'gc', 'worker'] },
      calls: count,
      total: ms,
      p50: ms,
      p95: ms,
      max: ms,
    },
  },
}

/** JSON Schema for `PerfRecord` (shipped as `.shard/schemas/perf-record.schema.json`). */
export function perfRecordJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://shard.dev/schemas/perf-record.schema.json',
    title: 'Shard performance record',
    description:
      'One measured run of one scenario on one renderer (spec 0062). Times are milliseconds, sizes bytes.',
    type: 'object',
    additionalProperties: false,
    required: [
      'version',
      'renderer',
      'fixture',
      'scenario',
      'device',
      'renderScale',
      'coldStart',
      'firstUsableFrame',
      'patchToFrame',
      'frameTime',
      'longTasks',
      'gpuMemory',
      'download',
    ],
    properties: {
      $schema: { type: 'string' },
      version: { enum: [1, 2] },
      renderer: {
        type: 'string',
        minLength: 1,
        description:
          "'shard@<sha>' or 'three@0.160.1': the name before '@' is what thresholds use.",
      },
      fixture: { type: 'string', minLength: 1 },
      scenario: { type: 'string', minLength: 1 },
      device: {
        type: 'object',
        additionalProperties: false,
        required: ['ua', 'gpu', 'dpr', 'viewport'],
        properties: {
          ua: { type: 'string' },
          gpu: { type: 'string' },
          dpr: { type: 'number', exclusiveMinimum: 0 },
          viewport: {
            type: 'array',
            items: { type: 'number', minimum: 0 },
            minItems: 2,
            maxItems: 2,
            description: 'Width and height in CSS pixels.',
          },
        },
      },
      renderScale: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'min', 'max'],
        description: 'The render scale over the window. Pinned runs have min = max.',
        properties: {
          mode: { enum: ['fixed', 'auto', 'none'] },
          min: { type: 'number', exclusiveMinimum: 0 },
          max: { type: 'number', exclusiveMinimum: 0 },
        },
      },
      coldStart: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'modules', 'device', 'pipelines', 'assets'],
        properties: { total: ms, modules: ms, device: ms, pipelines: ms, assets: ms },
      },
      firstUsableFrame: ms,
      patchToFrame: {
        type: 'object',
        additionalProperties: false,
        required: ['p50', 'p95', 'n'],
        properties: { p50: ms, p95: ms, n: count },
      },
      frameTime: {
        type: 'object',
        additionalProperties: false,
        required: ['p50', 'p95', 'p99', 'n'],
        properties: { p50: ms, p95: ms, p99: ms, n: count, gpuP95: ms },
      },
      longTasks: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'totalMs', 'maxMs'],
        properties: { count, totalMs: ms, maxMs: ms },
      },
      gpuMemory: {
        type: 'object',
        additionalProperties: false,
        required: ['bytes', 'byCategory'],
        properties: { bytes: count, byCategory: { type: 'object', additionalProperties: count } },
      },
      download: {
        type: 'object',
        additionalProperties: false,
        required: ['transferred', 'decoded'],
        properties: { transferred: count, decoded: count },
      },
      breakdown: {
        type: 'object',
        additionalProperties: false,
        required: ['cpu', 'gpu'],
        description:
          'Version 2 (spec 0074): the 10 CPU and 10 GPU spans with the highest p95 over the window.',
        properties: { cpu: spanStats, gpu: spanStats },
      },
    },
  }
}

/**
 * Checks `value` against a JSON Schema, for the keywords Shard's own schemas use: type, const,
 * enum, required, properties, additionalProperties, items, min/maxItems, minLength, minimum,
 * exclusiveMinimum. Returns every problem, each with its JSON path.
 */
export function validateJson(schema: JsonSchema, value: unknown, path = ''): ShardError[] {
  const errors: ShardError[] = []
  check(schema, value, path, errors)
  return errors
}

function check(schema: JsonSchema, value: unknown, path: string, out: ShardError[]): void {
  const fail = (message: string) =>
    out.push(new ShardError('verify/invalid-json', message, { path: path || '/' }))
  if ('const' in schema && value !== schema.const) {
    return void fail(`Expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
  }
  const options = schema.enum as unknown[] | undefined
  if (options && !options.includes(value)) {
    return void fail(`Expected one of ${options.map((o) => JSON.stringify(o)).join(', ')}`)
  }
  const type = schema.type as string | undefined
  if (type && !isType(value, type)) return void fail(`Expected ${type}, got ${typeName(value)}`)
  if (typeof value === 'number') {
    const min = schema.minimum as number | undefined
    const above = schema.exclusiveMinimum as number | undefined
    if (min !== undefined && value < min) fail(`Expected at least ${min}, got ${value}`)
    if (above !== undefined && value <= above) fail(`Expected more than ${above}, got ${value}`)
  }
  if (typeof value === 'string' && value.length < ((schema.minLength as number) ?? 0)) {
    fail('Expected a non-empty string')
  }
  if (Array.isArray(value)) {
    const min = schema.minItems as number | undefined
    const max = schema.maxItems as number | undefined
    if (min !== undefined && value.length < min) fail(`Expected at least ${min} items`)
    if (max !== undefined && value.length > max) fail(`Expected at most ${max} items`)
    const items = schema.items as JsonSchema | undefined
    if (items) for (let i = 0; i < value.length; i++) check(items, value[i], `${path}/${i}`, out)
  }
  if (type !== 'object' || !isType(value, 'object')) return
  const object = value as Record<string, unknown>
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!(key in object))
      out.push(
        new ShardError('verify/invalid-json', `Missing "${key}"`, { path: `${path}/${key}` }),
      )
  }
  const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {}
  const extra = schema.additionalProperties as boolean | JsonSchema | undefined
  for (const [key, item] of Object.entries(object)) {
    const own = properties[key]
    if (own) check(own, item, `${path}/${key}`, out)
    else if (extra === false) {
      out.push(
        new ShardError('verify/invalid-json', `Unknown field "${key}"`, { path: `${path}/${key}` }),
      )
    } else if (extra && typeof extra === 'object') check(extra, item, `${path}/${key}`, out)
  }
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    default:
      return typeof value === type
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return typeof value
}

/** Reads a record, or throws `verify/invalid-record` listing every problem. */
export function parsePerfRecord(json: unknown, file?: string): PerfRecord {
  const errors = validateJson(perfRecordJsonSchema(), json)
  if (errors.length > 0) {
    throw new ShardError(
      'verify/invalid-record',
      `${file ?? 'The record'} isn't a valid performance record: ${errors[0]!.message} at ${errors[0]!.path}`,
      {
        path: file,
        details: errors,
        hint: 'Records follow .shard/schemas/perf-record.schema.json.',
      },
    )
  }
  return json as PerfRecord
}

/** The renderer's name without its version: `three@0.160.1` → `three`. */
export function rendererName(record: Pick<PerfRecord, 'renderer'>): string {
  const at = record.renderer.indexOf('@')
  return at === -1 ? record.renderer : record.renderer.slice(0, at)
}
