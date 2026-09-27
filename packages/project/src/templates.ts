export type TemplateName = 'empty' | 'explorer'

export interface TemplateOptions {
  name: string
  template: TemplateName
  /** Version spec for `@aethervtt/shard-*` dependencies: `workspace:*` inside the Shard repo, a range otherwise. */
  engineSpec: string
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function manifest(name: string) {
  return {
    $schema: './.shard/schemas/shard.schema.json',
    name,
    version: '0.1.0',
    engine: '0.x',
    entry: 'scripts/main.ts',
    startScene: 'scenes/main.scene.json',
    seed: 1,
    window: { width: 1280, height: 720, msaa: 4 },
    plugins: ['render/forward', 'input'],
  }
}

const emptyScene = {
  $schema: '../.shard/schemas/scene.schema.json',
  version: 1,
  assets: { red: { type: 'Material', value: { baseColor: '#c0392b', roughness: 0.4 } } },
  resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 500 } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight' },
        'core/Transform': { rotationEuler: [-50, 30, 0] },
      },
    },
    {
      name: 'camera',
      components: {
        'render/Camera3d': { fovY: 60 },
        'core/Transform': { translation: [0, 2, 6], rotationEuler: [-15, 0, 0] },
      },
    },
    {
      name: 'cube',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:cube?size=1.5' } },
        'render/MeshMaterial': { material: { path: '#red' } },
        'core/Transform': { translation: [0, 0.5, 0] },
      },
    },
  ],
}

const explorerScene = (name: string) => ({
  $schema: '../.shard/schemas/scene.schema.json',
  version: 1,
  assets: {
    rock: { type: 'Material', value: { baseColor: '#7a5c48', roughness: 0.95 } },
    ice: { type: 'Material', value: { baseColor: '#c9d6df', roughness: 0.6 } },
    hull: { type: 'Material', value: { baseColor: '#d35400', roughness: 0.35 } },
    glass: {
      type: 'Material',
      value: { baseColor: '#1b2631', roughness: 0.1, emissive: '#5dade2', emissiveLuminance: 400 },
    },
  },
  resources: { 'render/AmbientLight': { color: [0.6, 0.7, 1], brightness: 300 } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight' },
        'core/Transform': { rotationEuler: [-25, 50, 0] },
      },
    },
    {
      name: 'planet',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=40&segments=64' } },
        'render/MeshMaterial': { material: { path: '#rock' } },
        'core/Transform': { translation: [0, -20, -140] },
      },
      children: [
        {
          name: 'moon',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=6&segments=32' } },
            'render/MeshMaterial': { material: { path: '#ice' } },
            'core/Transform': { translation: [70, 35, 20] },
          },
        },
      ],
    },
    {
      name: 'ship',
      components: {
        [`${name}/Ship`]: {},
        'render/Mesh3d': { mesh: { path: 'procedural:box?x=1.6&y=0.5&z=3.2' } },
        'render/MeshMaterial': { material: { path: '#hull' } },
        'core/Transform': {},
      },
      children: [
        {
          name: 'cockpit',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=0.45' } },
            'render/MeshMaterial': { material: { path: '#glass' } },
            'core/Transform': { translation: [0, 0.3, -0.6] },
          },
        },
        {
          name: 'camera',
          components: {
            'render/Camera3d': { fovY: 65 },
            'core/Transform': { translation: [0, 2.2, 8], rotationEuler: [-10, 0, 0] },
          },
        },
      ],
    },
  ],
})

