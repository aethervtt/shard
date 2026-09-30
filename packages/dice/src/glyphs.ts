import { ShardError } from '@aethervtt/shard-core'
import type { OutlineCommand } from '@aethervtt/shard-text'

// Glyph marks (0054): registered vector paths a face layout can name. A host registers its own
// closed vocabulary; faces never carry path data themselves.

export interface DiceGlyphDef {
  /** SVG path data (M L H V C S Q T A Z, absolute or relative), in `viewBox` units, y down. */
  path: string
  /** min-x, min-y, width, height. Default 0 0 100 100. */
  viewBox?: [number, number, number, number]
}

export interface DiceGlyph {
  name: string
  /** The outline in glyph units: y up, the viewBox's middle at the origin, its height 1. */
  commands: OutlineCommand[]
  /** Width over height of the viewBox. */
  aspect: number
}

const glyphs = new Map<string, DiceGlyph>()

function parseError(name: string, message: string): ShardError {
  return new ShardError('dice/invalid-glyph', `Glyph "${name}": ${message}`, {
    hint: 'Glyph paths are SVG path data (M, L, H, V, C, S, Q, T, A, Z).',
  })
}

/** Arc to cubic Béziers (SVG implementation notes, F.6), appended to `out`. */
function arcToCubics(
  out: OutlineCommand[],
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angle: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void {
  if (x1 === x2 && y1 === y2) return
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) {
    out.push({ type: 'L', x: x2, y: y2 })
    return
  }
  const phi = (angle * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const xp = cos * dx + sin * dy
  const yp = -sin * dx + cos * dy
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const den = rx * rx * yp * yp + ry * ry * xp * xp
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (k * rx * yp) / ry
  const cyp = (-k * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const vAngle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = vAngle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let dt = vAngle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && dt > 0) dt -= Math.PI * 2
  if (sweep && dt < 0) dt += Math.PI * 2
  const segments = Math.ceil(Math.abs(dt) / (Math.PI / 2))
  const step = dt / segments
  const kappa = (4 / 3) * Math.tan(step / 4)
  const point = (t: number): [number, number] => {
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]
  }
  const deriv = (t: number): [number, number] => {
    const ex = -rx * Math.sin(t)
    const ey = ry * Math.cos(t)
    return [cos * ex - sin * ey, sin * ex + cos * ey]
  }
  for (let i = 0; i < segments; i++) {
    const a = t1 + i * step
    const b = a + step
    const [ax, ay] = point(a)
    const [bx, by] = point(b)
    const [dax, day] = deriv(a)
    const [dbx, dby] = deriv(b)
    out.push({
      type: 'C',
      x1: ax + kappa * dax,
      y1: ay + kappa * day,
      x2: bx - kappa * dbx,
      y2: by - kappa * dby,
      x: bx,
      y: by,
    })
  }
}

/** SVG path data to outline commands (still y down, in path units). */
export function parseSvgPath(d: string, name = 'path'): OutlineCommand[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const out: OutlineCommand[] = []
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  // The last control point, for S and T.
  let cx = 0
  let cy = 0
  let prev = ''
  const num = () => {
    const t = tokens[i++]
    if (t === undefined || /[a-zA-Z]/.test(t))
      throw parseError(name, `expected a number after ${cmd}`)
    return Number(t)
  }
  const flag = () => num() !== 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (/[a-zA-Z]/.test(t)) {
      cmd = t
      i++
    } else if (!cmd) throw parseError(name, 'path data must start with a command')
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M': {
        x = ox + num()
        y = oy + num()
        sx = x
        sy = y
        out.push({ type: 'M', x, y })
        // Further pairs are line-tos.
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
        x = ox + num()
        y = oy + num()
        out.push({ type: 'L', x, y })
        break
      case 'H':
        x = ox + num()
        out.push({ type: 'L', x, y })
        break
      case 'V':
        y = oy + num()
        out.push({ type: 'L', x, y })
        break
      case 'C': {
        const x1 = ox + num()
        const y1 = oy + num()
        cx = ox + num()
        cy = oy + num()
        x = ox + num()
        y = oy + num()
        out.push({ type: 'C', x1, y1, x2: cx, y2: cy, x, y })
        break
      }
      case 'S': {
        const reflect = prev === 'C' || prev === 'S'
        const x1 = reflect ? 2 * x - cx : x
        const y1 = reflect ? 2 * y - cy : y
        cx = ox + num()
        cy = oy + num()
        x = ox + num()
        y = oy + num()
        out.push({ type: 'C', x1, y1, x2: cx, y2: cy, x, y })
        break
      }
      case 'Q':
        cx = ox + num()
        cy = oy + num()
        x = ox + num()
        y = oy + num()
        out.push({ type: 'Q', x1: cx, y1: cy, x, y })
        break
      case 'T': {
        const reflect = prev === 'Q' || prev === 'T'
        cx = reflect ? 2 * x - cx : x
        cy = reflect ? 2 * y - cy : y
        x = ox + num()
        y = oy + num()
        out.push({ type: 'Q', x1: cx, y1: cy, x, y })
        break
      }
      case 'A': {
        const rx = num()
        const ry = num()
        const angle = num()
        const large = flag()
        const sweep = flag()
        const ex = ox + num()
        const ey = oy + num()
        arcToCubics(out, x, y, rx, ry, angle, large, sweep, ex, ey)
        x = ex
        y = ey
        break
      }
      case 'Z':
        out.push({ type: 'Z' })
        x = sx
        y = sy
        break
      default:
        throw parseError(name, `unknown command ${cmd}`)
    }
    prev = cmd.toUpperCase()
  }
  return out
}

