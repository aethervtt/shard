import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AssetRef, ChildOf, type Entity } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Grid, gridPlugin } from '@aethervtt/shard-grid'
import { box, cylinder, plane } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  Gpu,
  GroundLayer,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  OffscreenTarget,
  RenderLayers,
  RenderTargets,
  renderPlugin,
  Tonemapping,
  worldToScreen,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, pngBytes, renderView, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Floor, Opening, structurePlugin, Wall } from '@aethervtt/shard-structure'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vectorPlugin } from './plugin'
import { VectorShape } from './shape'

// The tabletop parity fixture (0057): floor, tiles, grid, drawings, flat tokens, fog, walls and
// props on one scene, seen by a Map camera (flat token discs) and a Tabletop camera (standees).

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** Layer 1 is shared; each view adds its own visuals' layer. */
const SHARED = 1
const MAP = 2
const TABLETOP = 4

async function parity() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    structurePlugin,
    gridPlugin,
    vectorPlugin,
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'parity', width: 160, height: 120 })
  const ref = world.resource(RenderTargets).add(target, 'parity') as AssetRef<'RenderTarget'>
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const mat = (baseColor: [number, number, number, number], roughness = 0.8) =>
    materials.add(new MaterialAsset({ baseColor, roughness })) as AssetRef<'Material'>
  world.resource(AmbientLight).brightness = 1500
  world.spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: true, shadowUpdate: 'on-change' }],
    [Transform, { rotation: lookAt([-4, 10, 3], [0, 0, 0]) }],
  )
  // Floor and walls (0055), with a door and a window.
  world.spawn([
    Floor,
    {
      points: [
        [-10, -8],
        [10, -8],
        [10, 8],
        [-10, 8],
      ],
      material: mat([0.22, 0.21, 0.2, 1]),
    },
  ])
  const stone = mat([0.7, 0.68, 0.64, 1])
  const walls = [
    [
      [-10, -8],
      [10, -8],
    ],
    [
      [10, -8],
      [10, 8],
    ],
    [
      [-10, 8],
      [-10, -8],
    ],
    [
      [-3, -8],
      [-3, 2],
    ],
  ] as const
  const wallEntities: Entity[] = walls.map(([a, b]) =>
    world.spawn([Wall, { a: [...a], b: [...b], height: 2.5, thickness: 0.25, material: stone }]),
  )
  world.spawn([
    Opening,
    { wall: wallEntities[3]!, kind: 'door', offset: 5, width: 1.2, state: 'open' },
  ])
  world.spawn([
    Opening,
    { wall: wallEntities[1]!, kind: 'window', offset: 6, width: 2, sill: 1, height: 1 },
  ])
  // Tiles (band 10): a patch of quads, standing in for 0059.
  const quad = meshes.add(plane({ size: 1 }))
  const tile = mat([0.45, 0.28, 0.14, 1])
  for (let x = 0; x < 4; x++)
    for (let z = 0; z < 3; z++)
      world.spawn(
        [Mesh3d, { mesh: quad }],
        [MeshMaterial, { material: tile }],
        [GroundLayer, { band: 10 }],
        NotShadowCaster,
        [Transform, { translation: [1 + x * 1.5, 0, -6 + z * 1.5], scale: [1.4, 1, 1.4] }],
      )
  // The grid (band 20).
  world.spawn(
    [Grid, { size: 1.5, color: [1, 1, 1, 1], opacity: 0.35, lineWidth: 1, extent: [20, 16] }],
    Transform,
  )
  // Drawings (band 30): a filled polygon over the tiles, a pen stroke, an ellipse outline.
  world.spawn(
    [
      VectorShape,
      {
        geometry: {
          kind: 'polygon',
          outer: [
            [0, 0],
            [4, 0],
            [5, 3],
            [1, 4],
          ],
        },
        fill: [0.1, 0.3, 1, 1],
        fillOpacity: 0.7,
        stroke: [0.1, 0.3, 1, 1],
        strokeWidth: 2,
        strokeUnits: 'css-px',
      },
    ],
    [Transform, { translation: [2, 0, -6] }],
  )
  const pen: [number, number][] = []
  for (let i = 0; i <= 40; i++) pen.push([i * 0.25, Math.sin(i * 0.4) * 1.2])
  world.spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'pen', points: pen },
        stroke: [1, 0.15, 0.1, 1],
        strokeWidth: 3,
        strokeUnits: 'css-px',
      },
    ],
    [Transform, { translation: [-1, 0, 3] }],
  )
  world.spawn(
    [
      VectorShape,
      {
        geometry: { kind: 'ellipse', rx: 2, ry: 1.2 },
        stroke: [1, 0.9, 0.1, 1],
        strokeWidth: 0.12,
      },
    ],
    [Transform, { translation: [6, 0, 3] }],
  )
  // Tokens: a logical root, a flat disc for the Map (band 40), a standee for the Tabletop.
  const disc = meshes.add(cylinder({ radius: 0.5, height: 0.02 }))
  const standee = meshes.add(box({ x: 0.15, y: 1.6, z: 0.9 }))
  const tokenMat = mat([0.9, 0.35, 0.1, 1], 0.5)
  const tokens: Entity[] = []
  for (const [x, z] of [
    [3.5, -4.5],
    [-1.5, 3],
    [6, 2],
    [-6, -2],
  ] as const) {
    const root = world.spawn([Transform, { translation: [x, 0, z] }])
    world.spawn(
      [Mesh3d, { mesh: disc }],
      [MeshMaterial, { material: tokenMat }],
      [RenderLayers, { mask: MAP }],
      [GroundLayer, { band: 40 }],
      NotShadowCaster,
      Transform,
      [ChildOf, { parent: root }],
    )
    world.spawn(
      [Mesh3d, { mesh: standee }],
      [MeshMaterial, { material: tokenMat }],
      [RenderLayers, { mask: TABLETOP }],
      [Transform, { translation: [0, 0.8, 0] }],
      [ChildOf, { parent: root }],
    )
    tokens.push(root)
  }
  // Fog (band 50): the same tessellator, a dark fill over the east side.
  world.spawn(
    [
      VectorShape,
      {
        geometry: {
          kind: 'polygon',
          outer: [
            [0, 0],
            [4, 0],
            [4, 6],
            [0, 6],
          ],
          holes: [
            [
              [1, 2],
              [3, 2],
              [3, 4],
              [1, 4],
            ],
          ],
        },
        fill: [0, 0, 0, 1],
        fillOpacity: 0.75,
        strokeWidth: 0,
      },
    ],
    [GroundLayer, { band: 50 }],
    [Transform, { translation: [5.5, 0, -3] }],
  )
  // Props: boxes and a pillar.
  const propMat = mat([0.3, 0.5, 0.35, 1])
  for (const [x, z, s] of [
    [-7, -5, 1],
    [-6, 5, 0.8],
    [8.5, 6.5, 1.2],
  ] as const)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: s, y: s, z: s })) }],
      [MeshMaterial, { material: propMat }],
      [Transform, { translation: [x, s / 2, z] }],
    )
  const camera = (layers: number, orthographic: boolean) =>
    world.spawn(
      [
        Camera3d,
        {
          target: ref,
          fovY: 45,
          layers,
          active: false,
          clearColor: [0.02, 0.02, 0.03, 1],
          ...(orthographic
            ? { projection: 'orthographic' as const, orthoHeight: 18, far: 200 }
            : {}),
        },
      ],
      [Exposure, { ev100: 12.5 }],
      [Tonemapping, { dither: false }],
      Transform,
    )
  const map = camera(SHARED | MAP, true)
  const tabletop = camera(SHARED | TABLETOP, false)
  return { app, world, target, map, tabletop, tokens }
}

