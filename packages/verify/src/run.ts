import { ShardError } from '@aethervtt/shard-core'
import type { Tolerance } from './compare'
import type { CheckFailure } from './expect'
import type { CaptureScope } from './plan'

/** What `shard capture` wrote: `<out>/manifest.json`, next to the PNGs and records. */
export interface CaptureManifest {
  version: 1
  url: string
  fixture: string
  /** ISO time the run started. */
  date: string
  shots: CapturedShot[]
  /** Record files, relative to the manifest. */
  records: string[]
  /** Steps that ran and the checks that failed (a run with failures exits 1). */
  steps: { name: string; browser: string; dpr: number; failures: CheckFailure[] }[]
  /** Browsers the plan named that couldn't run it (no WebGPU, not installed), and why. */
  skipped: { browser: string; reason: string }[]
}

export interface CapturedShot {
  /** `chromium/main/map-close@2x`: also the PNG's path under the run, less `.png`. */
  id: string
  browser: string
  client: string
  shot: string
  dpr: number
  scope: CaptureScope
  width: number
  height: number
  /** SHA-256 of the PNG file. */
  hash: string
  tolerance: Tolerance
}

/** `approvals.json` in the approved directory: why each approved image looks the way it does. */
export interface ApprovalsFile {
  version: 1
  approvals: Approval[]
}

export interface Approval {
  shot: string
  /** SHA-256 of the approved PNG. */
  hash: string
  reason: string
  by: string
  /** ISO time. */
  date: string
}

/** Appends an approval. Refuses one without a reason: every visible change is explained. */
export function addApproval(file: ApprovalsFile | undefined, approval: Approval): ApprovalsFile {
  if (!approval.reason.trim()) {
    throw new ShardError(
      'verify/approval-needs-reason',
      `Approving "${approval.shot}" needs a reason`,
      {
        hint: 'Say why it looks the way it does: shard approve <shot> --reason "Shadows are softer since 0058".',
      },
    )
  }
  return {
    version: 1,
    approvals: [...(file?.approvals ?? []), { ...approval, reason: approval.reason.trim() }],
  }
}
