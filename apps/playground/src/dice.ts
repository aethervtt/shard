// Dice (0054): a VTT-shaped page. The table renders opaque into its canvas; the dice app renders
// into a transparent canvas over the whole page, panels and chat included, on the same GPU device
// (0052). The page decides every result, as a server would, and the dice show it: tracks record
// in a worker (0053) and land on the result by a symmetry of each die.
//
// Host families show the extension points: a drifting nebula, and (dice-cosmic.ts) Aether's animated
// black hole, pulsar and quasar. The black hole's natural 20 opens a ray-traced accretion disk and
// publishes a lens field; the host forwards it to the table, which bends (0063).

import { audioPlugin } from '@aethervtt/shard-audio'
import { t } from '@aethervtt/shard-core'
import {
  BUILTIN_SKINS,
  DICE_CONTACTS,
  DICE_SETTLE_RULE,
  DiceEffectRecipe,
  type DiceRoll,
  type DiceRollDie,
  DiceSkin,
  DiceTable,
  type DieKind,
  defineDiceFamily,
  diceEffectRecipe,
  dicePlugin,
  diceSettleParams,
  diceSkin,
  diceTrackScene,
  expandRoll,
  recipeProblems,
  renderDiceThumbnail,
  rollTrackRequest,
} from '@aethervtt/shard-dice'
import { diceWorker } from '@aethervtt/shard-dice/worker'
import { createGpuContext } from '@aethervtt/shard-gpu'
import { cylinder, plane } from '@aethervtt/shard-mesh'
import { particlesPlugin } from '@aethervtt/shard-particles'
import { trackHash } from '@aethervtt/shard-physics/track'
import { createWebAudioBackend } from '@aethervtt/shard-platform-web'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardLensFields,
  forwardPlugin,
  forwardScreenEffects,
  Lens,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App, animationFrameRunner, FrameDemand } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
// 0054's golden roll: Node records its hash in the dice tests; this page records it in Chromium.
import golden from '../../../packages/dice/src/golden.json'
import { addBackendSelect, backendLine, graphicsOptions } from './backend'
import {
  ACCRETION_SHADER,
  defineAccretionAttachment,
  definePulsarAttachment,
  defineQuasarAttachment,
  RESULT_SHADERS,
} from './dice-cosmic'
import {
  burnTable,
  defineInfernoEntrances,
  INFERNO_SHADERS,
  SCORCH_SHADERS,
  tendFires,
} from './dice-inferno'

const tableCanvas = document.getElementById('table') as HTMLCanvasElement
const diceCanvas = document.getElementById('dice') as HTMLCanvasElement
const chat = document.getElementById('chat') as HTMLElement
const hud = document.getElementById('hud') as HTMLElement

addBackendSelect(document.getElementById('bar') as HTMLElement, 'end')
const gpu = await createGpuContext(graphicsOptions())
const runner = () => animationFrameRunner({ mode: 'on-demand' })

// --- the table: felt, a grid, a few minis; its camera bends under lens fields -------------------------

function feltTexture(): Texture {
  const size = 1024
  const cell = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = ((x * 73856093) ^ (y * 19349663)) & 15
      const line = x % cell < 2 || y % cell < 2
      const o = (y * size + x) * 4
      data[o] = line ? 22 : 34 + (n >> 1)
      data[o + 1] = line ? 44 : 62 + n
      data[o + 2] = line ? 30 : 42 + (n >> 1)
      data[o + 3] = 255
    }
  }
  return Texture.create({ width: size, height: size, mips: [data], mipmaps: true })
}

