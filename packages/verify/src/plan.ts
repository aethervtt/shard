import type { JsonSchema } from '@aethervtt/shard-core'
import { ShardError } from '@aethervtt/shard-core'
import type { Tolerance } from './compare'
import { validateJson } from './record'

export type BrowserName = 'chromium' | 'webkit' | 'firefox'
export type CaptureScope = 'canvas' | 'page'

/**
 * A capture and measurement run (0062): which page, in which browsers, at which sizes, with what
 * shots, host steps and checks, measured scenarios, and pass thresholds. Every renderer in a
 * comparison runs the same plan.
 */
export interface CapturePlan {
  url: string
  browsers: BrowserName[]
  dpr: number[]
  /** CSS pixels. */
  viewport: [number, number]
  /** canvas: the canvas's own pixels, alpha included. page: the viewport, DOM and all. */
  scope: CaptureScope
  /** The canvas a canvas-scope shot reads. Default the page's first `canvas`. */
  canvas: string
  /** What records name the fixture. Default the URL's path and hash. */
  fixture: string
  /** What records name the renderer, when the page doesn't say. */
  renderer?: string
  /**
   * The graphics API the page is asked for (0064), as `?backend=`. Unset, the page picks. A browser
   * without it skips the plan: no WebGPU skips a 'webgpu' plan, not a 'webgl2' one.
   */
  backend?: 'auto' | 'webgpu' | 'webgl2'
  conditions: PlanConditions
  /** Default tolerance for every shot. */
  tolerance: Tolerance
  /** Browser contexts against one host session. Default one, `main`. */
  clients: PlanClient[]
  /** Shots every client takes before the steps run. */
  shots: PlanShot[]
  steps: PlanStep[]
  scenarios: PlanScenario[]
  thresholds: Thresholds
  /** Longest wait for readiness, an idle frame, or a step, in ms. Default 60 s. */
  timeoutMs: number
}

export interface PlanConditions {
  /** Pins Shard's RenderScale (0051) for the run, so resolution can't buy frame time. */
  renderScale?: { mode: 'fixed'; scale: number }
}

export interface PlanClient {
  name: string
  /** Passed to the page as `?role=`. */
  role?: string
  /** More query parameters for this client's page. */
  query?: Record<string, string>
  /** Its own shots, after the plan's. */
  shots?: PlanShot[]
}

export interface PlanShot {
  name: string
  /** Given to the page's `__shardCapture.apply(state)`: camera, view, toggles. */
  state?: Record<string, unknown>
  scope?: CaptureScope
  canvas?: string
  tolerance?: Tolerance
}

/** One host action, run in each of its clients in order, then checked in every client. */
export interface PlanStep {
  name: string
  /** The page's step to run (`__shardCapture.step`). Default `name`. */
  run?: string
  args?: unknown
  /** Clients that run it. Default all; every client is still checked. */
  clients?: string[]
  /** Stamp the step with `app.trace` and report `step.latencyMs` to the checks. */
  trace?: boolean
  /** Probe path → matcher, per client name. */
  expect?: Record<string, Expectations>
  /** Take a shot of every client after the step (named after it), or the named shots. */
  capture?: boolean | PlanShot[]
}

/** Dotted path into what the page's `probe()` returned (plus `step.latencyMs`) → matcher. */
export type Expectations = Record<string, Matcher>

export interface Matcher {
  equals?: unknown
  includes?: unknown[]
  excludes?: unknown[]
  min?: number
  max?: number
  /** Deep-equal to the value at another path (a fresh load's entity set, say). */
  sameAs?: string
}

/** A measured run: steps start it, the window runs `seconds`, then each client records. */
export interface PlanScenario {
  name: string
  steps?: PlanStep[]
  seconds: number
  /** Clients that record. Default all. */
  clients?: string[]
}

export interface ThresholdRule {
  max?: number
  min?: number
  /** A renderer in the same run whose value, times `ratio`, is the budget. */
  maxRatioTo?: string
  ratio?: number
}

/** Scenario → metric path (`frameTime.p95`) → rule. */
export type Thresholds = Record<string, Record<string, ThresholdRule>>

const tolerance: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deltaE: { type: 'number', exclusiveMinimum: 0 },
    maxShare: { type: 'number', minimum: 0 },
    minSsim: { type: 'number', minimum: 0 },
  },
}

const shot: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    state: { type: 'object' },
    scope: { enum: ['canvas', 'page'] },
    canvas: { type: 'string', minLength: 1 },
    tolerance,
  },
}

const matcher: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    equals: {},
    includes: { type: 'array' },
    excludes: { type: 'array' },
    min: { type: 'number' },
    max: { type: 'number' },
    sameAs: { type: 'string', minLength: 1 },
  },
}

const strings: JsonSchema = { type: 'array', items: { type: 'string', minLength: 1 } }

const step: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    run: { type: 'string', minLength: 1 },
    args: {},
    clients: strings,
    trace: { type: 'boolean' },
    expect: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: matcher },
    },
    capture: {},
  },
}

