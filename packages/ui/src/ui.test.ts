import { ChildOf, defineSystem, FixedUpdate, ProfilerResource } from '@shard/core'
import { addActions, defineActions, injectInput } from '@shard/input'
import { Camera3d } from '@shard/render'
import { LogResource } from '@shard/runtime'
import { measureText } from '@shard/text'
import { lookAt, Transform } from '@shard/transform'
import { describe, expect, it } from 'vitest'
import {
  UiAnchor,
  UiAnchorArrow,
  UiButton,
  UiChanged,
  UiClick,
  UiDefaults,
  UiInteraction,
  UiLayout,
  UiNode,
  UiRoot,
  UiSlider,
  UiStyle,
  UiText,
  UiTextInput,
  UiToggle,
} from './components'
import { UiPointer } from './interaction'
import { describeUi, uiMethods } from './methods'
import { addFont, click, interFont, mouse, node, rect, root, uiApp } from './testing'
import { UiThemeAsset, UiThemes } from './theme'
import { UiState } from './tree'

/** Budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

describe('layout in the world', () => {
  it('lays out a tree into UiLayout, in root pixels', async () => {
    const { world, frame } = await uiApp()
    const r = root(world, 800, 600)
    world.set(r, UiNode, { padding: [20, 20, 20, 20], direction: 'column', gap: [0, 10] })
    const bar = node(world, r, [UiNode, { height: 40 }])
    const row = node(world, r, [UiNode, { grow: 1, justify: 'space-between' }])
    const a = node(world, row, [UiNode, { width: '25%', height: 50 }])
    const b = node(world, row, [UiNode, { width: 100, alignSelf: 'end', height: 30 }])
    frame()
    expect(rect(world, r)).toEqual([0, 0, 800, 600])
    expect(rect(world, bar)).toEqual([20, 20, 760, 40])
    expect(rect(world, row)).toEqual([20, 70, 760, 510])
    expect(rect(world, a)).toEqual([20, 70, 190, 50])
    expect(rect(world, b)).toEqual([680, 550, 100, 30])
    expect(world.get(b, UiLayout).visible).toBe(true)
  })

  it('relays out only roots that changed, and not at all when nothing did', async () => {
    const { world, frame } = await uiApp()
    const a = root(world)
    const b = root(world)
    const box = node(world, a, [UiNode, { width: 10, height: 10 }])
    node(world, b, [UiNode, { width: 10, height: 10 }])
    frame()
    const store = world.resource(UiState)
    expect(store.layouts).toBe(2)
    frame()
    expect(store.layouts).toBe(0)
    expect(describeUi(world).frame.layouts).toBe(0)
    world.set(box, UiNode, { width: 30 })
    frame()
    expect(store.layouts).toBe(1)
    expect(rect(world, box)[2]).toBe(30)
    // Writing the same text again isn't a change that relays out.
    const fontRef = addFont(world)
    world.resource(UiDefaults).font = fontRef
    const label = node(world, a, [UiText, { text: 'Fuel' }])
    frame()
    frame()
    world.set(label, UiText, { text: 'Fuel' })
    frame()
    expect(store.layouts).toBe(0)
  })

  it('sizes nodes to their text, wrapping at the width they get', async () => {
    const { world, frame } = await uiApp()
    const fontRef = addFont(world)
    const r = root(world, 400, 300)
    world.set(r, UiNode, { alignItems: 'start', direction: 'column' })
    const short = node(world, r, [UiText, { text: 'Scanner', font: fontRef, size: 20 }])
    const long = node(
      world,
      r,
      [UiNode, { width: 120 }],
      [
        UiText,
        { text: 'Three wrapped lines of text here', font: fontRef, size: 20, lineHeight: 1.25 },
      ],
    )
    const padded = node(
      world,
      r,
      [UiNode, { padding: [4, 8, 4, 8] }],
      [UiText, { text: 'Scanner', font: fontRef, size: 20 }],
    )
    frame()
    const [, , w = 0, h = 0] = rect(world, short)
    expect(w).toBeGreaterThan(60)
    expect(w).toBeLessThan(90)
    expect(h).toBeCloseTo(20 * 1.2, 3)
    expect(rect(world, long)[2]).toBe(120)
    const lines = measureText(interFont(), 'Three wrapped lines of text here', {
      size: 20,
      maxWidth: 120,
    }).lines.length
    expect(lines).toBeGreaterThan(2)
    expect(rect(world, long)[3]).toBeCloseTo(lines * 25, 3)
    expect(rect(world, padded)[2]).toBeCloseTo(w + 16, 3)
    expect(rect(world, padded)[3]).toBeCloseTo(h + 8, 3)
  })

  it('clips and scrolls, and reports what is visible', async () => {
    const { world, frame } = await uiApp()
    const r = root(world, 400, 400)
    world.set(r, UiNode, { alignItems: 'start' })
    const list = node(world, r, [
      UiNode,
      { width: 200, height: 100, overflow: 'scroll', direction: 'column' },
    ])
    const items = Array.from({ length: 5 }, () =>
      node(world, list, [UiNode, { height: 40, shrink: 0 }]),
    )
    frame()
    expect(world.get(list, UiLayout).content).toEqual([200, 200])
    expect(world.get(items[3]!, UiLayout).clip[3]).toBe(0)
    world.set(list, UiNode, { scroll: [0, 70] })
    frame()
    expect(rect(world, items[2]!)).toEqual([0, 10, 200, 40])
    expect(world.get(items[3]!, UiLayout).clip).toEqual([0, 50, 200, 40])
    // Past the end, scroll clamps to the content.
    world.set(list, UiNode, { scroll: [0, 500] })
    frame()
    expect(rect(world, items[4]!)[1]).toBe(60)
  })

  it('reports nodes outside a root and unknown styles', async () => {
    const { world, frame } = await uiApp()
    const lost = world.spawn([UiNode, { width: 10 }])
    const r = root(world)
    world.set(r, UiRoot, {
      theme: world.resource(UiThemes).add(new UiThemeAsset(null, { panel: {} })),
    })
    node(world, r, [UiNode, { style: 'pannel' }], [UiStyle, {}])
    frame()
    expect(world.get(lost, UiLayout).visible).toBe(false)
    const warnings = world
      .resource(LogResource)
      .tail(100)
      .map((e) => e.message)
    expect(warnings.some((m) => m.startsWith('ui/no-root'))).toBe(true)
    expect(warnings.some((m) => m.startsWith('ui/unknown-style'))).toBe(true)
    expect(describeUi(world).problems[0]).toMatchObject({ code: 'ui/no-root', entity: lost })
  })
})

describe('interaction', () => {
  const Controls = defineActions('test/Controls', {
    fire: { kind: 'button', bindings: ['Mouse:Left', 'Key:KeyF'] },
  })

  async function hud() {
    const env = await uiApp()
    const { world } = env
    addActions(world, Controls)
    const r = root(world, 800, 600)
    const button = node(
      world,
      r,
      [UiNode, { width: 100, height: 40, margin: [10, 0, 0, 10] }],
      UiButton,
    )
    const panel = node(
      world,
      r,
      [UiNode, { width: 200, height: 100 }],
      [UiStyle, { background: [0, 0, 0, 0.5] }],
    )
    let fired = 0
    env.app.addSystems(
      FixedUpdate,
      defineSystem({
        name: 'test/fire',
        run: (_, w) => {
          if (w.resource(Controls.resource).justPressed('fire')) fired++
        },
      }),
    )
    return { ...env, button, panel, r, fired: () => fired }
  }

  it("a pointer click on a button sends UiClick and doesn't reach gameplay or world picks", async () => {
    const { world, frame, button, fired } = await hud()
    frame()
    const clicks = world.reader(UiClick)
    clicks.read()
    click(world, frame, 50, 30)
    expect(clicks.read().map((e) => e.entity)).toEqual([button])
    expect(fired()).toBe(0)
    // Off the UI, the same click fires.
    click(world, frame, 600, 500)
    expect(clicks.read()).toEqual([])
    expect(fired()).toBe(1)
  })

  it('a panel with a background takes the pointer; hover and press show in UiInteraction', async () => {
    const { world, frame, button, fired } = await hud()
    frame()
    click(world, frame, 150, 80)
    expect(fired()).toBe(0)
    mouse(world, 50, 30)
    frame()
    expect(world.get(button, UiInteraction).state).toBe('hovered')
    injectInput(world, { mouse: 'left', pressed: true })
    frame()
    expect(world.get(button, UiInteraction).state).toBe('pressed')
    expect(world.resource(UiPointer).overUi).toBe(true)
    // Dragging off and releasing doesn't click.
    mouse(world, 500, 500)
    frame()
    expect(world.get(button, UiInteraction).state).toBe('hovered')
    const clicks = world.reader(UiClick)
    clicks.read()
    injectInput(world, { mouse: 'left', pressed: false })
    frame()
    expect(clicks.read()).toEqual([])
    expect(world.get(button, UiInteraction).state).toBe('none')
  })

  it('ui.click sends UiClick by path, and flips toggles', async () => {
    const { app, world, frame, button } = await hud()
    const toggle = node(world, null, [UiNode, { width: 20, height: 20 }], UiToggle)
    world.add(toggle, ChildOf, { parent: button })
    frame()
    const clicks = world.reader(UiClick)
    const changes = world.reader(UiChanged)
    const method = uiMethods.find((m) => m.name === 'ui.click')!
    method.handler({ app, world }, { entity: button })
    method.handler({ app, world }, { entity: toggle })
    expect(clicks.read().map((e) => e.entity)).toEqual([button, toggle])
    expect(changes.read().map((e) => e.entity)).toEqual([toggle])
    expect(world.get(toggle, UiToggle).on).toBe(true)
    world.set(button, UiButton, { disabled: true })
    frame()
    expect(() => method.handler({ app, world }, { entity: button })).toThrow(/disabled/)
    expect(() => method.handler({ app, world }, { entity: 'nothing' })).toThrow(/No UI node/)
  })

  it('moves gamepad focus in all four directions through a 3×3 grid', async () => {
    const { world, frame } = await uiApp()
    const r = root(world, 600, 600)
    world.set(r, UiNode, { justify: 'center', alignItems: 'center' })
    const grid = node(world, r, [UiNode, { wrap: true, width: 300 }])
    const cells = Array.from({ length: 9 }, () =>
      node(world, grid, [UiNode, { width: 80, height: 80, margin: [10, 10, 10, 10] }], UiButton),
    )
    frame()
    const pad = (button: string) => {
      const buttons = new Array(17).fill(0)
      const index = [
        'South',
        'East',
        'West',
        'North',
        'LeftBumper',
        'RightBumper',
        'LeftTrigger',
        'RightTrigger',
        'Select',
        'Start',
        'LeftStickPress',
        'RightStickPress',
        'DpadUp',
        'DpadDown',
        'DpadLeft',
        'DpadRight',
        'Home',
      ].indexOf(button)
      buttons[index] = 1
      injectInput(world, {
        type: 'gamepad',
        index: 0,
        connected: true,
        buttons,
        axes: [0, 0, 0, 0],
      })
      frame()
      injectInput(world, {
        type: 'gamepad',
        index: 0,
        connected: true,
        buttons: new Array(17).fill(0),
        axes: [0, 0, 0, 0],
      })
      frame()
    }
    const focused = () => cells.indexOf(world.resource(UiPointer).focused!)
    world.resource(UiPointer).focused = cells[4]!
    frame()
    expect(world.get(cells[4]!, UiInteraction).focused).toBe(true)
    pad('DpadUp')
    expect(focused()).toBe(1)
    pad('DpadLeft')
    expect(focused()).toBe(0)
    pad('DpadDown')
    expect(focused()).toBe(3)
    pad('DpadDown')
    expect(focused()).toBe(6)
    pad('DpadRight')
    expect(focused()).toBe(7)
    pad('DpadRight')
    expect(focused()).toBe(8)
    pad('DpadRight')
    expect(focused()).toBe(8)
    pad('DpadUp')
    expect(focused()).toBe(5)
    const clicks = world.reader(UiClick)
    clicks.read()
    pad('South')
    expect(clicks.read().map((e) => e.entity)).toEqual([cells[5]])
    pad('East')
    expect(world.resource(UiPointer).focused).toBeNull()
  })

  it('Tab focuses widgets in order; typing edits a focused field and pauses gameplay actions', async () => {
    const { world, frame, button, fired } = await hud()
    const field = node(
      world,
      null,
      [UiNode, { width: 100, height: 20 }],
      [UiTextInput, { maxLength: 5 }],
      [UiText, {}],
    )
    world.add(field, ChildOf, { parent: world.resource(UiState).roots[0]?.entity ?? button })
    frame()
    injectInput(world, { key: 'Tab', pressed: true })
    frame()
    injectInput(world, { key: 'Tab', pressed: false })
    expect(world.resource(UiPointer).focused).toBe(button)
    injectInput(world, { key: 'Tab', pressed: true })
    frame()
    injectInput(world, { key: 'Tab', pressed: false })
    expect(world.resource(UiPointer).focused).toBe(field)
    const changes = world.reader(UiChanged)
    injectInput(world, { key: 'KeyF', pressed: true })
    injectInput(world, { type: 'text', text: 'fuel!!' })
    frame()
    injectInput(world, { key: 'KeyF', pressed: false })
    frame()
    expect(world.get(field, UiTextInput).value).toBe('fuel!')
    expect(changes.read().length).toBe(1)
    expect(fired()).toBe(0)
    injectInput(world, { type: 'text', text: '\b' })
    frame()
    expect(world.get(field, UiTextInput).value).toBe('fuel')
    injectInput(world, { key: 'Enter', pressed: true })
    frame()
    expect(world.resource(UiPointer).focused).toBeNull()
    injectInput(world, { key: 'Enter', pressed: false })
    injectInput(world, { key: 'KeyF', pressed: true })
    frame()
    frame()
    expect(fired()).toBe(1)
  })

  it('drags sliders, steps them from focus, and scrolls with the wheel', async () => {
    const { world, frame } = await uiApp()
    const r = root(world, 400, 400)
    world.set(r, UiNode, { alignItems: 'start', direction: 'column' })
    const slider = node(
      world,
      r,
      [UiNode, { width: 200, height: 20 }],
      [UiSlider, { min: 0, max: 10, step: 1 }],
    )
    const list = node(world, r, [
      UiNode,
      { width: 100, height: 50, overflow: 'scroll', direction: 'column' },
    ])
    for (let i = 0; i < 4; i++) node(world, list, [UiNode, { height: 30, shrink: 0 }])
    frame()
    mouse(world, 70, 10)
    frame()
    injectInput(world, { mouse: 'left', pressed: true })
    frame()
    expect(world.get(slider, UiSlider).value).toBe(4)
    mouse(world, 190, 10)
    frame()
    expect(world.get(slider, UiSlider).value).toBe(10)
    injectInput(world, { mouse: 'left', pressed: false })
    frame()
    world.resource(UiPointer).focused = slider
    injectInput(world, { key: 'ArrowLeft', pressed: true })
    frame()
    expect(world.get(slider, UiSlider).value).toBe(9)
    injectInput(world, { key: 'ArrowLeft', pressed: false })
    mouse(world, 50, 40)
    injectInput(world, { type: 'wheel', dx: 0, dy: 25 })
    frame()
    expect(world.get(list, UiNode).scroll).toEqual([0, 25])
    injectInput(world, { type: 'wheel', dx: 0, dy: 400 })
    frame()
    expect(world.get(list, UiNode).scroll).toEqual([0, 70])
  })
})

describe('anchors', () => {
  it('tracks an entity, clamps to the edge when behind the camera, and hides with hideBehind', async () => {
    const { world, frame } = await uiApp()
    const eye: [number, number, number] = [0, 0, 10]
    world.spawn([Camera3d, { fovY: 90 }], [Transform, { translation: eye }])
    const planet = world.spawn([Transform, { translation: [0, 0, 0] }])
    const r = root(world, 800, 600)
    const marker = node(
      world,
      r,
      [UiNode, { width: 20, height: 20 }],
      [UiAnchor, { target: planet, clamp: true, margin: 16 }],
    )
    const arrow = node(world, marker, [UiNode, { width: 10, height: 10 }], UiAnchorArrow)
    frame()
    // Straight ahead: the center of the screen.
    expect(rect(world, marker)).toEqual([390, 290, 20, 20])
    expect(world.get(marker, UiLayout)).toMatchObject({ anchor: 'on-screen', distance: 10 })
    expect(world.get(arrow, UiLayout).visible).toBe(false)
    // 45° right at fov 90 and aspect 4:3: x = 0.5 + 0.5 / (4/3) of the width.
    world.set(planet, Transform, { translation: [10, 0, 0] })
    frame()
    expect(rect(world, marker)[0]).toBeCloseTo(400 + 300 - 10, 1)
    const store = world.resource(UiState)
    expect(store.layouts).toBe(0)
    expect(store.repositions).toBe(1)
    // Behind and to the left: clamped to the left edge, arrow pointing left.
    world.set(planet, Transform, { translation: [-3, 0, 20] })
    frame()
    const l = world.get(marker, UiLayout)
    expect(l.anchor).toBe('clamped')
    expect(l.x + l.width / 2).toBeCloseTo(16, 3)
    expect(world.get(arrow, UiLayout).visible).toBe(true)
    expect(Math.abs(world.get(arrow, UiLayout).angle)).toBeCloseTo(Math.PI, 3)
    // It sits outside the marker, on the side facing the target.
    const a = world.get(arrow, UiLayout)
    expect(a.x + a.width).toBeLessThan(l.x)
    expect(a.y + a.height / 2).toBeCloseTo(l.y + l.height / 2, 3)
    // hideBehind wins.
    world.set(marker, UiAnchor, { hideBehind: true })
    frame()
    expect(world.get(marker, UiLayout)).toMatchObject({ anchor: 'hidden', visible: false })
    // Off to the side (in front) it clamps to that edge.
    world.set(planet, Transform, { translation: [100, 0, 0] })
    frame()
    expect(world.get(marker, UiLayout).anchor).toBe('clamped')
    expect(rect(world, marker)[0]! + 10).toBeCloseTo(800 - 16, 3)
  })

  it('scales by distance', async () => {
    const { world, frame } = await uiApp()
    world.spawn(
      [Camera3d, {}],
      [Transform, { translation: [0, 0, 0], rotation: lookAt([0, 0, 0], [0, 0, -1]) as never }],
    )
    const target = world.spawn([Transform, { translation: [0, 0, -20] }])
    const r = root(world, 800, 600)
    const marker = node(
      world,
      r,
      [UiNode, { width: 40, height: 20 }],
      [UiAnchor, { target, scaleDistance: 10, minScale: 0.25, maxScale: 2 }],
    )
    frame()
    expect(world.get(marker, UiLayout)).toMatchObject({ width: 20, height: 10, scale: 0.5 })
    world.set(target, Transform, { translation: [0, 0, -2] })
    frame()
    expect(world.get(marker, UiLayout).scale).toBe(2)
  })
})

describe('themes', () => {
  it('styles nodes by name, with state variants, and restyles when the theme changes', async () => {
    const { world, frame } = await uiApp()
    const themes = world.resource(UiThemes)
    const theme = UiThemeAsset.fromJson({
      styles: {
        button: { background: '#203040', radius: [6, 6, 6, 6] },
        'button:hovered': { background: '#406080' },
        label: { size: 24 },
      },
    })
    const ref = themes.add(theme)
    const r = root(world, 400, 300, { theme: ref })
    world.set(r, UiNode, { alignItems: 'start', direction: 'column' })
    const button = node(
      world,
      r,
      [UiNode, { width: 100, height: 30, style: 'button' }],
      UiButton,
      UiStyle,
    )
    const fontRef = addFont(world)
    const label = node(
      world,
      r,
      [UiNode, { style: 'label' }],
      [UiText, { text: 'Hi', font: fontRef }],
    )
    const own = node(
      world,
      r,
      [UiNode, { style: 'label' }],
      [UiText, { text: 'Hi', font: fontRef, size: 10 }],
    )
    frame()
    expect(rect(world, label)[3]).toBeCloseTo(24 * 1.2, 3)
    expect(rect(world, own)[3]).toBeCloseTo(10 * 1.2, 3)
    // A panel with a theme background takes the pointer like one with its own.
    mouse(world, 50, 15)
    frame()
    expect(world.get(button, UiInteraction).state).toBe('hovered')
    // Hot reload: the theme object updates in place and bumps its version.
    theme.copyFrom(UiThemeAsset.fromJson({ styles: { label: { size: 40 } } }))
    frame()
    expect(rect(world, label)[3]).toBeCloseTo(48, 3)
  })

  it('validates theme files field by field', () => {
    const errors = (json: unknown) => UiThemesSchemaErrors(json)
    expect(errors({ styles: { panel: { background: '#ff0000' } } })).toEqual([])
    expect(errors({ styles: { panel: { backgroud: '#ff0000' } } })).toEqual([
      'schema/unknown-field',
    ])
    expect(errors({ styles: { 'panel:hover': {} } })).toEqual(['ui/unknown-state'])
    expect(errors({ styles: { panel: { radius: 4 } } })).toEqual(['schema/type-mismatch'])
  })
})

import { UiThemeSchema } from './theme'

function UiThemesSchemaErrors(json: unknown): string[] {
  return UiThemeSchema.validate(json).map((e) => e.code)
}

describe('performance', () => {
  it('lays out 2,000 nodes in under 1 ms, and does nothing on an unchanged frame', async () => {
    const { world, frame } = await uiApp()
    const profiler = world.resource(ProfilerResource)
    const r = root(world, 1920, 1080)
    world.set(r, UiNode, { direction: 'column', padding: [8, 8, 8, 8], gap: [0, 4] })
    // 100 rows of 19 cells: rows wrap, cells grow and shrink, some percent widths.
    const cells: number[] = []
    for (let row = 0; row < 100; row++) {
      const line = node(world, r, [UiNode, { wrap: true, gap: [4, 4], padding: [2, 2, 2, 2] }])
      for (let c = 0; c < 19; c++) {
        cells.push(
          node(world, line, [
            UiNode,
            c % 3 === 0
              ? { width: '5%', height: 12 }
              : { width: 60 + (c % 5) * 10, height: 12, grow: c % 2 },
          ]),
        )
      }
    }
    frame()
    expect(world.resource(UiState).roots[0]!.count).toBe(2001)
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 20; i++) {
      world.set(cells[i * 7]!, UiNode, { width: 50 + (i % 4) })
      frame()
      expect(world.resource(UiState).layouts).toBe(1)
      best = Math.min(best, profiler.timing('ui/layout')!.last)
    }
    console.info(`ui/layout, 2,001 nodes: ${best.toFixed(3)} ms`)
    expect(best).toBeLessThan(budget(1))
    frame()
    const store = world.resource(UiState)
    expect(store.layouts).toBe(0)
    expect(store.nodesLaidOut).toBe(0)
    expect(profiler.timing('ui/layout')!.last).toBeLessThan(budget(0.2))
  })
})