const table = new App().addPlugin(
  TransformPlugin,
  renderPlugin({ gpu, surface: gpu.addSurface(tableCanvas), owner: 'table' }),
  forwardPlugin(),
  // The table draws the fires the dice set (0065's screen effects).
  particlesPlugin,
)
await table.init()
{
  const w = table.world
  const meshes = w.resource(Meshes)
  const materials = w.resource(Materials)
  w.resource(AmbientLight).brightness = 900
  w.spawn(
    [DirectionalLight, { illuminance: 32_000, shadows: true }],
    [Transform, { rotation: lookAt([-3.4, 10, 4.2], [0, 0, 0]) }],
  )
  const felt = w.resource(Textures).add(feltTexture())
  w.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 16 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({
            baseColorTexture: { texture: felt, scale: [1, 1] },
            roughness: 0.95,
          }),
        ),
      },
    ],
    [Transform, { translation: [0, 0, 0] }],
  )
  const mini = meshes.add(cylinder({ radius: 0.4, height: 0.22 }))
  const colors: [number, number, number, number][] = [
    [0.78, 0.24, 0.2, 1],
    [0.24, 0.44, 0.84, 1],
    [0.9, 0.74, 0.3, 1],
    [0.4, 0.74, 0.45, 1],
  ]
  for (let i = 0; i < 6; i++) {
    w.spawn(
      [Mesh3d, { mesh: mini }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({ baseColor: colors[i % 4]!, roughness: 0.45 }),
          ),
        },
      ],
      [
        Transform,
        { translation: [(i % 3) * 3 - 3 + 0.5, 0.11, Math.floor(i / 3) * 3 - 1.5 + 0.5] },
      ],
    )
  }
  const eye: [number, number, number] = [0, 12, 6]
  const camera = w.spawn(
    [Camera3d, { fovY: 42, clearColor: [0.04, 0.05, 0.05, 1] }],
    [Exposure, { ev100: 12.4 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0.6]) }],
    Lens,
  )
  // A die that asks for fire gets it here: flames, light, and a scorch that lingers.
  for (const { path, source } of SCORCH_SHADERS)
    w.resource(Shaders).register(path, source, 'apps/playground/src/dice-inferno.ts')
  burnTable(w, camera)
  table.onFrame(() => tendFires(w))
}
table.setRunner(runner())
void table.run()

// --- host families: a nebula here; the black hole, pulsar and quasar in dice-cosmic.ts ----------------

defineDiceFamily('playground/NebulaDice', {
  // Its clouds drift slowly: 30 frames a second is plenty while the dice rest.
  animated: { fps: 30 },
  fields: {
    nebulaDeep: t.color({
      default: [0.01, 0.01, 0.04, 1],
      description: 'Space between the clouds.',
    }),
    nebulaA: t.color({ default: [0.45, 0.1, 0.8, 1], description: 'One cloud color.' }),
    nebulaB: t.color({ default: [0.05, 0.55, 0.9, 1], description: 'The other.' }),
    nebulaGlow: t.f32({ default: 1800, unit: 'cd/m²', description: 'Cloud glow.' }),
  },
  surface: `
  let drift = globals.time * 0.04;
  let n1 = dice_fbm(local * 1.7 + vec3f(drift, 0.0, -drift) + vec3f(value * 0.37));
  let n2 = dice_fbm(local * 3.3 + vec3f(n1 * 2.2) - vec3f(0.0, drift, 0.0));
  let cloud = mix(F.nebulaA.rgb, F.nebulaB.rgb, smoothstep(0.3, 0.7, n2));
  let density = smoothstep(0.32, 0.82, n1 * 0.6 + n2 * 0.5);
  p.base_color = mix(F.nebulaDeep.rgb, cloud, density * 0.75);
  let star = pow(dice_noise(local * 46.0), 22.0);
  p.emissive += vec3f(1.0, 0.95, 0.9) * star * 90000.0 + cloud * density * F.nebulaGlow;
  p.roughness = 0.14;`,
  description: 'Playground: a nebula in the die, with stars.',
})

// Natural 20s: the black hole's accretion disk (and the lens field that bends the table), the
// pulsar's lighthouse beam, the quasar's disk and jet.
defineAccretionAttachment()
definePulsarAttachment()
defineQuasarAttachment()
// The inferno's natural 20 falls as a meteor, its natural 1 fizzles (0065 entrances).
defineInfernoEntrances()

// --- the dice app: transparent, over everything -------------------------------------------------------

const dice = new App().addPlugin(
  TransformPlugin,
  renderPlugin({
    gpu,
    surface: gpu.addSurface(diceCanvas, { alpha: 'premultiplied', label: 'dice' }),
    owner: 'dice',
  }),
  forwardPlugin(),
  particlesPlugin,
  audioPlugin({ backend: createWebAudioBackend() }),
  dicePlugin({ worker: diceWorker }),
)
await dice.init()
// The attachments' own shaders (the families' are the dice plugin's to register).
for (const { path, source } of [ACCRETION_SHADER, ...RESULT_SHADERS, ...INFERNO_SHADERS])
  dice.world.resource(Shaders).register(path, source, 'apps/playground/src/dice-cosmic.ts')
