import type { Entity, World } from '@aethervtt/shard-core'
import { box, cone, cylinder, plane, sphere } from '@aethervtt/shard-mesh'
import {
  AutoExposure,
  Camera3d,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { CloudMotion, Clouds, Sky, SkyFrame, setTimeOfDay, TimeOfDay } from '@aethervtt/shard-sky'
import { Transform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'

/**
 * Sky, time of day and clouds (specs 0130, 0131) in a realistic scene: a field with a house, a
 * few trees and props under a sky that runs through the day. The panel sets the time, its speed,
 * the sky mode, cloud coverage and type, and night brightness. URL parameters set the same things
 * (time, speed, mode, coverage, type, night, aurora, path, wind, look).
 */

const query = new URLSearchParams(location.search)
const num = (key: string, fallback: number) => {
  const v = query.get(key)
  return v === null || v === '' ? fallback : Number(v)
}

type Vec3 = [number, number, number]
let skyEntity: Entity | undefined

function material(world: World, color: [number, number, number], roughness = 0.8, metallic = 0) {
  return world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [...color, 1], roughness, metallic }))
}

const meshesOf = (world: World) => world.resource(Meshes)

function spawnMesh(
  world: World,
  mesh: ReturnType<ReturnType<typeof meshesOf>['add']>,
  mat: ReturnType<typeof material>,
  translation: Vec3,
  scale: Vec3 = [1, 1, 1],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
) {
  world.spawn(
    [Mesh3d, { mesh }],
    [MeshMaterial, { material: mat }],
    [Transform, { translation, scale, rotation }],
  )
}

function scene(world: World): void {
  const meshes = world.resource(Meshes)
  const ground = material(world, [0.2, 0.26, 0.12], 0.95)
  spawnMesh(world, meshes.add(plane({ size: 6000, subdivisions: 4 })), ground, [0, 0, 0])
  const path = material(world, [0.42, 0.38, 0.32], 0.9)
  spawnMesh(world, meshes.add(box({ x: 3, y: 0.04, z: 60 })), path, [0, 0.02, -10])

  // A house: walls, a pitched roof, a door and windows.
  const wall = material(world, [0.78, 0.74, 0.66], 0.85)
  const roof = material(world, [0.36, 0.17, 0.12], 0.7)
  const dark = material(world, [0.05, 0.05, 0.06], 0.3)
  const unit = meshes.add(box({ x: 1, y: 1, z: 1 }))
  spawnMesh(world, unit, wall, [6, 2, -14], [8, 4, 6])
  const s = Math.SQRT1_2
  const tilt = Math.sin(Math.PI / 8)
  const tc = Math.cos(Math.PI / 8)
  spawnMesh(world, unit, roof, [6, 4.9, -15.6], [8.6, 0.25, 3.8], [tilt, 0, 0, tc])
  spawnMesh(world, unit, roof, [6, 4.9, -12.4], [8.6, 0.25, 3.8], [-tilt, 0, 0, tc])
  spawnMesh(world, unit, dark, [4.5, 1.1, -10.98], [1.1, 2.2, 0.05])
  spawnMesh(world, unit, dark, [7.6, 2.4, -10.98], [1.4, 1.1, 0.05])
  spawnMesh(world, unit, dark, [2.2, 2.4, -10.98], [1.2, 1.1, 0.05])
  void s

  // Trees: trunks and two cones each.
  const trunk = material(world, [0.25, 0.17, 0.1], 0.9)
  const leaves = material(world, [0.1, 0.2, 0.07], 0.85)
  const trunkMesh = meshes.add(cylinder({ radius: 0.25, height: 3 }))
  const crown = meshes.add(cone({ radius: 2.2, height: 5 }))
  const trees: Vec3[] = [
    [-8, 0, -18],
    [-12, 0, -26],
    [-5, 0, -32],
    [14, 0, -28],
    [20, 0, -20],
    [-18, 0, -12],
    [-26, 0, -40],
    [28, 0, -45],
  ]
  for (const [x, , z] of trees) {
    const k = 0.8 + ((x * 13 + z * 7) % 5) * 0.1
    spawnMesh(world, trunkMesh, trunk, [x, 1.5 * k, z], [k, k, k])
    spawnMesh(world, crown, leaves, [x, 4.5 * k, z], [k, k, k])
    spawnMesh(world, crown, leaves, [x, 6.2 * k, z], [k * 0.75, k * 0.8, k * 0.75])
  }

  // Props to read light and reflections by.
  const metal = material(world, [0.9, 0.9, 0.92], 0.15, 1)
  const red = material(world, [0.7, 0.12, 0.08], 0.5)
  const ball = meshes.add(sphere({ radius: 0.8 }))
  spawnMesh(world, ball, metal, [-2.5, 0.8, -6])
  spawnMesh(world, ball, red, [-0.5, 0.8, -4.5])
  spawnMesh(world, unit, wall, [-4, 0.5, -4], [1, 1, 1])
  spawnMesh(world, unit, wall, [-4.6, 1.5, -4.2], [1, 1, 1])
}

