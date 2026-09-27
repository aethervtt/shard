/** Test helpers (not exported from the package): a headless UI app and entity builders. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChildOf, type ComponentDef, type Entity, type World } from '@aethervtt/shard-core'
import { injectInput, inputPlugin } from '@aethervtt/shard-input'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import { type Font, Fonts, fontFromBytes } from '@aethervtt/shard-text'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { UiLayout, UiNode, UiRoot } from './components'
import { uiPlugin } from './plugin'

const here = dirname(fileURLToPath(import.meta.url))
let inter: Font | undefined

/** Inter (latin), built once per test file. */
export function interFont(): Font {
  inter ??= fontFromBytes(
    new Uint8Array(readFileSync(resolve(here, '../../text/fixtures/Inter-Regular.ttf'))),
    {
      charset: 'latin',
    },
  )
  return inter
}

export async function uiApp(extra: Plugin[] = []) {
  const app = new App().addPlugin(TransformPlugin, inputPlugin(), uiPlugin, ...extra)
  await app.init()
  const world = app.world
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) app.update(1 / 60)
  }
  return { app, world, frame }
}

type Init = [ComponentDef, Record<string, unknown>?]

/** Spawns a node under `parent` (a UiNode is added if absent). */
export function node(
  world: World,
  parent: Entity | null,
  ...components: (ComponentDef | Init)[]
): Entity {
  const list = components.map((c) => (Array.isArray(c) ? c : ([c] as Init)))
  if (!list.some(([def]) => def === UiNode)) list.unshift([UiNode, {}])
  const e = world.spawn(...(list as never[]))
  if (parent !== null) world.add(e, ChildOf, { parent })
  return e
}

/** A root at a reference size (headless, that's its size). */
export function root(
  world: World,
  width = 800,
  height = 600,
  fields: Record<string, unknown> = {},
): Entity {
  return world.spawn([UiRoot, { referenceSize: [width, height], ...fields }] as never)
}

export function rect(world: World, e: Entity): number[] {
  const l = world.get(e, UiLayout)
  return [l.x, l.y, l.width, l.height].map((v) => Math.round(v * 100) / 100)
}

export function addFont(world: World) {
  return world.resource(Fonts).add(interFont())
}

export function mouse(world: World, x: number, y: number) {
  injectInput(world, { type: 'mouse-move', x, y, dx: 0, dy: 0 })
}

export function click(world: World, frame: () => void, x: number, y: number) {
  mouse(world, x, y)
  frame()
  injectInput(world, { mouse: 'left', pressed: true })
  frame()
  injectInput(world, { mouse: 'left', pressed: false })
  frame()
}
