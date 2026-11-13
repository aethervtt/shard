import {
  defineResource,
  defineSystem,
  type Entity,
  FixedUpdate,
  type World,
} from '@aethervtt/shard-core'
import { Physics, PhysicsSystems, type PhysicsWorld } from '@aethervtt/shard-physics'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import {
  type BlockingShape,
  cutoutBlockers,
  gapBlockers,
  slabBlockers,
  wallBlockers,
} from './blocking'
import { type ColliderSettings, defaultColliders, StructureSettings } from './components'
import {
  type CutoutModel,
  type EditCursor,
  type OpeningModel,
  type StructureEdit,
  StructureModel,
  type StructureModelState,
  structureModelPlugin,
  syncStructureFixed,
} from './model'

// Structure's colliders (0112): every wall, floor and roof gets static colliders that follow its
// geometry, openings cut out, owned by its entity so hits report it. Doors, windows and hatches get
// a collider filling their hole that turns on and off with their state, without a rebuild.

/** Whether an opening's hole is blocked: a shut door, or a window the game hasn't made passable. */
export function openingBlocks(o: OpeningModel): boolean {
  if (o.movement === 'none') return false
  return o.kind === 'window' || o.state !== 'open'
}

/** Whether a cutout's cover is there: a shut hatch, or a skylight. */
export function cutoutBlocks(c: CutoutModel): boolean {
  return c.kind === 'skylight' || (c.kind === 'hatch' && c.state !== 'open')
}

export interface CollidersState {
  cursor: EditCursor | undefined
  /** The settings object last applied (a patch replaces it), and its values. */
  seen: object | undefined
  settings: ColliderSettings
  /** Entities that own colliders here. */
  owners: Set<Entity>
  /** What the last run that did something did. */
  last: { built: number; toggled: number; removed: number; ms: number }
  shapes: BlockingShape[]
}

/** The colliders' bookkeeping: which entities own colliders, and what the last run did. */
export const StructureColliders = defineResource<CollidersState>('structure/Colliders', {
  description:
    "Structure's colliders (0112): the entities that own them and what the last update built, toggled and removed.",
})

function settingsOf(world: World): ColliderSettings {
  return { ...defaultColliders(), ...world.resource(StructureSettings).colliders }
}

/** Builds (or removes) one entity's colliders from the model. */
function build(
  s: CollidersState,
  model: StructureModelState,
  physics: PhysicsWorld,
  entity: Entity,
  part: StructureEdit['part'],
): void {
  const out = s.shapes
  out.length = 0
  let on = true
  if (part === 'wall') {
    const w = model.walls.get(entity)
    if (w) wallBlockers(w, out)
  } else if (part === 'opening') {
    const o = model.openings.get(entity)
    const w = o ? model.walls.get(o.wall) : undefined
    if (o && w) {
      gapBlockers(w, w.openings.indexOf(entity), out)
      on = openingBlocks(o)
    }
  } else if (part === 'cutout') {
    const c = model.cutouts.get(entity)
    const host = c ? model.slabs.get(c.host) : undefined
    if (c && host) {
      cutoutBlockers(c, host, out)
      on = cutoutBlocks(c)
    }
  } else {
    const slab = model.slabs.get(entity)
    if (slab) slabBlockers(slab, out)
  }
  if (out.length === 0) {
    physics.clearStatic(entity)
    s.owners.delete(entity)
    return
  }
  const { layers, mask, friction } = s.settings
  physics.setStatic(entity, out, { layers, mask, friction })
  physics.enableStatic(entity, on)
  s.owners.add(entity)
  s.last.built++
}

/** Removes every structure collider, then builds every one again in entity order. */
function rebuildAll(s: CollidersState, model: StructureModelState, physics: PhysicsWorld): void {
  for (const e of s.owners) physics.clearStatic(e)
  s.owners.clear()
  if (!s.settings.enabled) return
  const parts: [Entity, StructureEdit['part']][] = []
  for (const e of model.walls.keys()) parts.push([e, 'wall'])
  for (const [e, slab] of model.slabs) parts.push([e, slab.kind])
  for (const e of model.openings.keys()) parts.push([e, 'opening'])
  for (const e of model.cutouts.keys()) parts.push([e, 'cutout'])
  parts.sort((a, b) => a[0] - b[0])
  for (const [e, part] of parts) build(s, model, physics, e, part)
}

