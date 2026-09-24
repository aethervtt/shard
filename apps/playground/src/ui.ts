import { assetServer } from '@shard/assets'
import {
  ChildOf,
  defineResource,
  defineSystem,
  type Entity,
  quat,
  Update,
  type World,
} from '@shard/core'
import { sphere } from '@shard/mesh'
import {
  AmbientLight,
  Camera3d,
  DebugOverlays,
  DirectionalLight,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  setOverlays,
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import {
  findEntityByPath,
  loadScene,
  registerPrefab,
  type SceneEntity,
  type SceneFile,
  whenSceneReady,
} from '@shard/scene'
import { Texture, Textures } from '@shard/texture'
import { lookAt, Transform } from '@shard/transform'
import {
  describeUi,
  focusUi,
  UiChanged,
  UiClick,
  UiDefaults,
  UiImage,
  UiLayout,
  UiNode,
  UiPointer,
  UiSlider,
  UiState,
  UiText,
  UiTextInput,
  UiToggle,
} from '@shard/ui'
import interUrl from '../../../examples/star-explorer/assets/fonts/Inter-Regular.ttf?url'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

// --- the theme: a file in an in-memory project, imported and hot reloaded like any asset -------

const THEME = 'ui/hud.theme.json'
const FONT = 'assets/fonts/Inter-Regular.ttf'

const THEMES = {
  night: {
    font: { path: FONT },
    styles: {
      panel: {
        background: [0.006, 0.012, 0.028, 0.82],
        borderColor: '#2e86c1',
        borderWidth: 2,
        radius: [14, 14, 14, 14],
      },
      title: { size: 22, color: '#f5cb5c' },
      body: { size: 18, color: '#d6eaf8' },
      dim: { size: 16, color: '#7f8c8d' },
      bar: { background: [0.02, 0.03, 0.05, 1], radius: [7, 7, 7, 7] },
      fill: { background: '#e67e22', radius: [7, 7, 7, 7] },
      slot: { size: 16, color: '#ffffff' },
      'slot:hovered': { color: '#f5cb5c' },
      'slot:focused': { color: '#f5cb5c' },
      button: {
        background: '#1b4f72',
        radius: [10, 10, 10, 10],
        borderColor: '#1b4f72',
        borderWidth: 2,
      },
      'button:hovered': { background: '#2874a6' },
      'button:pressed': { background: '#154360' },
      'button:focused': { borderColor: '#f5cb5c' },
      'button:on': { background: '#b9770e', borderColor: '#b9770e' },
      field: {
        background: [0.02, 0.03, 0.05, 1],
        radius: [8, 8, 8, 8],
        borderColor: '#34495e',
        borderWidth: 2,
        size: 18,
      },
      'field:focused': { borderColor: '#f5cb5c' },
      slider: {
        background: [0.02, 0.03, 0.05, 1],
        radius: [8, 8, 8, 8],
        borderColor: '#34495e',
        borderWidth: 2,
      },
      'slider:focused': { borderColor: '#f5cb5c' },
      marker: {
        background: [0, 0, 0, 0.35],
        borderColor: '#f5cb5c',
        borderWidth: 2,
        radius: [12, 12, 12, 12],
      },
      'marker-text': { size: 16, color: '#f5cb5c' },
    },
  },
  day: {
    font: { path: FONT },
    styles: {
      panel: {
        background: [0.85, 0.88, 0.92, 0.9],
        borderColor: '#ffffff',
        borderWidth: 3,
        radius: [4, 4, 4, 4],
      },
      title: { size: 22, color: '#922b21' },
      body: { size: 18, color: '#17202a' },
      dim: { size: 16, color: '#566573' },
      bar: { background: [0.3, 0.3, 0.32, 1], radius: [2, 2, 2, 2] },
      fill: { background: '#27ae60', radius: [2, 2, 2, 2] },
      slot: { size: 16, color: '#ffffff' },
      'slot:hovered': { color: '#abebc6' },
      'slot:focused': { color: '#abebc6' },
      button: {
        background: '#566573',
        radius: [2, 2, 2, 2],
        borderColor: '#566573',
        borderWidth: 2,
      },
      'button:hovered': { background: '#808b96' },
      'button:pressed': { background: '#2c3e50' },
      'button:focused': { borderColor: '#922b21' },
      'button:on': { background: '#27ae60', borderColor: '#27ae60' },
      field: {
        background: '#ffffff',
        radius: [2, 2, 2, 2],
        borderColor: '#566573',
        borderWidth: 2,
        size: 18,
        color: '#17202a',
      },
      'field:focused': { borderColor: '#922b21' },
      slider: {
        background: '#ffffff',
        radius: [2, 2, 2, 2],
        borderColor: '#566573',
        borderWidth: 2,
      },
      'slider:focused': { borderColor: '#922b21' },
      marker: {
        background: [1, 1, 1, 0.5],
        borderColor: '#ffffff',
        borderWidth: 2,
        radius: [2, 2, 2, 2],
      },
      'marker-text': { size: 16, color: '#ffffff' },
    },
  },
}

// --- the HUD prefab ------------------------------------------------------------------------------

type Json = Record<string, unknown>
const n = (name: string, components: Json, children: Json[] = []) => ({
  name,
  components,
  children,
})
const text = (name: string, value: string, style: string, extra: Json = {}) =>
  n(name, { 'ui/UiNode': { style }, 'ui/UiText': { text: value, ...extra } })
const panel = (name: string, node: Json, children: Json[]) =>
  n(
    name,
    {
      'ui/UiNode': {
        style: 'panel',
        direction: 'column',
        padding: [16, 18, 18, 18],
        gap: [0, 10],
        ...node,
      },
      'ui/UiStyle': {},
    },
    children,
  )
const row = (name: string, children: Json[], node: Json = {}) =>
  n(name, { 'ui/UiNode': { alignItems: 'center', gap: [12, 0], ...node } }, children)

const CARGO = [
  'Fe 12',
  'Cu 4',
  'C 40',
  'Si 7',
  'Au 1',
  'He 22',
  'Na 9',
  'Ti 3',
  'Ni 15',
  'O 60',
  'H 99',
  '—',
]

const HUD = {
  version: 1,
  root: n(
    'hud',
    {
      'ui/UiRoot': { scale: 'fit-height', referenceSize: [1920, 1080], theme: { path: THEME } },
      'ui/UiNode': { padding: [32, 32, 32, 32], justify: 'space-between' },
    },
    [
      n('left', { 'ui/UiNode': { direction: 'column', width: 440, gap: [0, 16] } }, [
        panel('scanner', {}, [
          text('title', 'SCANNER', 'title'),
          text('target', 'No target', 'body'),
          text('about', '', 'dim'),
          text('fuel-label', 'Fuel', 'dim'),
          n('fuel', { 'ui/UiNode': { style: 'bar', height: 14 }, 'ui/UiStyle': {} }, [
            n('fill', { 'ui/UiNode': { style: 'fill', width: '100%' }, 'ui/UiStyle': {} }),
          ]),
        ]),
        panel('log', { grow: 1, shrink: 1, minHeight: 120 }, [
          text('title', 'LOG', 'title'),
          n(
            'entries',
            {
              'ui/UiNode': {
                direction: 'column',
                overflow: 'scroll',
                grow: 1,
                basis: 0,
                gap: [0, 4],
              },
            },
            [],
          ),
        ]),
      ]),
      n(
        'right',
        { 'ui/UiNode': { direction: 'column', width: 470, gap: [0, 16], alignItems: 'stretch' } },
        [
          panel('cargo', {}, [
            text('title', 'CARGO', 'title'),
            n(
              'grid',
              { 'ui/UiNode': { wrap: true, gap: [10, 10] } },
              CARGO.map((label, i) =>
                n(
                  `slot${i}`,
                  {
                    'ui/UiNode': {
                      style: 'slot',
                      width: 98,
                      height: 72,
                      justify: 'center',
                      alignItems: 'center',
                    },
                    'ui/UiImage': { slice: [10, 10, 10, 10] },
                    'ui/UiButton': {},
                  },
                  [text('label', label, 'slot')],
                ),
              ),
            ),
            text('selected', 'Click a slot, or Tab and the arrow keys.', 'dim'),
          ]),
          panel('settings', {}, [
            text('title', 'SETTINGS', 'title'),
            row('markers', [
              n(
                'toggle',
                {
                  'ui/UiNode': { style: 'button', padding: [8, 16, 8, 16] },
                  'ui/UiStyle': {},
                  'ui/UiToggle': { on: true },
                },
                [text('label', 'Markers on', 'body', { color: '#ffffff' })],
              ),
              n(
                'theme',
                {
                  'ui/UiNode': { style: 'button', padding: [8, 16, 8, 16] },
                  'ui/UiStyle': {},
                  'ui/UiButton': {},
                },
                [text('label', 'Day theme', 'body', { color: '#ffffff' })],
              ),
            ]),
            row('orbit', [
              text('label', 'Orbit', 'body', {}),
              n('slider', {
                'ui/UiNode': { style: 'slider', grow: 1, height: 26, padding: [4, 4, 4, 4] },
                'ui/UiStyle': {},
                'ui/UiSlider': { min: 0, max: 1, value: 0.3, fill: '#2e86c1' },
              }),
            ]),
            row('name', [
              text('label', 'Ship', 'body'),
              n('field', {
                'ui/UiNode': { style: 'field', grow: 1, padding: [6, 10, 6, 10] },
                'ui/UiStyle': {},
                'ui/UiText': { wrap: false },
                'ui/UiTextInput': {
                  value: 'Kestrel',
                  placeholder: 'Name your ship',
                  maxLength: 24,
                },
              }),
            ]),
          ]),
        ],
      ),
      n(
        'callsign',
        { 'ui/UiNode': { position: 'absolute', bottom: 28, left: 0, right: 0, justify: 'center' } },
        [text('text', 'KESTREL', 'title', { size: 30 })],
      ),
    ],
  ),
}

const PLANETS = [
  {
    name: 'ares',
    radius: 1.6,
    orbit: 9,
    speed: 0.35,
    color: [0.75, 0.35, 0.22],
    about: 'Iron oxide plains under thin air.',
  },
  {
    name: 'thule',
    radius: 2.4,
    orbit: 15,
    speed: 0.22,
    color: [0.35, 0.55, 0.85],
    about: 'Ice shelf over a salt ocean.',
  },
  {
    name: 'vesta',
    radius: 1.1,
    orbit: 21,
    speed: 0.16,
    color: [0.7, 0.68, 0.6],
    about: 'Cratered rock, rich in nickel.',
  },
  {
    name: 'nyx',
    radius: 3.2,
    orbit: 29,
    speed: 0.1,
    color: [0.45, 0.3, 0.6],
    about: 'Gas giant with violet storms.',
  },
] as const

const marker = (p: (typeof PLANETS)[number]): SceneEntity => ({
  name: `marker-${p.name}`,
  components: {
    'ui/UiNode': {
      style: 'marker',
      direction: 'column',
      alignItems: 'center',
      padding: [6, 12, 6, 12],
    },
    'ui/UiStyle': {},
    'ui/UiAnchor': {
      target: `planets/${p.name}`,
      offset: [0, p.radius + 0.6, 0],
      pivot: [0.5, 1],
      clamp: true,
      margin: 48,
      scaleDistance: 30,
      minScale: 0.7,
      maxScale: 1.25,
    },
  },
  children: [
    {
      name: 'name',
      components: {
        'ui/UiNode': { style: 'marker-text' },
        'ui/UiText': { text: p.name.toUpperCase() },
      },
    },
    {
      name: 'distance',
      components: { 'ui/UiNode': { style: 'marker-text' }, 'ui/UiText': { text: '' } },
    },
    {
      name: 'arrow',
      components: {
        'ui/UiNode': { position: 'absolute', width: 18, height: 6 },
        'ui/UiStyle': { background: '#f5cb5c', radius: [3, 3, 3, 3] },
        'ui/UiAnchorArrow': {},
      },
    },
  ],
})

const SCENE: SceneFile = {
  version: 1,
  entities: [
    { name: 'camera', components: { 'core/Transform': { translation: [0, 14, 42] } } },
    {
      name: 'planets',
      components: { 'core/Transform': {} },
      children: PLANETS.map((p) => ({
        name: p.name,
        components: { 'core/Transform': { translation: [p.orbit, 0, 0] } },
      })),
    },
    {
      name: 'hud',
      components: { 'scene/PrefabInstance': { prefab: { path: 'prefabs/hud.prefab.json' } } },
      children: PLANETS.map(marker),
    },
  ],
}

// --- systems -------------------------------------------------------------------------------------

interface DemoValue {
  planets: Entity[]
  camera: Entity | undefined
  angle: number
  orbit: number
  fuel: number
  selected: number
  log: string[]
  logDirty: boolean
  theme: 'night' | 'day'
  entities: Map<string, Entity>
}

const Demo = defineResource<DemoValue>('ui-demo/Demo', {
  init: () => ({
    planets: [],
    camera: undefined,
    angle: 0,
    orbit: 0,
    fuel: 1,
    selected: -1,
    log: [],
    logDirty: false,
    theme: 'night',
    entities: new Map(),
  }),
})

function at(world: World, path: string): Entity {
  const d = world.resource(Demo)
  let e = d.entities.get(path)
  if (e === undefined || !world.isAlive(e)) {
    e = findEntityByPath(world, path)!
    d.entities.set(path, e)
  }
  return e
}

function setText(world: World, path: string, value: string): void {
  const e = at(world, path)
  if (world.get(e, UiText).text !== value) world.set(e, UiText, { text: value })
}

/** Planets orbit the star; the camera circles at the slider's speed. */
const orbit = defineSystem({
  name: 'ui-demo/orbit',
  run: (_, world) => {
    const d = world.resource(Demo)
    if (!d.camera) return
    const dt = world.resource(Time).delta
    d.orbit += dt
    PLANETS.forEach((p, i) => {
      const a = d.orbit * p.speed + i * 1.7
      world.set(d.planets[i]!, Transform, {
        translation: [Math.cos(a) * p.orbit, 0, Math.sin(a) * p.orbit],
      })
    })
    const speed = world.get(at(world, 'hud/right/settings/orbit/slider'), UiSlider).value
    d.angle += dt * speed * 0.6
    const eye: [number, number, number] = [
      Math.sin(d.angle) * 42,
      12 + 4 * Math.sin(d.angle * 0.7),
      Math.cos(d.angle) * 42,
    ]
    world.set(d.camera, Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) })
  },
})

