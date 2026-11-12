import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebPlatform } from './index'

const file = new Uint8Array(1000).map((_, i) => i % 251)

/** A fake host for `file` at /pack: answering ranges or not, counting the requests it gets. */
function host(mode: 'ranges' | 'whole' | 'missing') {
  const requests: (string | null)[] = []
  vi.stubGlobal('fetch', async (_url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range ?? null
    requests.push(range)
    await new Promise((r) => setTimeout(r, 5))
    if (mode === 'missing') return new Response(null, { status: 404 })
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '')
    if (mode === 'ranges' && m) {
      return new Response(file.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 })
    }
    return new Response(file, { status: 200 })
  })
  return requests
}

const fs = () => createWebPlatform({ baseUrl: 'http://game.example/' }).fs
afterEach(() => vi.unstubAllGlobals())

describe('ranged reads on the web (0110)', () => {
  it('asks a host that answers ranges for each range', async () => {
    const requests = host('ranges')
    const web = fs()
    const reads = await Promise.all([0, 100, 200].map((o) => web.readRange!('pack', o, 10)))
    expect(reads[1]).toEqual(file.subarray(100, 110))
    await web.readRange!('pack', 500, 4)
    expect(requests).toEqual(['bytes=0-9', 'bytes=100-109', 'bytes=200-209', 'bytes=500-503'])
  })

  it('downloads a file once from a host that ignores ranges, and slices it from then on', async () => {
    const requests = host('whole')
    const web = fs()
    const reads = await Promise.all([0, 100, 200].map((o) => web.readRange!('pack', o, 10)))
    expect(reads[2]).toEqual(file.subarray(200, 210))
    expect(await web.readRange!('pack', 990, 10)).toEqual(file.subarray(990, 1000))
    expect(requests).toHaveLength(1)
  })

  it('asks again after a failed read', async () => {
    const requests = host('missing')
    const web = fs()
    await expect(web.readRange!('pack', 0, 10)).rejects.toMatchObject({
      code: 'platform/fs-not-found',
    })
    await expect(web.readRange!('pack', 0, 10)).rejects.toMatchObject({
      code: 'platform/fs-not-found',
    })
    expect(requests).toHaveLength(2)
  })
})
