// Shared by the playground's browser tests: a dev server for the pages, and the reason a browser
// can't run them here. Tests skip without Playwright's Chromium or a GPU adapter, unless
// SHARD_BROWSER_TESTS=required (CI), where that fails the run.

import { join } from 'node:path'
import { browserLaunch } from '@aethervtt/shard-verify/node'
import { chromium } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'

export interface PlaygroundServer {
  /** The pages' origin, without a trailing slash. */
  base: string
  close(): Promise<void>
}

/** Serves the playground's pages on a free port, as `pnpm playground` does. */
export async function servePlayground(): Promise<PlaygroundServer> {
  const root = join(import.meta.dirname, '..')
  const server: ViteDevServer = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { port: 0 },
  })
  await server.listen()
  return {
    base: server.resolvedUrls!.local[0]!.replace(/\/$/, ''),
    close: () => server.close(),
  }
}

/** Why Chromium can't run WebGPU pages here, or undefined when it can. */
export async function webGpuUnavailable(url: string): Promise<string | undefined> {
  try {
    const browser = await chromium.launch(browserLaunch('chromium', 1))
    try {
      const page = await browser.newPage()
      await page.goto(url)
      const ok = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))
      return ok ? undefined : 'Chromium has no WebGPU adapter here'
    } finally {
      await browser.close()
    }
  } catch (err) {
    return (err as Error).message.split('\n')[0]
  }
}

/** Throws when browser tests are required but can't run; otherwise warns that they skip. */
export function checkRequired(suite: string, reason: string | undefined): void {
  if (!reason) return
  if (process.env.SHARD_BROWSER_TESTS === 'required') {
    throw new Error(`${suite} browser tests are required here, but can't run: ${reason}`)
  }
  console.warn(`${suite} browser tests skipped: ${reason}`)
}
