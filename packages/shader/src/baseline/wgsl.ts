// A small WGSL reader for the baseline rewrite (0064): tokens with their offsets, module-scope
// declarations, struct layouts. Enough of WGSL to find and retarget declarations in linked code;
// not a validator (the device and naga validate).

export interface Token {
  kind: 'ident' | 'number' | 'punct'
  text: string
  start: number
  end: number
}

/** Tokens of `code`, comments skipped. Punctuation is one character, except `->`. */
export function tokenize(code: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code.charCodeAt(i)
    // Whitespace.
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++
      continue
    }
    // Comments: line, and block (which nest in WGSL).
    if (c === 47 && code.charCodeAt(i + 1) === 47) {
      while (i < n && code.charCodeAt(i) !== 10) i++
      continue
    }
    if (c === 47 && code.charCodeAt(i + 1) === 42) {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (code.charCodeAt(i) === 47 && code.charCodeAt(i + 1) === 42) {
          depth++
          i += 2
        } else if (code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47) {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    const start = i
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(code.charCodeAt(i))) i++
      out.push({ kind: 'ident', text: code.slice(start, i), start, end: i })
      continue
    }
    if (c >= 48 && c <= 57) {
      while (i < n && /[0-9a-fA-FxXuif.eEpP+-]/.test(code[i]!)) {
        // A sign only continues a number right after an exponent.
        const ch = code[i]!
        if ((ch === '+' || ch === '-') && !/[eEpP]/.test(code[i - 1]!)) break
        i++
      }
      out.push({ kind: 'number', text: code.slice(start, i), start, end: i })
      continue
    }
    if (c === 45 && code.charCodeAt(i + 1) === 62) {
      out.push({ kind: 'punct', text: '->', start, end: i + 2 })
      i += 2
      continue
    }
    out.push({ kind: 'punct', text: code[i]!, start, end: i + 1 })
    i++
  }
  return out
}

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57)
}

