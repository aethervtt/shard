// Actual Tauri/WebKitGTK journey through W3C WebDriver. No browser engine substitution.
// https://v2.tauri.app/develop/tests/webdriver/manual-setup/
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const fixture = resolve(homedir(), 'shard-audio-editor-fixture')
const evidence = resolve(process.env.SHARD_AUDIO_EDITOR_EVIDENCE ?? 'audio-editor-evidence')
await mkdir(evidence, { recursive: true })
await cp(resolve(repository, 'examples/audio-lab'), fixture, {
  recursive: true,
  // Native authoring reads project sources; workspace install links and generated caches
  // are not part of this standalone fixture or its authorized asset catalog.
  filter: (source) =>
    !source.split(sep).some((part) => part === 'node_modules' || part === '.shard'),
})
let reader
let readerOutput = ''
if (process.env.SHARD_SCREEN_READER === '1') {
  // Orca's documented debug mode records actual speech generation and AT-SPI events.
  // https://orca.gnome.org/debugging — this is separate from an ARIA snapshot.
  const settings = spawn('gsettings', [
    'set',
    'org.gnome.desktop.interface',
    'toolkit-accessibility',
    'true',
  ])
  await new Promise((done) => settings.on('exit', done))
  reader = spawn(
    'orca',
    [
      '--replace',
      '--enable=speech',
      '--debug',
      `--debug-file=${resolve(evidence, 'orca-debug.log')}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  reader.stdout.on('data', (chunk) => {
    readerOutput += chunk
  })
  reader.stderr.on('data', (chunk) => {
    readerOutput += chunk
  })
  // Allow the AT-SPI registry and speech dispatcher to initialize before the native window.
  await new Promise((done) => setTimeout(done, 1500))
}
const driver = spawn('tauri-driver', [], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let logs = ''
driver.stdout.on('data', (chunk) => {
  logs += chunk
  process.stdout.write(chunk)
})
driver.stderr.on('data', (chunk) => {
  logs += chunk
  process.stderr.write(chunk)
})
let session
async function request(path, body, method = 'POST') {
  if (path === '/session') console.info('Native WebDriver: creating the Studio session')
  const response = await fetch(`http://127.0.0.1:4444${path}`, {
    signal: AbortSignal.timeout(60000),
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result))
  return result.value
}
async function until(action, message) {
  const start = Date.now()
  let error
  while (Date.now() - start < 60000) {
    try {
      const value = await action()
      if (value) return value
    } catch (cause) {
      error = cause
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error(`${message}: ${String(error ?? 'timed out')}`)
}
const execute = (script, args = []) => request(`/session/${session}/execute/sync`, { script, args })
const root = 'document.querySelector("[data-audio-editor]").shadowRoot'
async function element(expression) {
  const result = await until(
    () =>
      execute(
        `const element=${expression};element?.scrollIntoView({block:'center',inline:'nearest'});return element`,
      ),
    expression,
  )
  return result['element-6066-11e4-a52e-4f735466cecf']
}
async function click(expression) {
  // Like a browser locator, reacquire when an asynchronous catalog refresh replaces the
  // control between lookup and native interaction. Do not replace the trusted click with JS.
  await until(async () => {
    const id = await element(
      `(()=>{const element=${expression};return element&&!element.disabled?element:null})()`,
    )
    try {
      await request(`/session/${session}/element/${id}/click`, {})
      return true
    } catch (error) {
      if (String(error).includes('stale element reference')) return false
      throw error
    }
  }, `Click ${expression}`)
}
try {
  console.info('Native WebDriver: waiting for driver readiness')
  await until(() => request('/status', undefined, 'GET'), 'Driver startup')
  const created = await request('/session', {
    capabilities: {
      alwaysMatch: {
        'tauri:options': { application: resolve(repository, 'target/debug/shard-studio') },
      },
    },
  })
  session = created.sessionId
  console.info('Native WebDriver: Studio session created', session)
  await until(
    () => execute('return !!document.querySelector("input[name=project]")'),
    'Studio opener',
  )
  await execute('document.querySelector("input[name=project]").value = arguments[0]', [fixture])
  await click('document.querySelector("form button")')
  console.info('Native WebDriver: opening the fixture project')
  await until(
    () =>
      execute(`return ${root}.querySelector('.title').textContent.includes('.audio-event.json')`),
    'Project event loaded',
  )
  const name = await execute(`return ${root}.querySelector('.title').textContent`)
  console.info('Native WebDriver: editing', name)
  await click(`[...${root}.querySelectorAll('[role=tab]')].find(e=>e.textContent==='Event')`)
  await click(`${root}.querySelector('details[data-group="/layers/0"] > summary')`)
  await click(`${root}.querySelector('[data-path="/layers/0/gainDb"]')`)
  // Clear dispatches change immediately in WebKitGTK, replacing the field before sendKeys.
  // Real keyboard replacement commits once on Tab and never retains a stale element ID.
  await request(`/session/${session}/actions`, {
    actions: [
      {
        type: 'key',
        id: 'editor-keyboard',
        actions: [
          { type: 'keyDown', value: '\uE009' },
          { type: 'keyDown', value: 'a' },
          { type: 'keyUp', value: 'a' },
          { type: 'keyUp', value: '\uE009' },
          { type: 'keyDown', value: '-' },
          { type: 'keyUp', value: '-' },
          { type: 'keyDown', value: '6' },
          { type: 'keyUp', value: '6' },
          { type: 'keyDown', value: '\uE004' },
          { type: 'keyUp', value: '\uE004' },
        ],
      },
    ],
  })
  await click(`[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Save')`)
  await until(
    () => execute(`return ${root}.querySelector('[role=status]').textContent.startsWith('Saved')`),
    'Durable save',
  )
  const file = resolve(fixture, 'data/audio', name)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).layers[0].gainDb, -6)
  console.info('Native WebDriver: saved source verified; starting audition')
  await click(`[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Play')`)
  await until(
    () =>
      execute(
        `return ${root}.querySelector('[role=status]').textContent.includes('Preview: playing')`,
      ),
    'Native audition',
  )
  await click(`[...${root}.querySelectorAll('[role=tab]')].find(e=>e.textContent==='Diagnostics')`)
  await click(
    `[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Refresh preview inspection')`,
  )
  const rendering = await until(async () => {
    const json = await execute(`return ${root}.querySelector('pre')?.textContent`)
    return json ? JSON.parse(json) : undefined
  }, 'Native rendering inspection')
  assert.equal(rendering.context, 'running')
  assert.ok(
    rendering.voices.some((voice) => voice.presentation?.state === 'rendering'),
    'Native Web Audio must report a rendering voice',
  )
  const capabilities = await execute(
    'return {userAgent:navigator.userAgent,audioContext:typeof AudioContext!=="undefined",offlineAudioContext:typeof OfflineAudioContext!=="undefined",studioWebview:true}',
  )
  const screenshot = await request(`/session/${session}/screenshot`, undefined, 'GET')
  await writeFile(resolve(evidence, 'studio-webview.png'), Buffer.from(screenshot, 'base64'))
  await click(`[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Stop')`)
  // Reload the native window and reopen from platform files, not the first session's cache.
  await request(`/session/${session}/refresh`, {})
  await until(
    () => execute('return !!document.querySelector("input[name=project]")'),
    'Reload opener',
  )
  await execute('document.querySelector("input[name=project]").value = arguments[0]', [fixture])
  await click('document.querySelector("form button")')
  await until(
    () => execute(`return ${root}.querySelector('.title').textContent===arguments[0]`, [name]),
    'Reopened document',
  )
  await click(`[...${root}.querySelectorAll('[role=tab]')].find(e=>e.textContent==='Event')`)
  assert.equal(
    await execute(`return ${root}.querySelector('[data-path="/layers/0/gainDb"]').value`),
    '-6',
  )
  await writeFile(
    resolve(evidence, 'studio-webview.json'),
    JSON.stringify(
      {
        ...capabilities,
        edited: name,
        savedGainDb: -6,
        reopened: true,
        audition: true,
        platformFiles: true,
        rendering,
      },
      null,
      2,
    ),
  )
  if (reader) {
    // Give Orca observable, settled focus targets after the persistence journey. Wait for
    // actual speech generation, not a fixed delay or an ARIA-only proxy for narration.
    await click(`${root}.querySelector('details[data-group="/layers/0"] > summary')`)
    await click(`${root}.querySelector('[data-path="/layers/0/gainDb"]')`)
    const announced = async (pattern) => {
      const debug = await readFile(resolve(evidence, 'orca-debug.log'), 'utf8')
      return debug.split('\n').some((line) => /SPEECH OUTPUT/i.test(line) && pattern.test(line))
    }
    await until(() => announced(/\bGain\b/i), 'Orca gain-field announcement')
    await click(`[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Play')`)
    await until(() => announced(/\bPlay\b/i), 'Orca playback-control announcement')
    const debug = await readFile(resolve(evidence, 'orca-debug.log'), 'utf8')
    const announcements = debug.split('\n').filter((line) => /SPEECH OUTPUT/i.test(line))
    const editorAnnouncements = announcements.filter((line) =>
      /\b(Event|Gain|Play|Save)\b/i.test(line),
    )
    const coverage = {
      field: editorAnnouncements.some((line) => /\bGain\b/i.test(line)),
      action: editorAnnouncements.some((line) => /\b(Play|Save|Event)\b/i.test(line)),
    }
    await writeFile(
      resolve(evidence, 'screen-reader-audit.json'),
      JSON.stringify(
        {
          screenReader: 'Orca',
          nativeHost: 'WebKitGTK / Tauri',
          method:
            'Recorded speech generation during real WebDriver focus, typing and button interactions',
          utterances: editorAnnouncements,
          coverage,
          totalSpeechLines: announcements.length,
          limitations:
            'Automated focus journey; no claim of human listening or comprehensive accessibility certification.',
        },
        null,
        2,
      ),
    )
    assert.ok(
      coverage.field && coverage.action,
      'Orca must announce an editor field and action; inspect orca-debug.log',
    )
    await click(`[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Stop')`)
  }
} finally {
  // Capture the X server independently when WebDriver itself is stalled.
  spawnSync('scrot', [resolve(evidence, 'studio-desktop-state.png')], { timeout: 10000 })
  if (session) {
    await request(`/session/${session}/screenshot`, undefined, 'GET')
      .then((shot) =>
        writeFile(resolve(evidence, 'studio-final-state.png'), Buffer.from(shot, 'base64')),
      )
      .catch(() => {})
    await request(`/session/${session}`, undefined, 'DELETE').catch(() => {})
  }
  for (const child of [driver, reader]) {
    if (!child) continue
    // Native driver/browser grandchildren can retain pipes after their parent exits.
    // These dedicated process groups contain only this test's owned processes.
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    child.stdout.destroy()
    child.stderr.destroy()
  }
  await writeFile(resolve(evidence, 'orca-process.log'), readerOutput)
  await writeFile(resolve(evidence, 'studio-driver.log'), logs)
}
