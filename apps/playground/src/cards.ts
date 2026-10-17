import {
  CardCollection,
  type CardHandle,
  type CardImage,
  type CardPose,
  Cards,
  cardDefinition,
  cardPose,
  cardsPlugin,
  cardTiltCoordinates,
  createCardHit,
  hitCards,
  prepareCardTextures,
} from '@aethervtt/shard-cards'
import { createView, poseView, viewRay } from '@aethervtt/shard-controls'
import { ShardError } from '@aethervtt/shard-core'
import { box } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { App, animationFrameRunner, LogResource } from '@aethervtt/shard-runtime'
import type { Image as TextureImage } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { addBackendSelect, graphicsOptions } from './backend'
import { ATELIER_FINISHES } from './cards-finishes'

const canvas = document.querySelector<HTMLCanvasElement>('#cards')!
const loading = document.querySelector<HTMLElement>('#loading')!
const input = (id: string) => document.getElementById(id) as HTMLInputElement
const text = (id: string, value: string) => {
  document.getElementById(id)!.textContent = value
}
const ids = ['ninetales', 'umbreon', 'pawmi']
const names = ['Ninetales', 'Umbreon VMAX', 'Pawmi']
const notes = ['Amber etching', 'Celestial prism', 'Meadow opal']
const patterns = ['ember-flow', 'stars', 'petals']
const patternNames = ['Flowing etching', 'Stars & glitter', 'Petals & leaves']
addBackendSelect(document.getElementById('backend-host')!)

