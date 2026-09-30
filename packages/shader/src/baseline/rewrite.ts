import { ShardError } from '@aethervtt/shard-core'
import { DATA_TEXTURE_WIDTH, type DataDeclaration } from '../data-marks'
import type { SourceLocation } from '../library'
import {
  attribute,
  type Declaration,
  declarations,
  Layouts,
  matching,
  parseType,
  type Token,
  tokenize,
  type WgslType,
} from './wgsl'

// The baseline tier's rewrite of linked WGSL (0064). The full tier never loads this module.
//
// - `@data` storage declarations (collected before linking) become data textures, `texture_2d<u32>`
//   read through generated loaders that fetch the texels an element covers and pull its fields out
//   at the storage layout's byte offsets, so the engine uploads the same bytes either way.
//   `@data(uniform)` ones become uniform blocks, which the storage layout must match.
// - Depth textures read without comparison become float textures (naga can't `textureLoad` depth).
// - `@interpolate(flat)` becomes `flat, either`, as compatibility mode requires.
// - Builtins GLSL ES 3.00 lacks are polyfilled.
// - Storage a vertex or fragment entry point reaches that isn't `@data` is an error, located.

/** What a binding becomes on baseline, for the engine's bind group layouts. */
export interface RetargetedBinding {
  group: number
  binding: number
  name: string
  as: 'data-texture' | 'uniform' | 'unfilterable-float'
}

export interface BaselineRewrite {
  code: string
  bindings: RetargetedBinding[]
  /** The offset in the linked code a rewritten offset came from (for compile errors). */
  toLinked(offset: number): number
}

interface Edit {
  start: number
  end: number
  text: string
}

const RENDER_STAGES = new Set(['vertex', 'fragment'])

/**
 * Rewrites linked WGSL for the baseline tier. `data` is every `@data` declaration of the modules
 * the variant links; `locate` maps a linked offset to its module and line, for errors.
 */
