import { assetServer } from '@aethervtt/shard-assets'
import { playSound } from '@aethervtt/shard-audio'
import {
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { addActions, defineActions, rebindAction } from '@aethervtt/shard-input'
import { Velocity } from '@aethervtt/shard-physics'
import { definePlugin, GlobalRng, Time } from '@aethervtt/shard-runtime'
import {
  describeSave,
  EngineSettings,
  listSaves,
  loadGame,
  readSave,
  SaveConfig,
  type SaveSlotInfo,
  saveGame,
  setSettings,
} from '@aethervtt/shard-save'
import {
  findEntityByPath,
  loadPrefab,
  loadScene,
  registerPrefab,
  type SceneFile,
  spawnPrefab,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { Locale, loadStringTables, setLocale, tr } from '@aethervtt/shard-text'
import { Transform } from '@aethervtt/shard-transform'
import { describeUi, UiChanged, UiClick, UiDefaults, UiSlider, UiText } from '@aethervtt/shard-ui'
import interUrl from '../../../examples/star-explorer/assets/fonts/Inter-Regular.ttf?url'
import laserUrl from '../../../examples/star-explorer/assets/sfx/laser.ogg?url'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

// --- the project: files in memory, saves and settings in IndexedDB ------------------------------

const SCENE_ID = 'scenes/yard.scene.json'
const CRATE = 'prefabs/crate.prefab.json'
const HUD = 'prefabs/yard-hud.prefab.json'
const THEME = 'ui/yard.theme.json'
const FONT = 'assets/fonts/Inter-Regular.ttf'
const THROW_SOUND = 'assets/sfx/throw.ogg'

const STRINGS = {
  en: {
    'yard.title': 'SALVAGE YARD',
    'yard.thrown': { one: '{n} crate thrown', other: '{n} crates thrown' },
    'yard.knocked': { one: '{n} crate cleared', other: '{n} crates cleared' },
    'yard.help': '{throw} throw · arrows move the beacon · X clears the top crate',
    'yard.slots': 'SAVES',
    'yard.slot-empty': 'Slot {slot}: empty',
    'yard.slot-info': 'Slot {slot}: {time} s, {crates} thrown',
    'yard.save': 'Save',
    'yard.load': 'Load',
    'yard.language': 'Português',
    'yard.rebind': 'Throw key: {key}',
    'yard.volume': 'Volume {pct}%',
    'yard.saved': 'Saved slot {slot}: {bytes} bytes, {changed} scene changes',
    'yard.loaded': 'Loaded slot {slot}: {spawned} runtime entities',
    'yard.nothing': 'Slot {slot} is empty',
  },
  'pt-BR': {
    'yard.title': 'FERRO-VELHO',
    'yard.thrown': { one: '{n} caixa arremessada', other: '{n} caixas arremessadas' },
    'yard.knocked': { one: '{n} caixa removida', other: '{n} caixas removidas' },
    'yard.help': '{throw} arremessa · setas movem o sinalizador · X remove a caixa do topo',
    'yard.slots': 'JOGOS SALVOS',
    'yard.slot-empty': 'Espaço {slot}: vazio',
    'yard.slot-info': 'Espaço {slot}: {time} s, {crates} arremessadas',
    'yard.save': 'Salvar',
    'yard.load': 'Carregar',
    'yard.language': 'English',
    'yard.rebind': 'Tecla de arremesso: {key}',
    'yard.volume': 'Volume {pct}%',
    'yard.saved': 'Espaço {slot} salvo: {bytes} bytes, {changed} mudanças na cena',
    'yard.loaded': 'Espaço {slot} carregado: {spawned} entidades criadas em jogo',
    'yard.nothing': 'O espaço {slot} está vazio',
  },
}

const THEME_JSON = {
  font: { path: FONT },
  styles: {
    panel: {
      background: [0.01, 0.012, 0.02, 0.78],
      borderColor: '#d68910',
      borderWidth: 2,
      radius: [10, 10, 10, 10],
    },
    title: { size: 22, color: '#f5b041' },
    body: { size: 17, color: '#eaeded' },
    dim: { size: 15, color: '#aab7b8' },
    button: {
      background: '#784212',
      radius: [8, 8, 8, 8],
      borderColor: '#784212',
      borderWidth: 2,
    },
    'button:hovered': { background: '#a04000' },
    'button:pressed': { background: '#512e14' },
    'button:focused': { borderColor: '#f5b041' },
    label: { size: 16, color: '#ffffff' },
    slider: {
      background: [0.02, 0.02, 0.03, 1],
      radius: [8, 8, 8, 8],
      borderColor: '#5d6d7e',
      borderWidth: 2,
    },
  },
}

// --- the scene ---------------------------------------------------------------------------------

const STACK: [number, number][] = [
  [-1.5, 0],
  [-0.5, 0],
  [0.5, 0],
  [1.5, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [-0.5, 2],
  [0.5, 2],
  [0, 3],
]

const box = (x: number, y: number, z: number) => ({ path: `procedural:box?x=${x}&y=${y}&z=${z}` })

const SCENE: SceneFile = {
  version: 1,
  assets: {
    ground: { type: 'Material', value: { baseColor: '#6e5b46', roughness: 0.95 } },
    wall: { type: 'Material', value: { baseColor: '#4d5656', roughness: 0.9 } },
    stack: { type: 'Material', value: { baseColor: '#1f618d', roughness: 0.6 } },
    beacon: {
      type: 'Material',
      value: { baseColor: '#f5b041', emissive: '#f5b041', emissiveLuminance: 3000 },
    },
  },
  resources: { 'render/AmbientLight': { color: [0.7, 0.8, 1], brightness: 700 } },
  entities: [
    {
      name: 'camera',
      components: {
        'core/Transform': { translation: [0, 4.5, 15], rotationEuler: [-9, 0, 0] },
        'render/Camera3d': { fovY: 52, clearColor: [0.03, 0.035, 0.05, 1] },
        'render/Exposure': { ev100: 12.3 },
        'audio/AudioListener': {},
      },
    },
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight', shadows: true },
        'core/Transform': { rotationEuler: [-55, 35, 0] },
      },
    },
    {
      name: 'ground',
      components: {
        'core/Transform': { translation: [0, -0.5, 0] },
        'physics/RigidBody': { kind: 'fixed' },
        'physics/Collider': { shape: 'cuboid', halfExtents: [14, 0.5, 9] },
        'render/Mesh3d': { mesh: box(28, 1, 18) },
        'render/MeshMaterial': { material: { path: '#ground' } },
      },
    },
    {
      name: 'wall',
      components: {
        'core/Transform': { translation: [0, 2, -6] },
        'physics/RigidBody': { kind: 'fixed' },
        'physics/Collider': { shape: 'cuboid', halfExtents: [10, 2, 0.4] },
        'render/Mesh3d': { mesh: box(20, 4, 0.8) },
        'render/MeshMaterial': { material: { path: '#wall' } },
      },
    },
    ...STACK.map(([x, level], i) => ({
      name: `stack-${i}`,
      components: {
        'core/Transform': { translation: [x, 0.5 + level, -3] },
        'physics/RigidBody': { kind: 'dynamic' },
        'physics/Collider': { shape: 'cuboid', halfExtents: [0.48, 0.48, 0.48], friction: 0.7 },
        'physics/Velocity': {},
        'render/Mesh3d': { mesh: box(0.96, 0.96, 0.96) },
        'render/MeshMaterial': { material: { path: '#stack' } },
      },
    })),
    {
      name: 'beacon',
      components: {
        'core/Transform': { translation: [4, 0.4, 2] },
        'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=0.35' } },
        'render/MeshMaterial': { material: { path: '#beacon' } },
        'render/PointLight': { color: [1, 0.7, 0.3, 1], intensity: 4000, range: 8 },
      },
    },
    {
      // The HUD reloads from the scene file with every load: it isn't part of the game state.
      name: 'hud',
      components: {
        'scene/PrefabInstance': { prefab: { path: HUD } },
        'save/NoSave': {},
      },
    },
  ],
}

