# Write a gameplay test

```ts
import { expect, test } from '@shard/testing'

test('thrust moves the ship', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  game.input.hold('maze-chase/Controls.thrust')
  await game.step(120)
  expect(game.get('ship', 'core/Transform').translation[2]).toBeLessThan(0)
})
```

Run with `shard test --json`. Tests are headless, seeded, and fixed-timestep: they pass or fail the
same way every run.