/** Index of the token closing the bracket at `open` (`(`, `[`, `{` or `<` of a template). */
export function matching(tokens: readonly Token[], open: number): number {
  const o = tokens[open]!.text
  const c = o === '(' ? ')' : o === '[' ? ']' : o === '{' ? '}' : '>'
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!.text
    if (t === o) depth++
    else if (t === c) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export interface Attribute {
  name: string
  /** Argument text, e.g. `2` for `@group(2)`; '' without arguments. */
  args: string
}

/** A module-scope declaration: its attributes, keyword, name and where it lies in the code. */
export interface Declaration {
  attributes: Attribute[]
  keyword: 'struct' | 'fn' | 'var' | 'const' | 'override' | 'alias' | 'other'
  name: string
  /** `var<storage, read>` → `storage, read`. */
  template: string
  /** The type after `:` (vars), as written. */
  type: string
  /** Offsets of the whole declaration, attributes included, and of its body or type. */
  start: number
  end: number
  /** Token range of the declaration. */
  first: number
  last: number
}

/** Module-scope declarations of linked WGSL, in order. */
export function declarations(code: string, tokens: readonly Token[]): Declaration[] {
  const out: Declaration[] = []
  let i = 0
  while (i < tokens.length) {
    const first = i
    const attributes: Attribute[] = []
    while (tokens[i]?.text === '@') {
      const name = tokens[i + 1]!.text
      i += 2
      let args = ''
      if (tokens[i]?.text === '(') {
        const close = matching(tokens, i)
        args = code.slice(tokens[i]!.end, tokens[close]!.start).trim()
        i = close + 1
      }
      attributes.push({ name, args })
    }
    const head = tokens[i]
    if (!head) break
    const kw = head.text
    const keyword =
      kw === 'struct' ||
      kw === 'fn' ||
      kw === 'var' ||
      kw === 'const' ||
      kw === 'override' ||
      kw === 'alias'
        ? kw
        : 'other'
    i++
    let template = ''
    if (keyword === 'var' && tokens[i]?.text === '<') {
      const close = matching(tokens, i)
      template = code.slice(tokens[i]!.end, tokens[close]!.start).replace(/\s+/g, ' ').trim()
      i = close + 1
    }
    const name = tokens[i]?.kind === 'ident' ? tokens[i]!.text : ''
    let type = ''
    // To the end: a `{ … }` body (struct, fn) or a `;`.
    let last = i
    if (keyword === 'struct' || keyword === 'fn') {
      while (last < tokens.length && tokens[last]!.text !== '{') last++
      last = matching(tokens, last)
      // A struct may end with a stray `;`.
      if (tokens[last + 1]?.text === ';') last++
    } else {
      let depth = 0
      let colon = -1
      while (last < tokens.length) {
        const t = tokens[last]!.text
        if (t === '(' || t === '[' || t === '{') depth++
        else if (t === ')' || t === ']' || t === '}') depth--
        else if (t === ':' && depth === 0 && colon === -1) colon = last
        else if (t === ';' && depth === 0) break
        else if (t === '=' && depth === 0 && colon !== -1 && !type) {
          type = code.slice(tokens[colon]!.end, tokens[last]!.start).trim()
        }
        last++
      }
      if (colon !== -1 && !type) type = code.slice(tokens[colon]!.end, tokens[last]!.start).trim()
    }
    const end = tokens[Math.min(last, tokens.length - 1)]!.end
    out.push({
      attributes,
      keyword,
      name,
      template,
      type,
      start: tokens[first]!.start,
      end,
      first,
      last: Math.min(last, tokens.length - 1),
    })
    i = last + 1
  }
  return out
}

export function attribute(d: Declaration, name: string): string | undefined {
  return d.attributes.find((a) => a.name === name)?.args
}

// --- types and layouts --------------------------------------------------------------------------

export type WgslType =
  | { kind: 'scalar'; name: 'f32' | 'u32' | 'i32' | 'f16' | 'bool' }
  | { kind: 'vector'; size: 2 | 3 | 4; element: WgslType & { kind: 'scalar' } }
  | { kind: 'matrix'; columns: 2 | 3 | 4; rows: 2 | 3 | 4; element: WgslType & { kind: 'scalar' } }
  | {
      kind: 'array'
      element: WgslType
      elementText: string
      count: number | undefined
      text: string
    }
  | { kind: 'struct'; name: string }
  | { kind: 'atomic'; element: WgslType }
  | { kind: 'other'; text: string }

const SHORT: Record<string, string> = { f: 'f32', u: 'u32', i: 'i32', h: 'f16' }

/** Parses a type as written (`array<Light>`, `vec3f`, `mat4x4<f32>`, `Instance`). */
export function parseType(text: string): WgslType {
  const t = text.replace(/\s+/g, '')
  if (t === 'f32' || t === 'u32' || t === 'i32' || t === 'f16' || t === 'bool') {
    return { kind: 'scalar', name: t }
  }
  let m = /^vec([234])(?:([fuih])|<(\w+)>)$/.exec(t)
  if (m) {
    const element = parseType(m[2] ? SHORT[m[2]]! : m[3]!) as WgslType & { kind: 'scalar' }
    return { kind: 'vector', size: Number(m[1]) as 2 | 3 | 4, element }
  }
  m = /^mat([234])x([234])(?:([fh])|<(\w+)>)$/.exec(t)
  if (m) {
    const element = parseType(m[3] ? SHORT[m[3]]! : m[4]!) as WgslType & { kind: 'scalar' }
    return {
      kind: 'matrix',
      columns: Number(m[1]) as 2 | 3 | 4,
      rows: Number(m[2]) as 2 | 3 | 4,
      element,
    }
  }
  if (t.startsWith('array<') && t.endsWith('>')) {
    const inner = t.slice(6, -1)
    // The last top-level comma splits element and count.
    let depth = 0
    let split = -1
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]
      if (c === '<') depth++
      else if (c === '>') depth--
      else if (c === ',' && depth === 0) split = i
    }
    const element = parseType(split === -1 ? inner : inner.slice(0, split))
    const countText = split === -1 ? undefined : inner.slice(split + 1).replace(/[ui]$/, '')
    const count = countText === undefined ? undefined : Number(countText)
    return {
      kind: 'array',
      element,
      elementText: split === -1 ? inner : inner.slice(0, split),
      count: Number.isFinite(count) ? count : undefined,
      text,
    }
  }
  if (t.startsWith('atomic<') && t.endsWith('>')) {
    return { kind: 'atomic', element: parseType(t.slice(7, -1)) }
  }
  if (/^\w+$/.test(t)) return { kind: 'struct', name: t }
  return { kind: 'other', text }
}

export interface Member {
  name: string
  type: WgslType
  typeText: string
  offset: number
  size: number
  align: number
}

export interface StructLayout {
  name: string
  members: Member[]
  size: number
  align: number
}

export type AddressSpace = 'storage' | 'uniform'

const roundUp = (n: number, a: number) => Math.ceil(n / a) * a

/**
 * Struct layouts by name, under one address space's rules (WGSL §14.4): uniform raises array
 * strides and struct alignments to 16. `@align` and `@size` are honored.
 */
export class Layouts {
  private readonly structs = new Map<
    string,
    { name: string; members: { name: string; typeText: string; align?: number; size?: number }[] }
  >()
  private readonly cache = new Map<string, StructLayout>()

