import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioBuses, audioPlugin } from '@aethervtt/shard-audio'
import { t } from '@aethervtt/shard-core'
import {
  addActions,
  defineActions,
  injectInput,
  inputPlugin,
  rebindAction,
} from '@aethervtt/shard-input'
import { createFileStorage, createNodePlatform } from '@aethervtt/shard-platform-node'
import { LightingSettings } from '@aethervtt/shard-render'
import { App, definePlugin } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Locale } from '@aethervtt/shard-text'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, describe, expect, it } from 'vitest'
import { savePlugin } from './plugin'
import { defineSettings, EngineSettings, flushSettings, setSettings } from './settings'

const GameSettings = defineSettings('save-test/Settings', {
  difficulty: t.enum(['normal', 'easy', 'hard']),
  invertY: t.bool(),
  sensitivity: t.f32({ default: 1, min: 0.1, max: 5 }),
})

const Controls = defineActions('save-test/Controls', {
  jump: { kind: 'button', bindings: ['Key:Space'] },
  fire: { kind: 'button', bindings: ['Key:KeyF'] },
})

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shard-settings-'))
  dirs.push(dir)
  return dir
}

/** An app as a game would start: input maps from the project, audio, save, settings from `dir`. */
async function start(dir: string): Promise<App> {
  const app = new App().addPlugin(
    TransformPlugin,
    ScenePlugin,
    inputPlugin(),
    audioPlugin(),
    definePlugin({ name: 'game', build: (a) => void addActions(a.world, Controls) }),
    savePlugin({
      storage: createFileStorage(join(dir, 'user')),
      fs: createNodePlatform({ root: dir, logTo: () => {} }).fs,
    }),
  )
  app.world.initResource(LightingSettings)
  app.world.initResource(Locale)
  await app.init()
  return app
}

function frames(app: App, n: number): void {
  for (let i = 0; i < n; i++) app.update(1 / 60)
}

describe('settings', () => {
  it('persist across a restart: volumes, quality, rebindings, and project settings', async () => {
    const dir = project()
    let app = await start(dir)
    let w = app.world
    expect(w.resource(GameSettings)).toEqual({
      difficulty: 'normal',
      invertY: false,
      sensitivity: 1,
    })
    setSettings(w, EngineSettings, { volumes: { music: 0.25 }, quality: 'low' })
    // Applied now, not at the next write.
    expect(w.resource(AudioBuses).music!.volume).toBe(0.25)
    expect(w.resource(LightingSettings)).toMatchObject({ cascadeMapSize: 1024, shadowMapSize: 512 })
    // Plain writes to the resource persist too, within half a second.
    w.resource(GameSettings).invertY = true
    rebindAction(w, 'save-test/Controls.jump', ['Key:KeyJ'])
    frames(app, 40)
    await flushSettings(w)
    const file = JSON.parse(readFileSync(join(dir, 'user', 'settings.json'), 'utf8'))
    expect(file.values['save-test/Settings']).toMatchObject({ invertY: true })
    expect(file.values['engine/Settings'].bindings).toEqual({
      'save-test/Controls': { jump: ['Key:KeyJ'] },
    })

    // Restart.
    app = await start(dir)
    w = app.world
    expect(w.resource(GameSettings).invertY).toBe(true)
    expect(w.resource(AudioBuses).music!.volume).toBe(0.25)
    expect(w.resource(LightingSettings).cascadeMapSize).toBe(1024)
    const controls = w.resource(Controls.resource)
    expect(controls.bindings('jump')).toEqual(['Key:KeyJ'])
    injectInput(w, { key: 'Space', pressed: true })
    frames(app, 1)
    expect(controls.pressed('jump')).toBe(false)
    injectInput(w, { key: 'Space', pressed: false })
    injectInput(w, { key: 'KeyJ', pressed: true })
    frames(app, 1)
    expect(controls.pressed('jump')).toBe(true)
    // Other actions keep their authored bindings; clearing the rebinding restores them.
    expect(controls.bindings('fire')).toEqual(['Key:KeyF'])
    setSettings(w, EngineSettings, { bindings: {} })
    expect(controls.bindings('jump')).toEqual(['Key:Space'])
  })

  it('start from project defaults in settings/*.json; the player file wins', async () => {
    const dir = project()
    mkdirSync(join(dir, 'settings'))
    writeFileSync(
      join(dir, 'settings', 'defaults.json'),
      JSON.stringify({
        'save-test/Settings': { difficulty: 'hard', sensitivity: 2 },
        'engine/Settings': { volumes: { sfx: 0.5 } },
      }),
    )
    let app = await start(dir)
    expect(app.world.resource(GameSettings)).toMatchObject({ difficulty: 'hard', sensitivity: 2 })
    expect(app.world.resource(AudioBuses).sfx!.volume).toBe(0.5)
    setSettings(app.world, GameSettings, { difficulty: 'easy' })
    await flushSettings(app.world)
    app = await start(dir)
    expect(app.world.resource(GameSettings)).toMatchObject({ difficulty: 'easy', sensitivity: 2 })
    expect(() => setSettings(app.world, GameSettings, { difficulty: 'nightmare' })).toThrow(
      /Expected one of/,
    )
    expect(() => setSettings(app.world, GameSettings, { speed: 1 })).toThrow(/no setting "speed"/)
  })

  it('remember the language the game switches to', async () => {
    const dir = project()
    let app = await start(dir)
    app.world.resource(Locale).current = 'pt-BR'
    frames(app, 1)
    expect(app.world.resource(EngineSettings).locale).toBe('pt-BR')
    await flushSettings(app.world)
    app = await start(dir)
    expect(app.world.resource(Locale).current).toBe('pt-BR')
  })
})
