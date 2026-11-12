// A web export (0110) in real Chromium: maze-chase as `shard export` writes it, served as plain
// static files, starts on both backends without errors, draws, and loads neither the shader linker
// nor naga (both are baked). Needs Playwright's Chromium with WebGPU and WebGL2 (see browser-tests.ts).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch, decodePng } from '@aethervtt/shard-verify/node'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkRequired, webGpuUnavailable, webgl2Unavailable } from './browser-tests'

const repo = resolve(import.meta.dirname, '../../..')
const out = mkdtempSync(join(tmpdir(), 'shard-export-browser-'))

interface Chunk {
  file: string
  kind: string
  packages: Record<string, number>
}

/** Serves `dir` as a static host would: files by path, no compression, no special headers. */
async function serveStatic(dir: string): Promise<{ base: string; server: Server }> {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  }
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname))
    const file = join(dir, path.endsWith('/') ? `${path}index.html` : path)
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, server }
}

// Whether a browser can run it first: without one, the export would be wasted work.
// A page to probe from (Chromium's error page for a 404 has no navigator.gpu); the export goes
// next to it, in web/.
writeFileSync(join(out, 'probe.html'), '<!doctype html>')
const { base, server } = await serveStatic(out)
const skipGpu = await webGpuUnavailable(`${base}/probe.html`)
checkRequired('Web export (WebGPU)', skipGpu)
const skipGl = await webgl2Unavailable(`${base}/probe.html`)
checkRequired('Web export (WebGL2)', skipGl)

let chunks: Chunk[] = []
if (!skipGpu || !skipGl) {
  const exported = spawnSync(
    process.execPath,
    [join(repo, 'apps/cli/bin/shard.mjs'), 'export', '--out', join(out, 'web'), '--json'],
    { cwd: join(repo, 'examples/maze-chase'), encoding: 'utf8', timeout: timeout(600_000) },
  )
  if (exported.status !== 0) throw new Error(`shard export failed:\n${exported.stderr}`)
  chunks = JSON.parse(exported.stdout).chunks
}

/** Files of the chunks holding `pkg`, and of WASM whose name starts with `name`. */
const filesOf = (pkg: string) => chunks.filter((c) => pkg in c.packages).map((c) => c.file)
const wasm = (name: string) =>
  chunks.filter((c) => c.kind === 'wasm' && c.file.includes(name)).map((c) => c.file)

let browser: Browser
beforeAll(async () => {
  if (!skipGpu || !skipGl) browser = await chromium.launch(browserLaunch('chromium', 1))
})
afterAll(async () => {
  await browser?.close()
  server.close()
  rmSync(out, { recursive: true, force: true })
})

describe('web export (0110)', () => {
  for (const backend of ['webgpu', 'webgl2'] as const) {
    it.skipIf(backend === 'webgpu' ? skipGpu : skipGl)(
      `maze-chase runs from static files on ${backend}, with its shaders baked`,
      async () => {
        const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
        const errors: string[] = []
        const fetched: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text())
        })
        page.on('request', (r) => fetched.push(new URL(r.url()).pathname.replace(/^\/web\//, '')))
        await page.goto(`${base}/web/?backend=${backend}`)
        await page.waitForFunction(() => document.getElementById('status')?.textContent === '', {
          timeout: timeout(60_000),
        })
        await page.waitForTimeout(500)
        expect(errors).toEqual([])

        // Drawn: the maze's walls light a good share of the canvas.
        const shot = await decodePng(new Uint8Array(await page.locator('canvas').screenshot()))
        let lit = 0
        for (let i = 0; i < shot.data.length; i += 4) {
          if (Math.max(shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!) > 40) lit++
        }
        expect(lit / (shot.width * shot.height)).toBeGreaterThan(0.1)

        for (const file of [...filesOf('wesl'), ...wasm('shard_naga')]) {
          expect(fetched, `${file} should stay unloaded`).not.toContain(file)
        }
        const webgl2 = filesOf('@aethervtt/shard-gpu-webgl2')
        if (backend === 'webgl2') expect(fetched.some((f) => webgl2.includes(f))).toBe(true)
        else for (const file of webgl2) expect(fetched).not.toContain(file)
        await page.close()
      },
      timeout(180_000),
    )
  }
})
