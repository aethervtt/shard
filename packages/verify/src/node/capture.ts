import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ShardError } from '@aethervtt/shard-core'
import type { Browser, BrowserContext, Page } from 'playwright'
import { type CheckFailure, checkExpectations } from '../expect'
import type {} from '../page-api'
import {
  type BrowserName,
  type CapturePlan,
  type PlanClient,
  type PlanShot,
  type PlanStep,
  shotId,
} from '../plan'
import type { PerfRecord } from '../record'
import type { CapturedShot, CaptureManifest } from '../run'
import { sha256 } from './png'

export interface CaptureOptions {
  /** Where PNGs, records and `manifest.json` go. */
  out: string
  /** Show the browser windows. Default false. */
  headed?: boolean
  /** Extra browser flags (also `SHARD_BROWSER_ARGS`, space-separated). */
  browserArgs?: string[]
  /** Progress lines. */
  log?: (message: string) => void
}

export interface CaptureRun {
  manifest: CaptureManifest
  /** Every failed check, naming the step and the client. */
  failures: CheckFailure[]
  records: PerfRecord[]
  pass: boolean
}

/**
 * Flags that turn WebGPU on in each browser's automation build. Chromium also gets a real device
 * scale: its DPR emulation alone reports `devicePixelRatio` 2 with a device-pixel box of CSS size,
 * so a canvas would render at 1× and be scaled up.
 */
function launchArgs(browser: BrowserName, dpr: number, extra: string[]): string[] {
  if (browser !== 'chromium') return extra
  const args = [
    '--enable-unsafe-webgpu',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    `--force-device-scale-factor=${dpr}`,
  ]
  if (process.platform === 'linux') args.push('--enable-features=Vulkan')
  return [...args, ...extra]
}

interface Client {
  plan: PlanClient
  context: BrowserContext
  page: Page
}

/** Runs a capture plan in real browsers (0062). Checks that fail don't stop the run. */
export async function runCapture(plan: CapturePlan, options: CaptureOptions): Promise<CaptureRun> {
  const playwright = await import('playwright')
  const log = options.log ?? (() => {})
  const extra = [
    ...(options.browserArgs ?? []),
    ...(process.env.SHARD_BROWSER_ARGS?.split(' ').filter(Boolean) ?? []),
  ]
  const manifest: CaptureManifest = {
    version: 1,
    url: plan.url,
    fixture: plan.fixture,
    date: new Date().toISOString(),
    shots: [],
    records: [],
    steps: [],
    skipped: [],
  }
  const failures: CheckFailure[] = []
  const records: PerfRecord[] = []
  await mkdir(options.out, { recursive: true })

  browsers: for (const name of plan.browsers) {
    // One launch per DPR: Chromium's device scale is a launch flag.
    for (const dpr of plan.dpr) {
      let browser: Browser
      try {
        browser = await playwright[name].launch({
          headless: !options.headed,
          // The full browser in its new headless mode: the headless shell has no GPU process.
          ...(name === 'chromium' && { channel: 'chromium' }),
          args: launchArgs(name, dpr, extra),
        })
      } catch (err) {
        const reason = (err as Error).message.split('\n')[0]!
        manifest.skipped.push({ browser: name, reason })
        log(`${name}: skipped (${reason})`)
        continue browsers
      }
      try {
        const run = await runSession(plan, name, dpr, browser, options.out, log)
        if (run === 'no-webgpu') {
          manifest.skipped.push({ browser: name, reason: 'no WebGPU adapter' })
          log(`${name}: skipped (no WebGPU adapter)`)
          continue browsers
        }
        manifest.shots.push(...run.shots)
        manifest.steps.push(...run.steps)
        manifest.records.push(...run.recordFiles)
        records.push(...run.records)
        for (const step of run.steps) failures.push(...step.failures)
      } finally {
        await browser.close()
      }
    }
  }
  if (manifest.shots.length === 0 && manifest.records.length === 0 && manifest.skipped.length > 0) {
    throw new ShardError('verify/no-browser', 'No browser in the plan could run it', {
      hint: `${manifest.skipped.map((s) => `${s.browser}: ${s.reason}`).join('; ')}. Install one with \`pnpm exec playwright install chromium\`.`,
    })
  }
  await writeFile(join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, failures, records, pass: failures.length === 0 }
}

interface SessionResult {
  shots: CapturedShot[]
  steps: CaptureManifest['steps']
  records: PerfRecord[]
  recordFiles: string[]
}