export function rewriteForBaseline(
  code: string,
  data: readonly DataDeclaration[],
  locate: (offset: number) => SourceLocation | undefined = () => undefined,
  label = 'shader',
): BaselineRewrite {
  const tokens = tokenize(code)
  const decls = declarations(code, tokens)
  const layouts = new Layouts(code, tokens, decls)
  const edits: Edit[] = []
  const bindings: RetargetedBinding[] = []
  const tail: string[] = []
  const fail = (code: string, message: string, offset: number, hint?: string): never => {
    const at = locate(offset)
    throw new ShardError(code, `${label}: ${message}`, {
      path: at ? `${at.module}:${at.line}:${at.column}` : undefined,
      hint,
    })
  }

  const globals = new Map<string, Declaration>()
  for (const d of decls) if (d.keyword === 'var') globals.set(d.name, d)
  const reachable = renderReachable(tokens, decls, globals)

  // --- storage ------------------------------------------------------------------------------------
  let coordNeeded = false
  for (const d of decls) {
    if (d.keyword !== 'var' || !d.template.startsWith('storage')) continue
    const group = Number(attribute(d, 'group'))
    const binding = Number(attribute(d, 'binding'))
    const marked = data.find((x) => x.group === group && x.binding === binding)
    if (!marked) {
      if (reachable.has(d.name)) {
        fail(
          'shader/baseline-storage',
          `storage buffer "${d.name}" is read by a vertex or fragment shader, which the baseline tier can't do`,
          d.start,
          'Read engine data through shard::data (a @data declaration), or keep it out of render stages on baseline with @if(!BASELINE).',
        )
      }
      continue
    }
    if (d.template.includes('read_write')) {
      fail('shader/baseline-data', `@data "${d.name}" must be read-only`, d.start)
    }
    const type = parseType(d.type)
    const varToken = tokens.findIndex((t, i) => i >= d.first && t.text === 'var')
    if (marked.kind === 'uniform') {
      // A runtime-sized array: a uniform array of the stated length.
      const runtime = type.kind === 'array' && type.count === undefined
      if (runtime && !marked.count) {
        fail(
          'shader/baseline-data',
          `@data(uniform) "${d.name}" is a runtime-sized array: give it a length, @data(uniform, N)`,
          d.start,
        )
      }
      const sized: WgslType =
        runtime && type.kind === 'array' ? { ...type, count: marked.count } : type
      if (!layouts.sameInUniform(sized)) {
        fail(
          'shader/baseline-uniform-layout',
          `@data(uniform) "${d.name}" (${d.type}) lies out differently in uniform memory`,
          d.start,
          'Pad its arrays to 16-byte strides, or declare it @data (a data texture).',
        )
      }
      if (runtime && type.kind === 'array') {
        edits.push({
          start: tokens[varToken]!.start,
          end: d.end,
          text: `var<uniform> ${d.name}: array<${type.elementText}, ${marked.count}>;`,
        })
        // arrayLength(&NAME) is the stated length.
        for (let i = 3; i < tokens.length - 1; i++) {
          if (
            tokens[i]!.text === d.name &&
            tokens[i - 1]!.text === '&' &&
            tokens[i - 2]!.text === '(' &&
            tokens[i - 3]!.text === 'arrayLength' &&
            tokens[i + 1]!.text === ')'
          ) {
            edits.push({
              start: tokens[i - 3]!.start,
              end: tokens[i + 1]!.end,
              text: `${marked.count}u`,
            })
          }
        }
      } else {
        // `var<storage, read>` → `var<uniform>`.
        const close = matching(tokens, varToken + 1)
        edits.push({
          start: tokens[varToken]!.start,
          end: tokens[close]!.end,
          text: 'var<uniform>',
        })
      }
      bindings.push({ group, binding, name: d.name, as: 'uniform' })
      continue
    }
    if (type.kind !== 'array') {
      fail('shader/baseline-data', `@data "${d.name}" must be an array (${d.type})`, d.start)
    }
    const array = type as WgslType & { kind: 'array' }
    edits.push({
      start: tokens[varToken]!.start,
      end: d.end,
      text: `var ${d.name}: texture_2d<u32>;`,
    })
    bindings.push({ group, binding, name: d.name, as: 'data-texture' })
    rejectShadowing(tokens, decls, d, fail)
    let lengthUsed = false
    for (const i of usesOf(tokens, decls, d)) {
      const t = tokens[i]!
      if (tokens[i + 1]?.text === '[') {
        const close = matching(tokens, i + 1)
        edits.push({ start: t.start, end: tokens[i + 1]!.end, text: `${d.name}_at(u32(` })
        edits.push({ start: tokens[close]!.start, end: tokens[close]!.end, text: '))' })
        continue
      }
      // arrayLength(&NAME)
      if (
        tokens[i - 1]?.text === '&' &&
        tokens[i - 2]?.text === '(' &&
        tokens[i - 3]?.text === 'arrayLength' &&
        tokens[i + 1]?.text === ')'
      ) {
        edits.push({
          start: tokens[i - 3]!.start,
          end: tokens[i + 1]!.end,
          text: `${d.name}_len()`,
        })
        lengthUsed = true
        continue
      }
      fail(
        'shader/baseline-data',
        `@data "${d.name}" is used other than by index or arrayLength`,
        t.start,
        'Read one element at a time: name[i].',
      )
    }
    tail.push(loader(d.name, array, layouts, lengthUsed))
    coordNeeded = true
  }
  if (coordNeeded) {
    tail.unshift(
      `fn shard_data_coord(k: u32) -> vec2i {\n  return vec2i(i32(k % ${DATA_TEXTURE_WIDTH}u), i32(k / ${DATA_TEXTURE_WIDTH}u));\n}`,
    )
  }

  // --- depth read as a float texture ---------------------------------------------------------------
  for (const d of decls) {
    if (d.keyword !== 'var' || !d.type.startsWith('texture_depth_')) continue
    const kind = d.type.trim()
    const floatType =
      kind === 'texture_depth_2d'
        ? 'texture_2d<f32>'
        : kind === 'texture_depth_2d_array'
          ? 'texture_2d_array<f32>'
          : kind === 'texture_depth_cube'
            ? 'texture_cube<f32>'
            : undefined
    if (!floatType) continue // multisampled depth has its own baseline path (a resolved copy)
    const calls = callsOn(tokens, d)
    if (calls.some((c) => /Compare/.test(c.fn))) continue // a shadow map: stays depth
    // Used any other way (passed to a function that may compare it): stays depth too.
    if (usesOf(tokens, decls, d).length !== calls.length) continue
    const typeStart = code.indexOf(kind, d.start)
    edits.push({ start: typeStart, end: typeStart + kind.length, text: floatType })
    for (const c of calls) {
      if (c.fn === 'textureGather') {
        edits.push({ start: c.open, end: c.open, text: '0, ' })
      } else if (c.fn !== 'textureDimensions' && c.fn !== 'textureNumLayers') {
        edits.push({ start: c.close, end: c.close, text: '.x' })
      }
    }
    bindings.push({
      group: Number(attribute(d, 'group')),
      binding: Number(attribute(d, 'binding')),
      name: d.name,
      as: 'unfilterable-float',
    })
  }

  // --- flat interpolation and builtins ------------------------------------------------------------
  let reverseBits = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (
      t.text === 'interpolate' &&
      tokens[i - 1]?.text === '@' &&
      tokens[i + 1]?.text === '(' &&
      tokens[i + 2]?.text === 'flat' &&
      tokens[i + 3]?.text === ')'
    ) {
      edits.push({ start: tokens[i + 3]!.start, end: tokens[i + 3]!.start, text: ', either' })
    }
    if (t.text === 'reverseBits' && tokens[i + 1]?.text === '(') {
      edits.push({ start: t.start, end: t.end, text: 'shard_reverse_bits' })
      reverseBits = true
    }
    if (
      (t.text === 'countOneBits' ||
        t.text === 'firstLeadingBit' ||
        t.text === 'firstTrailingBit' ||
        t.text === 'extractBits' ||
        t.text === 'insertBits' ||
        t.text === 'textureNumLevels') &&
      tokens[i + 1]?.text === '('
    ) {
      fail(
        'shader/baseline-builtin',
        `${t.text} has no GLSL ES 3.00 equivalent`,
        t.start,
        'Compute it differently on baseline (@if(BASELINE)).',
      )
    }
  }
  if (reverseBits) tail.push(REVERSE_BITS)

  return { ...apply(code, edits, tail), bindings }
}

