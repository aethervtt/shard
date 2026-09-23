import { ShardError } from '@shard/core'

/**
 * Hooks: WESL has no function overrides, so this pre-pass adds them.
 *
 *   // in shard::pbr::material
 *   @hook fn pbr_input(in: VertexOutput) -> PbrInput { ...default... }
 *
 *   // in an override module
 *   import shard::pbr::material::{ pbr_input as base };
 *   override fn shard::pbr::material::pbr_input(in: VertexOutput) -> PbrInput { ... base(in) ... }
 *
 * With an override active, the hook module gets `pbr_input__default` (the original body) and a
 * `pbr_input` that forwards to the override; the override module's import of the hook name is
 * pointed at `__default`, so extensions can wrap the default. The last override in the list wins.
 */

const HOOK = /@hook\s+fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{/g
const OVERRIDE =
  /override\s+fn\s+((?:[A-Za-z_]\w*::)*)([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{/g

export interface HookSignature {
  params: string
  returns: string
}

const normalize = (s: string | undefined) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,:<>()])\s*/g, '$1')
    .trim()

export function findHooks(source: string): Map<string, HookSignature> {
  const hooks = new Map<string, HookSignature>()
  for (const m of source.matchAll(HOOK)) hooks.set(m[1]!, { params: m[2]!, returns: m[3] ?? '' })
  return hooks
}

function paramNames(params: string): string[] {
  const names: string[] = []
  let depth = 0
  let current = ''
  for (const ch of params) {
    if (ch === '<' || ch === '(') depth++
    if (ch === '>' || ch === ')') depth--
    if (ch === ',' && depth === 0) {
      names.push(current)
      current = ''
    } else current += ch
  }
  if (current.trim()) names.push(current)
  return names
    .map((p) =>
      p
        .replace(/@\w+(\([^)]*\))?/g, '')
        .split(':')[0]!
        .trim(),
    )
    .filter(Boolean)
}

/** Inserts lines after the module's import block (WESL requires imports first). */
function insertAfterImports(source: string, lines: string): string {
  const importRe = /^\s*import\s[^;]*;/gm
  let end = 0
  for (const m of source.matchAll(importRe)) end = m.index! + m[0].length
  return `${source.slice(0, end)}\n${lines}\n${source.slice(end)}`
}

/**
 * Applies hooks and overrides to module sources (keyed by module path like `shard::pbr::material`).
 * Returns new sources; inputs are not modified.
 */
export function applyHooks(
  sources: ReadonlyMap<string, string>,
  overrides: readonly string[],
): Map<string, string> {
  const out = new Map(sources)
  const hooksByModule = new Map<string, Map<string, HookSignature>>()
  for (const [path, source] of sources) {
    const hooks = findHooks(source)
    if (hooks.size > 0) hooksByModule.set(path, hooks)
  }

  // Last override wins: remember the winner per (module, hook).
  const winners = new Map<string, { module: string; fn: string; params: string; returns: string }>()
  overrides.forEach((overrideModule, index) => {
    const source = out.get(overrideModule)
    if (source === undefined) {
      throw new ShardError(
        'shader/link-unknown-module',
        `Override module "${overrideModule}" is not registered`,
      )
    }
    let rewritten = source
    for (const m of source.matchAll(OVERRIDE)) {
      const name = m[2]!
      let target = m[1]!.slice(0, -2)
      if (!target) {
        // Unqualified: the one module that declares a hook with this name.
        const owners = [...hooksByModule].filter(([, hooks]) => hooks.has(name)).map(([p]) => p)
        if (owners.length !== 1) {
          throw new ShardError(
            owners.length === 0 ? 'shader/unknown-hook' : 'shader/ambiguous-hook',
            owners.length === 0
              ? `"${name}" is not a hook`
              : `"${name}" is a hook in ${owners.join(' and ')}`,
            {
              path: overrideModule,
              hint:
                owners.length === 0
                  ? 'Only functions marked @hook can be overridden.'
                  : `Qualify it: override fn ${owners[0]}::${name}(...).`,
            },
          )
        }
        target = owners[0]!
      }
      const hook = hooksByModule.get(target)?.get(name)
      if (!hook) {
        throw new ShardError('shader/unknown-hook', `"${target}::${name}" is not a hook`, {
          path: overrideModule,
          hint: 'Only functions marked @hook can be overridden.',
        })
      }
      if (
        normalize(hook.params) !== normalize(m[3]) ||
        normalize(hook.returns) !== normalize(m[4])
      ) {
        throw new ShardError(
          'shader/hook-signature-mismatch',
          `Override of ${target}::${name} in ${overrideModule} has a different signature`,
          {
            path: overrideModule,
            hint: `Expected fn ${name}(${hook.params.trim()})${hook.returns ? ` -> ${hook.returns.trim()}` : ''}.`,
          },
        )
      }
      const fn = `${name}__override_${index}`
      rewritten = rewritten.replace(m[0], `fn ${fn}(${m[3]})${m[4] ? ` -> ${m[4].trim()}` : ''} {`)
      // `import target::{ name as base }` inside the override module means the default.
      const importPattern = new RegExp(
        `(import\\s+${target.replace(/::/g, '::')}::[^;]*?\\b)${name}\\b`,
        'g',
      )
      rewritten = rewritten.replace(importPattern, `$1${name}__default`)
      winners.set(`${target}::${name}`, {
        module: overrideModule,
        fn,
        params: m[3]!,
        returns: m[4] ?? '',
      })
    }
    out.set(overrideModule, rewritten)
  })

  for (const [path, hooks] of hooksByModule) {
    let source = out.get(path)!
    const imports: string[] = []
    const dispatchers: string[] = []
    for (const [name, sig] of hooks) {
      const winner = winners.get(`${path}::${name}`)
      const header = new RegExp(`@hook\\s+fn\\s+${name}\\s*\\(`)
      if (!winner) {
        source = source.replace(header, `fn ${name}(`)
        continue
      }
      source = source.replace(header, `fn ${name}__default(`)
      imports.push(`import ${winner.module}::${winner.fn};`)
      const ret = sig.returns.trim()
      const call = `${winner.fn}(${paramNames(sig.params).join(', ')})`
      dispatchers.push(
        `fn ${name}(${sig.params})${ret ? ` -> ${ret}` : ''} { ${ret ? 'return ' : ''}${call}; }`,
      )
    }
    if (imports.length > 0)
      source = `${insertAfterImports(source, imports.join('\n'))}\n${dispatchers.join('\n')}\n`
    out.set(path, source)
  }
  return out
}