const CRATE_PREFAB = {
  version: 1,
  assets: { wood: { type: 'Material', value: { baseColor: '#b9770e', roughness: 0.8 } } },
  root: {
    name: 'crate',
    components: {
      'core/Transform': {},
      'physics/RigidBody': { kind: 'dynamic' },
      'physics/Collider': { shape: 'cuboid', halfExtents: [0.35, 0.35, 0.35], friction: 0.6 },
      'physics/Velocity': {},
      'render/Mesh3d': { mesh: box(0.7, 0.7, 0.7) },
      'render/MeshMaterial': { material: { path: '#wood' } },
    },
  },
}

type Json = Record<string, unknown>
const n = (name: string, components: Json, children: Json[] = []) => ({
  name,
  components,
  children,
})
const label = (name: string, key: string, style: string, params: Json = {}) =>
  n(name, { 'ui/UiNode': { style }, 'ui/UiText': { key, params } })
const button = (name: string, key: string, params: Json = {}) =>
  n(
    name,
    {
      'ui/UiNode': { style: 'button', padding: [6, 12, 6, 12], shrink: 0 },
      'ui/UiStyle': {},
      'ui/UiButton': {},
    },
    [label('label', key, 'label', params)],
  )
const panel = (name: string, width: number, children: Json[]) =>
  n(
    name,
    {
      'ui/UiNode': {
        style: 'panel',
        direction: 'column',
        width,
        padding: [14, 16, 16, 16],
        gap: [0, 8],
      },
      'ui/UiStyle': {},
    },
    children,
  )