/**
 * Where a global is named: every token with its name outside its own declaration, member accesses
 * (`in.name`) and struct bodies, where the same name is a member's.
 */
function usesOf(tokens: readonly Token[], decls: readonly Declaration[], d: Declaration): number[] {
  const out: number[] = []
  let s = 0
  const structs = decls.filter((x) => x.keyword === 'struct')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'ident' || t.text !== d.name || tokens[i - 1]?.text === '.') continue
    if (i >= d.first && i <= d.last) continue
    while (s < structs.length && structs[s]!.last < i) s++
    if (s < structs.length && structs[s]!.first <= i) continue
    out.push(i)
  }
  return out
}

/** Globals a vertex or fragment entry point reaches, through the functions it calls. */
function renderReachable(
  tokens: readonly Token[],
  decls: readonly Declaration[],
  globals: ReadonlyMap<string, Declaration>,
): Set<string> {
  const fns = new Map<string, Declaration>()
  for (const d of decls) if (d.keyword === 'fn') fns.set(d.name, d)
  const seen = new Set<string>()
  const out = new Set<string>()
  const stack = decls
    .filter((d) => d.keyword === 'fn' && d.attributes.some((a) => RENDER_STAGES.has(a.name)))
    .map((d) => d.name)
  while (stack.length > 0) {
    const name = stack.pop()!
    if (seen.has(name)) continue
    seen.add(name)
    const fn = fns.get(name)!
    for (let i = fn.first; i <= fn.last; i++) {
      const t = tokens[i]!
      if (t.kind !== 'ident' || tokens[i - 1]?.text === '.') continue
      if (fns.has(t.text) && !seen.has(t.text)) stack.push(t.text)
      else if (globals.has(t.text)) out.add(t.text)
    }
  }
  return out
}

