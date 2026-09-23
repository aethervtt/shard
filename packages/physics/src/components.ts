import { defineComponent, defineEvent, defineResource, type Entity, t } from '@shard/core'
import { Transform } from '@shard/transform'

export const BODY_KINDS = ['dynamic', 'fixed', 'kinematic-position', 'kinematic-velocity'] as const
export type BodyKind = (typeof BODY_KINDS)[number]

export const RigidBody = defineComponent(
  'physics/RigidBody',
  {
    kind: t.enum(BODY_KINDS, {
      description:
        'dynamic: moved by forces and contacts. fixed: never moves. kinematic-position: follows its Transform. kinematic-velocity: moves by its Velocity.',
    }),
    gravityScale: t.f32({ default: 1, description: 'Multiplies gravity for this body.' }),
    linearDamping: t.f32({ min: 0, description: 'Slows linear motion over time (1/s).' }),
    angularDamping: t.f32({ min: 0, description: 'Slows rotation over time (1/s).' }),
    ccd: t.bool({
      description: 'Continuous collision detection: fast bodies (bullets) do not tunnel.',
    }),
    canSleep: t.bool({
      default: true,
      description: 'Stops simulating the body while it rests.',
    }),
    dominance: t.i8({
      min: -127,
      max: 127,
      description: 'Higher dominance pushes lower without being pushed back.',
    }),
    lockTranslation: t.vec3({
      min: 0,
      max: 1,
      description: 'Per axis: 1 locks movement along that world axis.',
    }),
    lockRotation: t.vec3({
      min: 0,
      max: 1,
      description: 'Per axis: 1 locks rotation around that axis. In 2D, z locks rotation.',
    }),
  },
  {
    description:
      'A physics body. Colliders on this entity and on descendants without their own body make its shape. Moves the entity’s Transform.',
    requires: [Transform],
  },
)

export const Velocity = defineComponent(
  'physics/Velocity',
  {
    linear: t.vec3({ unit: 'm/s', description: 'World-space linear velocity.' }),
    angular: t.vec3({ unit: 'rad/s', description: 'World-space angular velocity (2D: z).' }),
  },
  {
    description:
      'A body’s velocity. Written by physics each step; writing it sets the body’s velocity.',
  },
)

export const SHAPES = [
  'ball',
  'cuboid',
  'capsule',
  'cylinder',
  'cone',
  'convex',
  'trimesh',
  'heightfield',
  'segment',
  'polyline',
] as const
export type Shape = (typeof SHAPES)[number]

export const Collider = defineComponent(
  'physics/Collider',
  {
    shape: t.enum(SHAPES, {
      description:
        'ball: radius. cuboid: halfExtents. capsule, cylinder, cone: radius and halfHeight (along Y). convex and trimesh: mesh or points. heightfield: heightfield and halfExtents. segment and polyline (2D): points or mesh.',
    }),
    radius: t.f32({ default: 0.5, min: 0, unit: 'm' }),
    halfExtents: t.vec3({
      default: [0.5, 0.5, 0.5],
      min: 0,
      unit: 'm',
      description:
        'cuboid: half size per axis. heightfield: half width (x), height scale (y), half depth (z).',
    }),
    halfHeight: t.f32({
      default: 0.5,
      min: 0,
      unit: 'm',
      description: 'Half the length of a capsule’s middle, or half a cylinder’s or cone’s height.',
    }),
    mesh: t.handle('Mesh', {
      description: 'convex, trimesh, and polyline: the mesh whose vertices make the shape.',
    }),
    points: t.list(t.vec3, {
      description:
        'convex, polyline, and segment without a mesh: points in local space (2D reads x and y).',
    }),
    heightfield: t.struct(
      {
        rows: t.u16({ description: 'Samples along Z.' }),
        cols: t.u16({ description: 'Samples along X.' }),
        heights: t.list(t.f32, {
          description: 'rows × cols heights, row by row, scaled by halfExtents.y.',
        }),
      },
      { description: 'heightfield: the height samples.' },
    ),
    friction: t.f32({ default: 0.5, min: 0 }),
    restitution: t.f32({ min: 0, description: 'Bounciness: 0 stops, 1 bounces back fully.' }),
    density: t.f32({
      default: 1,
      min: 0,
      unit: 'kg/m³',
      description: 'Mass from volume. Ignored when the body has Mass.',
    }),
    sensor: t.bool({ description: 'Detects overlaps without colliding.' }),
    layers: t.u16({
      default: 1,
      description: 'Bitmask: the collision layers this collider is in.',
    }),
    mask: t.u16({
      default: 0xffff,
      description: 'Bitmask: the layers it collides with. Both sides must accept each other.',
    }),
    events: t.bool({ description: 'Send CollisionEvent when contacts start and stop.' }),
    forceThreshold: t.f32({
      min: 0,
      unit: 'N',
      description: 'Send ContactForceEvent when the contact force exceeds this (0: never).',
    }),
  },
  {
    description:
      'A collision shape. Uses the entity’s world transform (scale included). Without a RigidBody on it or an ancestor, it is fixed.',
    requires: [Transform],
  },
)

