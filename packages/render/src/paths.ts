import {
  ChildOf,
  Children,
  type ComponentDef,
  type Entity,
  findComponent,
  type World,
} from '@aethervtt/shard-core'

let memberDef: ComponentDef | null | undefined
let partDef: ComponentDef | null | undefined

/**
 * An entity's name: the last segment of its scene path (`scene/SceneMember`) or instance path
 * (`scene/InstancePart`). Undefined for entities made in code without either. Cold path: allocates.
 */
export function entityName(world: World, entity: Entity): string | undefined {
  if (!memberDef) memberDef = findComponent('scene/SceneMember') ?? null
  if (!partDef) partDef = findComponent('scene/InstancePart') ?? null
  const path =
    (memberDef && (world.tryGet(entity, memberDef) as { path?: string } | undefined)?.path) ||
    (partDef && (world.tryGet(entity, partDef) as { path?: string } | undefined)?.path)
  if (!path) return undefined
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * Every descendant of `root` by path relative to it (`Armature/Hips/Spine`), plus `''` for the root
 * itself. Entities without a name (and their subtrees) are left out. Cold path: allocates.
 */
export function descendantPaths(world: World, root: Entity): Map<string, Entity> {
  const out = new Map<string, Entity>([['', root]])
  const visit = (entity: Entity, prefix: string, depth: number) => {
    if (depth > 64 || !world.has(entity, Children)) return
    for (const child of world.get(entity, Children).entities) {
      if (child === null || !world.isAlive(child)) continue
      const name = entityName(world, child)
      if (name === undefined) continue
      const path = prefix ? `${prefix}/${name}` : name
      if (!out.has(path)) out.set(path, child)
      visit(child, path, depth + 1)
    }
  }
  visit(root, '', 0)
  return out
}

/**
 * Resolves paths relative to a model root, looking for that root among `entity` and its
 * ancestors: the nearest one under which `probe` (a path every root has, like a skin's first joint)
 * exists. Returns the root and its paths, or undefined. Cold path: allocates.
 */
export function findModelRoot(
  world: World,
  entity: Entity,
  probe: string,
): { root: Entity; paths: Map<string, Entity> } | undefined {
  let current: Entity | null = entity
  for (let depth = 0; current !== null && depth < 32; depth++) {
    const paths = descendantPaths(world, current)
    if (paths.has(probe)) return { root: current, paths }
    current = world.has(current, ChildOf) ? world.get(current, ChildOf).parent : null
    if (current !== null && !world.isAlive(current)) return undefined
  }
  return undefined
}