function addControls(world: World): void {
  const panel = document.getElementById('panel')
  if (!panel) return
  const box = document.createElement('div')
  box.style.cssText =
    'display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;margin-top:8px;font:12px monospace;align-items:center'
  panel.appendChild(box)
  const row = (label: string, input: HTMLElement, out?: HTMLElement) => {
    const l = document.createElement('span')
    l.textContent = label
    box.append(l, input, out ?? document.createElement('span'))
  }
  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    format = (v: number) => v.toFixed(2),
  ) => {
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(get())
    const out = document.createElement('span')
    out.textContent = format(get())
    input.addEventListener('input', () => {
      set(Number(input.value))
      out.textContent = format(Number(input.value))
    })
    row(label, input, out)
    return { input, out }
  }
  const select = (
    label: string,
    options: string[],
    get: () => string,
    set: (v: string) => void,
  ) => {
    const el = document.createElement('select')
    for (const o of options) el.add(new Option(o, o, o === get(), o === get()))
    el.addEventListener('change', () => set(el.value))
    row(label, el)
  }
  const sky = () => world.get(skyEntity!, Sky)
  const clouds = () => world.get(skyEntity!, Clouds)
  const time = slider(
    'time',
    0,
    24,
    0.05,
    () => world.resource(TimeOfDay).hours,
    (v) => setTimeOfDay(world, v),
    (v) =>
      `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.floor((v % 1) * 60)).padStart(2, '0')}`,
  )
  // Keep the time slider moving with the clock.
  setInterval(() => {
    if (document.activeElement === time.input) return
    const h = world.resource(TimeOfDay).hours
    time.input.value = String(h)
    time.out.textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`
  }, 250)
  select(
    'speed',
    ['paused', '1×', '10×', '60×', '300×'],
    () => speedLabel(world),
    (v) => {
      const c = world.resource(TimeOfDay)
      c.paused = v === 'paused'
      c.speed = v === 'paused' ? 1 : Number(v.replace('×', ''))
    },
  )
  select(
    'mode',
    ['volumetric', '2d', 'none'],
    () => sky().mode,
    (v) => world.set(skyEntity!, Sky, { mode: v } as never),
  )
  select(
    'path',
    ['simple', 'real'],
    () => sky().path,
    (v) => world.set(skyEntity!, Sky, { path: v } as never),
  )
  slider(
    'coverage',
    0,
    1,
    0.01,
    () => clouds().coverage,
    (v) => world.set(skyEntity!, Clouds, { coverage: v } as never),
  )
  slider(
    'type',
    0,
    1,
    0.01,
    () => clouds().type,
    (v) => world.set(skyEntity!, Clouds, { type: v } as never),
  )
  slider(
    'density',
    0.002,
    0.08,
    0.001,
    () => clouds().density,
    (v) => world.set(skyEntity!, Clouds, { density: v } as never),
    (v) => v.toFixed(3),
  )
  slider(
    'wind',
    0,
    30,
    0.5,
    () => world.resource(Wind).speed,
    (v) => {
      world.resource(Wind).speed = v
    },
    (v) => `${v.toFixed(1)} m/s`,
  )
  slider(
    'night',
    1,
    40,
    0.5,
    () => sky().nightBrightness,
    (v) => world.set(skyEntity!, Sky, { nightBrightness: v } as never),
    (v) => v.toFixed(1),
  )
  slider(
    'aurora',
    0,
    3,
    0.05,
    () => sky().aurora,
    (v) => world.set(skyEntity!, Sky, { aurora: v } as never),
  )
  const shadows = document.createElement('input')
  shadows.type = 'checkbox'
  shadows.checked = true
  shadows.addEventListener('change', () =>
    world.set(skyEntity!, Clouds, { shadows: shadows.checked } as never),
  )
  row('cloud shadows', shadows)
}

function speedLabel(world: World): string {
  const c = world.resource(TimeOfDay)
  if (c.paused) return 'paused'
  return `${c.speed}×`
}

export const weatherDemoPlugin = definePlugin({
  name: 'weather-demo',
  dependencies: ['render/forward', 'sky'],
  build() {},
  ready(app) {
    const world = app.world
    const clock = world.resource(TimeOfDay)
    const speed = query.get('speed')
    clock.paused = speed === '0' || speed === 'paused'
    clock.speed = speed && !clock.paused ? Number(speed) : 1
    clock.dayLength = 1200
    clock.nightLength = 600
    const wind = world.resource(Wind)
    wind.speed = num('wind', 6)
    skyEntity = world.spawn(
      [
        Sky,
        {
          mode: query.get('mode') ?? 'volumetric',
          path: (query.get('path') as 'simple' | 'real') ?? 'simple',
          nightBrightness: num('night', 12),
          aurora: num('aurora', 0),
        },
      ],
      [
        Clouds,
        {
          coverage: num('coverage', 0.45),
          type: num('type', 0.5),
          density: num('density', 0.04),
          quality: (query.get('quality') as 'low' | 'medium' | 'high') ?? 'medium',
        },
      ],
    )
    setTimeOfDay(world, query.get('time') ?? '10:00')
    // A low camera looking a little up, so most of the frame is sky.
    const look = (query.get('look') ?? '0,2,16,0,7,-20').split(',').map(Number) as number[]
    world.spawn(
      [Camera3d, { fovY: num('fov', 60) }],
      [AutoExposure, { minEv: num('minEv', 3), maxEv: 15, speedUp: 6, speedDown: 4 }],
      Transform,
      orbitFrom([look[0]!, look[1]!, look[2]!], [look[3]!, look[4]!, look[5]!], {
        minPitch: -60,
      }),
    )
    scene(world)
    if (!query.has('nopanel')) addControls(world)
    else document.getElementById('panel')?.remove()
    hudExtras.push((w) => {
      const f = w.resource(SkyFrame)
      const c = w.resource(TimeOfDay)
      const m = w.resource(CloudMotion)
      const h = c.hours
      return [
        `time      day ${c.day} ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}  sun ${f.celestial.sunElevation.toFixed(1)}°  moon ${f.celestial.moonElevation.toFixed(1)}° (${Math.round(f.celestial.illuminated * 100)}%)`,
        `shadows   ${f.shadows}   clouds offset ${(m.offset[0]! / 1000).toFixed(1)}, ${(m.offset[1]! / 1000).toFixed(1)} km`,
      ]
    })
  },
})
