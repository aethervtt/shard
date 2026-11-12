import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS, Manifest } from './manifest'
import * as rows from './plugins'
import { enginePluginExport, enginePlugins, resolvePlugins } from './plugins'

describe('engine plugin table (0110)', () => {
  it('exports every row under the name an export imports it by', () => {
    for (const row of enginePlugins) {
      expect((rows as Record<string, unknown>)[enginePluginExport(row.name)], row.name).toBe(row)
    }
  })

  it('has a row for every plugin a manifest can name', () => {
    const named = new Set(enginePlugins.filter((p) => !p.always).map((p) => p.name))
    expect([...named].sort()).toEqual(Object.keys(BUILTIN_PLUGINS).sort())
  })

  it('resolves what a plugin implies, and drops display plugins for servers', () => {
    const manifest = Manifest.deserialize({ name: 'demo', plugins: ['sprite', 'scatter'] })
    const names = resolvePlugins(manifest)
    for (const n of ['sprite', 'render/forward', 'render', 'core/transform', 'scatter', 'wind'])
      expect(names.has(n), n).toBe(true)
    const server = resolvePlugins(manifest, { display: false })
    expect(server.has('render')).toBe(false)
    expect(server.has('scatter')).toBe(false)
    expect(server.has('wind')).toBe(true)
  })
})
