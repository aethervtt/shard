import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findComponent } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { LogResource } from '@shard/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type HeadlessProject, openProject } from './index'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const example = resolve(fileURLToPath(import.meta.url), '../../../../examples/star-explorer')

let gpu: GpuContext
let root: string
let project: HeadlessProject

const main = () => join(root, 'scripts/main.ts')
const edit = (from: string, to: string) => {
  const text = readFileSync(main(), 'utf8')
  if (!text.includes(from)) throw new Error(`"${from}" not in main.ts`)
  writeFileSync(main(), text.replace(from, to))
}
const call = async (method: string, params?: unknown) => {
  const r = await project.server.handle({ jsonrpc: '2.0', id: 1, method, params })
  if (r!.error) throw new Error(JSON.stringify(r!.error))
  return r!.result as never
}
const ship = async () =>
  (await call('entity.get', { entity: 'ship' })) as {
    components: Record<string, Record<string, unknown>>
  }

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  // Inside the example, so `@shard/*` resolves through its node_modules.
  root = mkdtempSync(join(example, '.shard', 'reload-'))
  for (const dir of ['scripts', 'scenes', 'shard.json', 'package.json', 'tsconfig.json']) {
    cpSync(join(example, dir), join(root, dir), { recursive: true })
  }
  project = await openProject({ root, gpu, width: 64, height: 36 })
})
afterAll(() => {
  project?.close()
  gpu.destroy()
  rmSync(root, { recursive: true, force: true })
})

describe('project code in bundle mode', () => {
  it('shares engine module instances with the host', () => {
    const Ship = findComponent('star-explorer/Ship')!
    // The bundle defined Ship through the same @shard/core the host uses: the world stores it.
    expect(project.app.world.registry.component('star-explorer/Ship')).toBe(Ship)
  })

  it('an edited system body runs from the next step, keeping the world', async () => {
    await call('time.step', { frames: 30 })
    const before = await ship()
    const entities = project.app.world.entityCount
    // Make thrust ten times stronger.
    edit('speed[i]! + acceleration[i]! * dt', 'speed[i]! + acceleration[i]! * dt * 10')
    const report = (await call('project.reload')) as { ok: boolean; systems: { changed: string[] } }
    expect(report.ok).toBe(true)
    expect(report.systems.changed).toEqual(['star-explorer/fly'])
    expect(project.app.world.entityCount).toBe(entities)
    expect((await ship()).components['core/Transform']).toEqual(before.components['core/Transform'])
    await call('input.inject', { action: 'star-explorer/Controls.thrust', pressed: true })
    await call('time.step', { frames: 10 })
    await call('input.inject', { action: 'star-explorer/Controls.thrust', pressed: false })
    // 10 frames at 15 m/s² would be 2.5 m/s; ten times that, capped at maxSpeed 40.
    expect((await ship()).components['star-explorer/Ship']!.speed).toBeGreaterThan(20)
  })

  it('adding a component field migrates the loaded ship', async () => {
    edit(
      "turnRate: t.f32({ default: 1.2, min: 0, unit: 'rad/s', description: 'Steering speed.' }),",
      "turnRate: t.f32({ default: 1.2, min: 0, unit: 'rad/s', description: 'Steering speed.' }),\n    boost: t.f32({ default: 3, description: 'Test field.' }),",
    )
    const report = (await call('project.reload')) as { ok: boolean; migrated: string[] }
    expect(report).toMatchObject({ ok: true, migrated: ['star-explorer/Ship'] })
    const s = (await ship()).components['star-explorer/Ship']!
    expect(s.boost).toBe(3)
    expect(s.maxSpeed).toBe(40)
  })

  it('a syntax error keeps the old code and reports file, line, and column', async () => {
    const good = readFileSync(main(), 'utf8')
    writeFileSync(main(), `${good}\nconst broken = ;\n`)
    const r = await project.server.handle({ jsonrpc: '2.0', id: 1, method: 'project.reload' })
    const data = r!.error!.data as { code: string; message: string }
    expect(data.code).toBe('project/bundle-failed')
    const line = good.split('\n').length + 1
    expect(data.message).toContain(`scripts/main.ts:${line}:`)
    const status = (await call('project.status')) as { error: { source: string } }
    expect(status.error.source).toMatch(new RegExp(`^scripts/main.ts:${line}:\\d+$`))
    writeFileSync(main(), good)
    expect(((await call('project.reload')) as { ok: boolean }).ok).toBe(true)
  })

  it('a Node built-in import fails the bundle', async () => {
    const good = readFileSync(main(), 'utf8')
    writeFileSync(
      main(),
      `import { readFileSync } from 'node:fs'\nconsole.log(readFileSync)\n${good}`,
    )
    const r = await project.server.handle({ jsonrpc: '2.0', id: 1, method: 'project.reload' })
    expect((r!.error!.data as { code: string }).code).toBe('project/node-builtin')
    writeFileSync(main(), good)
  })

  it('a system that throws logs the project source line', async () => {
    const good = readFileSync(main(), 'utf8')
    edit(
      'const dt = world.resource(FixedTime).step',
      "const dt = world.resource(FixedTime).step\n    if (dt > 0) throw new Error('kaboom')",
    )
    expect(((await call('project.reload')) as { ok: boolean }).ok).toBe(true)
    const line =
      readFileSync(main(), 'utf8')
        .split('\n')
        .findIndex((l) => l.includes('kaboom')) + 1
    await project.server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'time.step',
      params: { frames: 1 },
    })
    const errors = project.app.world.resource(LogResource).errors(5)
    const entry = errors.find((e) => e.message.includes('kaboom'))!
    expect(entry.source).toMatch(new RegExp(`^scripts/main.ts:${line}:\\d+$`))
    writeFileSync(main(), good)
    await call('project.reload')
  })

  it('reverting to earlier, identical code reloads it (no stale module cache)', async () => {
    const original = readFileSync(main(), 'utf8')
    edit(
      'speed[i]! * Math.max(0, 1 - drag[i]! * dt)',
      'speed[i]! * Math.max(0, 1 - drag[i]! * dt * 3)',
    )
    expect(((await call('project.reload')) as { ok: boolean }).ok).toBe(true)
    writeFileSync(main(), original)
    const report = (await call('project.reload')) as { ok: boolean; orphaned: string[] }
    expect(report).toMatchObject({ ok: true, orphaned: [] })
  })

  it('rebuilds and swaps star-explorer in under 100 ms', async () => {
    edit(
      'speed[i]! * Math.max(0, 1 - drag[i]! * dt)',
      'speed[i]! * Math.max(0, 1 - drag[i]! * dt * 1)',
    )
    const start = performance.now()
    const report = (await call('project.reload')) as { ok: boolean }
    const ms = performance.now() - start
    expect(report.ok).toBe(true)
    expect(ms).toBeLessThan(budget(100))
    expect(relative(root, project.bundler!.last!.file)).toMatch(
      /^\.shard\/build\/main\.[0-9a-f]{16}\.mjs$/,
    )
  })
})