function log(world: World, line: string): void {
  const d = world.resource(Demo)
  const time = world.resource(Time).elapsed.toFixed(1).padStart(5)
  d.log.push(`${time}s  ${line}`)
  if (d.log.length > 40) d.log.shift()
  d.logDirty = true
}

/** Binds game state to the HUD: target, distances, fuel, the ship name, cargo, and the log. */
const bind = defineSystem({
  name: 'ui-demo/bind',
  run: (_, world, ctx) => {
    const d = world.resource(Demo)
    if (!d.camera) return
    const dt = world.resource(Time).delta
    // The nearest planet in front is the target.
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    PLANETS.forEach((p, i) => {
      const layout = world.get(at(world, `hud/marker-${p.name}`), UiLayout)
      const distance = layout.distance
      setText(world, `hud/marker-${p.name}/distance`, `${distance.toFixed(0)} m`)
      if (layout.anchor === 'on-screen' && distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    })
    const target = PLANETS[best]
    setText(
      world,
      'hud/left/scanner/target',
      target ? `${target.name.toUpperCase()} · ${bestDistance.toFixed(0)} m` : 'No target',
    )
    setText(
      world,
      'hud/left/scanner/about',
      target ? target.about : 'Point the camera at a planet.',
    )
    // Fuel drains and refills.
    d.fuel -= dt * 0.04
    if (d.fuel < 0.05) d.fuel = 1
    const pct = Math.round(d.fuel * 100)
    const fill = at(world, 'hud/left/scanner/fuel/fill')
    if (world.get(fill, UiNode).width !== `${pct}%`) world.set(fill, UiNode, { width: `${pct}%` })
    setText(world, 'hud/left/scanner/fuel-label', `Fuel ${pct}%`)
    // The callsign follows the text field.
    const name = world.get(at(world, 'hud/right/settings/name/field'), UiTextInput).value
    setText(world, 'hud/callsign/text', (name || '—').toUpperCase())

    for (const e of ctx.reader(UiClick).read()) {
      const index = CARGO.findIndex(
        (_, i) => at(world, `hud/right/cargo/grid/slot${i}`) === e.entity,
      )
      if (index >= 0) {
        d.selected = index
        setText(
          world,
          'hud/right/cargo/selected',
          `Selected ${CARGO[index]}: slot ${index + 1} of ${CARGO.length}`,
        )
        log(world, `cargo: ${CARGO[index]}`)
      } else if (e.entity === at(world, 'hud/right/settings/markers/theme')) {
        void swapTheme(world)
      }
    }
    for (const e of ctx.reader(UiChanged).read()) {
      if (e.entity === at(world, 'hud/right/settings/markers/toggle')) {
        const on = world.get(e.entity, UiToggle).on
        setText(world, 'hud/right/settings/markers/toggle/label', on ? 'Markers on' : 'Markers off')
        for (const p of PLANETS)
          world.set(at(world, `hud/marker-${p.name}`), UiNode, { display: on ? 'flex' : 'none' })
        log(world, `markers ${on ? 'on' : 'off'}`)
      }
    }
    if (d.logDirty) {
      d.logDirty = false
      rebuildLog(world)
    }
  },
})

/** The log list: one text node per line, scrolled to the newest. */
function rebuildLog(world: World): void {
  const d = world.resource(Demo)
  const list = at(world, 'hud/left/log/entries')
  const existing = world.resource(UiState)
  const kids: Entity[] = []
  const r = existing.rootOf.get(list)
  if (r) {
    const i = existing.indexOf.get(list)!
    for (let c = i + 1; c < r.end[i]!; c = r.end[c]!) kids.push(r.entities[c]!)
  }
  for (let i = kids.length; i < d.log.length; i++) {
    const e = world.spawn([UiNode, { style: 'dim', shrink: 0 }], [UiText, { text: d.log[i]! }])
    world.add(e, ChildOf, { parent: list })
  }
  world.set(list, UiNode, { scroll: [0, 100_000] })
}

let platform: ReturnType<typeof memoryPlatform> | undefined

/** Rewrites the theme file and rescans: the asset server reimports it and the HUD restyles. */
async function swapTheme(world: World): Promise<void> {
  const d = world.resource(Demo)
  d.theme = d.theme === 'night' ? 'day' : 'night'
  await platform!.fs.writeText(THEME, JSON.stringify(THEMES[d.theme]))
  await assetServer(world).scan()
  setText(
    world,
    'hud/right/settings/markers/theme/label',
    d.theme === 'night' ? 'Day theme' : 'Night theme',
  )
  log(world, `theme file rewritten: ${d.theme}`)
}

/** A 32×32 slot frame: a bright rim, darker corners, a translucent middle, for nine-slicing. */
function slotTexture(): Texture {
  const size = 32
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
      const cx = Math.min(x, size - 1 - x)
      const cy = Math.min(y, size - 1 - y)
      // Rounded outer corners.
      const r = 8
      const out = cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r
      const o = (y * size + x) * 4
      const c = out
        ? [0, 0, 0, 0]
        : edge < 2
          ? [120, 190, 255, 255]
          : edge < 10
            ? [30, 60, 100, 235]
            : [12, 24, 44, 200]
      data.set(c, o)
    }
  }
  return Texture.create({ width: size, height: size, mips: [data] })
}

