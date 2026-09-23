# Write a system

```ts
const burn = defineSystem({
  name: 'star-explorer/burn',
  setup: (world) => ({ q: world.query({ with: [Fuel] }) }),
  run: ({ q }, world) => {
    const dt = world.resource(FixedTime).step
    for (const table of q.tables) {
      const liters = table.column(Fuel, 'liters')
      for (let i = 0; i < table.count; i++) liters[i] = Math.max(0, liters[i]! - dt)
      table.markChanged(Fuel)
    }
  },
})
```

Register it in the project's `build(app)`: `app.addSystems(FixedUpdate, burn)`. Hot loops must not
allocate: walk `q.tables` and use columns.
