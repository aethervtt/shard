import { ShardError } from '@aethervtt/shard-core'
import { attribute, declarations, matching, type Token, tokenize } from './wgsl'

// Baseline tier (0064), loaded only there: an image kernel's compute entry point as a fragment
// entry point, so the baseline tier runs the same WGSL body as a render pass into the texel the
// compute invocation would have stored. One source for both tiers: the full tier dispatches the
// kernel as written.
//
// An image kernel has one write-only storage texture it stores to, at `id.xy` (and `id.z`, the
// layer or face), from `@builtin(global_invocation_id) id`. The fragment form:
//
// - binds a `vec4u` uniform where the storage texture was: the target's width, height and depth
//   (texels), and the layer the pass renders (w);
// - reads `textureDimensions(output)` from it;
// - turns each `textureStore(output, …, value)` into `return value;` and an early `return;` into
//   `discard;`, and derives `id` from the fragment's position and the layer.
//
// The pass renders into one layer (or 3D slice) of one mip, with a fullscreen triangle.

/** The uniform an image kernel's fragment form reads its target from: width, height, depth, layer. */
export const FRAGMENT_KERNEL_TARGET = 'shard_target'

export interface FragmentKernel {
  /** The module's WGSL with the fragment entry point (named as the compute one was). */
  source: string
  /** The storage texture it wrote: its format, and its (group, binding), now the target uniform. */
  format: string
  group: number
  binding: number
}

/**
 * The fragment form of the image kernel `entry` in a module's source. Throws
 * `shader/fragment-kernel` when the kernel isn't one (no single storage output, stores elsewhere).
 */
export function fragmentKernel(source: string, entry = 'main', label = 'kernel'): FragmentKernel {
  const fail = (message: string): never => {
    throw new ShardError('shader/fragment-kernel', `${label}: ${message}`, {
      hint: 'Only image kernels run as fragment passes: one storage texture, stored at the invocation id.',
    })
  }
  const tokens = tokenize(source)
  const decls = declarations(source, tokens)
  const outputs = decls.filter(
    (d) => d.keyword === 'var' && d.type.trim().startsWith('texture_storage_'),
  )
  if (outputs.length !== 1) fail(`needs exactly one storage texture, found ${outputs.length}`)
  const output = outputs[0]!
  const kind = output.type.trim()
  const format = kind.slice(kind.indexOf('<') + 1, kind.indexOf(',')).trim()
  const dims = kind.startsWith('texture_storage_3d') ? 'xyz' : 'xy'
  const fn = decls.find((d) => d.keyword === 'fn' && d.name === entry)
  if (!fn?.attributes.some((a) => a.name === 'compute')) fail(`no @compute fn ${entry}`)
  // From the `fn` keyword: the attributes before it have parentheses of their own.
  const fnToken = tokens.findIndex((t, k) => k >= fn!.first && t.text === 'fn')
  const body = fnBody(tokens, fnToken, fn!.last)
  // The invocation id parameter.
  const id = invocationId(tokens, body.params, body.open)
  if (!id) fail('its entry point takes no @builtin(global_invocation_id)')

  const edits: { start: number; end: number; text: string }[] = []
  const group = attribute(output, 'group')
  const binding = attribute(output, 'binding')
  edits.push({
    start: output.start,
    end: output.end,
    text: `@group(${group}) @binding(${binding}) var<uniform> ${FRAGMENT_KERNEL_TARGET}: vec4u;`,
  })
  for (let i = 0; i < tokens.length; i++) {
    if (i >= output.first && i <= output.last) continue
    const t = tokens[i]!
    if (t.kind !== 'ident' || t.text !== output.name || tokens[i - 1]?.text === '.') continue
    const call = tokens[i - 2]?.text
    if (tokens[i - 1]?.text !== '(' || (call !== 'textureDimensions' && call !== 'textureStore')) {
      fail(`uses "${output.name}" other than in textureDimensions or textureStore`)
    }
    const open = i - 1
    const close = matching(tokens, open)
    if (call === 'textureDimensions') {
      edits.push({
        start: tokens[i - 2]!.start,
        end: tokens[close]!.end,
        text: `${FRAGMENT_KERNEL_TARGET}.${dims}`,
      })
      continue
    }
    if (i < body.open || i > body.close) fail('stores outside its entry point')
    // textureStore(output, coords[, layer], value): the value is the last argument.
    const commas = topLevelCommas(tokens, open, close)
    const value = source.slice(tokens[commas[commas.length - 1]!]!.end, tokens[close]!.start).trim()
    let end = tokens[close]!.end
    let next = close + 1
    if (tokens[next]?.text === ';') end = tokens[next++]!.end
    // `textureStore(…); return;`: the store is the return.
    if (tokens[next]?.text === 'return' && tokens[next + 1]?.text === ';')
      end = tokens[next + 1]!.end
    edits.push({ start: tokens[i - 2]!.start, end, text: `return ${value};` })
  }
  // Early exits discard the fragment.
  for (let i = body.open; i < body.close; i++) {
    if (tokens[i]!.text !== 'return' || tokens[i + 1]?.text !== ';') continue
    if (edits.some((e) => e.start <= tokens[i]!.start && tokens[i]!.end <= e.end)) continue
    edits.push({ start: tokens[i]!.start, end: tokens[i + 1]!.end, text: 'discard;' })
  }
  // The signature: the fragment's position, and the id derived from it and the layer.
  const attrStart = fn!.attributes.length > 0 ? tokens[fn!.first]!.start : fn!.start
  edits.push({
    start: attrStart,
    end: tokens[fnToken]!.start,
    text: '@fragment ',
  })
  edits.push({
    start: tokens[body.params]!.start,
    end: tokens[body.open]!.end,
    text: `(@builtin(position) shard_position: vec4f) -> @location(0) vec4f {\n  let ${id} = vec3u(vec2u(shard_position.xy), ${FRAGMENT_KERNEL_TARGET}.w);`,
  })
  edits.sort((a, b) => b.start - a.start)
  let out = source
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return { source: out, format, group: Number(group), binding: Number(binding) }
}

/** The parameter list's `(` and the body's braces of the fn declared across [first, last]. */
function fnBody(tokens: readonly Token[], first: number, last: number) {
  let params = first
  while (params <= last && tokens[params]!.text !== '(') params++
  const paramsClose = matching(tokens, params)
  let open = paramsClose + 1
  while (open <= last && tokens[open]!.text !== '{') open++
  return { params, open, close: matching(tokens, open) }
}

/** The name of the `@builtin(global_invocation_id)` parameter before the body. */
function invocationId(tokens: readonly Token[], first: number, open: number): string | undefined {
  for (let i = first; i < open; i++) {
    if (tokens[i]!.text === 'global_invocation_id' && tokens[i - 2]?.text === 'builtin') {
      // @builtin(global_invocation_id) NAME: vec3u
      return tokens[i + 2]?.kind === 'ident' ? tokens[i + 2]!.text : undefined
    }
  }
  return undefined
}

function topLevelCommas(tokens: readonly Token[], open: number, close: number): number[] {
  const out: number[] = []
  let depth = 0
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i]!.text
    if (t === '(' || t === '[' || t === '{') depth++
    else if (t === ')' || t === ']' || t === '}') depth--
    else if (t === ',' && depth === 0) out.push(i)
  }
  return out
}
