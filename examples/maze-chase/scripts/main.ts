import { defineSystem, FixedUpdate, t, Update } from '@aethervtt/shard-core'
import { addActions, defineActions } from '@aethervtt/shard-input'
import { NavAgent } from '@aethervtt/shard-nav'
import { defineProject } from '@aethervtt/shard-project'
import { FixedTime } from '@aethervtt/shard-runtime'
import { findEntityByPath } from '@aethervtt/shard-scene'
import { tileAt } from '@aethervtt/shard-sprite'
import { Transform } from '@aethervtt/shard-transform'

/** Arrow keys or WASD run through the maze. */
export const Controls = defineActions('maze-chase/Controls', {
  up: { kind: 'button', bindings: ['Key:ArrowUp', 'Key:KeyW', 'Gamepad:DpadUp'] },
  down: { kind: 'button', bindings: ['Key:ArrowDown', 'Key:KeyS', 'Gamepad:DpadDown'] },
  left: { kind: 'button', bindings: ['Key:ArrowLeft', 'Key:KeyA', 'Gamepad:DpadLeft'] },
  right: { kind: 'button', bindings: ['Key:ArrowRight', 'Key:KeyD', 'Gamepad:DpadRight'] },
})

const project = defineProject({
  name: 'maze-chase',
  build(app) {
    addActions(app.world, Controls)
    app.addSystems(FixedUpdate, run).addSystems(Update, catchPlayer)
  },
})

export const Player = project.component(
  'Player',
  {
    speed: t.f32({ default: 4, min: 0, unit: 'm/s', description: 'Running speed.' }),
    radius: t.f32({ default: 0.3, min: 0, unit: 'm', description: 'Half the body’s width.' }),
    maze: t.entity({ description: 'The tilemap whose walls stop the player.' }),
  },
  { description: 'The player: runs with the arrows or WASD, stopped by the maze walls.' },
)

export const Enemy = project.component(
  'Enemy',
  {
    reach: t.f32({
      default: 0.6,
      min: 0,
      unit: 'm',
      description: 'Catches the player this close.',
    }),
    caught: t.bool({ readonly: true, description: 'Caught the player; the chase is over.' }),
  },
  { description: 'Chases the player (its NavAgent targets them) and stops once it catches them.' },
)

/** Whether a box of half-size `r` at (x, y) is clear of wall tiles. */
function clear(world: Parameters<typeof tileAt>[0], maze: number, x: number, y: number, r: number) {
  // Tile (tx, ty) covers x tx..tx + 1 and y 14 − ty..15 − ty (the maze sits at y = 15, rows down).
  const top = world.get(maze, Transform).translation[1]
  for (const [cx, cy] of [
    [x - r, y - r],
    [x + r, y - r],
    [x - r, y + r],
    [x + r, y + r],
  ] as const) {
    if (tileAt(world, maze, Math.floor(cx), Math.floor(top - cy), 'walls') !== 0) return false
  }
  return true
}

/** Moves the player by the controls, one axis at a time so it slides along walls. */
const run = defineSystem({
  name: 'maze-chase/run',
  setup: (world) => ({ players: world.query({ with: [Player, Transform] }) }),
  run: ({ players }, world) => {
    const dt = world.resource(FixedTime).step
    const c = world.resource(Controls.resource)
    const dx = (c.pressed('right') ? 1 : 0) - (c.pressed('left') ? 1 : 0)
    const dy = (c.pressed('up') ? 1 : 0) - (c.pressed('down') ? 1 : 0)
    if (dx === 0 && dy === 0) return
    for (const e of players.entities()) {
      const p = world.get(e, Player)
      if (p.maze === null) continue
      const [x, y, z] = world.get(e, Transform).translation
      const step = p.speed * dt
      let nx = x + dx * step
      if (!clear(world, p.maze, nx, y, p.radius)) nx = x
      let ny = y + dy * step
      if (!clear(world, p.maze, nx, ny, p.radius)) ny = y
      world.set(e, Transform, { translation: [nx, ny, z] })
    }
  },
})

/** An enemy close enough catches the player and stops. */
const catchPlayer = defineSystem({
  name: 'maze-chase/catch',
  setup: (world) => ({ enemies: world.query({ with: [Enemy, NavAgent, Transform] }) }),
  run: ({ enemies }, world) => {
    const player = findEntityByPath(world, 'player')
    if (player === undefined) return
    const [px, py] = world.get(player, Transform).translation
    for (const e of enemies.entities()) {
      const enemy = world.get(e, Enemy)
      if (enemy.caught) continue
      const [ex, ey] = world.get(e, Transform).translation
      if (Math.hypot(px - ex, py - ey) <= enemy.reach) {
        world.set(e, Enemy, { caught: true })
        world.set(e, NavAgent, { stopped: true })
      }
    }
  },
})

export default project
