import type { Approval } from './run'

/** One shot's line in the compare report. Image paths are relative to the report. */
export interface ReportShot {
  id: string
  status: 'pass' | 'fail' | 'new'
  reason?: string
  approved?: string
  capture: string
  heatmap?: string
  share?: number
  maxDeltaE?: number
  ssim?: number
  /** The latest approval of this shot, if any. */
  approval?: Approval
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The compare report (0062): per shot, the approved image, the capture, and a heatmap of what
 * changed, with the numbers and the reason it was last approved. Failures first.
 */
export function renderReport(title: string, shots: readonly ReportShot[]): string {
  const order = { fail: 0, new: 1, pass: 2 }
  const sorted = [...shots].sort(
    (a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id),
  )
  const count = (s: ReportShot['status']) => shots.filter((x) => x.status === s).length
  const figure = (label: string, src: string | undefined) =>
    src
      ? `<figure><img src="${escapeHtml(src)}" alt="${label}" loading="lazy"><figcaption>${label}</figcaption></figure>`
      : `<figure class="none"><div>none</div><figcaption>${label}</figcaption></figure>`
  const rows = sorted.map((s) => {
    const numbers =
      s.share === undefined
        ? ''
        : `<span>${(s.share * 100).toFixed(3)}% changed</span><span>max ΔE ${s.maxDeltaE!.toFixed(1)}</span><span>SSIM ${s.ssim!.toFixed(4)}</span>`
    const approval = s.approval
      ? `<p class="approval">Approved ${escapeHtml(s.approval.date.slice(0, 10))} by ${escapeHtml(s.approval.by)}: ${escapeHtml(s.approval.reason)}</p>`
      : ''
    return `<section class="${s.status}">
<h2><span class="status">${s.status}</span> ${escapeHtml(s.id)}</h2>
<p class="numbers">${numbers}${s.reason ? `<span class="reason">${escapeHtml(s.reason)}</span>` : ''}</p>${approval}
<div class="row">${figure('approved', s.approved)}${figure('capture', s.capture)}${figure('changes', s.heatmap)}</div>
</section>`
  })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; background: #15171a; color: #d8dade; }
h1 { font-size: 20px; } h2 { font-size: 15px; margin: 0 0 4px; font-family: ui-monospace, monospace; }
section { border-left: 4px solid #3a8f5c; padding: 8px 12px; margin: 16px 0; background: #1c1f23; }
section.fail { border-color: #d0463b; } section.new { border-color: #d8a93b; }
.status { text-transform: uppercase; font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #333; }
.fail .status { background: #7a2620; } .new .status { background: #6d5620; }
.numbers span { margin-right: 14px; color: #aab; } .reason { color: #f0b0a8 !important; }
.approval { color: #9fb8a6; margin: 2px 0; }
.row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
figure { margin: 0; } figure img { width: 100%; image-rendering: pixelated;
  background: repeating-conic-gradient(#2a2d31 0 25%, #202226 0 50%) 0 0 / 16px 16px; }
figure.none div { aspect-ratio: 16 / 9; display: grid; place-items: center; background: #202226; color: #667; }
figcaption { color: #889; font-size: 12px; }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${count('fail')} changed, ${count('new')} new, ${count('pass')} unchanged.</p>
${rows.join('\n')}
</body></html>
`
}