const row = (name: string, children: Json[]) =>
  n(name, { 'ui/UiNode': { alignItems: 'center', gap: [8, 0] } }, children)

const SLOTS = [1, 2, 3]

const HUD_PREFAB = {
  version: 1,
  root: n(
    'hud',
    {
      'ui/UiRoot': { scale: 'fit-height', referenceSize: [1280, 720], theme: { path: THEME } },
      'ui/UiNode': { padding: [18, 18, 18, 18], justify: 'space-between', alignItems: 'start' },
    },
    [
      panel('left', 380, [
        label('title', 'yard.title', 'title'),
        label('thrown', 'yard.thrown', 'body', { n: 0 }),
        label('knocked', 'yard.knocked', 'body', { n: 0 }),
        label('help', 'yard.help', 'dim', { throw: 'Space' }),
        n('status', { 'ui/UiNode': { style: 'dim' }, 'ui/UiText': { text: '' } }),
      ]),
      panel('right', 460, [
        label('title', 'yard.slots', 'title'),
        ...SLOTS.map((slot) =>
          row(`slot${slot}`, [
            n('info', {
              'ui/UiNode': { style: 'body', grow: 1 },
              'ui/UiText': { key: 'yard.slot-empty', params: { slot } },
            }),
            button('save', 'yard.save'),
            button('load', 'yard.load'),
          ]),
        ),
        row('settings', [
          button('language', 'yard.language'),
          button('rebind', 'yard.rebind', { key: 'Space' }),
        ]),
        row('volume', [
          label('label', 'yard.volume', 'body', { pct: 100 }),
          n('slider', {
            'ui/UiNode': { style: 'slider', grow: 1, height: 22, padding: [4, 4, 4, 4] },
            'ui/UiStyle': {},
            'ui/UiSlider': { min: 0, max: 1, step: 0.05, value: 1, fill: '#d68910' },
          }),
        ]),
      ]),
    ],
  ),
}

// --- game code ---------------------------------------------------------------------------------

export const YardControls = defineActions('save-demo/Controls', {
  throw: { kind: 'button', bindings: ['Key:Space'] },
  clear: { kind: 'button', bindings: ['Key:KeyX'] },
  move: { kind: 'axis2d', bindings: [{ composite: 'arrows' }] },
})

const StatsSchema = defineSchema('save-demo/Stats', {
  thrown: t.u32({ description: 'Crates thrown.' }),
  cleared: t.u32({ description: 'Stack crates cleared with X.' }),
})

