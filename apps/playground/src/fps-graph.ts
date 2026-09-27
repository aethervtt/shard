import { defineSystem, Last } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'

/** 30 seconds of history, one column per tenth of a second. */
const COLUMNS = 300
const BUCKET_MS = 100
const WIDTH = 300
const HEIGHT = 56

interface GraphState {
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  /** Worst (longest) frame per column, ms; 0 = no data yet. */
  worst: Float32Array
  /** Column being filled, and the ring's write position. */
  head: number
  filled: number
  bucketStart: number
  bucketWorst: number
  last: number
}

/**
 * FPS over the last 30 seconds as a green line in the panel. Each column is the slowest frame in
 * its tenth of a second, so a single dropped frame shows as a dip instead of averaging away.
 */
const fpsGraph = defineSystem({
  name: 'playground/fps-graph',
  setup: (): GraphState => {
    const canvas = document.getElementById('fps-graph') as HTMLCanvasElement | null
    const dpr = globalThis.devicePixelRatio ?? 1
    if (canvas) {
      canvas.width = WIDTH * dpr
      canvas.height = HEIGHT * dpr
      canvas.style.width = `${WIDTH}px`
      canvas.style.height = `${HEIGHT}px`
    }
    const ctx = canvas?.getContext('2d') ?? null
    ctx?.scale(dpr, dpr)
    return {
      canvas,
      ctx,
      worst: new Float32Array(COLUMNS),
      head: 0,
      filled: 0,
      bucketStart: performance.now(),
      bucketWorst: 0,
      last: performance.now(),
    }
  },
  run: (s) => {
    const now = performance.now()
    const frame = now - s.last
    s.last = now
    if (frame > s.bucketWorst) s.bucketWorst = frame
    if (now - s.bucketStart < BUCKET_MS) return
    // A long stall (tab hidden) spans several columns; fill them all with it.
    const columns = Math.min(COLUMNS, Math.floor((now - s.bucketStart) / BUCKET_MS))
    for (let i = 0; i < columns; i++) {
      s.worst[s.head] = s.bucketWorst
      s.head = (s.head + 1) % COLUMNS
      if (s.filled < COLUMNS) s.filled++
    }
    s.bucketStart = now
    s.bucketWorst = 0
    draw(s)
  },
})

function draw(s: GraphState): void {
  const ctx = s.ctx
  if (!ctx) return
  ctx.clearRect(0, 0, WIDTH, HEIGHT)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  // Scale to 0..max(75, best seen) fps so 60 sits near the top on normal displays.
  let top = 75
  let min = Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < s.filled; i++) {
    const fps = 1000 / s.worst[(s.head - 1 - i + COLUMNS) % COLUMNS]!
    if (fps > top) top = fps
    if (fps < min) min = fps
    sum += fps
  }
  const y = (fps: number) => HEIGHT - 2 - (Math.min(fps, top) / top) * (HEIGHT - 12)

  ctx.lineWidth = 1
  ctx.font = '9px ui-monospace, monospace'
  for (const guide of [60, 30]) {
    ctx.strokeStyle = 'rgba(207, 214, 228, 0.18)'
    ctx.beginPath()
    ctx.moveTo(0, Math.round(y(guide)) + 0.5)
    ctx.lineTo(WIDTH, Math.round(y(guide)) + 0.5)
    ctx.stroke()
    ctx.fillStyle = 'rgba(207, 214, 228, 0.45)'
    ctx.fillText(String(guide), WIDTH - 14, Math.round(y(guide)) - 2)
  }

  // Oldest on the left, newest at the right edge.
  ctx.strokeStyle = '#4ade80'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < s.filled; i++) {
    const column = (s.head - s.filled + i + COLUMNS) % COLUMNS
    const x = WIDTH - s.filled + i
    const py = y(1000 / s.worst[column]!)
    if (i === 0) ctx.moveTo(x, py)
    else ctx.lineTo(x, py)
  }
  ctx.stroke()

  if (s.filled > 0) {
    const current = 1000 / s.worst[(s.head - 1 + COLUMNS) % COLUMNS]!
    ctx.fillStyle = '#cfd6e4'
    ctx.fillText(
      `now ${current.toFixed(0)}  avg ${(sum / s.filled).toFixed(0)}  min ${min.toFixed(0)}  (${((s.filled * BUCKET_MS) / 1000).toFixed(0)} s)`,
      4,
      9,
    )
  }
}

/** The FPS graph, for any demo (it only needs a `<canvas id="fps-graph">` on the page). */
export const fpsGraphPlugin = definePlugin({
  name: 'playground/fps-graph',
  build(app) {
    app.addSystems(Last, fpsGraph)
  },
})
