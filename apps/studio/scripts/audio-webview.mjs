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
  const readerData = resolve(evidence, 'orca-data')
  await mkdir(resolve(readerData, 'orca'), { recursive: true })
  // Orca 46's diagnostic writer does not flush each line. Its supported customization
  // hook runs while loading settings, after --debug-file has initialized debugFile.
  // Configure only transport buffering; speech generation and log contents stay untouched.
  // https://github.com/GNOME/orca/blob/ORCA_46_1/src/orca/debug.py
  await writeFile(
    resolve(readerData, 'orca/orca-customizations.py'),
    'from orca import debug\n' +
      'assert debug.debugFile is not None, "Orca debug output must initialize before settings"\n' +
      'debug.debugFile.reconfigure(line_buffering=True, write_through=True)\n',
  )
  reader = spawn(
    'orca',
    [
      '--replace',
      '--enable=speech',
      '--debug',
      `--debug-file=${resolve(evidence, 'orca-debug.log')}`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, XDG_DATA_HOME: readerData },
    },
  )
  reader.stdout.on('data', (chunk) => {
    readerOutput += chunk
  })
  reader.stderr.on('data', (chunk) => {
    readerOutput += chunk
  })
  // Verify the actual hook succeeded and AT-SPI is listening before starting the app.
  await until(async () => {
    const debug = await readFile(resolve(evidence, 'orca-debug.log'), 'utf8')
    return (
      debug.includes('orca-customizations.py succeeded.') &&
      debug.includes('Starting Atspi main event loop')
    )
  }, 'Orca line-buffered diagnostic setup')
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
async function stopProcessGroup(child) {
  if (!child?.pid) return
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const waitForExit = (milliseconds) =>
    new Promise((done) => {
      if (exited()) return done(true)
      const onExit = () => {
        clearTimeout(timer)
        done(true)
      }
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        done(false)
      }, milliseconds)
      child.once('exit', onExit)
    })
  signalGroup('SIGTERM')
  await waitForExit(1500)
  // Orca can finish its speech loop but retain worker threads after SIGTERM. Native
  // grandchildren can also retain pipes after the driver exits. Kill only this test's
  // dedicated process group after the grace period, then verify the child exited.
  signalGroup('SIGKILL')
  const stopped = await waitForExit(2000)
  child.stdout.destroy()
  child.stderr.destroy()
  assert.ok(stopped, `Native test process ${child.pid} did not exit during cleanup`)
}
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
async function keys(actions) {
  await request(`/session/${session}/actions`, {
    actions: [{ type: 'key', id: 'editor-keyboard', actions }],
  })
}
const stroke = (value) => [
  { type: 'keyDown', value },
  { type: 'keyUp', value },
]
function nativeKeys(...chords) {
  const result = spawnSync('xdotool', ['key', '--clearmodifiers', '--delay', '250', ...chords], {
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(result.status, 0, `Native keyboard input failed: ${result.stderr}`)
}
async function focusField(path) {
  // Navigate like a user, checking actual ShadowRoot focus instead of relying on
  // WebKitGTK's element-click/sendKeys focus handling for numeric controls.
  let focused
  for (let step = 0; step < 100; step++) {
    focused = await execute(
      `const field=${root}.activeElement;return {path:field?.dataset.path,tag:field?.tagName,label:field?.textContent,value:field?.value}`,
    )
    if (focused.path === path) {
      console.info('Native WebDriver: keyboard focus verified', focused)
      return
    }
    await keys(stroke('\uE004'))
  }
  throw new Error(`Keyboard could not reach ${path}; last focus ${JSON.stringify(focused)}`)
}
async function focusButton(name) {
  for (let step = 0; step < 100; step++) {
    if (
      await execute(
        `return ${root}.activeElement?.tagName==='BUTTON'&&${root}.activeElement.textContent===arguments[0]`,
        [name],
      )
    )
      return
    await keys([
      { type: 'keyDown', value: '\uE008' },
      ...stroke('\uE004'),
      { type: 'keyUp', value: '\uE008' },
    ])
  }
  throw new Error(`Keyboard could not reach ${name}`)
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
  await until(
    () =>
      execute(
        `return [...${root}.querySelectorAll('.wave-lane canvas')].filter(canvas => /waveform, .+ seconds/.test(canvas.getAttribute('aria-label'))).length === 2`,
      ),
    'Project host references produce both decoded waveform lanes',
  )
  console.info('Native WebDriver: both host-resolved waveforms rendered')
  await click(`${root}.querySelector('details[data-group="/layers/0"] > summary')`)
  await focusField('/layers/0/gainDb')
  // Global trusted keys operate on the verified focused field. Commit once on Tab.
  await keys([
    { type: 'keyDown', value: '\uE009' },
    ...stroke('a'),
    { type: 'keyUp', value: '\uE009' },
    ...stroke('-'),
    ...stroke('6'),
    ...stroke('\uE004'),
  ])
  await until(
    () =>
      execute(
        `return ${root}.querySelector('[data-path="/layers/0/gainDb"]')?.value==='-6'&&${root}.querySelector('[role=status]').textContent.includes('Unsaved changes')`,
      ),
    'Keyboard gain edit and dirty state',
  )
  console.info('Native WebDriver: keyboard edit committed; saving')
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
        `return ${root}.querySelector('[role=status]').textContent.includes('Preview request: playing')`,
      ),
    'Native audition',
  )
  await click(`[...${root}.querySelectorAll('[role=tab]')].find(e=>e.textContent==='Diagnostics')`)
  const rendering = await until(async () => {
    await click(
      `[...${root}.querySelectorAll('button')].find(e=>e.textContent==='Refresh preview inspection')`,
    )
    const json = await execute(`return ${root}.querySelector('pre')?.textContent`)
    if (!json) return undefined
    const inspection = JSON.parse(json)
    return inspection.context === 'running' &&
      inspection.voices?.some((voice) => voice.presentation?.state === 'rendering')
      ? inspection
      : undefined
  }, 'Native rendering inspection')
  assert.equal(rendering.context, 'running')
  assert.ok(
    rendering.voices.some((voice) => voice.presentation?.state === 'rendering'),
    'Native Web Audio must report a rendering voice',
  )
  console.info('Native WebDriver: running audio context and rendering voice verified')
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
  await click(`${root}.querySelector('details[data-group="/layers/0"] > summary')`)
  assert.equal(
    await until(
      () => execute(`return ${root}.querySelector('[data-path="/layers/0/gainDb"]')?.value`),
      'Reopened gain field',
    ),
    '-6',
  )
  console.info('Native WebDriver: persisted gain reopened; auditing screen-reader focus')
  await writeFile(
    resolve(evidence, 'studio-webview.json'),
    JSON.stringify(
      {
        ...capabilities,
        edited: name,
        savedGainDb: -6,
        waveformLanes: 2,
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
    await focusField('/layers/0/gainDb')
    const window = spawnSync('xdotool', ['search', '--onlyvisible', '--name', '^Shard Studio$'], {
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(window.status, 0, `Native Studio window unavailable: ${window.stderr}`)
    const windowId = window.stdout.trim().split('\n')[0]
    const focus = spawnSync('xdotool', ['windowfocus', '--sync', windowId], {
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(focus.status, 0, `Native Studio focus failed: ${focus.stderr}`)
    // XTest reaches Orca's global keyboard listener as well as WebKit. Driver-only key
    // dispatch changes DOM focus but can leave Orca treating it as a silent caret update.
    nativeKeys('shift+Tab', 'Tab')
    assert.equal(
      await execute(`return ${root}.activeElement?.dataset.path`),
      '/layers/0/gainDb',
      'OS keyboard must return to the actual Gain field',
    )
    const announced = async (pattern) => {
      const debug = await readFile(resolve(evidence, 'orca-debug.log'), 'utf8')
      return debug.split('\n').some((line) => /SPEECH OUTPUT/i.test(line) && pattern.test(line))
    }
    await until(() => announced(/\bGain\b/i), 'Orca gain-field announcement')
    // Audit a stable, idle toolbar. Actual audio rendering was already verified above;
    // starting another audition here would replace accessibility objects during narration.
    await focusButton('Play')
    nativeKeys('shift+Tab')
    assert.equal(await execute(`return ${root}.activeElement?.textContent`), 'Save')
    await until(() => announced(/\bSave\b/i), 'Orca neighboring save-control announcement')
    nativeKeys('Tab')
    assert.equal(
      await execute(`return ${root}.activeElement?.textContent`),
      'Play',
      'OS keyboard must return to the actual Play control',
    )
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
            'Recorded Orca speech generation during verified native WebDriver focus and XTest keyboard navigation; diagnostic output is line-buffered',
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
  console.info('Native WebDriver: stopping owned driver and screen-reader processes')
  await Promise.all([stopProcessGroup(driver), stopProcessGroup(reader)])
  await writeFile(resolve(evidence, 'orca-process.log'), readerOutput)
  await writeFile(resolve(evidence, 'studio-driver.log'), logs)
  console.info('Native WebDriver: cleanup complete')
}