const explorerMain = (
  name: string,
) => `import { defineSystem, FixedUpdate, quat, t, vec3 } from '@aethervtt/shard-core'
import { addActions, defineActions } from '@aethervtt/shard-input'
import { defineProject } from '@aethervtt/shard-project'
import { FixedTime } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'

/** Flight controls. Bindings are data: an agent (or player) can remap them without code changes. */
export const Controls = defineActions('${name}/Controls', {
  thrust: { kind: 'button', bindings: ['Key:KeyW', 'Key:Space', 'Gamepad:RightTrigger'] },
  steer: { kind: 'axis2d', bindings: [{ composite: 'arrows' }, 'Gamepad:LeftStick'], deadZone: 0.15 },
})

const project = defineProject({
  name: '${name}',
  build(app) {
    addActions(app.world, Controls)
    app.addSystems(FixedUpdate, fly)
  },
})

export const Ship = project.component(
  'Ship',
  {
    speed: t.f32({ min: 0, unit: 'm/s', description: 'Current forward speed.' }),
    maxSpeed: t.f32({ default: 40, min: 0, unit: 'm/s', description: 'Speed cap.' }),
    acceleration: t.f32({ default: 15, min: 0, unit: 'm/s²', description: 'Thrust acceleration.' }),
    drag: t.f32({ default: 0.4, min: 0, description: 'Fraction of speed lost per second without thrust.' }),
    turnRate: t.f32({ default: 1.2, min: 0, unit: 'rad/s', description: 'Steering speed.' }),
  },
  { description: 'A ship the player flies: steer with arrows or the left stick, thrust with W.' },
)

const spin = quat.create()
const forward = vec3.create()

/** Steers and moves every ship along its -Z axis. */
const fly = defineSystem({
  name: '${name}/fly',
  setup: (world) => ({ ships: world.query({ with: [Ship, Transform] }) }),
  run: ({ ships }, world) => {
    const dt = world.resource(FixedTime).step
    const controls = world.resource(Controls.resource)
    const [yaw, pitch] = controls.axis2d('steer')
    const thrust = controls.pressed('thrust')
    for (const table of ships.tables) {
      const speed = table.column(Ship, 'speed')
      const maxSpeed = table.column(Ship, 'maxSpeed')
      const acceleration = table.column(Ship, 'acceleration')
      const drag = table.column(Ship, 'drag')
      const turnRate = table.column(Ship, 'turnRate')
      const translation = table.column(Transform, 'translation')
      const rotation = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        const s = thrust
          ? Math.min(maxSpeed[i]!, speed[i]! + acceleration[i]! * dt)
          : speed[i]! * Math.max(0, 1 - drag[i]! * dt)
        speed[i] = s
        const r = rotation.subarray(i * 4, i * 4 + 4)
        quat.fromEuler(spin, pitch * turnRate[i]! * dt, -yaw * turnRate[i]! * dt, 0)
        quat.normalize(r, quat.multiply(r, r, spin))
        vec3.transformQuat(forward, [0, 0, -1], r)
        translation[i * 3] = translation[i * 3]! + forward[0]! * s * dt
        translation[i * 3 + 1] = translation[i * 3 + 1]! + forward[1]! * s * dt
        translation[i * 3 + 2] = translation[i * 3 + 2]! + forward[2]! * s * dt
      }
      table.markChanged(Ship)
      table.markChanged(Transform)
    }
  },
})

export default project
`

const emptyMain = (name: string) => `import { defineProject } from '@aethervtt/shard-project'

const project = defineProject({
  name: '${name}',
  build(_app) {
    // Register systems here: app.addSystems(Update, mySystem)
  },
})

export default project
`

const explorerTest = (name: string) => `import { expect, test } from '@aethervtt/shard-testing'

test('holding thrust flies the ship forward', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  game.input.hold('${name}/Controls.thrust')
  await game.step(120)
  const ship = game.get('ship', '${name}/Ship')
  expect(ship.speed).toBeGreaterThan(10)
  expect(game.get('ship', 'core/Transform').translation[2]).toBeLessThan(-10)
  await game.screenshot('thrust.png')
})

test('the ship coasts to a stop without thrust', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(60)
  expect(game.get('ship', '${name}/Ship').speed).toBe(0)
})
`

const emptyTest = `import { expect, test } from '@aethervtt/shard-testing'

test('the start scene loads', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(10)
  expect(game.get('cube', 'core/Transform').translation[1]).toBe(0.5)
})
`

/** Files for a new project, by project-relative path. */
export function projectTemplate(options: TemplateOptions): Record<string, string> {
  const { name, template, engineSpec } = options
  const deps = Object.fromEntries(
    [
      '@aethervtt/shard-cli',
      '@aethervtt/shard-core',
      '@aethervtt/shard-input',
      '@aethervtt/shard-project',
      '@aethervtt/shard-runtime',
      '@aethervtt/shard-testing',
      '@aethervtt/shard-transform',
    ].map((p) => [p, engineSpec]),
  )
  return {
    'shard.json': json(manifest(name)),
    'package.json': json({
      name,
      private: true,
      type: 'module',
      scripts: {
        validate: 'shard validate',
        test: 'shard test',
        check: 'shard check',
        dev: 'shard dev',
        docs: 'shard docs',
      },
      dependencies: deps,
      // Engine packages ship as TypeScript source, so type checks need their ambient types.
      devDependencies: {
        '@types/node': '^26.6.2',
        '@webgpu/types': '^0.1.74',
        typescript: '^7.0.2',
      },
    }),
    'scripts/main.ts': template === 'explorer' ? explorerMain(name) : emptyMain(name),
    'scenes/main.scene.json': json(template === 'explorer' ? explorerScene(name) : emptyScene),
    'tests/main.test.ts': template === 'explorer' ? explorerTest(name) : emptyTest,
    'shaders/.gitkeep': '',
    'assets/.gitkeep': '',
    '.gitignore': '.shard/\nnode_modules/\n',
    '.mcp.json': json({
      mcpServers: { shard: { command: 'pnpm', args: ['exec', 'shard', 'mcp'] } },
    }),
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['node', '@webgpu/types'],
      },
      include: ['scripts', 'tests'],
    }),
  }
}