/** JSON Schema for capture plans (`.shard/schemas/capture-plan.schema.json`). */
export function capturePlanJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://shard.dev/schemas/capture-plan.schema.json',
    title: 'Shard capture plan',
    description:
      'Browser captures, host steps with checks, and measured scenarios with pass thresholds (spec 0062).',
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      $schema: { type: 'string' },
      url: { type: 'string', minLength: 1 },
      browsers: { type: 'array', items: { enum: ['chromium', 'webkit', 'firefox'] }, minItems: 1 },
      dpr: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 1 },
      viewport: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
      scope: { enum: ['canvas', 'page'] },
      canvas: { type: 'string', minLength: 1 },
      fixture: { type: 'string', minLength: 1 },
      renderer: { type: 'string', minLength: 1 },
      backend: { enum: ['auto', 'webgpu', 'webgl2'] },
      conditions: {
        type: 'object',
        additionalProperties: false,
        properties: {
          renderScale: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'scale'],
            properties: {
              mode: { const: 'fixed' },
              scale: { type: 'number', exclusiveMinimum: 0 },
            },
          },
        },
      },
      tolerance,
      clients: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            role: { type: 'string', minLength: 1 },
            query: { type: 'object', additionalProperties: { type: 'string' } },
            shots: { type: 'array', items: shot },
          },
        },
      },
      shots: { type: 'array', items: shot },
      steps: { type: 'array', items: step },
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'seconds'],
          properties: {
            name: { type: 'string', minLength: 1 },
            steps: { type: 'array', items: step },
            seconds: { type: 'number', minimum: 0 },
            clients: strings,
          },
        },
      },
      thresholds: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              max: { type: 'number' },
              min: { type: 'number' },
              maxRatioTo: { type: 'string', minLength: 1 },
              ratio: { type: 'number', exclusiveMinimum: 0 },
            },
          },
        },
      },
      timeoutMs: { type: 'number', exclusiveMinimum: 0 },
    },
  }
}

/**
 * Reads a plan, filling in defaults, or throws `verify/invalid-plan` listing every problem: schema
 * errors, then references to clients that don't exist and names used twice.
 */
export function parsePlan(json: unknown, file?: string): CapturePlan {
  const errors = validateJson(capturePlanJsonSchema(), json)
  const raw = json as Partial<CapturePlan>
  if (errors.length === 0) errors.push(...referenceErrors(raw))
  if (errors.length > 0) {
    throw new ShardError(
      'verify/invalid-plan',
      `${file ?? 'The plan'} has ${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors[0]!.message} at ${errors[0]!.path}`,
      {
        path: file,
        details: errors,
        hint: 'Plans follow .shard/schemas/capture-plan.schema.json.',
      },
    )
  }
  const url = new URL(raw.url!, 'http://localhost/')
  return {
    url: raw.url!,
    browsers: raw.browsers ?? ['chromium'],
    dpr: raw.dpr ?? [1],
    viewport: raw.viewport ?? [1280, 720],
    scope: raw.scope ?? 'canvas',
    canvas: raw.canvas ?? 'canvas',
    fixture: raw.fixture ?? `${url.pathname}${url.hash}`,
    renderer: raw.renderer,
    backend: raw.backend,
    conditions: raw.conditions ?? {},
    tolerance: raw.tolerance ?? {},
    clients: raw.clients ?? [{ name: 'main' }],
    shots: raw.shots ?? [],
    steps: raw.steps ?? [],
    scenarios: raw.scenarios ?? [],
    thresholds: raw.thresholds ?? {},
    timeoutMs: raw.timeoutMs ?? 60_000,
  }
}

function referenceErrors(plan: Partial<CapturePlan>): ShardError[] {
  const errors: ShardError[] = []
  const clients = new Set((plan.clients ?? [{ name: 'main' }]).map((c) => c.name))
  const problem = (message: string, path: string) =>
    errors.push(new ShardError('verify/invalid-json', message, { path }))
  const unique = (names: string[], path: string, what: string) => {
    const seen = new Set<string>()
    names.forEach((name, i) => {
      if (seen.has(name)) problem(`Two ${what} are named "${name}"`, `${path}/${i}/name`)
      seen.add(name)
    })
  }
  unique(
    (plan.clients ?? []).map((c) => c.name),
    '/clients',
    'clients',
  )
  unique(
    (plan.shots ?? []).map((s) => s.name),
    '/shots',
    'shots',
  )
  unique(
    (plan.steps ?? []).map((s) => s.name),
    '/steps',
    'steps',
  )
  unique(
    (plan.scenarios ?? []).map((s) => s.name),
    '/scenarios',
    'scenarios',
  )
  const known = (names: string[] | undefined, path: string) => {
    names?.forEach((name, i) => {
      if (!clients.has(name)) problem(`No client is named "${name}"`, `${path}/${i}`)
    })
  }
  const steps = (list: PlanStep[] | undefined, path: string) => {
    list?.forEach((s, i) => {
      known(s.clients, `${path}/${i}/clients`)
      known(Object.keys(s.expect ?? {}), `${path}/${i}/expect`)
    })
  }
  steps(plan.steps, '/steps')
  plan.scenarios?.forEach((s, i) => {
    known(s.clients, `/scenarios/${i}/clients`)
    steps(s.steps, `/scenarios/${i}/steps`)
  })
  return errors
}

/** A shot's id in a capture run: `chromium/main/map-close@2x` (the capture's path, less `.png`). */
export function shotId(browser: string, client: string, shot: string, dpr: number): string {
  return `${browser}/${client}/${shot}@${dpr}x`
}
