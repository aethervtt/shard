import {
  ChildOf,
  Children,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'

export const BoneSocket = defineComponent(
  'animation/BoneSocket',
  {
    name: t.string({ description: 'What attachments ask for, e.g. "hand_r".' }),
    joint: t.entity({
      description:
        'The joint it rides on. None: this entity (put the socket on the joint itself, e.g. with a SceneInstance override, so it survives the model respawning).',
    }),
    offset: t.vec3({ unit: 'm', description: "Where attachments sit, in the joint's frame." }),
    rotation: t.quat({ description: "How attachments turn, in the joint's frame." }),
  },
  {
    description:
      'A named attachment point on a joint. Prefabs attach by socket name ("hand_r"), so swapping the model keeps them working.',
  },
)

export const Attach = defineComponent(
  'animation/Attach',
  {
    owner: t.entity({ description: 'The model (or character) whose socket this rides on.' }),
    socket: t.string({ description: 'The socket name, e.g. "hand_r".' }),
  },
  {
    description:
      "Parents this entity to a BoneSocket under owner, at the socket's offset, once the socket exists; attaches again when the owner's model respawns (reloads).",
  },
)

/** The BoneSocket named `name` on `owner` or under it, or undefined. Cold: walks the subtree. */
export function findSocket(world: World, owner: Entity, name: string): Entity | undefined {
  const stack: Entity[] = [owner]
  for (let guard = 0; stack.length > 0 && guard < 100_000; guard++) {
    const e = stack.pop()!
    if (!world.isAlive(e)) continue
    const socket = world.tryGet(e, BoneSocket)
    if (socket && socket.name === name) return e
    const children = world.tryGet(e, Children)?.entities
    if (children)
      for (let k = children.length - 1; k >= 0; k--)
        if (children[k] !== null) stack.push(children[k]!)
  }
  return undefined
}

/** Every socket under `owner`, by name. Cold. */
export function listSockets(world: World, owner: Entity): string[] {
  const out: string[] = []
  const stack: Entity[] = [owner]
  while (stack.length > 0) {
    const e = stack.pop()!
    if (!world.isAlive(e)) continue
    const socket = world.tryGet(e, BoneSocket)
    if (socket) out.push(socket.name)
    const children = world.tryGet(e, Children)?.entities
    if (children) for (const c of children) if (c !== null) stack.push(c)
  }
  return out.sort()
}

/**
 * Parents `entity` to the joint of `owner`'s socket `name`, at the socket's offset and rotation
 * (its scale is kept). Returns the joint. Throws `animation/unknown-socket` when there's none.
 */
export function attachToSocket(world: World, entity: Entity, owner: Entity, name: string): Entity {
  const at = findSocket(world, owner, name)
  if (at === undefined) {
    const known = listSockets(world, owner)
    throw new ShardError(
      'animation/unknown-socket',
      `No socket "${name}" under entity ${owner}${known.length ? ` (it has ${known.map((k) => `"${k}"`).join(', ')})` : ''}`,
      {
        hint: 'Put animation/BoneSocket { "name": ... } on the joint; on a model, add it with a SceneInstance override on the joint path.',
      },
    )
  }
  const socket = world.get(at, BoneSocket)
  const joint = socket.joint !== null && world.isAlive(socket.joint) ? socket.joint : at
  const scale = world.tryGet(entity, Transform)?.scale ?? [1, 1, 1]
  world.add(entity, Transform, {
    translation: [...socket.offset] as never,
    rotation: [...socket.rotation] as never,
    scale: [...scale] as never,
  })
  world.add(entity, ChildOf, { parent: joint })
  return joint
}

interface Attachment {
  owner: Entity
  socket: string
  joint: Entity
  /** Frame to look for a socket that wasn't there. */
  retryAt: number
}

export const AttachStateResource = defineResource<{
  attached: Map<Entity, Attachment>
  frame: number
}>('animation/AttachState', {
  description: 'Where each animation/Attach entity is attached. Internal.',
  init: () => ({ attached: new Map(), frame: 0 }),
})

const pending: Entity[] = []

/**
 * Attaches animation/Attach entities to their sockets: once the socket exists (models load late),
 * and again when the joint they were on is gone (the model respawned) or they were moved off it.
 * Runs in PostUpdate before transform propagation.
 */
export const attachToSockets = defineSystem({
  name: 'animation/attach',
  description:
    'Parents animation/Attach entities to their owner’s BoneSocket, re-attaching after respawns.',
  setup: (world) => ({ q: world.query({ with: [Attach] }) }),
  run: ({ q }, world) => {
    const state = world.resource(AttachStateResource)
    state.frame++
    pending.length = 0
    const tables = q.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const owners = table.column(Attach, 'owner')
      const sockets = table.column(Attach, 'socket') as string[]
      const parents = table.has(ChildOf) ? table.column(ChildOf, 'parent') : undefined
      for (let i = 0; i < table.count; i++) {
        const e = table.entities[i]!
        const a = state.attached.get(e)
        if (
          a !== undefined &&
          a.owner === owners[i] &&
          a.socket === sockets[i] &&
          (a.joint < 0
            ? state.frame < a.retryAt
            : parents !== undefined && parents[i] === a.joint && world.isAlive(a.joint))
        ) {
          continue
        }
        pending.push(e)
      }
    }
    // Structural changes after the walk: reparenting moves entities between tables.
    for (let k = 0; k < pending.length; k++) {
      const e = pending[k]!
      const { owner, socket } = world.get(e, Attach)
      let a = state.attached.get(e)
      if (!a) {
        a = { owner: -1 as Entity, socket: '', joint: -1 as Entity, retryAt: 0 }
        state.attached.set(e, a)
      }
      a.owner = owner ?? (-1 as Entity)
      a.socket = socket
      a.joint = -1 as Entity
      a.retryAt = state.frame + 10
      if (owner === null || !world.isAlive(owner) || !socket) continue
      if (findSocket(world, owner, socket) === undefined) continue // not spawned yet
      try {
        a.joint = attachToSocket(world, e, owner, socket)
      } catch (err) {
        world.tryResource(LogResource)?.error(err)
      }
    }
  },
})

/** Forgets an attachment when its component goes away. */
export function forgetAttachment(world: World, entity: Entity): void {
  world.tryResource(AttachStateResource)?.attached.delete(entity)
}
