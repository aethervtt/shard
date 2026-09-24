import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer } from '@shard/assets'
import { createNodePlatform } from '@shard/platform-node'
import { afterEach, describe, expect, it } from 'vitest'
import { UiNode, UiRoot, UiStyle, UiText } from './components'
import { describeUi } from './methods'
import { addFont, node, rect, root, uiApp } from './testing'
import { UiThemes } from './theme'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function write(path: string, content: unknown) {
  const file = join(dir!, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(content))
}

describe('theme files', () => {
  it('editing a theme file restyles a running UI', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shard-ui-theme-'))
    write('ui/hud.theme.json', {
      styles: {
        panel: { background: '#102030', radius: [8, 8, 8, 8] },
        label: { size: 20, color: '#ffcc00' },
      },
    })
    const { world, frame } = await uiApp()
    const server = assetServer(world).configure({
      platform: createNodePlatform({ root: dir }),
      roots: ['ui'],
    })
    await server.scan()
    await server.load('ui/hud.theme.json')
    const ref = server.resolve('ui/hud.theme.json')!
    const r = root(world, 400, 300, { theme: ref })
    world.set(r, UiNode, { alignItems: 'start' })
    const panel = node(world, r, [UiNode, { style: 'panel', padding: [4, 4, 4, 4] }], UiStyle)
    const label = node(
      world,
      panel,
      [UiNode, { style: 'label' }],
      [UiText, { text: 'Fuel', font: addFont(world) }],
    )
    frame()
    expect(rect(world, label)[3]).toBeCloseTo(24, 3)
    expect(describeUi(world).roots[0]!.tree.children).toBeDefined()
    const theme = world.resource(UiThemes).get(ref)!
    expect(theme.styles.get('panel')!.background).toEqual([
      expect.closeTo(0.0052, 3),
      expect.closeTo(0.0144, 3),
      expect.closeTo(0.0296, 3),
      1,
    ])

    await new Promise((resolve) => setTimeout(resolve, 5))
    write('ui/hud.theme.json', {
      styles: { panel: { background: '#ff0000' }, label: { size: 30 } },
    })
    const report = await server.scan()
    expect(report.imported).toEqual(['ui/hud.theme.json'])
    frame()
    expect(world.resource(UiThemes).get(ref)).toBe(theme)
    expect(rect(world, label)[3]).toBeCloseTo(36, 3)
    expect(rect(world, panel)[3]).toBeCloseTo(44, 3)
    expect(world.get(r, UiRoot).theme?.guid).toBe(ref.guid)

    // A broken edit keeps the last good theme and reports the field.
    await new Promise((resolve) => setTimeout(resolve, 5))
    write('ui/hud.theme.json', { styles: { panel: { backgroundColor: '#ff0000' } } })
    const failed = await server.scan()
    expect(failed.failed[0]?.error.path).toBe('/styles/panel/backgroundColor')
    frame()
    expect(rect(world, label)[3]).toBeCloseTo(36, 3)
  })
})
