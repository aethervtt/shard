/**
 * Just enough source-map reading to turn a bundle stack frame back into `scripts/x.ts:line:col`.
 * Works on every host (no Node APIs), so the browser runner and the CLI report errors the same way.
 */

const B64 = new Map(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]),
)

interface Segment {
  column: number
  source: number
  line: number
  sourceColumn: number
}

export interface SourceMapData {
  version: number
  sources: string[]
  mappings: string
  sourceRoot?: string
}

export interface SourcePosition {
  source: string
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
}

/** Decoded mappings: `lookup(line, column)` with 1-based generated positions. */
export class SourceMap {
  readonly sources: string[]
  private readonly lines: Segment[][] = []

  constructor(data: SourceMapData) {
    this.sources = data.sources.map((s) => (data.sourceRoot ? `${data.sourceRoot}${s}` : s))
    let source = 0
    let line = 0
    let sourceColumn = 0
    for (const text of data.mappings.split(';')) {
      const segments: Segment[] = []
      let column = 0
      for (const segment of text.split(',')) {
        if (segment === '') continue
        const values = decodeVlq(segment)
        column += values[0]!
        if (values.length >= 4) {
          source += values[1]!
          line += values[2]!
          sourceColumn += values[3]!
          segments.push({ column, source, line, sourceColumn })
        }
      }
      this.lines.push(segments)
    }
  }

  lookup(line: number, column: number): SourcePosition | undefined {
    const segments = this.lines[line - 1]
    if (!segments || segments.length === 0) return undefined
    let best: Segment | undefined
    for (const s of segments) {
      if (s.column > column - 1) break
      best = s
    }
    best ??= segments[0]!
    return {
      source: this.sources[best.source]!,
      line: best.line + 1,
      column: best.sourceColumn + 1,
    }
  }
}

function decodeVlq(text: string): number[] {
  const out: number[] = []
  let value = 0
  let shift = 0
  for (const char of text) {
    const digit = B64.get(char)!
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
    } else {
      const negative = value & 1
      value >>>= 1
      out.push(negative ? -value : value)
      value = 0
      shift = 0
    }
  }
  return out
}

/** The inline source map in a bundle's text (`//# sourceMappingURL=data:...;base64,...`). */
export function inlineSourceMap(code: string): SourceMap | undefined {
  const m =
    /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(
      code,
    )
  if (!m) return undefined
  const json = new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)))
  return new SourceMap(JSON.parse(json) as SourceMapData)
}

/**
 * The first stack frame of `error` inside the bundle at `bundleUrl`, mapped to project source and
 * made relative (`scripts/main.ts:42:7`). Frames in dependencies (node_modules) are skipped.
 */
export function locateInBundle(
  error: unknown,
  bundleUrl: string,
  map: SourceMap,
  normalize: (source: string) => string = (s) => s,
): string | undefined {
  const stack = (error as { stack?: unknown })?.stack
  if (typeof stack !== 'string') return undefined
  const file = bundleUrl.replace(/[?#].*$/, '')
  for (const line of stack.split('\n')) {
    const at = line.lastIndexOf(file)
    if (at === -1) continue
    const m = /:(\d+):(\d+)/.exec(line.slice(at + file.length))
    if (!m) continue
    const pos = map.lookup(Number(m[1]), Number(m[2]))
    if (!pos || pos.source.includes('node_modules')) continue
    return `${normalize(pos.source)}:${pos.line}:${pos.column}`
  }
  return undefined
}