/** Maps commands through (x, y) → (a·x + b, c·y + d). */
function transform(
  cmds: OutlineCommand[],
  a: number,
  b: number,
  c: number,
  d: number,
): OutlineCommand[] {
  return cmds.map((k) => {
    switch (k.type) {
      case 'M':
      case 'L':
        return { type: k.type, x: a * k.x + b, y: c * k.y + d }
      case 'Q':
        return { type: 'Q', x1: a * k.x1 + b, y1: c * k.y1 + d, x: a * k.x + b, y: c * k.y + d }
      case 'C':
        return {
          type: 'C',
          x1: a * k.x1 + b,
          y1: c * k.y1 + d,
          x2: a * k.x2 + b,
          y2: c * k.y2 + d,
          x: a * k.x + b,
          y: c * k.y + d,
        }
      default:
        return k
    }
  })
}

/**
 * Registers a glyph a face layout can name. The same path again is a no-op; a different one under
 * a taken name throws `dice/registry-conflict`.
 */
export function defineDiceGlyph(name: string, def: DiceGlyphDef): DiceGlyph {
  const [vx, vy, vw, vh] = def.viewBox ?? [0, 0, 100, 100]
  const existing = glyphs.get(name)
  const commands = transform(
    parseSvgPath(def.path, name),
    1 / vh,
    -(vx + vw / 2) / vh,
    -1 / vh,
    (vy + vh / 2) / vh,
  )
  const glyph: DiceGlyph = { name, commands, aspect: vw / vh }
  if (existing) {
    if (JSON.stringify(existing.commands) === JSON.stringify(commands)) return existing
    throw new ShardError(
      'dice/registry-conflict',
      `Glyph "${name}" is already defined, differently`,
      {
        hint: 'Give the new glyph its own name.',
      },
    )
  }
  glyphs.set(name, glyph)
  return glyph
}

export function findDiceGlyph(name: string): DiceGlyph | undefined {
  return glyphs.get(name)
}

export function allDiceGlyphs(): string[] {
  return [...glyphs.keys()].sort()
}

export { transform as transformOutline }

const star = (points: number, outer: number, inner: number, turn = 0) => {
  const out: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + turn + (i * Math.PI) / points
    const r = i % 2 === 0 ? outer : inner
    out.push(`${(50 + Math.cos(a) * r).toFixed(2)} ${(50 + Math.sin(a) * r).toFixed(2)}`)
  }
  return `M${out.join('L')}Z`
}

/** Built-in glyphs, in a 100 × 100 box. */
export const BUILTIN_GLYPHS: Readonly<Record<string, DiceGlyphDef>> = {
  star: { path: star(5, 48, 20) },
  sun: { path: star(12, 48, 33) },
  moon: { path: 'M62 6A44 44 0 1 0 94 70A36 36 0 1 1 62 6Z' },
  heart: {
    path: 'M50 90C22 68 4 52 4 32C4 16 16 6 29 6C39 6 46 12 50 20C54 12 61 6 71 6C84 6 96 16 96 32C96 52 78 68 50 90Z',
  },
  crown: { path: 'M6 82L12 26L32 52L50 14L68 52L88 26L94 82Z' },
  diamond: { path: 'M50 2L90 50L50 98L10 50Z' },
}

let registered = false

export function registerBuiltinGlyphs(): void {
  if (registered) return
  registered = true
  for (const [name, def] of Object.entries(BUILTIN_GLYPHS)) defineDiceGlyph(name, def)
}