/**
 * UI: a HUD prefab over a small star system. Planet markers follow their planets, clamp to the
 * edges with an arrow when off screen, and scale with distance; the scanner binds the nearest
 * target and a draining fuel bar; the cargo grid (nine-sliced buttons) works with the mouse, Tab and
 * arrows, or a gamepad; settings has a toggle, a slider (orbit speed), and a text field (the ship's
 * callsign). "Day theme" rewrites the theme file, and the asset server's reimport restyles the HUD.
 * The panel shows ui.describe: layouts and uploads are 0 on frames where nothing changed.
 */
export const uiDemoPlugin = definePlugin({
  name: 'ui-demo',
  dependencies: ['ui', 'scene'],
  build(app) {
    app.world.initResource(Demo)
    app.addSystems(Update, orbit, bind.after(orbit))
  },
  async ready(app) {
    const world = app.world
    world.resource(AmbientLight).brightness = 400
    world.spawn(
      [DirectionalLight, { illuminance: 30_000 }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.4, 0.8, 0) as never }],
    )
    platform = memoryPlatform()
    await platform.fs.writeBytes(FONT, new Uint8Array(await (await fetch(interUrl)).arrayBuffer()))
    await platform.fs.writeText(THEME, JSON.stringify(THEMES.night))
    const server = assetServer(world).configure({ platform, roots: ['assets', 'ui'] })
    await server.scan()
    await server.load(FONT)
    world.resource(UiDefaults).font = server.resolve(FONT) as never
    registerPrefab(world, 'prefabs/hud.prefab.json', HUD)
    loadScene(world, SCENE, { id: 'ui' })
    await whenSceneReady(world, 'ui')

    const d = world.resource(Demo)
    d.camera = findEntityByPath(world, 'camera')!
    world.add(d.camera, Camera3d, { fovY: 55, clearColor: [0.004, 0.005, 0.012, 1] })
    world.add(d.camera, Exposure, { ev100: 12 })
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const star = materials.add(
      new MaterialAsset({
        baseColor: [1, 0.8, 0.4, 1],
        emissive: [1, 0.7, 0.3, 1],
        emissiveLuminance: 60_000,
      }),
    )
    // Material first: the render slot is made when Mesh3d arrives.
    const sun = world.spawn(Transform)
    world.add(sun, MeshMaterial, { material: star })
    world.add(sun, Mesh3d, { mesh: meshes.add(sphere({ radius: 3 })) })
    for (const p of PLANETS) {
      const e = findEntityByPath(world, `planets/${p.name}`)!
      d.planets.push(e)
      world.add(e, MeshMaterial, {
        material: materials.add(new MaterialAsset({ baseColor: [...p.color, 1], roughness: 0.8 })),
      })
      world.add(e, Mesh3d, { mesh: meshes.add(sphere({ radius: p.radius, segments: 48 })) })
    }
    const slot = world.resource(Textures).add(slotTexture())
    for (let i = 0; i < CARGO.length; i++)
      world.set(at(world, `hud/right/cargo/grid/slot${i}`), UiImage, { texture: slot })
    log(world, 'systems online')

    // Demo shortcuts (ignored while typing in the ship-name field).
    const actions: Record<string, () => void> = {
      theme: () => void swapTheme(world),
      overlay: () => {
        const on = !(
          (world.resource(DebugOverlays).extra['ui-layout'] as boolean | undefined) ?? false
        )
        setOverlays(world, { 'ui-layout': on })
      },
      focus: () => focusUi(world, at(world, 'hud/right/cargo/grid/slot0')),
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-ui]')) {
      button.addEventListener('click', () => actions[button.dataset.ui!]?.())
    }
    window.addEventListener('keydown', (event) => {
      const focused = world.resource(UiPointer).focused
      if (focused !== null && world.has(focused, UiTextInput)) return
      const key = ['theme', 'overlay', 'focus'][['Digit1', 'Digit2', 'Digit3'].indexOf(event.code)]
      if (key) actions[key]!()
    })

    hudExtras.push((w) => {
      const u = describeUi(w)
      const render = u.frame.render as {
        quads: number
        drawCalls: number
        uploadedBytes: number
      } | null
      return [
        '',
        `ui     ${u.roots[0]?.nodes ?? 0} nodes · ${render?.quads ?? 0} quads in ${render?.drawCalls ?? 0} draws`,
        `frame  ${u.frame.layouts} layouts (${u.frame.nodesLaidOut} nodes) · ${u.frame.repositions} anchor moves · ${render?.uploadedBytes ?? 0} B uploaded`,
        `focus  ${u.focus ?? '-'}`,
        `hover  ${u.hovered ?? '-'}   pointer over UI: ${u.pointer.overUi}`,
        '1 swap theme file · 2 ui-layout overlay · 3 focus cargo (then arrows, Enter)',
      ]
    })
    Object.assign(globalThis, { ui: { describe: () => describeUi(world), actions } })
  },
})
