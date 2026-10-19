# Installed-package regression check

`pnpm release --check` packs Shard without publishing it, installs the tarballs into a separate
consumer, then runs declaration checks, Vite 6/Vite 8/Bun/webpack/Next production builds, Node and Bun
codecs, and real Chromium tests. Chromium must be installed first:

```sh
pnpm --filter @aethervtt/shard-playground exec playwright install chromium
pnpm release --check --out /tmp/shard-consumer
```

The workspace and Aether dependencies are not used by the installed consumer. Fonts and WebP
inputs are copied read-only from existing licensed repository fixtures. Both Basis compression
modes are encoded and transcoded, including every mip. Browser checks fetch the emitted codec
assets, exercise differently sized shared surfaces, read visible canvases (including alpha),
render a scene and transparent dice after repeated resizes, execute a real dice worker, and
measure a 4.8-second animation at display, 30 and 20 fps demand. PNGs and JSON results are written
beside the consumer's builds. Failure to launch a browser or render is a failure, not a skip.

The Vite fixture deliberately sets `worker.format: 'es'` because physics loads in separate
module-worker chunks. Development optimization excludes dice, gpu-webgl2, texture and noise to
retain relative worker/codec/WASM URLs, and includes their CommonJS `jpeg-js` dependency.
The dev server is also exercised by the browser check. The webpack fixture selects ESM before
CommonJS to exercise OpenType's browser
module. The Next fixture uses ordinary client imports without Shard-specific webpack hooks.

No check publishes packages. A later release must update the unified version and publish the
rebuilt dependency graph together; copying generated files into Aether is not a release workflow.