const diceTable = dice.world.resource(DiceTable)
void diceTable.tracks().ready()
dice.setRunner(runner())
void dice.run()

// The dice's lens fields and screen effects reach the table: both canvases measure them in their own
// CSS pixels.
dice.onFrame(() => {
  const t = tableCanvas.getBoundingClientRect()
  const d = diceCanvas.getBoundingClientRect()
  const offset: [number, number] = [t.left - d.left, t.top - d.top]
  forwardLensFields(dice.world, table.world, offset)
  forwardScreenEffects(dice.world, table.world, offset)
})

// Recipes: a natural 20 celebrates, a natural 1 falls flat.
const recipes = dice.world.resource(DiceEffectRecipe.store)
recipes.set(
  'demo:nat20',
  diceEffectRecipe({
    id: 'nat20',
    conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
    effects: [
      { kind: 'light-pulse', color: '#ffd76a', intensity: 5, durationMs: 1100 },
      {
        kind: 'particle-burst',
        colors: ['#fff4c2', '#ffd76a', '#ff9a3c'],
        count: 32,
        durationMs: 1100,
      },
      { kind: 'sound-accent', cue: 'arcane-spark', gain: 0.8 },
    ],
  }),
)
recipes.set(
  'demo:nat1',
  diceEffectRecipe({
    id: 'nat1',
    conditions: [{ kind: 'die', die: 'd20', value: 1, state: 'kept' }],
    effects: [
      { kind: 'light-pulse', color: '#ff4a3a', intensity: 3, durationMs: 800 },
      { kind: 'sound-accent', cue: 'void-whump', gain: 0.9 },
    ],
  }),
)
// The cosmic skins' own: on a 20 the black hole opens its disk, a pulsar sweeps its beam, a quasar
// lights its disk and jet; on a 1 they collapse or fracture (in their shaders; the recipes add sound).
const cosmicRecipes: [string, Parameters<typeof diceEffectRecipe>[0]][] = [
  [
    'demo:hole20',
    {
      id: 'hole20',
      conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
      effects: [
        { kind: 'attachment', attachment: 'accretion-disk' },
        { kind: 'light-pulse', color: '#ffb070', intensity: 5, durationMs: 1200 },
        { kind: 'sound-accent', cue: 'resin-chime', gain: 0.9 },
      ],
    },
  ],
  [
    'demo:hole1',
    {
      id: 'hole1',
      conditions: [{ kind: 'die', die: 'd20', value: 1, state: 'kept' }],
      effects: [{ kind: 'sound-accent', cue: 'void-whump', gain: 0.8 }],
    },
  ],
  [
    'demo:pulsar20',
    {
      id: 'pulsar20',
      conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
      effects: [
        { kind: 'attachment', attachment: 'pulsar-beam' },
        {
          kind: 'particle-burst',
          colors: ['#e7fbff', '#2389ff', '#176bff'],
          count: 32,
          durationMs: 1200,
        },
        { kind: 'sound-accent', cue: 'arcane-spark', gain: 0.9 },
      ],
    },
  ],
  [
    'demo:quasar20',
    {
      id: 'quasar20',
      conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
      effects: [
        { kind: 'attachment', attachment: 'quasar-jet' },
        { kind: 'light-pulse', color: '#ff8a3c', intensity: 6, durationMs: 1200 },
        { kind: 'sound-accent', cue: 'resin-chime', gain: 0.9 },
      ],
    },
  ],
  [
    'demo:cosmic1',
    {
      id: 'cosmic1',
      conditions: [{ kind: 'die', die: 'd20', value: 1, state: 'kept' }],
      effects: [
        { kind: 'light-pulse', color: '#a98aff', intensity: 2, durationMs: 900 },
        { kind: 'sound-accent', cue: 'void-whump', gain: 0.9 },
      ],
    },
  ],
]
// The inferno's (0065): its natural 20 arrives as a meteor and sets the table on fire; its 1 fizzles.
cosmicRecipes.push(
  [
    'demo:inferno20',
    {
      id: 'inferno20',
      conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
      effects: [
        { kind: 'entrance', entrance: 'meteor' },
        { kind: 'light-pulse', color: '#ff8a3a', intensity: 7, durationMs: 1200 },
        { kind: 'sound-accent', cue: 'arcane-spark', gain: 0.8 },
      ],
    },
  ],
  [
    'demo:inferno1',
    {
      id: 'inferno1',
      conditions: [{ kind: 'die', die: 'd20', value: 1, state: 'kept' }],
      effects: [
        { kind: 'entrance', entrance: 'fizzle' },
        { kind: 'light-pulse', color: '#ff4a3a', intensity: 1.5, durationMs: 700 },
      ],
    },
  ],
)
for (const [guid, json] of cosmicRecipes) recipes.set(guid, diceEffectRecipe(json))
// A recipe over its bounds fails every roll of the skins that carry it: fail here instead, loudly.
for (const [guid, recipe] of recipes.entries()) {
  const problem = recipeProblems(recipe)[0]
  if (problem) throw new Error(`${guid}: ${problem.message} at ${problem.path}`)
}