  constructor(code: string, tokens: readonly Token[], decls: readonly Declaration[]) {
    for (const d of decls) {
      if (d.keyword !== 'struct') continue
      let i = d.first
      while (tokens[i]!.text !== '{') i++
      const close = matching(tokens, i)
      const members: { name: string; typeText: string; align?: number; size?: number }[] = []
      i++
      while (i < close) {
        let align: number | undefined
        let size: number | undefined
        while (tokens[i]!.text === '@') {
          const attr = tokens[i + 1]!.text
          i += 2
          if (tokens[i]!.text === '(') {
            const end = matching(tokens, i)
            const value = Number(
              code.slice(tokens[i]!.end, tokens[end]!.start).trim().replace(/[ui]$/, ''),
            )
            if (attr === 'align') align = value
            if (attr === 'size') size = value
            i = end + 1
          }
        }
        const name = tokens[i]!.text
        i += 2 // name, ':'
        let depth = 0
        const from = i
        while (i < close) {
          const t = tokens[i]!.text
          if (t === '<' || t === '(') depth++
          else if (t === '>' || t === ')') depth--
          else if (t === ',' && depth === 0) break
          i++
        }
        members.push({
          name,
          typeText: code.slice(tokens[from]!.start, tokens[i - 1]!.end),
          align,
          size,
        })
        if (tokens[i]?.text === ',') i++
      }
      this.structs.set(d.name, { name: d.name, members })
    }
  }

  has(name: string): boolean {
    return this.structs.has(name)
  }

  struct(name: string, space: AddressSpace): StructLayout {
    const key = `${space}:${name}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const s = this.structs.get(name)
    if (!s) throw new Error(`No struct ${name}`)
    let offset = 0
    let align = 1
    const members: Member[] = []
    for (const m of s.members) {
      const type = parseType(m.typeText)
      const a = m.align ?? this.align(type, space)
      const size = m.size ?? this.size(type, space)
      offset = roundUp(offset, a)
      members.push({ name: m.name, type, typeText: m.typeText, offset, size, align: a })
      offset += size
      align = Math.max(align, a)
    }
    if (space === 'uniform') align = roundUp(align, 16)
    const layout = { name, members, size: roundUp(offset, align), align }
    this.cache.set(key, layout)
    return layout
  }

  align(t: WgslType, space: AddressSpace): number {
    switch (t.kind) {
      case 'scalar':
        return t.name === 'f16' ? 2 : 4
      case 'atomic':
        return 4
      case 'vector': {
        const e = t.element.name === 'f16' ? 2 : 4
        return t.size === 2 ? 2 * e : 4 * e
      }
      case 'matrix':
        return this.align({ kind: 'vector', size: t.rows, element: t.element }, space)
      case 'array': {
        const a = this.align(t.element, space)
        return space === 'uniform' ? roundUp(a, 16) : a
      }
      case 'struct':
        return this.struct(t.name, space).align
      default:
        throw new Error(`No layout for ${t.text}`)
    }
  }

  size(t: WgslType, space: AddressSpace): number {
    switch (t.kind) {
      case 'scalar':
        return t.name === 'f16' ? 2 : 4
      case 'atomic':
        return 4
      case 'vector':
        return t.size * (t.element.name === 'f16' ? 2 : 4)
      case 'matrix': {
        const column = { kind: 'vector', size: t.rows, element: t.element } as const
        return t.columns * roundUp(this.size(column, space), this.align(column, space))
      }
      case 'array':
        if (t.count === undefined) return this.stride(t, space)
        return t.count * this.stride(t, space)
      case 'struct':
        return this.struct(t.name, space).size
      default:
        throw new Error(`No layout for ${t.text}`)
    }
  }

  /** Bytes between an array's elements. */
  stride(t: WgslType & { kind: 'array' }, space: AddressSpace): number {
    const e = t.element
    const stride = roundUp(this.size(e, space), this.align(e, space))
    return space === 'uniform' ? roundUp(stride, 16) : stride
  }

  /**
   * Whether a type lies out the same in uniform and storage memory: every member and element at
   * the same offset, so the same bytes read the same through either.
   */
  sameInUniform(t: WgslType): boolean {
    try {
      return this.sameLayout(t)
    } catch {
      return false
    }
  }

  private sameLayout(t: WgslType): boolean {
    switch (t.kind) {
      case 'scalar':
      case 'vector':
      case 'matrix':
        return true
      case 'array':
        return (
          t.count !== undefined &&
          this.stride(t, 'storage') === this.stride(t, 'uniform') &&
          this.sameLayout(t.element)
        )
      case 'struct': {
        const s = this.struct(t.name, 'storage')
        const u = this.struct(t.name, 'uniform')
        return s.members.every(
          (m, i) => m.offset === u.members[i]!.offset && this.sameLayout(m.type),
        )
      }
      default:
        return false
    }
  }
}
