import { defineSystem, findResource, t, Update, type World } from '@shard/core'
import { App } from '@shard/runtime'
import { describe, expect, it } from 'vitest'
import { defineProject, type ProjectDef } from './define'
import { createProjectReloader } from './reload'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

/**
 * A stand-in for a project bundle: calling it defines the project's types (inside the reloader's
 * redefinition scope) and returns the plugin. `version` picks the code variant.
 */
function bundle(
  ns: string,
  variant: {
    step?: number
    extraField?: boolean
    labelKind?: 'string' | 'f32'
    throwInBuild?: boolean
    dropTag?: boolean
  },
) {
  return async () => {
    const project: ProjectDef = defineProject({
      name: ns,
      build(app) {
        if (variant.throwInBuild) throw new Error('build exploded')
        app.addSystems(Update, move)
        app.world.initResource(Score)
      },
    })
    const Mover = project.component('Mover', {
      x: t.f32(),
      ...(variant.extraField ? { speed: t.f32({ default: 2 }) } : {}),
      label: variant.labelKind === 'f32' ? t.f32() : t.string(),
    })
    if (!variant.dropTag) project.tag('Marked')
    const Score = project.resource<{ value: number }>('Score', { init: () => ({ value: 0 }) })
    const step = variant.step ?? 1
    const move = defineSystem({
      name: `${ns}/move`,
      setup: (world: World) => ({ q: world.query({ with: [Mover] }) }),
      run: ({ q }) => {
        for (const table of q.tables) {
          const x = table.column(Mover, 'x' as never) as unknown as Float32Array
          for (let i = 0; i < table.count; i++) x[i] = x[i]! + step
        }
      },
    })
    return { default: project, Mover }
  }
}

async function start(ns: string, count = 3) {
  const first = await bundle(ns, {})()
  const app = new App().addPlugin(first.default)
  await app.init()
  const entities = []
  for (let i = 0; i < count; i++) {
    entities.push(app.world.spawn([first.Mover, { x: i * 10, label: `m${i}` }]))
  }
  const reloader = createProjectReloader(app, { namespace: ns, current: first.default })
  return { app, entities, Mover: first.Mover, reloader }
}

const x = (app: App, e: number) => {
  const table = app.world.entityTable(e)
  const def = table.components.find((c) => c.name.endsWith('/Mover'))!
  return (table.readComponent(def, app.world.entityRow(e)) as { x: number }).x
}

describe('project hot reload', () => {
  it('a changed system body takes effect next frame; entities and resources are kept', async () => {
    const { app, entities, reloader } = await start('hr-a')
    app.update(1 / 60)
    expect(x(app, entities[1]!)).toBe(11)
    const score = app.world.resource(findResource('hr-a/Score')!)
    const report = await reloader.reload(bundle('hr-a', { step: 5 }))
    expect(report).toMatchObject({ ok: true, migrated: [], systems: { added: [], removed: [] } })
    app.update(1 / 60)
    expect(x(app, entities[1]!)).toBe(16)
    expect(app.world.entityCount).toBe(3)
    expect(app.world.resource(findResource('hr-a/Score')!)).toBe(score)
  })

  it('adding a field migrates every instance, keeping other values, fast', async () => {
    const { app, entities, reloader } = await start('hr-b', 100_000)
    const report = await reloader.reload(bundle('hr-b', { extraField: true }))
    expect(report.ok).toBe(true)
    expect(report.migrated).toEqual(['hr-b/Mover'])
    expect(report.ms).toBeLessThan(budget(300))
    const e = entities[4321]!
    const table = app.world.entityTable(e)
    const def = table.components.find((c) => c.name === 'hr-b/Mover')!
    expect(table.readComponent(def, app.world.entityRow(e))).toEqual({
      x: 43210,
      speed: 2,
      label: 'm4321',
    })
    app.update(1 / 60)
    expect(x(app, e)).toBe(43211)
  }, 30_000)

  it('failures leave the old code running: bad module, throwing build, impossible migration', async () => {
    const { app, entities, reloader } = await start('hr-c')

    const syntax = await reloader.reload(async () => {
      throw Object.assign(new SyntaxError('Unexpected token'), { source: 'scripts/main.ts:3:9' })
    })
    expect(syntax).toMatchObject({ ok: false, error: { source: 'scripts/main.ts:3:9' } })

    const build = await reloader.reload(bundle('hr-c', { step: 9, throwInBuild: true }))
    expect(build).toMatchObject({ ok: false, error: { message: 'build exploded' } })

    const migrate = await reloader.reload(bundle('hr-c', { step: 9, labelKind: 'f32' }))
    expect(migrate).toMatchObject({
      ok: false,
      error: { code: 'project/migration-failed', path: '/label' },
    })

    app.update(1 / 60)
    expect(x(app, entities[2]!)).toBe(21) // still the original step of 1
    // And a good reload still works afterwards.
    expect((await reloader.reload(bundle('hr-c', { step: 3 }))).ok).toBe(true)
    app.update(1 / 60)
    expect(x(app, entities[2]!)).toBe(24)
  })

  it('reports components the new code no longer defines, and keeps them', async () => {
    const { reloader } = await start('hr-d')
    const report = await reloader.reload(bundle('hr-d', { dropTag: true }))
    expect(report.ok).toBe(true)
    expect(report.orphaned).toEqual(['hr-d/Marked'])
  })
})
