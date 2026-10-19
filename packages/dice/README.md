# @aethervtt/shard-dice

Install the dice package together with Shard's runtime, transform and render packages. Add
`TransformPlugin`, `renderPlugin`, `forwardPlugin` and `dicePlugin` to the app.

For browser physics, pass `diceWorker` from `@aethervtt/shard-dice/worker` to
`dicePlugin({ worker: diceWorker })`. Workers are ES modules with lazy physics chunks.
Vite 6/Rollup production builds require ES worker output for these split chunks. Vite 8 can
inline IIFE workers, but ES output retains lazy chunks and works with both versions:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: {
    include: ['@aethervtt/shard-texture > jpeg-js'],
    exclude: [
      '@aethervtt/shard-dice',
      '@aethervtt/shard-gpu-webgl2',
      '@aethervtt/shard-texture',
      '@aethervtt/shard-noise',
    ],
  },
})
```

The development exclusions preserve package-relative worker and shader WASM URLs. The texture
and noise exclusions are needed when those codecs/kernels execute in Vite development mode;
prebundling would move their relative asset URLs into `.vite/deps`. Keep the nested `jpeg-js`
dependency included so Vite converts its CommonJS module, even without hoisting. Webpack 5
recognizes Shard's module worker directly; no Node externals workaround is required for the
browser codec/importer graph. Serve emitted JS/WASM assets with their correct content types.

`worker: 'inline'` runs physics on the calling thread where workers are unavailable. It is an
explicit fallback, not the recommended browser configuration.
