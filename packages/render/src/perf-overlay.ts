import { type Entity, ProfilerResource, spanStats, type World } from '@aethervtt/shard-core'
import {
  gpuPassOverlap,
  isGpuPass,
  measureSlices,
  PerfBudgets,
  PerfScenario,
  perfBudgetState,
  Time,
} from '@aethervtt/shard-runtime'
import { PassCosts } from './ablation'
import { LABEL_FONT, labelWidth } from './gizmo-font'
import type { GizmoStore } from './gizmos'
import { Cameras } from './view'

// The `perf` debug overlay (0074): frame time, the 8 spans with the most time, and the GPU frame,
// drawn by the engine as screen-anchored labels in the top-left corner of the primary camera.
// 0075: where GPU pass times overlap (tile-based GPUs), they're grey, marked "overlapping" and not
// ranked; the latest ablation ranks them instead. With `App.perfScenario`, each slice's measured
// share of the frame shows against its budget, red when over.

const LINES = 8
/** GPU passes listed when their times overlap. */
const PASS_LINES = 4
const REFRESH_S = 0.25
const MARGIN = 8
const COLOR = [1, 1, 1, 1]
const HEADER = [0.55, 0.9, 1, 1]
const GREY = [0.6, 0.6, 0.6, 1]
const RED = [1, 0.35, 0.3, 1]
const LABEL_OPTIONS = { depthTest: false }

interface OverlayState {
  at: number
  lines: string[]
  colors: number[][]
}

const states = new WeakMap<World, OverlayState>()

const pad = (ms: number) => ms.toFixed(2).padStart(6)
const percent = (share: number) => `${Math.round(share * 100)}%`.padStart(4)

/** The overlay's text and colours: refreshed four times a second, so it's readable and cheap. */
export function perfOverlayLines(world: World): { lines: string[]; colors: number[][] } {
  const now = world.tryResource(Time)?.elapsed ?? 0
  let state = states.get(world)
  if (state && now - state.at < REFRESH_S && now >= state.at) return state
  const profiler = world.tryResource(ProfilerResource)
  const lines: string[] = []
  const colors: number[][] = []
  const line = (text: string, color: number[]) => {
    lines.push(text)
    colors.push(color)
  }
  if (profiler) {
    const frame = spanStats(profiler, 'frame')
    const gpu = spanStats(profiler, 'gpu:frame')
    line(
      `frame ${frame ? pad(frame.avg) : '     -'} ms  p95 ${frame ? pad(frame.p95) : '     -'}` +
        (profiler.gpu.status === 'unavailable'
          ? '   gpu n/a'
          : `   gpu ${gpu ? pad(gpu.avg) : '     -'} ms`),
      HEADER,
    )
    const overlapping = gpuPassOverlap(profiler)?.overlapping ?? false
    const spans: { name: string; avg: number }[] = []
    const passes: { name: string; avg: number }[] = []
    for (const name of profiler.names()) {
      if (
        name === 'frame' ||
        name === 'gpu:frame' ||
        name.startsWith('schedule/') ||
        name.startsWith('commands/')
      )
        continue
      const entry = { name, avg: profiler.timing(name)!.avg }
      // Overlapping pass times don't rank: they're listed apart.
      if (overlapping && name.startsWith('gpu:')) {
        if (isGpuPass(name)) passes.push(entry)
      } else spans.push(entry)
    }
    spans.sort((a, b) => b.avg - a.avg || (a.name < b.name ? -1 : 1))
    for (let i = 0; i < Math.min(LINES, spans.length); i++) {
      line(`${pad(spans[i]!.avg)} ms  ${spans[i]!.name}`, COLOR)
    }
    if (overlapping) {
      const ablation = world.tryResource(PassCosts)?.latest
      if (ablation && ablation.passes.length > 0) {
        line('gpu passes by ablation (timestamps overlap)', GREY)
        const ranked = [...ablation.passes].sort((a, b) => b.ms - a.ms)
        for (let i = 0; i < Math.min(PASS_LINES, ranked.length); i++) {
          line(`${pad(ranked[i]!.ms)} ms  gpu:${ranked[i]!.pass}  ablated`, COLOR)
        }
      } else {
        // Unranked: by name. perf.ablate measures what each costs.
        line('gpu passes overlapping: perf.ablate ranks them', GREY)
        passes.sort((a, b) => (a.name < b.name ? -1 : 1))
        for (let i = 0; i < Math.min(PASS_LINES, passes.length); i++) {
          line(`${pad(passes[i]!.avg)} ms  ${passes[i]!.name}  overlapping`, GREY)
        }
      }
    }
    const name = world.tryResource(PerfScenario)?.name
    const scenario = name ? world.tryResource(PerfBudgets)?.budgets.scenarios[name] : undefined
    if (name && scenario) {
      const machine = perfBudgetState(world)?.detection.machine ?? null
      line(`scenario ${name}${machine ? ` on ${machine}` : ''}: share of frame / budget`, HEADER)
      for (const s of measureSlices(profiler, scenario, machine).slices) {
        const measured = s.measuredShare === null ? '   -' : percent(s.measuredShare)
        line(
          `${s.track} ${measured} / ${percent(s.share)}  ${s.slice}`,
          s.verdict === 'over' ? RED : s.verdict === 'unmeasured' ? GREY : COLOR,
        )
      }
    }
  }
  state = { at: now, lines, colors }
  states.set(world, state)
  return state
}

const point = new Float32Array(3)

/** Unprojects a pixel (from the top left) of the camera's target to a world point in front of it. */
function unproject(inv: Float32Array, width: number, height: number, px: number, py: number) {
  const x = (px / width) * 2 - 1
  const y = 1 - (py / height) * 2
  const z = 0.5
  const w = inv[3]! * x + inv[7]! * y + inv[11]! * z + inv[15]!
  point[0] = (inv[0]! * x + inv[4]! * y + inv[8]! * z + inv[12]!) / w
  point[1] = (inv[1]! * x + inv[5]! * y + inv[9]! * z + inv[13]!) / w
  point[2] = (inv[2]! * x + inv[6]! * y + inv[10]! * z + inv[14]!) / w
  return point
}

/** Draws the perf overlay for the primary camera. Gizmo labels center on their anchor, above it. */
export function drawPerfOverlay(world: World, g: GizmoStore, camera: Entity | undefined): void {
  if (camera === undefined) return
  const cam = world.resource(Cameras).get(camera)
  if (!cam || cam.width <= 0 || cam.height <= 0) return
  const { lines, colors } = perfOverlayLines(world)
  const step = LABEL_FONT.cellHeight + 4
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!
    const px = MARGIN + labelWidth(text) / 2
    const py = MARGIN + (i + 1) * step
    g.label(
      unproject(cam.invViewProj, cam.width, cam.height, px, py),
      text,
      colors[i]!,
      LABEL_OPTIONS,
    )
  }
}