/** A `let`, `var`, `const` or parameter named like a data declaration would be rewritten wrongly. */
function rejectShadowing(
  tokens: readonly Token[],
  decls: readonly Declaration[],
  data: Declaration,
  fail: (code: string, message: string, offset: number, hint?: string) => never,
): void {
  for (const d of decls) {
    if (d.keyword !== 'fn') continue
    for (let i = d.first; i <= d.last; i++) {
      const t = tokens[i]!
      if (t.text !== data.name) continue
      const before = tokens[i - 1]?.text
      const after = tokens[i + 1]?.text
      const declares = before === 'let' || before === 'var' || before === 'const'
      const parameter = after === ':' && (before === '(' || before === ',')
      if (declares || parameter) {
        fail(
          'shader/baseline-shadowed',
          `"${data.name}" is declared again inside ${d.name}, over the @data declaration`,
          t.start,
          'Rename the local.',
        )
      }
    }
  }
}

/** Calls whose first argument is `d`: the builtin's name, and its parentheses' offsets. */
function callsOn(tokens: readonly Token[], d: Declaration) {
  const out: { fn: string; open: number; close: number }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'ident' || !t.text.startsWith('texture')) continue
    if (tokens[i + 1]?.text !== '(' || tokens[i + 2]?.text !== d.name) continue
    const close = matching(tokens, i + 1)
    out.push({ fn: t.text, open: tokens[i + 2]!.start, close: tokens[close]!.end })
  }
  return out
}

/**
 * `NAME_at(i)`: element i, from the texels it covers, fields at their storage offsets.
 * `NAME_len()`: the element count, from the byte length the data store keeps in the last texel.
 */
function loader(
  name: string,
  array: WgslType & { kind: 'array' },
  layouts: Layouts,
  withLength: boolean,
): string {
  const stride = layouts.stride(array, 'storage')
  const element = array.element
  const lines: string[] = []
  let word: (byte: number) => string
  if (stride % 16 === 0) {
    // Whole texels per element: fetch each once.
    const texels = stride / 16
    lines.push(`  let b = i * ${texels}u;`)
    for (let k = 0; k < texels; k++) {
      lines.push(`  let t${k} = textureLoad(${name}, shard_data_coord(b + ${k}u), 0);`)
    }
    word = (byte) => `t${byte >> 4}.${'xyzw'[(byte & 15) >> 2]}`
  } else {
    // Elements share texels (u32, vec2): one fetch per word.
    lines.push(`  let b = i * ${stride}u;`)
    word = (byte) => `${name}_word(b + ${byte}u)`
  }
  const body = `${lines.join('\n')}\n  return ${read(element, 0, word, layouts)};`
  let out = `fn ${name}_at(i: u32) -> ${canonical(element)} {\n${body}\n}`
  if (stride % 16 !== 0) {
    out += `\nfn ${name}_word(byte: u32) -> u32 {\n  return textureLoad(${name}, shard_data_coord(byte / 16u), 0)[(byte % 16u) / 4u];\n}`
  }
  if (withLength) {
    out += `\nfn ${name}_len() -> u32 {\n  let d = vec2i(textureDimensions(${name}));\n  return textureLoad(${name}, d - vec2i(1, 1), 0).x / ${stride}u;\n}`
  }
  return out
}

