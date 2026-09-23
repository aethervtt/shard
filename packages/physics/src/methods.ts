import { defineSchema, type Entity, findComponent, t, type World } from '@shard/core'
import type { AppMethod } from '@shard/runtime'
import { createRayHit, Physics, type PhysicsWorld, type QueryOptions, type RayHit } from './world'

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || entity < 0 || !world.isAlive(entity)) return null
  const v = world.tryGet(entity, member) as { path?: string } | undefined
  return v?.path || null
}

function hitJson(world: World, hit: RayHit) {
  return {
    entity: hit.entity,
    path: scenePath(world, hit.entity),
    body: hit.body >= 0 ? hit.body : null,
    bodyPath: hit.body >= 0 ? scenePath(world, hit.body) : null,
    distance: hit.distance,
    point: Array.from(hit.point),
    normal: Array.from(hit.normal),
  }
}

function ready(world: World): PhysicsWorld {
  // Methods only exist when a physics plugin is added; `ready` ran before the server started.
  return world.resource(Physics)
}

const filterFields = {
  mask: t.u16({ default: 0xffff, description: 'Only colliders in these layers (bitmask).' }),
  exclude: t.entity({ description: 'Skip this entity’s colliders (and its body’s).' }),
  sensors: t.bool({ description: 'Include sensors.' }),
}

function options(p: Record<string, unknown>, maxDistance?: number): QueryOptions {
  const exclude = p.exclude as Entity | null | undefined
  return {
    maxDistance,
    mask: p.mask as number,
    exclude: exclude !== null && exclude !== undefined && exclude >= 0 ? exclude : undefined,
    sensors: p.sensors as boolean,
  }
}

export const physicsMethods: AppMethod[] = [
  {
    name: 'physics.raycast',
    description:
      'Casts a ray against physics colliders: the nearest hit (or every hit with all) with collider entity and scene path, body, point, normal, and distance. Sees the state after the last physics step.',
    params: defineSchema('physics/RaycastParams', {
      origin: t.vec3({ required: true }),
      direction: t.vec3({ required: true }),
      maxDistance: t.f32({ min: 0, description: 'Ignore hits past this (0: no limit).' }),
      all: t.bool({ description: 'Every collider along the ray, nearest first.' }),
      ...filterFields,
    }),
    handler: ({ world }, p) => {
      const physics = ready(world)
      const o = options(p, (p.maxDistance as number) || undefined)
      if (p.all) {
        const hits = physics.raycastAll(p.origin as number[], p.direction as number[], o)
        return { hits: hits.map((h) => hitJson(world, h)) }
      }
      const hit = createRayHit()
      const found = physics.raycast(p.origin as number[], p.direction as number[], o, hit)
      return { hits: found ? [hitJson(world, hit)] : [] }
    },
  },
  {
    name: 'physics.overlap',
    description:
      'Colliders overlapping a point, or a ball, cuboid, or capsule placed at a position: their entities and scene paths.',
    params: defineSchema('physics/OverlapParams', {
      position: t.vec3({ required: true }),
      shape: t.enum(['point', 'ball', 'cuboid', 'capsule']),
      radius: t.f32({ default: 0.5, min: 0 }),
      halfExtents: t.vec3({ default: [0.5, 0.5, 0.5], min: 0 }),
      halfHeight: t.f32({ default: 0.5, min: 0 }),
      rotation: t.quat(),
      ...filterFields,
    }),
    handler: ({ world }, p) => {
      const physics = ready(world)
      const found: { entity: number; path: string | null }[] = []
      const visit = (entity: Entity) => {
        found.push({ entity, path: scenePath(world, entity) })
        return true
      }
      const o = options(p)
      if (p.shape === 'point') physics.overlapPoint(p.position as number[], o, visit)
      else {
        physics.overlapShape(
          {
            shape: p.shape as 'ball' | 'cuboid' | 'capsule',
            radius: p.radius as number,
            halfExtents: p.halfExtents as number[],
            halfHeight: p.halfHeight as number,
          },
          p.position as number[],
          p.rotation as number[],
          o,
          visit,
        )
      }
      return { colliders: found }
    },
  },
  {
    name: 'physics.describe',
    description:
      'Physics state: dimension, gravity, bodies by kind and how many sleep, colliders by shape, joints, contact pairs, colliders waiting for a mesh, and the last step time.',
    params: defineSchema('physics/DescribeParams', {}),
    handler: ({ world }) => {
      const physics = ready(world)
      return {
        dimension: physics.dim,
        gravity: physics.config.gravity,
        interpolate: physics.config.interpolate,
        paused: physics.config.paused,
        ...physics.describe(),
      }
    },
  },
]
