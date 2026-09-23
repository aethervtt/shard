import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import { createNodePlatform } from '@shard/platform-node'
import { App } from '@shard/runtime'
import '@shard/text'
import { afterAll, describe, expect, it } from 'vitest'
import { decodePng } from './png'
import { createProtocolServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'shard-text-protocol-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('text over the protocol', () => {
  it('measures text without rendering, and previews a font as a specimen', async () => {
    mkdirSync(join(root, 'assets/fonts'), { recursive: true })
    cpSync(
      resolve(here, '../../text/fixtures/Inter-Regular.ttf'),
      join(root, 'assets/fonts/Inter.ttf'),
    )
    const app = new App()
    await app.init()
    await assetServer(app.world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
    const server = createProtocolServer(app)
    const call = async (method: string, params: unknown) => {
      const r = await server.handle({ jsonrpc: '2.0', id: 1, method, params })
      if (r!.error) throw new Error(JSON.stringify(r!.error))
      return r!.result as Record<string, unknown>
    }
    const one = await call('text.measure', {
      font: 'assets/fonts/Inter.ttf',
      value: 'Scanner 7',
      size: 0.5,
    })
    const two = await call('text.measure', {
      font: 'assets/fonts/Inter.ttf',
      value: 'Scanner 7',
      size: 1,
    })
    expect(one.width as number).toBeGreaterThan(1)
    expect(two.width as number).toBeCloseTo((one.width as number) * 2, 4)
    const wrapped = await call('text.measure', {
      font: 'assets/fonts/Inter.ttf',
      value: 'a planet named Veil',
      size: 1,
      maxWidth: 5,
    })
    const lines = wrapped.lines as { text: string; width: number }[]
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(5)
    const bad = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'text.measure',
      params: { font: 'nope.ttf', value: 'x' },
    })
    expect(bad!.error).toBeDefined()
    const preview = await call('asset.preview', {
      asset: 'assets/fonts/Inter.ttf',
      width: 400,
      height: 200,
    })
    const png = await decodePng(
      Uint8Array.from(atob(preview.data as string), (c) => c.charCodeAt(0)),
    )
    let ink = 0
    for (let p = 0; p < png.data.length; p += 4) if (png.data[p]! > 200) ink++
    expect(ink).toBeGreaterThan(1000)
  }, 60_000)
})
