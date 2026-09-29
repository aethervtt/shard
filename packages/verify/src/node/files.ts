import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { ShardError } from '@aethervtt/shard-core'
import { compareImages, diffHeatmap } from '../compare'
import { type CapturePlan, parsePlan } from '../plan'
import { type PerfRecord, parsePerfRecord } from '../record'
import { type ReportShot, renderReport } from '../report'
import { type Approval, type ApprovalsFile, addApproval, type CaptureManifest } from '../run'
import { checkThresholds, type PerfCheck } from '../thresholds'
import { decodePng, encodePng, sha256 } from './png'

async function readJson(file: string, what: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new ShardError('verify/not-found', `No ${what} at ${file}`, { path: file })
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ShardError(
      'verify/invalid-json',
      `${file} isn't valid JSON: ${(err as Error).message}`,
      {
        path: file,
      },
    )
  }
}

export async function readPlan(file: string): Promise<CapturePlan> {
  return parsePlan(await readJson(file, 'capture plan'), file)
}

export async function readManifest(captures: string): Promise<CaptureManifest> {
  const json = await readJson(join(captures, 'manifest.json'), 'capture run')
  return json as CaptureManifest
}

async function readApprovals(approved: string): Promise<ApprovalsFile | undefined> {
  try {
    return JSON.parse(await readFile(join(approved, 'approvals.json'), 'utf8')) as ApprovalsFile
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

export interface CompareResult extends ReportShot {
  hash: string
}

export interface CompareRun {
  pass: boolean
  shots: CompareResult[]
  report: string
}

/**
 * Diffs each capture of a run against its approved image (0062) and writes an HTML report with
 * heatmaps. A shot with no approved image is `new`, and fails until approved.
 */
export async function compareRun(
  captures: string,
  approved: string,
  options: { report?: string } = {},
): Promise<CompareRun> {
  const manifest = await readManifest(captures)
  const approvals = await readApprovals(approved)
  const reportFile = resolve(options.report ?? join(captures, 'report.html'))
  const base = dirname(reportFile)
  const link = (file: string) => relative(base, file).split('\\').join('/')
  const shots: CompareResult[] = []
  for (const shot of manifest.shots) {
    const captureFile = join(captures, `${shot.id}.png`)
    const approvedFile = join(approved, `${shot.id}.png`)
    const approval = approvals?.approvals.filter((a) => a.shot === shot.id).at(-1)
    const entry: CompareResult = {
      id: shot.id,
      hash: shot.hash,
      status: 'new',
      capture: link(captureFile),
      ...(approval && { approval }),
    }
    if (!(await exists(approvedFile))) {
      shots.push({ ...entry, reason: 'no approved image' })
      continue
    }
    const approvedBytes = new Uint8Array(await readFile(approvedFile))
    entry.approved = link(approvedFile)
    if (sha256(approvedBytes) === shot.hash) {
      shots.push({ ...entry, status: 'pass', share: 0, maxDeltaE: 0, ssim: 1 })
      continue
    }
    const before = await decodePng(approvedBytes)
    const after = await decodePng(new Uint8Array(await readFile(captureFile)))
    let diff: ReturnType<typeof compareImages>
    try {
      diff = compareImages(before, after, shot.tolerance)
    } catch (err) {
      shots.push({ ...entry, status: 'fail', reason: (err as Error).message })
      continue
    }
    const heatmapFile = join(captures, 'diff', `${shot.id}.png`)
    await mkdir(dirname(heatmapFile), { recursive: true })
    await writeFile(heatmapFile, encodePng(diffHeatmap(before, diff), before.width, before.height))
    shots.push({
      ...entry,
      status: diff.pass ? 'pass' : 'fail',
      reason: diff.reason,
      heatmap: link(heatmapFile),
      share: diff.share,
      maxDeltaE: diff.maxDeltaE,
      ssim: diff.ssim,
    })
  }
  await mkdir(base, { recursive: true })
  await writeFile(reportFile, renderReport(`Captures of ${manifest.fixture}`, shots))
  return { pass: shots.every((s) => s.status === 'pass'), shots, report: reportFile }
}

/**
 * Approves a capture (0062): copies it into `approved/` and appends `{ shot, hash, reason, by,
 * date }` to `approved/approvals.json`. Refuses without a reason.
 */
export async function approveShot(options: {
  captures: string
  approved: string
  shot: string
  reason: string | undefined
  by: string
  date?: Date
}): Promise<Approval> {
  const { captures, approved, shot } = options
  const approval: Approval = {
    shot,
    hash: '',
    reason: options.reason ?? '',
    by: options.by,
    date: (options.date ?? new Date()).toISOString(),
  }
  // Refuse before touching anything.
  const approvals = addApproval(await readApprovals(approved), approval)
  const manifest = await readManifest(captures)
  const captured = manifest.shots.find((s) => s.id === shot)
  if (!captured) {
    throw new ShardError('verify/unknown-shot', `The run in ${captures} has no shot "${shot}"`, {
      hint: `Its shots: ${manifest.shots.map((s) => s.id).join(', ') || 'none'}.`,
    })
  }
  const target = join(approved, `${shot}.png`)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(captures, `${shot}.png`), target)
  const recorded = approvals.approvals.at(-1)!
  recorded.hash = captured.hash
  await writeFile(join(approved, 'approvals.json'), `${JSON.stringify(approvals, null, 2)}\n`)
  return recorded
}

/** Every `.json` record under the given files and directories. */
export async function readRecords(paths: readonly string[]): Promise<PerfRecord[]> {
  const records: PerfRecord[] = []
  const visit = async (path: string): Promise<void> => {
    const info = await stat(path).catch(() => undefined)
    if (!info) throw new ShardError('verify/not-found', `No records at ${path}`, { path })
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        const child = join(path, entry)
        if (entry.endsWith('.json') || (await stat(child)).isDirectory()) await visit(child)
      }
    } else if (!path.endsWith('manifest.json')) {
      records.push(parsePerfRecord(await readJson(path, 'record'), path))
    }
  }
  for (const path of paths) await visit(path)
  return records
}

/** `shard perf-check`: a plan's thresholds over records (0062). */
export async function perfCheck(
  planFile: string,
  paths: readonly string[],
): Promise<PerfCheck & { records: number }> {
  const plan = await readPlan(planFile)
  const records = await readRecords(paths)
  return { ...checkThresholds(records, plan.thresholds), records: records.length }
}