/** Saved with the game (persist): counts survive a load, and reset when an older save loads. */
export const Stats = defineResource<{ thrown: number; cleared: number }>('save-demo/Stats', {
  schema: StatsSchema,
  persist: true,
  init: () => StatsSchema.defaults(),
})

interface YardValue {
  slots: Map<number, SaveSlotInfo>
  status: string
  statusShown: string
  busy: boolean
  lastBytes: number
  lastWarnings: number
}

const Yard = defineResource<YardValue>('save-demo/Yard', {
  init: () => ({
    slots: new Map(),
    status: '',
    statusShown: '',
    busy: false,
    lastBytes: 0,
    lastWarnings: 0,
  }),
})

function at(world: World, path: string): Entity | undefined {
  const e = findEntityByPath(world, path)
  return e !== undefined && world.isAlive(e) ? e : undefined
}

/** Sets a keyed text's params when they changed (a no-op frame costs nothing). */
function params(world: World, path: string, values: Json): void {
  const e = at(world, path)
  if (e === undefined) return
  const now = world.get(e, UiText).params as Json
  if (JSON.stringify(now) !== JSON.stringify(values))
    world.set(e, UiText, { params: values as never })
}

const keyName = (binding: unknown) =>
  typeof binding === 'string' ? binding.replace(/^Key:(Key)?/, '') : '?'

/** Throws crates, moves the beacon, clears stack crates. */
const play = defineSystem({
  name: 'save-demo/play',
  run: (_, world) => {
    if (world.resource(Yard).busy) return
    const controls = world.resource(YardControls.resource)
    const stats = world.resource(Stats)
    if (controls.justPressed('throw')) {
      // A named stream: after a load, the next throws fly exactly as they did after the save.
      const rng = world.resource(GlobalRng).stream('save-demo/throws')
      const crate = spawnPrefab(world, CRATE, {
        transform: { translation: [rng.range(-1, 1), 1.2, 8] },
      })
      world.set(crate, Velocity, {
        linear: [rng.range(-2.5, 2.5), rng.range(3, 5), -rng.range(10, 13)],
        angular: [rng.range(-4, 4), rng.range(-4, 4), rng.range(-4, 4)],
      })
      stats.thrown++
      playSound(world, THROW_SOUND, { bus: 'sfx', volume: 0.4, pitch: rng.range(0.7, 1) })
    }
    if (controls.justPressed('clear')) {
      for (let i = STACK.length - 1; i >= 0; i--) {
        const e = at(world, `stack-${i}`)
        if (e === undefined) continue
        world.despawn(e)
        stats.cleared++
        break
      }
    }
    const [x, y] = controls.axis2d('move')
    const beacon = at(world, 'beacon')
    if (beacon !== undefined && (x !== 0 || y !== 0)) {
      const dt = world.resource(Time).delta
      const p = world.get(beacon, Transform).translation
      world.set(beacon, Transform, {
        translation: [
          Math.max(-12, Math.min(12, p[0]! + x * 6 * dt)),
          p[1]!,
          Math.max(-5, Math.min(8, p[2]! - y * 6 * dt)),
        ],
      })
    }
  },
})

