import { ShardError } from '@aethervtt/shard-core'

// `@data` marks (0064): a storage declaration of engine data that vertex or fragment shaders read.
// The library strips the mark before linking, so the full tier links exactly the code it always
// has, and remembers the declaration for the baseline rewrite (loaded only on baseline), which
// retargets it to a data texture (`@data`) or a uniform block (`@data(uniform)`). A runtime-sized
// array becomes a uniform array of a stated length: `@data(uniform, 128)`.
//
//   @data @group(2) @binding(0) var<storage, read> instances: array<Instance>;
//   @data(uniform, 128) @group(0) @binding(1) var<storage, read> lights: array<Light>;
//
// The mark is followed by exactly one space or newline, which goes with it.

/** Bumps when the baseline rewrite's output changes: baked baseline code from before goes stale. */
export const BASELINE_REWRITE_VERSION = 1

/** A storage declaration marked `@data`, as collected before linking. */
export interface DataDeclaration {
  /** The module that declared it, for errors. */
  module: string
  name: string
  group: number
  binding: number
  kind: 'texture' | 'uniform'
  /** `@data(uniform, N)`: the uniform array length of a runtime-sized array. */
  count?: number
}

const MARK = /@data(?:\((texture|uniform)(?:\s*,\s*(\d+))?\))?\s/g
const DECLARATION = /^((?:@\w+\s*(?:\([^)]*\))?\s*)*)var\s*<\s*storage[^>]*>\s*([A-Za-z_]\w*)/

/** The source without its `@data` marks, and the declarations they marked. */
export function collectData(
  source: string,
  module: string,
): { code: string; data: DataDeclaration[] } {
  if (!source.includes('@data')) return { code: source, data: [] }
  const data: DataDeclaration[] = []
  let code = ''
  let at = 0
  for (const m of source.matchAll(MARK)) {
    const after = source.slice(m.index + m[0].length)
    const d = DECLARATION.exec(after)
    const group = d ? /@group\s*\(\s*(\d+)/.exec(d[1]!) : null
    const binding = d ? /@binding\s*\(\s*(\d+)/.exec(d[1]!) : null
    if (!d || !group || !binding) {
      throw new ShardError(
        'shader/data-misplaced',
        `@data in ${module} must mark a storage declaration with @group and @binding`,
        { hint: '@data @group(2) @binding(0) var<storage, read> name: array<T>;' },
      )
    }
    data.push({
      module,
      name: d[2]!,
      group: Number(group[1]),
      binding: Number(binding[1]),
      kind: m[1] === 'uniform' ? 'uniform' : 'texture',
      ...(m[2] ? { count: Number(m[2]) } : {}),
    })
    code += source.slice(at, m.index)
    at = m.index + m[0].length
  }
  return { code: code + source.slice(at), data }
}
