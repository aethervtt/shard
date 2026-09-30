// Aether-shaped scenes at the sizes of its structural contract (ADR-0072), generated from a seed so
// the files stay small and every run sees the same scene. Coordinates are Aether's: pixels, with
// the scene grid's size in pixels per cell. `shadowStress` is Aether's shadow-stress fixture;
// `maxScene` fills every limit at once.

/** Aether's contract limits. */
export const LIMITS = {
  walls: 5000,
  openings: 1024,
  floors: 256,
  floorVertices: 256,
  materials: 64,
  props: 256,
  propAssets: 64,
  propTriangles: 500_000,
}

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const GRID = {
  type: 'square',
  hexOrientation: 'pointy',
  size: 70,
  offset: { x: 0, y: 0 },
  distance: 5,
  unit: 'ft',
  diagonal: 'euclidean',
}

/** Walls along every edge of a grid of `cols`-wide rooms of `room` px, until there are `count`. */
function roomWalls(count, cols, room, materials, random) {
  const walls = []
  for (let r = 0; walls.length < count; r++) {
    for (let c = 0; c < cols && walls.length < count; c++) {
      walls.push(wall(walls.length, c * room, r * room, (c + 1) * room, r * room, materials, random))
      if (walls.length < count)
        walls.push(wall(walls.length, c * room, r * room, c * room, (r + 1) * room, materials, random))
    }
    if (walls.length < count)
      walls.push(wall(walls.length, cols * room, r * room, cols * room, (r + 1) * room, materials, random))
  }
  return walls
}

function wall(i, ax, ay, bx, by, materials, random) {
  return {
    id: `wall-${i}`,
    rev: 0,
    runId: `run-${Math.floor(i / 8)}`,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    height: 140,
    thickness: 12,
    elevation: 0,
    materialId: materials[Math.floor(random() * materials.length)].id,
  }
}

function materials(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const tint = hsl((i * 0.618034) % 1, 0.25, 0.55)
    out.push({ id: `mat-${i}`, rev: 0, name: `Material ${i}`, tint, roughness: 0.6 + (i % 5) * 0.08 })
  }
  return out
}

function hsl(h, s, l) {
  const k = (n) => (n + h * 12) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hex = (v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

function openings(walls, count, random, windows) {
  const out = []
  const step = Math.max(1, Math.floor(walls.length / count))
  for (let i = 0; out.length < count && i < walls.length; i += step) {
    const w = walls[i]
    const window = windows && out.length % 3 === 2
    const doc = {
      id: `opening-${out.length}`,
      rev: 0,
      kind: window ? 'window' : 'door',
      hostWallId: w.id,
      offset: 70,
      width: 70,
      height: window ? 50 : 110,
      sill: window ? 45 : 0,
      frameWidth: 6,
      frameDepth: 4,
      frameMaterialId: null,
      sight: window ? 'none' : 'normal',
      movement: 'normal',
    }
    if (!window) {
      doc.hinge = random() < 0.5 ? 'start' : 'end'
      doc.swing = random() < 0.5 ? 'left' : 'right'
      doc.state = 'closed'
    }
    out.push(doc)
  }
  return out
}

function props(count, assets, span, random) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: `prop-${i}`,
      rev: 0,
      asset: `asset-${i % assets}`,
      x: 35 + random() * (span - 70),
      y: 35 + random() * (span - 70),
      cells: 0.5 + random() * 0.5,
      rotation: random() * 360,
    })
  }
  return out
}

function tokens(count) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: `token-${i}`,
      rev: 0,
      name: `Token ${i}`,
      x: 105 + (i % 4) * 210,
      y: 105 + Math.floor(i / 4) * 210,
      size: 1 + (i % 2),
    })
  }
  return out
}

/** A floor of `vertices` points: a concave star inside a square of `size` px at (x, y). */
function starFloor(i, x, y, size, vertices, material) {
  const points = []
  const r0 = size * 0.48
  for (let k = 0; k < vertices; k++) {
    const a = (k / vertices) * Math.PI * 2
    const r = k % 2 === 0 ? r0 : r0 * 0.72
    points.push({ x: x + size / 2 + Math.cos(a) * r, y: y + size / 2 + Math.sin(a) * r })
  }
  return {
    id: `floor-${i}`,
    rev: 0,
    name: `Floor ${i}`,
    points,
    elevation: 0,
    surface: { kind: 'material', materialId: material.id },
  }
}

/** Aether's shadow-stress fixture: 5,000 walls, 64 doors, 256 props, 1 floor, 12 tokens. */
export function shadowStress(seed = 1) {
  const random = rng(seed)
  const mats = materials(8)
  const cols = 50
  const room = 210
  const walls = roomWalls(5000, cols, room, mats, random)
  const span = cols * room
  return {
    grid: { ...GRID },
    materials: mats,
    walls,
    openings: openings(walls, 64, random, false),
    floors: [
      {
        id: 'floor-0',
        rev: 0,
        name: 'Ground',
        points: [
          { x: 0, y: 0 },
          { x: span, y: 0 },
          { x: span, y: span },
          { x: 0, y: span },
        ],
        elevation: 0,
        surface: { kind: 'material', materialId: mats[0].id },
      },
    ],
    props: props(256, 16, span, random),
    tokens: tokens(12),
  }
}

/** Every limit at once: 5,000 walls, 1,024 openings, 256 floors × 256 vertices, 64 materials, 256 props. */
export function maxScene(seed = 2) {
  const random = rng(seed)
  const mats = materials(LIMITS.materials)
  const cols = 50
  const room = 210
  const walls = roomWalls(LIMITS.walls, cols, room, mats, random)
  const floors = []
  for (let i = 0; i < LIMITS.floors; i++) {
    const fx = (i % 16) * 3 * room
    const fy = Math.floor(i / 16) * 3 * room
    floors.push(starFloor(i, fx, fy, 3 * room, LIMITS.floorVertices, mats[i % mats.length]))
  }
  return {
    grid: { ...GRID },
    materials: mats,
    walls,
    openings: openings(walls, LIMITS.openings, random, true),
    floors,
    props: props(LIMITS.props, LIMITS.propAssets, cols * room, random),
    tokens: tokens(12),
  }
}