interface DemoSkin {
  guid: string
  name: string
}
const skins: DemoSkin[] = []
const store = dice.world.resource(DiceSkin.store)
const addSkin = (name: string, json: Record<string, unknown>, effects: string[]) => {
  const guid = `demo:skin/${name}`
  store.set(guid, diceSkin({ ...json, id: name, effects: effects.map((g) => ({ guid: g })) }))
  skins.push({ guid, name })
}
for (const [name, json] of Object.entries(BUILTIN_SKINS))
  addSkin(name, json, ['demo:nat20', 'demo:nat1'])
addSkin(
  'nebula',
  {
    family: 'playground/NebulaDice',
    params: { markColor: '#f3ecff', edgeColor: '#9a7bff', edgeMix: 0.35, markEmissive: 600 },
    sounds: { impact: 'glass', accent: 'resin-chime' },
  },
  ['demo:nat20', 'demo:nat1'],
)
// Aether's cosmic skins: the reactions live on the d20 (its variant's params name the values).
addSkin(
  'black hole',
  {
    family: 'playground/BlackHoleDice',
    params: {
      markColor: '#e9ecff',
      markEmissive: 1400,
      markDepth: 0.3,
      edgeColor: '#204d68',
      edgeMix: 0.2,
    },
    variants: {
      d4: { params: { bhScale: 0.65 } },
      d20: { params: { bhTriumph: 20, bhFumble: 1 } },
    },
    sounds: { impact: 'glass' },
  },
  ['demo:hole20', 'demo:hole1'],
)
addSkin(
  'pulsar',
  {
    family: 'playground/CosmicDice',
    params: {
      cosmicKind: 0,
      cosmicSpeed: 1.08,
      cosmicShadow: '#02031a',
      cosmicCore: '#273fc8',
      cosmicBeam: '#2389ff',
      cosmicAccent: '#e7fbff',
      cosmicWin: '#176bff',
      cosmicWinLight: '#e7fbff',
      cosmicLose: '#7c174b',
      cosmicLoseLight: '#ff6f82',
      markColor: '#ffffff',
      markEmissive: 1200,
      edgeColor: '#25106b',
      edgeMix: 0.25,
    },
    variants: { d20: { params: { cosmicTriumph: 20, cosmicFumble: 1 } } },
    sounds: { impact: 'glass' },
  },
  ['demo:pulsar20', 'demo:cosmic1'],
)
addSkin(
  'quasar',
  {
    family: 'playground/CosmicDice',
    params: {
      cosmicKind: 1,
      cosmicSpeed: 0.5,
      cosmicShadow: '#06020f',
      cosmicCore: '#ed3b8b',
      cosmicBeam: '#4de6ff',
      cosmicAccent: '#ffc25b',
      cosmicWin: '#ff6a18',
      cosmicWinLight: '#fff1bd',
      cosmicLose: '#4c1d76',
      cosmicLoseLight: '#a98aff',
      markColor: '#fff3dd',
      markEmissive: 1200,
      edgeColor: '#65288d',
      edgeMix: 0.25,
    },
    variants: { d20: { params: { cosmicTriumph: 20, cosmicFumble: 1 } } },
    sounds: { impact: 'glass' },
  },
  ['demo:quasar20', 'demo:cosmic1'],
)
addSkin(
  'inferno',
  {
    family: 'playground/InfernoDice',
    params: {
      markColor: '#ffe6c2',
      markEmissive: 2200,
      markDepth: 0.5,
      edgeColor: '#2a1a14',
      edgeMix: 0.4,
    },
    variants: { d20: { params: { infernoTriumph: 20 } } },
    sounds: { impact: 'resin' },
  },
  ['demo:inferno20', 'demo:inferno1'],
)
let skin = skins[0]!

