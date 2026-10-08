// shard capture / compare / approve / perf-check (0062): browser captures, perceptual diffs against
// approved images, approvals with reasons, and performance records against a plan's thresholds.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { ShardError } from '@aethervtt/shard-core'
import {
  approveShot,
  perfCheck as checkRecords,
  compareRun,
  readPlan,
  runCapture,
} from '@aethervtt/shard-verify/node'
import type { CommandContext } from './commands'
import { EXIT } from './output'

const DEFAULT_CAPTURES = 'captures/latest'
const DEFAULT_APPROVED = 'captures/approved'

export async function capture(ctx: CommandContext): Promise<number> {
  const file = ctx.args[0]
  if (!file) throw new ShardError('cli/usage', 'Usage: shard capture <plan.json> [--out dir]')
  const plan = await readPlan(resolve(file))
  const out = resolve((ctx.flags.out as string | undefined) ?? DEFAULT_CAPTURES)
  const run = await runCapture(plan, {
    out,
    headed: Boolean(ctx.flags.headed),
    ...(ctx.flags.channel ? { channel: String(ctx.flags.channel) } : {}),
    log: (message) => ctx.out.say(message),
  })
  const { manifest, failures } = run
  const lines = [
    `Captured ${manifest.shots.length} shots and ${manifest.records.length} records into ${out}.`,
    ...manifest.skipped.map((s) => `Skipped ${s.browser}: ${s.reason}.`),
    ...failures.map(
      (f) => `FAIL ${f.step} [${f.client}]${f.path ? ` ${f.path}` : ''}: ${f.message}`,
    ),
  ]
  ctx.out.result(
    {
      pass: run.pass,
      out,
      shots: manifest.shots.map((s) => ({
        id: s.id,
        hash: s.hash,
        width: s.width,
        height: s.height,
      })),
      records: manifest.records,
      skipped: manifest.skipped,
      failures,
    },
    lines.join('\n'),
  )
  return run.pass ? EXIT.ok : EXIT.failed
}

export async function compare(ctx: CommandContext): Promise<number> {
  const captures = resolve(ctx.args[0] ?? DEFAULT_CAPTURES)
  const approved = resolve((ctx.flags.approved as string | undefined) ?? DEFAULT_APPROVED)
  const result = await compareRun(captures, approved, {
    report: ctx.flags.report as string | undefined,
  })
  const lines = result.shots
    .filter((s) => s.status !== 'pass')
    .map((s) => `${s.status === 'new' ? 'NEW ' : 'FAIL'} ${s.id}: ${s.reason ?? ''}`)
  lines.push(
    `${result.shots.filter((s) => s.status === 'pass').length}/${result.shots.length} shots match their approved images. Report: ${result.report}`,
  )
  ctx.out.result(
    {
      pass: result.pass,
      report: result.report,
      shots: result.shots.map((s) => ({
        id: s.id,
        status: s.status,
        reason: s.reason ?? null,
        share: s.share ?? null,
        maxDeltaE: s.maxDeltaE ?? null,
        ssim: s.ssim ?? null,
      })),
    },
    lines.join('\n'),
  )
  return result.pass ? EXIT.ok : EXIT.failed
}

/** Who approves: `--by`, else git's user.name, else the OS user. */
function approver(flag: unknown): string {
  if (typeof flag === 'string' && flag) return flag
  try {
    const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim()
    if (name) return name
  } catch {
    // no git, or no name configured
  }
  return process.env.USER ?? process.env.USERNAME ?? 'unknown'
}

export async function approve(ctx: CommandContext): Promise<number> {
  const shot = ctx.args[0]
  if (!shot) {
    throw new ShardError(
      'cli/usage',
      'Usage: shard approve <shot> --reason "…" [--captures dir] [--approved dir]',
    )
  }
  const approval = await approveShot({
    captures: resolve((ctx.flags.captures as string | undefined) ?? DEFAULT_CAPTURES),
    approved: resolve((ctx.flags.approved as string | undefined) ?? DEFAULT_APPROVED),
    shot,
    reason: ctx.flags.reason as string | undefined,
    by: approver(ctx.flags.by),
  })
  ctx.out.result(approval, `Approved ${shot} (${approval.hash.slice(0, 12)}): ${approval.reason}`)
  return EXIT.ok
}

export async function perfCheck(ctx: CommandContext): Promise<number> {
  const plan = ctx.flags.plan as string | undefined
  if (!plan || ctx.args.length === 0) {
    throw new ShardError('cli/usage', 'Usage: shard perf-check <records...> --plan plan.json')
  }
  const result = await checkRecords(
    resolve(plan),
    ctx.args.map((p) => resolve(p)),
  )
  const lines = result.breaches.map((b) => `FAIL ${b.message} (budget: ${b.budget})`)
  lines.push(
    `${result.checked - result.breaches.length}/${result.checked} checks passed over ${result.records} records.`,
  )
  ctx.out.result(result, lines.join('\n'))
  return result.pass ? EXIT.ok : EXIT.failed
}