export const ExternalForce = defineComponent(
  'physics/ExternalForce',
  {
    force: t.vec3({ unit: 'N', description: 'World-space force applied every step.' }),
    torque: t.vec3({ unit: 'N·m' }),
  },
  { description: 'A continuous force on the body, e.g. thrust. Set to zero to stop.' },
)

export const ExternalImpulse = defineComponent(
  'physics/ExternalImpulse',
  {
    impulse: t.vec3({ unit: 'N·s', description: 'Applied once at the next step, then zeroed.' }),
    torque: t.vec3({ unit: 'N·m·s' }),
  },
  { description: 'A one-off push: a jump, an explosion, a hit.' },
)

export const Mass = defineComponent(
  'physics/Mass',
  { mass: t.f32({ default: 1, min: 0, unit: 'kg', description: 'The body’s total mass.' }) },
  { description: 'Sets a body’s mass directly instead of from collider density.' },
)

export const GravitySource = defineComponent(
  'physics/GravitySource',
  {
    strength: t.f32({
      default: 9.81,
      unit: 'm/s²',
      description: 'Acceleration toward this entity at `radius` (at any distance if constant).',
    }),
    radius: t.f32({
      default: 1,
      min: 0,
      unit: 'm',
      description: 'Surface radius; inverse-square falloff is 1 here.',
    }),
    range: t.f32({ min: 0, unit: 'm', description: 'No pull beyond this distance (0: no limit).' }),
    falloff: t.enum(['inverse-square', 'constant']),
  },
  {
    description:
      'Point gravity toward the entity (a planet). Pulls dynamic bodies and sets character up.',
    requires: [Transform],
  },
)

export const JOINT_KINDS = ['fixed', 'revolute', 'prismatic', 'spherical', 'rope'] as const

export const Joint = defineComponent(
  'physics/Joint',
  {
    kind: t.enum(JOINT_KINDS),
    other: t.entity({ description: 'The body this one is jointed to.' }),
    anchor: t.vec3({ unit: 'm', description: 'Joint point in this body’s local space.' }),
    otherAnchor: t.vec3({ unit: 'm', description: 'Joint point in the other body’s local space.' }),
    axis: t.vec3({
      default: [0, 1, 0],
      description: 'revolute: hinge axis. prismatic: slide axis (local to this body).',
    }),
    limits: t.vec2({
      description:
        'revolute (rad), prismatic (m): [min, max], off when equal. rope: [_, max length].',
    }),
    motorVelocity: t.f32({ description: 'revolute, prismatic: drive at this speed (0: off).' }),
    motorFactor: t.f32({ default: 1, min: 0, description: 'How hard the motor drives.' }),
  },
  { description: 'Connects this entity’s body to another body.' },
)

/** App-wide physics settings. */
export const PhysicsConfig = defineResource<PhysicsConfigValue>('physics/Config', {
  description:
    'Gravity, solver iterations, and render interpolation. Set before the first step or at any time.',
  init: () => ({
    gravity: [0, -9.81, 0],
    iterations: 4,
    interpolate: false,
    paused: false,
  }),
})

export interface PhysicsConfigValue {
  /** m/s². In 2D, x and y are used. */
  gravity: [number, number, number]
  /** Solver iterations per step (Rapier's default is 4). */
  iterations: number
  /** Blend Transforms between steps by FixedTime.alpha, for smooth motion on fast displays. */
  interpolate: boolean
  /** Skip stepping (bodies keep their state). */
  paused: boolean
}

export interface CollisionEventData {
  kind: 'started' | 'stopped'
  /** The collider entities. */
  a: Entity
  b: Entity
  /** Their bodies (the collider's entity or ancestor with RigidBody; -1 for fixed colliders). */
  bodyA: Entity
  bodyB: Entity
  sensor: boolean
}

export const CollisionEvent = defineEvent<CollisionEventData>('physics/CollisionEvent', {
  description:
    'Contacts starting and stopping between colliders with events: true (either side). Sensors report overlaps.',
})

export interface ContactForceEventData {
  a: Entity
  b: Entity
  /** Total contact force magnitude, N. */
  force: number
}

export const ContactForceEvent = defineEvent<ContactForceEventData>('physics/ContactForceEvent', {
  description: 'Contact force above a collider’s forceThreshold (hits, crashes).',
})