// --- choosing ------------------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const option = (id: string) => $<HTMLSelectElement>(`#${id}`).value

/** The page is the server: it decides every value. */
const rollValue = (sides: number) => {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return (a[0]! % sides) + 1
}
const sidesOf = (kind: DieKind) =>
  kind === 'd100' || kind === 'percentile' ? 100 : Number(kind.slice(1))

let rolls = 0
const pool: DieKind[] = []

interface Pending {
  roll: DiceRoll
  entry: HTMLElement
  formula: string
  total: number
  landed: boolean
}
let pending: Pending | undefined

function rollOf(formula: string, dice: DiceRollDie[], total: number): DiceRoll {
  const fixed = option('seed') === 'fixed'
  const id = `roll-${++rolls}`
  return {
    id,
    seed: fixed ? 'demo-fixed' : id,
    dice,
    total,
    source: { mine: true, gm: false },
    tray: option('tray') === 'shared' ? { halfWidth: 5.4, halfDepth: 3.15 } : undefined,
    motion: option('motion') as 'full' | 'reduced',
    quality: option('quality') as DiceRoll['quality'],
    effects: option('effects') === 'on',
    soundGain: Number(option('sound')),
    tags: [formula],
  }
}

function chatEntry(formula: string): HTMLElement {
  const entry = document.createElement('div')
  entry.className = 'entry'
  entry.innerHTML = `<span class="who">You</span><span class="formula">${formula}</span><div class="note">rolling…</div>`
  chat.appendChild(entry)
  chat.scrollTop = chat.scrollHeight
  return entry
}

/** Shows the result in the chat once the dice are down: the host's value, not the dice's. */
function reveal(p: Pending): void {
  if (p.landed) return
  p.landed = true
  const chips = p.roll.dice
    .map((d) => {
      const cls = d.dropped
        ? 'die dropped'
        : d.kind === 'd20' && d.value === 20
          ? 'die crit'
          : d.kind === 'd20' && d.value === 1
            ? 'die fumble'
            : 'die'
      return `<span class="${cls}" title="${d.kind}">${d.value}</span>`
    })
    .join('')
  const bodies = expandRoll(p.roll)
  const d = diceTable.describe() as {
    track: { steps: number; settled: boolean } | null
    placed: unknown[]
    quality: { tier: string }
  }
  const note = d.track
    ? `${bodies.length} ${bodies.length === 1 ? 'die' : 'dice'} · ${d.quality.tier} · ${d.track.steps} steps${d.placed.length ? ` · ${d.placed.length} placed` : ''}`
    : `${bodies.length} ${bodies.length === 1 ? 'die' : 'dice'} · placed (reduced motion)`
  p.entry.innerHTML = `<span class="who">You</span><span class="formula">${p.formula}</span><div class="dice">${chips}</div><div class="total">${p.total}</div><div class="note">${note}</div>`
  chat.scrollTop = chat.scrollHeight
}

async function present(
  formula: string,
  dice: DiceRollDie[],
  total: number,
  abortAfterMs?: number,
): Promise<void> {
  const roll = rollOf(formula, dice, total)
  const entry = chatEntry(formula)
  const p: Pending = { roll, entry, formula, total, landed: false }
  pending = p
  const abort = new AbortController()
  if (abortAfterMs !== undefined) setTimeout(() => abort.abort(), abortAfterMs)
  const outcome = await diceTable.play(roll, { replace: true, signal: abort.signal })
  // Gone before it landed: say so, rather than describe the roll that replaced it.
  if (outcome === 'dismissed' && !p.landed)
    entry.querySelector('.note')!.textContent =
      pending === p ? 'dismissed' : 'replaced by the next roll'
  else if (outcome === 'cancelled')
    entry.querySelector('.note')!.textContent =
      `cancelled (${diceTable.phase === 'idle' ? 'nothing left on the table' : diceTable.phase})`
  else if (outcome === 'failed')
    entry.querySelector('.note')!.textContent = `failed: ${diceTable.lastError?.code}`
  else reveal(p)
}