async function loadImage(id: string, url: string): Promise<CardImage> {
  const response = await fetch(url)
  if (!response.ok) throw new ShardError('cards/art-unavailable', `${url}: ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' })
  const target = document.createElement('canvas')
  target.width = bitmap.width
  target.height = bitmap.height
  const ctx = target.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  const pixels = ctx.getImageData(0, 0, target.width, target.height)
  bitmap.close()
  return {
    id,
    image: {
      width: target.width,
      height: target.height,
      kind: 'u8',
      data: new Uint8Array(pixels.data.buffer),
    },
  }
}

/** A code-authored geometric back, shared by the entire deck. */
function cardBack(): TextureImage {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 720
  const x = c.getContext('2d')!
  x.fillStyle = '#18222e'
  x.fillRect(0, 0, 512, 720)
  x.strokeStyle = '#bba071'
  x.lineWidth = 1.5
  x.strokeRect(20, 20, 472, 680)
  x.strokeRect(29, 29, 454, 662)
  x.save()
  x.translate(256, 360)
  for (let i = 0; i < 48; i++) {
    x.rotate(Math.PI / 24)
    x.globalAlpha = 0.22
    x.beginPath()
    x.ellipse(0, 0, 150, 285, 0, 0, Math.PI * 2)
    x.stroke()
  }
  x.globalAlpha = 1
  x.fillStyle = '#18222e'
  x.beginPath()
  x.arc(0, 0, 80, 0, Math.PI * 2)
  x.fill()
  x.stroke()
  x.beginPath()
  x.moveTo(0, -55)
  x.lineTo(35, 0)
  x.lineTo(0, 55)
  x.lineTo(-35, 0)
  x.closePath()
  x.stroke()
  x.fillStyle = '#ddbd84'
  x.font = '12px sans-serif'
  x.textAlign = 'center'
  x.fillText('S H A R D', 0, 115)
  x.restore()
  return {
    width: 512,
    height: 720,
    kind: 'u8',
    data: new Uint8Array(x.getImageData(0, 0, 512, 720).data.buffer),
  }
}

async function main(): Promise<void> {
  const artImages = await Promise.all(ids.map((id) => loadImage(id, `/cards/${id}.png`)))
  artImages.push({ id: 'back', image: cardBack() })
  const maskImages = await Promise.all(
    [...ids, ...patterns].map((id) =>
      // The original's green channel keeps Umbreon's coverage registered to the exact source pixels.
      // AI-redrawn silhouettes drift even when their overall composition looks similar.
      id === 'umbreon' ? artImages[1]! : loadImage(id, `/cards/${id}-foil.png`),
    ),
  )
  const art = prepareCardTextures(artImages, { width: 768, height: 1080 })
  const masks = prepareCardTextures(maskImages, { width: 768, height: 1080, mask: true })
  const lighting =
    new URLSearchParams(location.search).get('lighting') === 'unlit' ? 'unlit' : 'pbr'
  const lightingSelect = document.getElementById('lighting') as HTMLSelectElement
  lightingSelect.value = lighting
  lightingSelect.addEventListener('change', () => {
    const url = new URL(location.href)
    url.searchParams.set('lighting', lightingSelect.value)
    location.href = url.href
  })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ canvas, ...graphicsOptions() }),
    forwardPlugin({ msaa: 4 }),
    cardsPlugin({ art, masks, lighting, finishes: ATELIER_FINISHES, capacity: 1024 }),
  )
  await app.init()
  const world = app.world
  const table = world.resource(Cards)
  const gpu = world.resource(Gpu)
  const camera = world.spawn(
    [
      Camera3d,
      {
        projection: 'orthographic',
        orthoHeight: 0.14,
        near: 0.001,
        // Tabletop-scale depth precision for sub-millimetre card faces and gaps.
        far: 1,
        clearColor: [0.006, 0.008, 0.012, 1],
      },
    ],
    [Transform, { translation: [0, 0, 0.5] }],
    [Exposure, { ev100: lighting === 'pbr' ? 7 : 0 }],
    [Tonemapping, { curve: 'none', dither: false }],
  )
  // Ordinary engine lights and geometry: foil goes through the same PBR/shadow path.
  const ambient = world.resource(AmbientLight)
  ambient.brightness = lighting === 'pbr' ? 18 : 0.14
  const key = world.spawn(
    [
      DirectionalLight,
      {
        illuminance: lighting === 'pbr' ? 400 : 3.125,
        shadows: true,
        shadowBias: 0.000015,
        shadowNormalBias: 0.3,
        cascades: { count: 1, maxDistance: 0.8, splitLambda: 0.8 },
      },
    ],
    [Transform, { rotation: lookAt([-0.4, 0.6, 1], [0, 0, 0]) }],
  )
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 0.8, y: 0.8, z: 0.002 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({ baseColor: [0.008, 0.011, 0.017, 1], roughness: 1 }),
        ),
      },
    ],
    [Transform, { translation: [0, 0, -0.012] }],
  )
  // A small floating bar gives a controllable received-shadow example on the artwork.
  const blocker = world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 0.27, y: 0.003, z: 0.002 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({ baseColor: [0.09, 0.07, 0.04, 1], roughness: 0.65 }),
        ),
      },
    ],
    [Transform, { translation: [0, 2, 0.025] }],
  )
  input('shadow-example').addEventListener('change', () => {
    world.set(blocker, Transform, {
      translation: [0, input('shadow-example').checked ? 0.02 : 2, 0.025],
    })
    app.requestFrame()
  })
  input('scene-lights').addEventListener('change', () => {
    const on = input('scene-lights').checked
    world.set(key, DirectionalLight, { illuminance: on ? (lighting === 'pbr' ? 400 : 3.125) : 0 })
    ambient.brightness = on ? (lighting === 'pbr' ? 18 : 0.14) : 0
    app.requestFrame()
  })
  const definitions = ids.map((id, i) =>
    cardDefinition({
      label: names[i],
      size: [0.063, 0.088],
      cornerRadius: 0.0028,
      front: {
        art: { path: id },
        fit: 'stretch',
        finishes: [
          {
            family: ATELIER_FINISHES[i]!.name,
            strength: 0.8,
            mask: { texture: { path: id }, space: 'art', channel: id === 'umbreon' ? 'g' : 'r' },
          },
          {
            family: 'cards/hologram',
            strength: 0.55,
            mask: {
              texture: { path: patterns[i]! },
              space: 'face',
              scale: i === 2 ? [1.5, 2.1] : [1, 1.4],
            },
          },
        ],
      },
      back: {
        art: { path: 'back' },
        fit: 'stretch',
        finishes: [],
      },
    }),
  )
  const heroes = definitions.map((d, i) => table.spawn(d, `hero:${i}`))
  const extras: CardHandle[] = []
  const deck = new CardCollection(
    'atelier-deck',
    Array.from({ length: 10000 }, (_, i) => ({
      instanceId: `deck:${i}`,
      definition: ids[i % 3]!,
      faceDown: true,
    })),
  )
  let selected = 0
  let selectedCard = heroes[0]!
  let layout = 'gallery'
  let shuffleSeed = 7
  let orthoHeight = 0.14
  let dragging: CardHandle | undefined
  let pressed: CardHandle | undefined
  let pressX = 0,
    pressY = 0,
    grabX = 0,
    grabY = 0,
    dragMoved = false
  let pointerX = 0,
    pointerY = 0,
    pointerInside = false
  let pointerCard: CardHandle | undefined
  let frontCard: CardHandle | undefined
  let frontRest: CardPose | undefined
  let flipAfterLift: CardHandle | undefined
  const strengths = [
    [0.8, 0.55],
    [0.8, 0.55],
    [0.8, 0.55],
  ]
  const enabled = [
    [true, true],
    [true, true],
    [true, true],
  ]
  const chosen = ATELIER_FINISHES.map((f) => f.name)
  const chosenSize = ['poker', 'poker', 'poker']
  const sizes: Record<string, readonly [number, number]> = {
    poker: [0.063, 0.088],
    bridge: [0.057, 0.088],
    tarot: [0.07, 0.12],
    square: [0.08, 0.08],
  }
  const view = createView()
  const origin = new Float64Array(3),
    direction = new Float64Array(3),
    pose = new Float64Array(4)
  const eye = [0, 0, 0.5],
    rotation = [0, 0, 0, 1]
  const hit = createCardHit()
  const tiltUV = new Float64Array(2)
  const dragStart = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, scale: 1 }
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
  input('reduced').checked = motionPreference.matches
  table.reducedMotion = motionPreference.matches

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    const pixelRatio = Math.min(devicePixelRatio, 2)
    canvas.width = Math.round(rect.width * pixelRatio)
    canvas.height = Math.round(rect.height * pixelRatio)
    orthoHeight = Math.max(0.115, 0.242 / (rect.width / rect.height))
    world.set(camera, Camera3d, { orthoHeight })
    poseView(view, eye, rotation, true, 45, orthoHeight, rect.width / rect.height)
    app.requestFrame()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  const finishSelect = document.getElementById('finish') as HTMLSelectElement
  const sizeSelect = document.getElementById('card-size') as HTMLSelectElement
  for (const f of table.finishes) {
    const option = document.createElement('option')
    option.value = f.name
    option.textContent = f.name.split('/')[1]!.replace(/([a-z])([A-Z])/g, '$1 $2')
    finishSelect.append(option)
  }

  function refreshPanel(): void {
    text('selected-name', names[selected]!)
    text('selected-note', notes[selected]!)
    text('pattern-name', `02  ${patternNames[selected]}`)
    finishSelect.value = chosen[selected]!
    sizeSelect.value = chosenSize[selected]!
    text(
      'finish-description',
      table.finishes.find((f) => f.name === chosen[selected])?.options.description ??
        'A built-in finish using the same shader extension API.',
    )
    for (let l = 0; l < 2; l++) {
      input(`layer${l}`).checked = enabled[selected]![l]!
      input(`strength${l}`).value = String(strengths[selected]![l])
      text(`strength${l}-value`, `${Math.round(strengths[selected]![l]! * 100)}%`)
    }
    document.querySelectorAll<HTMLButtonElement>('[data-card]').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.card) === selected)
    })
  }

  function updateTilt(): void {
    const allowed = (layout === 'gallery' || layout === 'inspect') && !input('automatic').checked
    input('tilt').disabled = !allowed
    text(
      'tilt-label',
      input('automatic').checked
        ? 'Pointer tilt · automatic mode active'
        : allowed
          ? 'Pointer tilt'
          : 'Pointer tilt · gallery / inspect only',
    )
    for (const card of table.cards) if (card) card.tilt = allowed && input('tilt').checked
    table.wake()
  }

  function updateAutomaticMotion(): void {
    const enabled = input('automatic').checked
    const seconds = Number(input('automatic-seconds').value)
    input('automatic-tilt').disabled = !enabled || layout === 'stack'
    input('automatic-seconds').disabled = !enabled
    text('automatic-seconds-value', `${seconds} s`)
    for (const card of table.cards) {
      if (!card) continue
      const visible =
        layout === 'gallery'
          ? heroes.includes(card)
          : layout === 'inspect'
            ? card === heroes[selected]
            : extras.includes(card)
      const tiltAllowed = layout === 'gallery' || layout === 'inspect' || card === frontCard
      card.setAutomaticMotion({
        enabled: enabled && visible,
        seconds,
        tilt:
          enabled && visible && input('automatic-tilt').checked && tiltAllowed && card !== dragging,
      })
    }
  }

  function returnHandCard(): void {
    if (frontCard?.active && frontRest) {
      frontCard.automaticTilt = false
      frontCard.setPose({ ...frontRest, yaw: frontCard.target[4]! }, 0.2)
    }
    frontCard = undefined
    frontRest = undefined
  }

  function selectCard(card: CardHandle): void {
    selectedCard = card
    selected = definitions.indexOf(card.definition)
    if (layout === 'hand' && card !== frontCard) {
      returnHandCard()
      const p = card.target
      frontRest = {
        x: p[0]!,
        y: p[1]!,
        z: p[2]!,
        pitch: p[3]!,
        yaw: p[4]!,
        roll: p[5]!,
        scale: p[6]!,
      }
      frontCard = card
      // Raise depth immediately so the selected card never sweeps through its neighbours.
      card.setPose({
        x: card.pose[0]!,
        y: card.pose[1]!,
        z: 0.06,
        pitch: card.pose[3]!,
        yaw: p[4]!,
        roll: card.pose[5]!,
        scale: card.pose[6]!,
      })
      card.setPose({ ...frontRest, y: frontRest.y + 0.012, z: 0.06, roll: 0 }, 0.2)
      text('status', `${card.definition.label} in front · click empty space to return`)
    }
    refreshPanel()
    updateAutomaticMotion()
  }

  function flipCard(card: CardHandle): void {
    const clearance =
      (Math.max(card.definition.size[0], card.definition.size[1]) * card.pose[6]!) / 2 + 0.015
    if (layout !== 'stack' || card.pose[2]! >= clearance) {
      card.flip()
      return
    }
    // A deck card must leave the pile before rotating through neighbouring faces.
    flipAfterLift = card
    card.setPose(
      {
        x: card.pose[0]!,
        y: card.pose[1]!,
        z: clearance,
        pitch: card.pose[3]!,
        yaw: card.pose[4]!,
        roll: card.pose[5]!,
        scale: card.pose[6]!,
      },
      0.25,
    )
  }

  function arrange(animate = true): void {
    flipAfterLift = undefined
    cancel()
    frontCard = undefined
    frontRest = undefined
    for (const extra of extras) extra.dispose()
    extras.length = 0
    table.configure({ maskView: 0 })
    document.querySelectorAll('[id^=mask]').forEach((b) => {
      b.classList.remove('active')
    })
    for (let i = 0; i < 3; i++) {
      const card = heroes[i]!
      if (layout === 'gallery')
        card.setPose({ x: (i - 1) * 0.077, y: 0, z: 0, roll: 0, scale: 1 }, animate ? 0.55 : 0)
      else if (layout === 'inspect')
        card.setPose(
          {
            x: i === selected ? 0 : i < selected ? -0.3 : 0.3,
            y: 0,
            z: 0.02,
            scale: i === selected ? Math.min(1.35, 0.108 / card.definition.size[1]) : 1,
          },
          animate ? 0.55 : 0,
        )
      else card.setPose({ x: 0.5 + i * 0.1, y: 0, z: 0 }, 0)
    }
    if (layout === 'hand') {
      for (let i = 0; i < 15; i++) {
        const entry = deck.at(i)!
        const d = definitions[ids.indexOf(entry.definition)]!
        const card = table.spawn(d, `hand:${entry.instanceId}`, {
          x: -0.12,
          y: -0.02,
          z: -0.02,
          yaw: 180,
          scale: 0.8,
        })
        cardPose({ kind: 'fan', angle: 65, spacing: 0.008, height: 0.088 }, i, 15, pose)
        card.setPose(
          {
            x: pose[0]!,
            y: pose[1]! + 0.015,
            z: pose[2]!,
            roll: (pose[3]! * 180) / Math.PI,
            scale: 0.8,
          },
          animate ? 0.6 + i * 0.025 : 0,
        )
        extras.push(card)
      }
    }
    if (layout === 'stack') {
      let height = 0
      const pitch = 8
      const sine = Math.sin((pitch * Math.PI) / 180)
      const cosine = Math.cos((pitch * Math.PI) / 180)
      for (let i = 0; i < 10; i++) {
        const entry = deck.at(i)!
        const definition = definitions[ids.indexOf(entry.definition)]!
        const depth = height + definition.thickness / 2
        const card = table.spawn(definition, `stack:${entry.instanceId}`, {
          x: 0,
          y: -sine * depth,
          z: cosine * depth,
          pitch,
          yaw: 180,
          roll: -8,
        })
        // Stack along the shared face normal: only card edges show under the top back.
        height += definition.thickness + 0.00002
        extras.push(card)
      }
    }
    for (const card of [...heroes, ...extras]) {
      const i = definitions.indexOf(card.definition)
      card.setFinish(0, chosen[i]!)
      for (let l = 0; l < 2; l++) card.setStrength(enabled[i]![l] ? strengths[i]![l]! : 0, l)
    }
    selectedCard =
      layout === 'stack'
        ? extras.at(-1)!
        : (extras.find((c) => c.definition === definitions[selected]) ?? heroes[selected]!)
    selected = definitions.indexOf(selectedCard.definition)
    updateTilt()
    updateAutomaticMotion()
    refreshPanel()
    text(
      'interaction',
      layout === 'hand'
        ? 'Click a card to bring it forward · ← / → browse the hand · click empty space to return'
        : layout === 'stack'
          ? 'Click to select · double click to flip · drag to move'
          : 'Hover to tilt · click to select · double click to flip · drag to move',
    )
    text(
      'status',
      layout === 'stack' ? '10,000 logical cards · 10 exposed' : 'Two independent finish layers',
    )
    app.requestFrame()
  }
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((button) => {
    button.addEventListener('click', () => {
      layout = button.dataset.layout!
      document.querySelectorAll('[data-layout]').forEach((b) => {
        b.classList.toggle('active', b === button)
      })
      arrange()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('[data-card]').forEach((button) => {
    button.addEventListener('click', () => {
      selected = Number(button.dataset.card)
      selectCard(extras.find((c) => c.definition === definitions[selected]) ?? heroes[selected]!)
      if (layout === 'inspect') arrange()
    })
  })
  finishSelect.addEventListener('change', () => {
    chosen[selected] = finishSelect.value
    for (const card of table.cards)
      if (card && card.definition === definitions[selected]) card.setFinish(0, finishSelect.value)
    refreshPanel()
  })
  document.getElementById('card-size')!.addEventListener('change', (event) => {
    const size = (event.target as HTMLSelectElement).value
    chosenSize[selected] = size
    const previous = definitions[selected]!
    definitions[selected] = cardDefinition({
      ...previous,
      size: sizes[size],
      front: { ...previous.front, fit: 'contain' },
      back: { ...previous.back, fit: 'cover' },
    })
    heroes[selected]!.dispose()
    heroes[selected] = table.spawn(definitions[selected]!, `hero:${selected}`)
    arrange(false)
  })
  for (let l = 0; l < 2; l++) {
    const change = () => {
      strengths[selected]![l] = Number(input(`strength${l}`).value)
      enabled[selected]![l] = input(`layer${l}`).checked
      for (const card of table.cards)
        if (card && card.definition === definitions[selected])
          card.setStrength(enabled[selected]![l] ? strengths[selected]![l]! : 0, l)
      text(`strength${l}-value`, `${Math.round(strengths[selected]![l]! * 100)}%`)
    }
    input(`strength${l}`).addEventListener('input', change)
    input(`layer${l}`).addEventListener('change', change)
    document.getElementById(`mask${l}`)!.addEventListener('click', () => {
      const button = document.getElementById(`mask${l}`)!
      const on = !button.classList.contains('active')
      document.querySelectorAll('[id^=mask]').forEach((b) => {
        b.classList.remove('active')
      })
      button.classList.toggle('active', on)
      table.configure({ maskView: on ? l + 1 : 0 })
    })
  }
  input('gloss').addEventListener('input', () => {
    table.configure({ gloss: Number(input('gloss').value) })
    text('gloss-value', `${Math.round(Number(input('gloss').value) * 100)}%`)
  })
  input('light').addEventListener('input', () => {
    const x = Number(input('light').value)
    table.configure({ light: [x, 0.6, 1, 0] })
    world.set(key, Transform, { rotation: lookAt([x, 0.6, 1], [0, 0, 0]) })
    app.requestFrame()
  })
  input('tilt').addEventListener('change', updateTilt)
  input('automatic').addEventListener('change', () => {
    updateTilt()
    updateAutomaticMotion()
  })
  input('automatic-tilt').addEventListener('change', updateAutomaticMotion)
  input('automatic-seconds').addEventListener('input', updateAutomaticMotion)
  input('reduced').addEventListener('change', () => {
    table.reducedMotion = input('reduced').checked
    table.wake()
  })
  document.getElementById('flip')!.addEventListener('click', () => flipCard(selectedCard))
  document.getElementById('reset')!.addEventListener('click', () => arrange())
  document.getElementById('shuffle')!.addEventListener('click', () => {
    deck.shuffle(shuffleSeed++)
    arrange()
    text('interaction', `Shuffled with seed ${shuffleSeed - 1} · stable card IDs preserved`)
  })
  const plain = document.getElementById('plain')!
  plain.addEventListener('pointerdown', (event) => {
    plain.setPointerCapture((event as PointerEvent).pointerId)
    for (const card of table.cards) card?.setStrength(0)
  })
  const restore = () => {
    for (const card of table.cards) card?.setStrength(1)
  }
  plain.addEventListener('pointerup', restore)
  plain.addEventListener('pointercancel', restore)
  plain.addEventListener('lostpointercapture', restore)

  function pointer(event: PointerEvent | MouseEvent): void {
    const rect = canvas.getBoundingClientRect()
    pointerX = event.clientX - rect.left
    pointerY = event.clientY - rect.top
    pointerInside =
      pointerX >= 0 && pointerY >= 0 && pointerX <= rect.width && pointerY <= rect.height
    viewRay(view, pointerX, pointerY, rect.width, rect.height, origin, direction)
  }
  function hover(): void {
    if (!pointerInside || dragging) return
    hitCards(table, origin, direction, hit)
    if (pointerCard !== hit.card) pointerCard?.setHover(0.5, 0.5, false)
    pointerCard = hit.card
    if (hit.card) {
      if (cardTiltCoordinates(hit.card, origin, direction, tiltUV))
        hit.card.setHover(tiltUV[0]!, tiltUV[1]!, true)
      canvas.style.cursor = 'grab'
      text(
        'interaction',
        `${hit.card.definition.label} · ${hit.side} · ${layout === 'hand' ? 'click to bring forward · ← / → browse' : `UV ${hit.u.toFixed(2)}, ${hit.v.toFixed(2)} · double click to flip`}`,
      )
    } else canvas.style.cursor = 'default'
  }
  canvas.addEventListener('pointermove', (event) => {
    pointer(event)
    if (pressed && Math.abs(pointerX - pressX) + Math.abs(pointerY - pressY) > 4) {
      dragging = pressed
      dragging.automaticTilt = false
      dragMoved = true
      dragging.setHover(0.5, 0.5, false)
      const px = origin[0]! + direction[0]! * 0.5
      const py = origin[1]! + direction[1]! * 0.5
      dragging.setPose({
        x: px - grabX,
        y: py - grabY,
        z: layout === 'hand' ? 0.08 : 0.035,
        yaw: dragging.pose[4],
        scale: dragging.pose[6],
      })
      canvas.style.cursor = 'grabbing'
      return
    }
    if (event.pointerType !== 'touch') hover()
  })
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    pointer(event)
    hitCards(table, origin, direction, hit)
    pressed = hit.card
    if (pressed === flipAfterLift) flipAfterLift = undefined
    pressX = pointerX
    pressY = pointerY
    dragMoved = false
    if (pressed) {
      dragStart.x = pressed.pose[0]!
      dragStart.y = pressed.pose[1]!
      dragStart.z = pressed.pose[2]!
      dragStart.pitch = pressed.pose[3]!
      dragStart.yaw = pressed.pose[4]!
      dragStart.roll = pressed.pose[5]!
      dragStart.scale = pressed.pose[6]!
      canvas.setPointerCapture(event.pointerId)
      grabX = origin[0]! - pressed.pose[0]!
      grabY = origin[1]! - pressed.pose[1]!
      canvas.focus()
    }
  })
  function cancel(): void {
    if (dragging?.active) dragging.setPose(dragStart, 0.2)
    pressed = undefined
    dragging = undefined
    pointerCard?.setHover(0.5, 0.5, false)
    pointerCard = undefined
    updateAutomaticMotion()
  }
  canvas.addEventListener('pointerup', (event) => {
    pointer(event)
    hitCards(table, origin, direction, hit)
    if (!dragMoved && pressed && hit.card === pressed) {
      selectCard(pressed)
      if (layout !== 'hand') text('status', `Clicked ${pressed.instanceId} · ${hit.side}`)
    } else if (!pressed && !hit.card && layout === 'hand') {
      returnHandCard()
      text('status', 'Click a card to bring it forward')
    }
    pressed = undefined
    dragging = undefined
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointercancel', cancel)
  canvas.addEventListener('lostpointercapture', cancel)
  canvas.addEventListener('pointerleave', () => {
    pointerInside = false
    if (!dragging) cancel()
  })
  canvas.addEventListener('dblclick', (event) => {
    pointer(event)
    if (hitCards(table, origin, direction, hit)) flipCard(hit.card!)
  })
  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      flipCard(selectedCard)
    }
    if (event.key === 'Escape') {
      cancel()
      arrange()
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      if (layout === 'hand') {
        const index = extras.indexOf(selectedCard)
        selectCard(extras[(index + step + extras.length) % extras.length]!)
      } else {
        selected = (selected + step + 3) % 3
        selectCard(extras.find((c) => c.definition === definitions[selected]) ?? heroes[selected]!)
      }
      if (layout === 'inspect') arrange()
    }
  })
  const sweepLight = [-0.4, 0.6, 1, 0]
  const lightRotation: [number, number, number, number] = [0, 0, 0, 1]
  const lightTransform = { rotation: lightRotation }
  let previousTime = 0
  let visualFrame = 0
  function visual(time: number): void {
    if (flipAfterLift && !flipAfterLift.duration) {
      const card = flipAfterLift
      flipAfterLift = undefined
      if (card.active) card.flip()
    }
    if (input('sweep').checked && !table.reducedMotion) {
      sweepLight[0] = Math.sin(time * 0.0005) * 0.9
      sweepLight[1] = Math.cos(time * 0.00035) * 0.7
      const length = Math.sqrt(
        sweepLight[0]! * sweepLight[0]! + sweepLight[1]! * sweepLight[1]! + 1,
      )
      const w = Math.sqrt((1 + 1 / length) * 0.5)
      lightRotation[0] = -sweepLight[1]! / (2 * w * length)
      lightRotation[1] = sweepLight[0]! / (2 * w * length)
      lightRotation[3] = w
      world.set(key, Transform, lightTransform)
      table.material.value.light = sweepLight
      table.material.version++
      table.wake()
    }
    if (time - previousTime > 500) {
      const state = table.describe()
      text(
        'stats',
        `${gpu.backend.toUpperCase()} · ${state.cards} exposed · ${(state.textureBytes / 1048576).toFixed(1)} MB`,
      )
      previousTime = time
    }
    visualFrame = requestAnimationFrame(visual)
  }
  refreshPanel()
  arrange(false)
  app.setRunner(animationFrameRunner({ mode: 'on-demand' }))
  void app.run()
  visualFrame = requestAnimationFrame(visual)
  loading.style.display = 'none'
  // Expose the live scene for manual inspection, without a test harness.
  Object.assign(window, {
    cardsApp: app,
    cardsReady: () =>
      gpu.pipelines.pending === 0 &&
      gpu.pipelines.skipped === 0 &&
      table.cards.every((card) => !card?.dataDirty),
    cardsTable: table,
    cardsHeroes: heroes,
    cardsDeck: deck,
    cardsErrors: () => world.resource(LogResource).tail(30, 'warn'),
  })
  window.addEventListener(
    'pagehide',
    () => {
      cancelAnimationFrame(visualFrame)
      observer.disconnect()
      void app.dispose()
    },
    { once: true },
  )
}

main().catch((error) => {
  console.error(error)
  loading.style.display = 'grid'
  loading.textContent = error instanceof Error ? error.message : String(error)
})
