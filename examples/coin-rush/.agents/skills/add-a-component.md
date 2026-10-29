# Add a component

In `scripts/`, define it on the project so it gets the project namespace:

```ts
export const Fuel = project.component('Fuel', {
  liters: t.f32({ default: 100, min: 0, unit: 'L', description: 'Fuel left.' }),
})
```

Write a description for every field: it ends up in `.agents/components.md`. Run `shard docs` after.