let current: CollidersState
let currentModel: StructureModelState
let currentPhysics: PhysicsWorld

function apply(edit: StructureEdit): void {
  const s = current
  const physics = currentPhysics
  if (edit.kind === 'removed') {
    if (s.owners.delete(edit.entity)) {
      physics.clearStatic(edit.entity)
      s.last.removed++
    }
  } else if (edit.kind === 'geometry') {
    build(s, currentModel, physics, edit.entity, edit.part)
  } else {
    const model = currentModel
    const o = edit.part === 'opening' ? model.openings.get(edit.entity) : undefined
    const c = edit.part === 'cutout' ? model.cutouts.get(edit.entity) : undefined
    const on = o ? openingBlocks(o) : c ? cutoutBlocks(c) : true
    if (physics.isStaticEnabled(edit.entity) !== on && s.owners.has(edit.entity)) {
      physics.enableStatic(edit.entity, on)
      s.last.toggled++
    }
  }
}

/**
 * Brings structure's colliders up to date with the model's edit log: a wall, floor or roof edit
 * rebuilds that entity's colliders, an opening's or cutout's state turns its collider on or off.
 */
export const structureColliders = defineSystem({
  name: 'structure/physics',
  description:
    "Keeps structure's static colliders in step with the structure model: rebuilds the colliders of what changed, and turns door, window and hatch colliders on and off by state (0112).",
  run: (_, world) => {
    const physics = world.tryResource(Physics)
    if (!physics) return
    const s = world.resource(StructureColliders)
    const model = world.resource(StructureModel)
    const raw = world.resource(StructureSettings).colliders
    // Nothing new in the log and the same settings: no work, and no allocation.
    if (s.cursor !== undefined && raw === s.seen && s.cursor.at === model.offset + model.log.length)
      return
    const start = performance.now()
    s.last.built = 0
    s.last.toggled = 0
    s.last.removed = 0
    if (s.cursor === undefined || raw !== s.seen) {
      // First run, or new settings: start over from the model's records.
      s.seen = raw
      s.settings = settingsOf(world)
      s.cursor ??= model.cursor()
      s.cursor.at = model.offset + model.log.length
      rebuildAll(s, model, physics)
    } else if (s.settings.enabled) {
      current = s
      currentModel = model
      currentPhysics = physics
      model.read(s.cursor, apply)
    } else {
      s.cursor.at = model.offset + model.log.length
    }
    model.compact()
    if (s.last.built + s.last.toggled + s.last.removed > 0) s.last.ms = performance.now() - start
  },
})

/**
 * Structure's colliders (0112): static colliders for walls (openings cut out), floors and roofs,
 * and colliders for doors, windows and hatches that follow their state. Needs `physics3d`; adds
 * `structure/model` when it's missing. Runs headless.
 */
export const structurePhysicsPlugin: Plugin = definePlugin({
  name: 'structure/physics',
  dependencies: ['physics3d'],
  build(app) {
    if (!app.hasPlugin('structure/model')) app.addPlugin(structureModelPlugin)
    app.world.insertResource(StructureColliders, {
      cursor: undefined,
      seen: undefined,
      settings: defaultColliders(),
      owners: new Set<Entity>(),
      last: { built: 0, toggled: 0, removed: 0, ms: 0 },
      shapes: [],
    })
    app.addSystems(FixedUpdate, structureColliders.after(syncStructureFixed).before(PhysicsSystems))
  },
  ready(app) {
    const world = app.world
    world.resource(StructureModel).sections.push(() => {
      const s = world.resource(StructureColliders)
      const physics = world.tryResource(Physics)
      let colliders = 0
      let disabled = 0
      for (const e of s.owners) {
        const set = physics?.statics.get(e)
        if (!set) continue
        colliders += set.colliders.length
        if (!set.enabled) disabled++
      }
      return {
        colliders: {
          owners: s.owners.size,
          colliders,
          disabled,
          settings: s.settings,
          last: s.last,
        },
      }
    })
  },
})
