import { type Entity, ProfilerResource, type World } from '@aethervtt/shard-core'
import { Time } from '@aethervtt/shard-runtime'
import { LABEL_FONT, labelWidth } from './gizmo-font'
import type { GizmoStore } from './gizmos'
import { Cameras } from './view'

// The `perf` debug overlay (0074): frame time, the 8 spans with the most time, and the GPU frame,
// drawn by the engine as screen-anchored labels in the top-left corner of the primary camera.

const LINES = 8
const REFRESH_S = 0.25
const MARGIN = 8
const COLOR = [1, 1, 1, 1]
const HEADER = [0.55, 0.9, 1, 1]
const LABEL_OPTIONS = { depthTest: false }

interface OverlayState {
  at: number
  lines: string[]
}

const states = new WeakMap<World, OverlayState>()

const pad = (ms: number) => ms.toFixed(2).padStart(6)

/** The overlay's text: refreshed four times a second, so it's readable and cheap. */
function linesOf(world: World): string[] {
  const now = world.tryResource(Time)?.elapsed ?? 0
  let state = states.get(world)
  if (state && now - state.at < REFRESH_S && now >= state.at) return state.lines
  const profiler = world.tryResource(ProfilerResource)
  const lines: string[] = []
  if (profiler) {
    const frame = profiler.stats('frame')
    const gpu = profiler.stats('gpu:frame')
    lines.push(
      `frame ${frame ? pad(frame.avg) : '     -'} ms  p95 ${frame ? pad(frame.p95) : '     -'}` +
        (profiler.gpu.status === 'unavailable'
          ? '   gpu n/a'
          : `   gpu ${gpu ? pad(gpu.avg) : '     -'} ms`),
    )
    const spans: { name: string; avg: number }[] = []
    for (const name of profiler.names()) {
      if (
        name === 'frame' ||
        name === 'gpu:frame' ||
        name.startsWith('schedule/') ||
        name.startsWith('commands/')
      )
        continue
      spans.push({ name, avg: profiler.timing(name)!.avg })
    }
    spans.sort((a, b) => b.avg - a.avg || (a.name < b.name ? -1 : 1))
    for (let i = 0; i < Math.min(LINES, spans.length); i++) {
      lines.push(`${pad(spans[i]!.avg)} ms  ${spans[i]!.name}`)
    }
  }
  state = { at: now, lines }
  states.set(world, state)
  return lines
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
  const lines = linesOf(world)
  const step = LABEL_FONT.cellHeight + 4
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!
    const px = MARGIN + labelWidth(text) / 2
    const py = MARGIN + (i + 1) * step
    g.label(
      unproject(cam.invViewProj, cam.width, cam.height, px, py),
      text,
      i === 0 ? HEADER : COLOR,
      LABEL_OPTIONS,
    )
  }
}