describe('tabletop parity fixture', () => {
  it('keeps band order at 30°, 55° and top-down in both views, and walls hide the bands', {
    timeout: 120_000,
  }, async () => {
    const r = await parity()
    const { world } = r
    const pose = (cam: Entity, angle: 'top' | 30 | 55) => {
      const distance = cam === r.map ? 30 : 22
      const pitch = angle === 'top' ? 89.99 : angle
      const a = (pitch * Math.PI) / 180
      const eye: [number, number, number] = [0, Math.sin(a) * distance, Math.cos(a) * distance]
      world.set(cam, Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) })
    }
    for (const view of ['map', 'tabletop'] as const) {
      const cam = view === 'map' ? r.map : r.tabletop
      world.set(r.map, Camera3d, { active: view === 'map' })
      world.set(r.tabletop, Camera3d, { active: view === 'tabletop' })
      for (const angle of ['top', 55, 30] as const) {
        pose(cam, angle)
        await settle(r.app)
        const image = await renderView(r.app, `camera:${cam}`)
        const name = `parity-${view}-${angle}`
        if (process.env.SHARD_GOLDEN_OUT)
          writeFileSync(
            `${process.env.SHARD_GOLDEN_OUT}/${name}.png`,
            pngBytes(image.data, image.width, image.height),
          )
        const at = (p: [number, number, number]) => {
          const css = [0, 0]
          expect(worldToScreen(world, cam, p, css)).toBe(true)
          return pixel(image, Math.floor(css[0]!), Math.floor(css[1]!))
        }
        if (view === 'map') {
          // A disc (band 40) over the drawing polygon (band 30) over the tiles (band 10).
          const token = at([3.5, 0, -4.5])
          expect(token[0]!, name).toBeGreaterThan(token[2]! + 40)
          // The polygon's fill over the tiles: blue wins.
          const drawing = at([4.2, 0, -5.2])
          expect(drawing[2]!, name).toBeGreaterThan(drawing[0]!)
          // Fog (band 50) darkens the token under it; one in the open isn't.
          const fogged = at([6, 0, 2])
          const clear = at([-6, 0, -2])
          expect(fogged[0]! + 30, name).toBeLessThan(clear[0]!)
        }
        expect(compareGolden(here, name, image).mean, name).toBeLessThan(1.5)
      }
    }
    expect(world.resource(Gpu).errors).toEqual([])
    await r.app.dispose()
    r.target.destroy()
  })
})
