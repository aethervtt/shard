import { type AssetRef, type Entity, quat, type World } from '@aethervtt/shard-core'
import { plane } from '@aethervtt/shard-mesh'
import {
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  NotShadowReceiver,
} from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'
import type { DiceSceneContext } from './attachments'

// Windows (0065): quads facing the dice camera over a die, for effects drawn in a shader (a beam, a
// disk, a jet, a meteor's trail). The quad lies in its x–z plane, ±1 across: x reads right on
// screen and −z up, so a shader's vertex_extra can hand on (position.x, −position.z).

/** Where a window sits over a die, in die radii. */
export interface DiceWindow {
  /** Center from the die's center (or `at`): x right, y up on screen. */
  x: number
  y: number
  width: number
  height: number
  /** Turn on screen, radians counter-clockwise. */
  turn: number
  /** Toward the camera from the die's center, in die radii (0: at its depth). */
  lift: number
  /** Where it's centered in the world, instead of the die's position (an entrance's rest spot). */
  at?: ArrayLike<number>
}

const quads = new WeakMap<World, AssetRef<'Mesh'>>()

function quadOf(world: World): AssetRef<'Mesh'> {
  let mesh = quads.get(world)
  if (!mesh) {
    mesh = world.resource(Meshes).add(plane({ size: 2 }), 'dice:window') as AssetRef<'Mesh'>
    quads.set(world, mesh)
  }
  return mesh
}

/**
 * Spawns a window facing the dice camera over a die, with `material`. A window lifted toward the
 * camera is moved along the line from the camera and scaled by how much nearer it got, so it covers
 * the pixels it would at the die's depth: windows at different depths (a disk's far half behind the
 * die, its near band over it) line up wherever the die is.
 */
export function spawnDiceWindow(
  ctx: Pick<DiceSceneContext, 'world' | 'die' | 'scale' | 'camera'>,
  material: AssetRef<'Material'>,
  window: DiceWindow,
): Entity {
  const w = ctx.world
  const { rotation: cam, translation: eye } = w.get(ctx.camera, Transform)
  const [qx, qy, qz, qw] = cam
  // The camera's right and up, in the world.
  const rx = 1 - 2 * (qy * qy + qz * qz)
  const ry = 2 * (qx * qy + qw * qz)
  const rz = 2 * (qx * qz - qw * qy)
  const ux = 2 * (qx * qy - qw * qz)
  const uy = 1 - 2 * (qx * qx + qz * qz)
  const uz = 2 * (qy * qz + qw * qx)
  const at = window.at ?? w.get(ctx.die, Transform).translation
  const s = ctx.scale
  const px = at[0]! + (rx * window.x + ux * window.y) * s - eye[0]!
  const py = at[1]! + (ry * window.x + uy * window.y) * s - eye[1]!
  const pz = at[2]! + (rz * window.x + uz * window.y) * s - eye[2]!
  const dx = at[0]! - eye[0]!
  const dy = at[1]! - eye[1]!
  const dz = at[2]! - eye[2]!
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const f = Math.max(0.05, (d - window.lift * s) / d)
  // The quad's +y to the camera's +z (its −z reads up on screen), turned on screen.
  const face = quat.multiply(
    [0, 0, 0, 1],
    cam,
    quat.multiply(
      [0, 0, 0, 1],
      quat.fromEuler([0, 0, 0, 1], 0, 0, window.turn),
      quat.fromEuler([0, 0, 0, 1], Math.PI / 2, 0, 0),
    ),
  ) as [number, number, number, number]
  return w.spawn(
    [Mesh3d, { mesh: quadOf(w) }],
    [MeshMaterial, { material }],
    NotShadowCaster,
    NotShadowReceiver,
    [
      Transform,
      {
        translation: [eye[0]! + px * f, eye[1]! + py * f, eye[2]! + pz * f],
        rotation: face,
        scale: [(window.width / 2) * s * f, 1, (window.height / 2) * s * f],
      },
    ],
  )
}

/** Vertices the meshes of `entities` draw (their Mesh3d), for holding scenes to their budgets. */
export function meshVertices(world: World, entities: readonly Entity[]): number {
  const meshes = world.resource(Meshes)
  let n = 0
  for (const e of entities) {
    const ref = world.isAlive(e) ? world.tryGet(e, Mesh3d)?.mesh : undefined
    const mesh = ref ? meshes.get(ref) : undefined
    if (mesh) n += mesh.positions.length / 3
  }
  return n
}