/** One browser at one DPR: every client, its shots, the steps, and the scenarios. */
async function runSession(
  plan: CapturePlan,
  browser: BrowserName,
  dpr: number,
  instance: Browser,
  out: string,
  log: (message: string) => void,
): Promise<SessionResult | 'no-webgpu'> {
  const result: SessionResult = { shots: [], steps: [], records: [], recordFiles: [] }
  const clients: Client[] = []
  try {
    for (const client of plan.clients) {
      const context = await instance.newContext({
        viewport: { width: plan.viewport[0], height: plan.viewport[1] },
        deviceScaleFactor: dpr,
      })
      const page = await context.newPage()
      page.setDefaultTimeout(plan.timeoutMs)
      clients.push({ plan: client, context, page })
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))
      await page.goto(clientUrl(plan.url, client))
      if (!(await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter())))) {
        return 'no-webgpu'
      }
      await page
        .waitForFunction(() => window.__shardReady === true, undefined, { timeout: plan.timeoutMs })
        .catch((err: Error) => {
          throw new ShardError(
            'verify/not-ready',
            `${clientUrl(plan.url, client)} never became ready`,
            {
              hint: `The page sets window.__shardReady through installCapturePage once the host calls app.markUsable().${errors.length ? ` Page errors: ${errors.join('; ')}` : ''}`,
              cause: err,
            },
          )
        })
      await page.evaluate((c) => window.__shardCapture!.conditions(c), plan.conditions)
      log(`${browser}@${dpr}x ${client.name}: ready`)
    }

    // Shots each client takes before anything runs.
    for (const client of clients) {
      for (const shot of [...plan.shots, ...(client.plan.shots ?? [])]) {
        result.shots.push(await takeShot(plan, browser, dpr, client, shot, out))
      }
    }

    // Steps, in order: run in their clients, then checked in every client.
    const failures = await runSteps(plan, plan.steps, browser, dpr, clients, out, result)
    if (failures.length > 0) log(`${browser}@${dpr}x: ${failures.length} failed checks`)

    for (const scenario of plan.scenarios) {
      const recording = clients.filter(
        (c) => !scenario.clients || scenario.clients.includes(c.plan.name),
      )
      for (const client of recording)
        await client.page.evaluate(() => window.__shardCapture!.reset())
      await runSteps(plan, scenario.steps ?? [], browser, dpr, clients, out, result, scenario.name)
      await new Promise((resolve) => setTimeout(resolve, scenario.seconds * 1000))
      for (const client of recording) {
        const record = await client.page.evaluate((meta) => window.__shardCapture!.record(meta), {
          fixture: plan.fixture,
          scenario: scenario.name,
          renderer: plan.renderer,
        })
        const file = `records/${scenario.name}/${browser}@${dpr}x-${client.plan.name}.json`
        await writeOut(join(out, file), `${JSON.stringify(record, null, 2)}\n`)
        result.records.push(record)
        result.recordFiles.push(file)
      }
      log(`${browser}@${dpr}x: recorded ${scenario.name}`)
    }
    return result
  } finally {
    for (const client of clients) await client.context.close()
  }
}

async function runSteps(
  plan: CapturePlan,
  steps: readonly PlanStep[],
  browser: BrowserName,
  dpr: number,
  clients: readonly Client[],
  out: string,
  result: SessionResult,
  prefix?: string,
): Promise<CheckFailure[]> {
  const all: CheckFailure[] = []
  for (const step of steps) {
    const name = prefix ? `${prefix}/${step.name}` : step.name
    const failures: CheckFailure[] = []
    const latency = new Map<string, number | undefined>()
    for (const client of clients) {
      if (step.clients && !step.clients.includes(client.plan.name)) continue
      try {
        const ran = await client.page.evaluate(
          ({ run, args, trace }) => window.__shardCapture!.step(run, args, trace),
          { run: step.run ?? step.name, args: step.args ?? null, trace: step.trace ?? false },
        )
        latency.set(client.plan.name, ran.latencyMs)
      } catch (err) {
        failures.push({ step: name, client: client.plan.name, path: '', message: pageMessage(err) })
      }
    }
    for (const client of clients) {
      await client.page.evaluate(() => window.__shardCapture!.idle())
      const expectations = step.expect?.[client.plan.name]
      if (expectations) {
        const probe = await client.page.evaluate(() => window.__shardCapture!.probe())
        const seen = { ...(probe as object), step: { latencyMs: latency.get(client.plan.name) } }
        failures.push(...checkExpectations(name, client.plan.name, seen, expectations))
      }
      if (step.capture) {
        const shots: PlanShot[] = step.capture === true ? [{ name: step.name }] : step.capture
        for (const shot of shots) {
          const named = { ...shot, name: prefix ? `${prefix}-${shot.name}` : shot.name }
          result.shots.push(await takeShot(plan, browser, dpr, client, named, out))
        }
      }
    }
    result.steps.push({ name, browser, dpr, failures })
    all.push(...failures)
  }
  return all
}

async function takeShot(
  plan: CapturePlan,
  browser: BrowserName,
  dpr: number,
  client: Client,
  shot: PlanShot,
  out: string,
): Promise<CapturedShot> {
  const page = client.page
  if (shot.state) await page.evaluate((s) => window.__shardCapture!.apply(s), shot.state)
  await page.evaluate(() => window.__shardCapture!.idle())
  const scope = shot.scope ?? plan.scope
  let png: Uint8Array
  let width: number
  let height: number
  if (scope === 'page') {
    png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
    width = Math.round(plan.viewport[0] * dpr)
    height = Math.round(plan.viewport[1] * dpr)
  } else {
    const snap = await page.evaluate(
      (s) => window.__shardCapture!.snapshot(s),
      shot.canvas ?? plan.canvas,
    )
    png = Buffer.from(snap.png, 'base64')
    width = snap.width
    height = snap.height
  }
  const id = shotId(browser, client.plan.name, shot.name, dpr)
  await writeOut(join(out, `${id}.png`), png)
  return {
    id,
    browser,
    client: client.plan.name,
    shot: shot.name,
    dpr,
    scope,
    width,
    height,
    hash: sha256(png),
    tolerance: { ...plan.tolerance, ...shot.tolerance },
  }
}

/** The plan's URL with the client's role and query parameters. */
export function clientUrl(url: string, client: PlanClient): string {
  const u = new URL(url)
  if (client.role) u.searchParams.set('role', client.role)
  for (const [key, value] of Object.entries(client.query ?? {})) u.searchParams.set(key, value)
  return u.toString()
}

async function writeOut(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, data)
}

/** A page-side error's message without Playwright's call log. */
function pageMessage(err: unknown): string {
  const message = (err as Error).message ?? String(err)
  return message.replace(/^page\.evaluate: /, '').split('\n')[0]!
}