const ref = () => ({ type: 'dice/DiceSkin', guid: skin.guid, path: undefined })
const die = (kind: DieKind, extra: Partial<DiceRollDie> = {}): DiceRollDie => ({
  kind,
  value: rollValue(sidesOf(kind)),
  skin: ref(),
  ...extra,
})

function quick(name: string): void {
  switch (name) {
    case 'd20': {
      const d = die('d20')
      void present('1d20', [d], d.value)
      return
    }
    case 'advantage': {
      const [a, b] = [die('d20'), die('d20')]
      const low = a.value < b.value ? a : b
      low.dropped = true
      ;(low === a ? b : a).high = true
      void present('2d20kh1 (advantage)', [a, b], Math.max(a.value, b.value))
      return
    }
    case 'stats': {
      const four = [die('d6'), die('d6'), die('d6'), die('d6')]
      const lowest = four.reduce((m, d) => (d.value < m.value ? d : m), four[0]!)
      lowest.dropped = true
      lowest.low = true
      void present(
        '4d6dl1',
        four,
        four.reduce((s, d) => s + (d.dropped ? 0 : d.value), 0),
      )
      return
    }
    case 'fireball': {
      const eight = Array.from({ length: 8 }, () => die('d6'))
      void present(
        '8d6 fire',
        eight,
        eight.reduce((s, d) => s + d.value, 0),
      )
      return
    }
    case 'percentile': {
      const d = die('percentile')
      void present('d%', [d], d.value)
      return
    }
    case 'd100': {
      const d = die('d100')
      void present('1d100', [d], d.value)
      return
    }
    case 'all': {
      const all = (['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'percentile'] as DieKind[]).map((k) =>
        die(k),
      )
      void present(
        'one of each',
        all,
        all.reduce((s, d) => s + d.value, 0),
      )
      return
    }
    case 'pool': {
      const kinds: DieKind[] = ['d6', 'd8', 'd10', 'd12', 'd20', 'd4']
      const many = Array.from({ length: 32 }, (_, i) => die(kinds[i % kinds.length]!))
      void present(
        '32 mixed',
        many,
        many.reduce((s, d) => s + d.value, 0),
      )
    }
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-quick]'))
  b.onclick = () => quick(b.dataset.quick!)

function renderPool(): void {
  const counts = new Map<DieKind, number>()
  for (const k of pool) counts.set(k, (counts.get(k) ?? 0) + 1)
  $('#pool').innerHTML = [...counts]
    .map(([k, n]) => `<span class="chip">${n}${k === 'percentile' ? 'd%' : k}</span>`)
    .join('')
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-add]')) {
  b.onclick = () => {
    if (pool.length >= 32) return
    pool.push(b.dataset.add as DieKind)
    renderPool()
  }
}
$<HTMLButtonElement>('[data-action="clear"]').onclick = () => {
  pool.length = 0
  renderPool()
}
$<HTMLButtonElement>('[data-action="roll"]').onclick = () => {
  if (pool.length === 0) pool.push('d20')
  const dice = pool.map((k) => die(k))
  const formula = [...new Set(pool)]
    .map((k) => `${pool.filter((x) => x === k).length}${k === 'percentile' ? 'd%' : k}`)
    .join(' + ')
  void present(
    formula,
    dice,
    dice.reduce((s, d) => s + d.value, 0),
  )
}
$<HTMLButtonElement>('[data-action="dismiss"]').onclick = () => diceTable.dismiss()
$<HTMLButtonElement>('[data-action="skip"]').onclick = () => diceTable.skip()
$<HTMLButtonElement>('[data-action="shorten"]').onclick = () => diceTable.shortenRest(150)
$<HTMLButtonElement>('[data-action="cancel"]').onclick = () => {
  const many = Array.from({ length: 16 }, () => die('d10'))
  void present('16d10, cancelled mid-roll', many, 0, 700)
}

// --- skin thumbnails, rendered on the dice app's own device --------------------------------------------

const picker = $('#skins')
for (const s of skins) {
  const b = document.createElement('button')
  b.type = 'button'
  b.innerHTML = `<img alt="" /><span>${s.name}</span>`
  b.onclick = () => {
    skin = s
    for (const other of picker.children) other.classList.toggle('on', other === b)
  }
  if (s === skin) b.classList.add('on')
  picker.appendChild(b)
}
void (async () => {
  for (let i = 0; i < skins.length; i++) {
    const thumb = await renderDiceThumbnail(dice, {
      skin: { type: 'dice/DiceSkin', guid: skins[i]!.guid, path: undefined },
      kind: 'd20',
      value: 20,
      size: 104,
    })
    const img = picker.children[i]!.querySelector('img')!
    img.src = URL.createObjectURL(new Blob([thumb.png as BlobPart], { type: 'image/png' }))
  }
})()

// --- golden (0054): the worker here records what Node recorded ------------------------------------------

let goldenNote = 'recording…'
void (async () => {
  const roll = {
    ...golden.roll,
    dice: golden.roll.dice.map((d) => ({ ...d, skin: ref() })),
  } as DiceRoll
  const bodies = expandRoll(roll)
  const request = rollTrackRequest(roll, bodies, { halfWidth: 5.4, halfDepth: 3.15 })
  const track = await diceTable.tracks().record(diceTrackScene(request), {
    settle: { rule: DICE_SETTLE_RULE, params: diceSettleParams(request) },
    contacts: DICE_CONTACTS,
  })
  const got = trackHash(track).toString(16).padStart(8, '0')
  goldenNote = `${got} ${got === golden.hash ? '= Node ✓' : `≠ Node's ${golden.hash} ✗`}`
})()

// --- HUD: dice.describe, on a timer (not rAF: it mustn't keep the page awake) ---------------------------

let rafCalls = 0
const raf = window.requestAnimationFrame.bind(window)
window.requestAnimationFrame = (fn) => {
  rafCalls++
  return raf(fn)
}
let lastRaf = 0
let lastAt = performance.now()
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`

setInterval(() => {
  const d = diceTable.describe() as {
    phase: string
    quality: { tier: string; reason: string } | null
    track: {
      hash: string
      steps: number
      settled: boolean
      maxStepsHit: boolean
      simulationMs: number
      contacts: number
    } | null
    placed: { index: number; reason: string }[]
    dice: { kind: string; label: string; natural: number | null; value: number }[]
    recipes: { id: string; anchors: number[] }[]
    drawCalls: number | null
    attachments: { name: string }[]
    lensFields: unknown[]
    resources: { entries: number; used: number; materials: number }
    gpu: { buffers: number; textures: number; bytes: number } | null
    worker: { recordings: number; spawns: number }
    lastError: { code: string } | null
  }
  if (pending && !pending.landed && (d.phase === 'accent' || d.phase === 'rest')) reveal(pending)
  const now = performance.now()
  const rate = ((rafCalls - lastRaf) * 1000) / (now - lastAt)
  lastRaf = rafCalls
  lastAt = now
  const demand = dice.world.resource(FrameDemand).held()
  hud.textContent = [
    backendLine(gpu),
    `phase ${d.phase}${d.quality ? `   tier ${d.quality.tier} (${d.quality.reason})` : ''}`,
    d.track
      ? `track ${d.track.hash}  ${d.track.steps} steps  ${d.track.settled ? 'settled' : 'max steps'}  ${d.track.contacts} contacts  ${d.track.simulationMs} ms in the worker`
      : 'track —',
    d.dice.length
      ? `dice  ${d.dice.map((x) => `${x.kind}:${x.label}${x.natural !== null && x.natural !== x.value ? `←${x.natural}` : ''}`).join(' ')}`
      : 'dice  —',
    `placed ${d.placed.length ? d.placed.map((p) => `${p.index} (${p.reason})`).join(', ') : '—'}   recipes ${d.recipes.map((r) => r.id).join(', ') || '—'}`,
    `draws ${d.drawCalls ?? '—'}   attachments ${d.attachments.length}   lens fields ${d.lensFields.length}`,
    `resources ${d.resources.entries} (${d.resources.used} in use, ${d.resources.materials} materials)   gpu ${d.gpu ? `${d.gpu.buffers} buffers, ${d.gpu.textures} textures, ${mb(d.gpu.bytes)}` : '—'}`,
    `worker ${d.worker.recordings} recordings, ${d.worker.spawns} spawned   golden ${goldenNote}`,
    `frames: rAF ${rate.toFixed(0)}/s   holding ${demand.length ? demand.join(', ') : '— (idle)'}`,
    d.lastError ? `last error ${d.lastError.code}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}, 250)

// Something on the table to start with: one die, landed.
void present('1d20', [{ kind: 'd20', value: 20, skin: ref() }], 20)

Object.assign(globalThis, { dice, table, diceTable })