/** Binds the HUD: counts, key names, slot info, volume; handles its buttons. */
const hud = defineSystem({
  name: 'save-demo/hud',
  run: (_, world, ctx) => {
    const yard = world.resource(Yard)
    const stats = world.resource(Stats)
    const settings = world.resource(EngineSettings)
    const controls = world.resource(YardControls.resource)
    const throwKey = keyName(controls.bindings('throw')[0])
    params(world, 'hud/left/thrown', { n: stats.thrown })
    params(world, 'hud/left/knocked', { n: stats.cleared })
    params(world, 'hud/left/help', { throw: throwKey })
    params(world, 'hud/right/settings/rebind/label', { key: throwKey })
    const volume = (settings.volumes as Json).master
    const pct = Math.round((typeof volume === 'number' ? volume : 1) * 100)
    params(world, 'hud/right/volume/label', { pct })
    const slider = at(world, 'hud/right/volume/slider')
    if (slider !== undefined && Math.round(world.get(slider, UiSlider).value * 100) !== pct)
      world.set(slider, UiSlider, { value: pct / 100 })
    for (const slot of SLOTS) {
      const info = yard.slots.get(slot)
      const e = at(world, `hud/right/slot${slot}/info`)
      if (e === undefined) continue
      const meta = (info?.meta ?? {}) as Json
      const key = info ? 'yard.slot-info' : 'yard.slot-empty'
      const values = info
        ? { slot, time: Math.round(info.time?.elapsed ?? 0), crates: (meta.thrown as number) ?? 0 }
        : { slot }
      if (world.get(e, UiText).key !== key) world.set(e, UiText, { key })
      params(world, `hud/right/slot${slot}/info`, values)
    }
    if (yard.status !== yard.statusShown) {
      const e = at(world, 'hud/left/status')
      if (e !== undefined) {
        world.set(e, UiText, { text: yard.status })
        yard.statusShown = yard.status
      }
    }
    for (const click of ctx.reader(UiClick).read()) {
      for (const slot of SLOTS) {
        if (click.entity === at(world, `hud/right/slot${slot}/save`)) void save(world, slot)
        if (click.entity === at(world, `hud/right/slot${slot}/load`)) void load(world, slot)
      }
      if (click.entity === at(world, 'hud/right/settings/language')) toggleLanguage(world)
      if (click.entity === at(world, 'hud/right/settings/rebind')) toggleThrowKey(world)
    }
    for (const change of ctx.reader(UiChanged).read()) {
      if (change.entity !== slider) continue
      const value = world.get(change.entity, UiSlider).value
      setSettings(world, EngineSettings, {
        volumes: { ...(settings.volumes as Json), master: value },
      })
    }
  },
})

function toggleLanguage(world: World): void {
  setLocale(world, world.resource(Locale).current === 'pt-BR' ? 'en' : 'pt-BR')
}

function toggleThrowKey(world: World): void {
  const current = world.resource(YardControls.resource).bindings('throw')[0]
  rebindAction(world, 'save-demo/Controls.throw', [
    current === 'Key:Space' ? 'Key:KeyT' : 'Key:Space',
  ])
}

async function refreshSlots(world: World): Promise<void> {
  const yard = world.resource(Yard)
  yard.slots.clear()
  for (const info of await listSaves(world)) {
    const slot = Number(info.slot.replace('slot', ''))
    if (SLOTS.includes(slot)) yard.slots.set(slot, info)
  }
}

/** The status line: a plain string made with tr(), so it's in the language of the moment. */
function say(world: World, key: string, values: Json): void {
  world.resource(Yard).status = tr(world, key, values)
}

async function save(world: World, slot: number): Promise<void> {
  const yard = world.resource(Yard)
  if (yard.busy) return
  yard.busy = true
  try {
    const file = await saveGame(world, `slot${slot}`, {
      meta: { thrown: world.resource(Stats).thrown },
    })
    const d = describeSave(file)
    yard.lastBytes = d.bytes
    const changed = Object.values(d.scenes).reduce(
      (sum, s) => sum + Object.keys(s.changed).length + s.removed.length,
      0,
    )
    say(world, 'yard.saved', { slot, bytes: d.bytes, changed })
    await refreshSlots(world)
  } finally {
    yard.busy = false
  }
}

async function load(world: World, slot: number): Promise<void> {
  const yard = world.resource(Yard)
  if (yard.busy) return
  if (!yard.slots.has(slot)) {
    say(world, 'yard.nothing', { slot })
    return
  }
  yard.busy = true
  try {
    const report = await loadGame(world, `slot${slot}`)
    yard.lastWarnings = report.warnings.length
    say(world, 'yard.loaded', { slot, spawned: report.spawned })
  } finally {
    yard.busy = false
  }
}