/** An expression reading a value of type `t` at byte `offset` of the element. */
function read(
  t: WgslType,
  offset: number,
  word: (byte: number) => string,
  layouts: Layouts,
): string {
  switch (t.kind) {
    case 'scalar':
      return scalar(t.name, word(offset))
    case 'vector': {
      const parts: string[] = []
      for (let k = 0; k < t.size; k++) parts.push(scalar(t.element.name, word(offset + k * 4)))
      return `${canonical(t)}(${parts.join(', ')})`
    }
    case 'matrix': {
      const column = { kind: 'vector', size: t.rows, element: t.element } as const
      const step = t.rows === 2 ? 8 : 16
      const columns: string[] = []
      for (let c = 0; c < t.columns; c++)
        columns.push(read(column, offset + c * step, word, layouts))
      return `${canonical(t)}(${columns.join(', ')})`
    }
    case 'array': {
      if (t.count === undefined)
        throw new ShardError('shader/baseline-data', 'Nested runtime array')
      const stride = layouts.stride(t, 'storage')
      const items: string[] = []
      for (let k = 0; k < t.count; k++)
        items.push(read(t.element, offset + k * stride, word, layouts))
      return `${canonical(t)}(${items.join(', ')})`
    }
    case 'struct': {
      const s = layouts.struct(t.name, 'storage')
      return `${t.name}(${s.members.map((m) => read(m.type, offset + m.offset, word, layouts)).join(', ')})`
    }
    default:
      throw new ShardError(
        'shader/baseline-data',
        `Can't read ${JSON.stringify(t)} from a data texture`,
      )
  }
}

function scalar(name: string, w: string): string {
  if (name === 'u32') return w
  if (name === 'i32' || name === 'f32') return `bitcast<${name}>(${w})`
  throw new ShardError('shader/baseline-data', `${name} can't live in a data texture`)
}

function canonical(t: WgslType): string {
  switch (t.kind) {
    case 'scalar':
      return t.name
    case 'vector':
      return `vec${t.size}<${t.element.name}>`
    case 'matrix':
      return `mat${t.columns}x${t.rows}<${t.element.name}>`
    case 'array':
      return t.count === undefined
        ? `array<${canonical(t.element)}>`
        : `array<${canonical(t.element)}, ${t.count}>`
    case 'struct':
      return t.name
    case 'atomic':
      return `atomic<${canonical(t.element)}>`
    default:
      return t.text
  }
}

const REVERSE_BITS = `fn shard_reverse_bits(v: u32) -> u32 {
  var x = v;
  x = ((x >> 1u) & 0x55555555u) | ((x & 0x55555555u) << 1u);
  x = ((x >> 2u) & 0x33333333u) | ((x & 0x33333333u) << 2u);
  x = ((x >> 4u) & 0x0F0F0F0Fu) | ((x & 0x0F0F0F0Fu) << 4u);
  x = ((x >> 8u) & 0x00FF00FFu) | ((x & 0x00FF00FFu) << 8u);
  return (x >> 16u) | (x << 16u);
}`

/** Applies non-overlapping edits and appends `tail`; maps rewritten offsets back. */
function apply(
  code: string,
  edits: Edit[],
  tail: readonly string[],
): Omit<BaselineRewrite, 'bindings'> {
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  let out = ''
  let at = 0
  // Where each edit starts in the output, and how far output offsets are from linked ones after it.
  const marks: { out: number; linked: number }[] = []
  for (const e of edits) {
    out += code.slice(at, e.start)
    marks.push({ out: out.length, linked: e.start })
    out += e.text
    at = e.end
    marks.push({ out: out.length, linked: e.end })
  }
  out += code.slice(at)
  const end = code.length
  if (tail.length > 0) out += `\n// baseline tier (0064)\n${tail.join('\n\n')}\n`
  return {
    code: out,
    toLinked(offset: number) {
      let base = { out: 0, linked: 0 }
      for (const m of marks) {
        if (m.out > offset) break
        base = m
      }
      return Math.min(end, base.linked + (offset - base.out))
    },
  }
}
