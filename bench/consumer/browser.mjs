import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { chromium } from 'playwright'

const html = (await readFile('compat.html', 'utf8')).replace('./compat.ts', '/main.js')
const browser = await chromium.launch({
  headless: true,
  args:
    process.platform === 'linux'
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : [],
})
try {
  const requested = process.argv.slice(2)
  for (const output of requested.length
    ? requested
    : ['dist', 'dist-vite6', 'dist-webpack', 'next', 'dev-vite6']) {
    const responses = [],
      errors = []
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
        const publicFile = ['font.ttf', 'pattern.webp'].includes(path.slice(1))
        const file = resolve(publicFile ? 'public' : output, `.${path}`)
        const body =
          output === 'dist-webpack' && path === '/compat.html' ? html : await readFile(file)
        res.setHeader(
          'Content-Type',
          { '.wasm': 'application/wasm', '.js': 'text/javascript', '.html': 'text/html' }[
            extname(path)
          ] ?? 'application/octet-stream',
        )
        res.end(body)
      } catch {
        res.statusCode = 404
        res.end()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    let next, dev
    const port = server.address().port
    if (output === 'dev-vite6') {
      await new Promise((resolve) => server.close(resolve))
      const { createServer } = await import('vite6')
      dev = await createServer({
        configFile: 'vite6.config.mjs',
        server: { host: '127.0.0.1', port, strictPort: true },
      })
      await dev.listen()
    }
    if (output === 'next') {
      await new Promise((resolve) => server.close(resolve))
      next = spawn(
        process.execPath,
        ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      next.stderr.on('data', (data) => process.stderr.write(data))
      await new Promise((resolve, reject) => {
        next.stdout.on('data', (data) => {
          if (String(data).includes('Ready')) resolve()
        })
        next.once('exit', (code) => reject(new Error(`Next exited before ready: ${code}`)))
      })
    }
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text())
    })
    page.on('response', (response) =>
      responses.push({
        url: response.url(),
        status: response.status(),
        type: response.headers()['content-type'],
      }),
    )
    try {
      await page.goto(`http://127.0.0.1:${port}/${output === 'next' ? '' : 'compat.html'}`)
      try {
        await page.waitForFunction(() => 'consumer' in window, undefined, { timeout: 60_000 })
      } catch (error) {
        await writeFile(
          `${output}-verification.json`,
          JSON.stringify({ error: String(error), responses, errors }, null, 2),
        )
        throw new Error(`${error}\n${errors.join('\n')}`)
      }
      const result = await page.evaluate(() =>
        Promise.race([
          window.consumer,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ error: 'Consumer verification exceeded 180 seconds' }),
              180_000,
            ),
          ),
        ]),
      )
      await page.screenshot({ path: `${output}-consumer.png` })
      await writeFile(
        `${output}-verification.json`,
        JSON.stringify({ result, responses, errors }, null, 2),
      )
      assert.equal(result.error, undefined, JSON.stringify(result))
      assert.deepEqual(errors, [])
      assert(
        responses.every((r) => r.status === 200),
        'all codec/worker fetches return 200',
      )
      assert(
        responses.filter((r) => r.type?.includes('application/wasm')).length >= 4,
        'Basis, WebP and naga WASM fetched',
      )
      console.log(output, JSON.stringify(result.result))
    } finally {
      await page.close()
      if (next) {
        const stopped = new Promise((resolve) => next.once('exit', resolve))
        next.kill()
        await stopped
      } else if (dev) await dev.close()
      else await new Promise((resolve) => server.close(resolve))
    }
  }
} finally {
  await browser.close()
}
