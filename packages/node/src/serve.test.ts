import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic } from './serve'

let dir: string
let server: Server
let base: string
const chunk = 'x'.repeat(4000)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shard-serve-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, 'f'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  writeFileSync(join(dir, 'assets/index-abc.js'), chunk)
  writeFileSync(join(dir, 'assets/index-abc.js.br'), brotliCompressSync(chunk))
  writeFileSync(join(dir, 'f/0123.bin'), '0123456789')
  writeFileSync(join(tmpdir(), 'shard-serve-secret.txt'), 'secret')
  server = createServer((req, res) => {
    void serveStatic(dir, req, res).then((ok) => {
      if (!ok) res.writeHead(404).end()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('serveStatic (0110)', () => {
  it('serves the page uncached and hashed files immutable, brotli when accepted', async () => {
    const page = await fetch(`${base}/`)
    expect(await page.text()).toBe('<!doctype html>')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(page.headers.get('content-type')).toContain('text/html')

    const js = await fetch(`${base}/assets/index-abc.js`, {
      headers: { 'accept-encoding': 'br' },
    })
    expect(js.headers.get('content-encoding')).toBe('br')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(await js.text()).toBe(chunk) // fetch decodes it
  })

  it('answers a Range request with 206 and the bytes, and an impossible one with 416', async () => {
    const part = await fetch(`${base}/f/0123.bin`, { headers: { range: 'bytes=2-4' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await part.text()).toBe('234')
    const tail = await fetch(`${base}/f/0123.bin`, { headers: { range: 'bytes=-3' } })
    expect(await tail.text()).toBe('789')
    const bad = await fetch(`${base}/f/0123.bin`, { headers: { range: 'bytes=20-30' } })
    expect(bad.status).toBe(416)
  })

  it("never serves outside its folder, and 404s what isn't there", async () => {
    expect((await fetch(`${base}/%2e%2e/shard-serve-secret.txt`)).status).toBe(404)
    expect((await fetch(`${base}/..%2fshard-serve-secret.txt`)).status).toBe(404)
    expect((await fetch(`${base}/missing.js`)).status).toBe(404)
  })
})