/**
 * Save and load, settings, and localization. A salvage yard: throw crates (a runtime prefab, aimed
 * by a named RNG stream) at a stack of scene crates, move the beacon, clear crates with X. Three
 * slots save the game to IndexedDB: a save holds what changed in the scene (moved and cleared
 * crates, the beacon), the thrown crates, the Stats resource, and the RNG stream, so a load (even
 * after reloading the page) puts every crate back and the next throw flies the same way. The HUD's
 * text is keyed in two string tables; the language, the throw key, and the volume are engine
 * settings, kept in IndexedDB too.
 */
export const saveDemoPlugin = definePlugin({
  name: 'save-demo',
  dependencies: ['ui', 'scene', 'save', 'physics3d', 'audio'],
  build(app) {
    app.world.initResource(Yard)
    app.world.initResource(Stats)
    addActions(app.world, YardControls)
    app.addSystems(Update, play, hud.after(play))
  },
  async ready(app) {
    const world = app.world
    const platform = memoryPlatform()
    await platform.fs.writeBytes(FONT, new Uint8Array(await (await fetch(interUrl)).arrayBuffer()))
    await platform.fs.writeBytes(
      THROW_SOUND,
      new Uint8Array(await (await fetch(laserUrl)).arrayBuffer()),
    )
    await platform.fs.writeText(THEME, JSON.stringify(THEME_JSON))
    for (const [locale, table] of Object.entries(STRINGS))
      await platform.fs.writeText(`locales/${locale}.strings.json`, JSON.stringify(table))
    const server = assetServer(world).configure({
      platform,
      roots: ['assets', 'ui', 'locales'],
    })
    await server.scan()
    await server.load(FONT)
    await loadStringTables(world)
    world.resource(UiDefaults).font = server.resolve(FONT) as never
    registerPrefab(world, CRATE, CRATE_PREFAB)
    registerPrefab(world, HUD, HUD_PREFAB)
    await loadPrefab(world, CRATE)
    // Saved scenes reload from their file: here, the scene above.
    world.resource(SaveConfig).readScene = async (id) =>
      id === SCENE_ID ? structuredClone(SCENE) : undefined
    loadScene(world, structuredClone(SCENE), { id: SCENE_ID })
    await whenSceneReady(world, SCENE_ID)
    await refreshSlots(world)

    const actions: Record<string, () => void> = {
      save1: () => void save(world, 1),
      save2: () => void save(world, 2),
      save3: () => void save(world, 3),
      load1: () => void load(world, 1),
      load2: () => void load(world, 2),
      load3: () => void load(world, 3),
      language: () => toggleLanguage(world),
      rebind: () => toggleThrowKey(world),
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-save]')) {
      b.addEventListener('click', () => actions[b.dataset.save!]?.())
    }
    hudExtras.push((w) => {
      const yard = w.resource(Yard)
      const settings = w.resource(EngineSettings)
      return [
        '',
        `storage  IndexedDB "shard-playground" · ${yard.slots.size} of 3 slots used`,
        `last     save ${yard.lastBytes} B · load warnings ${yard.lastWarnings}`,
        `locale   ${w.resource(Locale).current} · quality ${settings.quality} · bindings ${JSON.stringify(settings.bindings)}`,
        'Space throw · arrows beacon · X clear · reload the page, then Load',
      ]
    })
    Object.assign(globalThis, {
      saveDemo: {
        save: (slot: number) => save(world, slot),
        load: (slot: number) => load(world, slot),
        read: (slot: number) => readSave(world, `slot${slot}`),
        slots: () => listSaves(world),
        crates: () => {
          const out: number[][] = []
          for (let i = 0; i < STACK.length; i++) {
            const e = at(world, `stack-${i}`)
            out.push(
              e === undefined
                ? []
                : [...world.get(e, Transform).translation].map((v) => Math.round(v * 100) / 100),
            )
          }
          return out
        },
        stats: () => ({ ...world.resource(Stats) }),
        ui: () => describeUi(world),
        world,
        locale: () => world.resource(Locale).current,
        settings: () => structuredClone(world.resource(EngineSettings)),
      },
    })
  },
})
