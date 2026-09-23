# 0016 — Textures

- **Status:** accepted
- **Packages:** `@shard/texture` (new), `@shard/render`, `@shard/gltf`, `@shard/protocol`
- **Depends on:** 0005, 0007, 0014, 0015

## Context

The renderer draws flat colors. Materials have no texture slots, the GPU layer has no texture
upload path, and glTF materials (0015) import their factors and drop their maps. Real models are
mostly textures: albedo, normal, metallic-roughness, occlusion, emissive.

Textures are also the biggest assets a game ships and the easiest to get subtly wrong. The color
space can be wrong, mips can be filtered in gamma space, and normal maps can be read with the
wrong tangents. This spec gets them right once, on every host, and makes textures visible to agents,
who otherwise can't tell a missing normal map from a working one.

## Goals

- Import PNG, JPEG, WebP, KTX2, and Radiance `.hdr` into one GPU-ready artifact format.
- Decode identically on every host, so artifacts and golden images match between Node, Studio,
  and the browser.
- Mipmaps generated at import, in linear light, with normal maps renormalized.
- Optional Basis Universal compression, transcoded at load to what the GPU supports (BC7, ASTC,
  ETC2) with an uncompressed fallback.
- Five texture slots on `StandardMaterial`, matching glTF's metallic-roughness model, including
  normal mapping with correct tangents.
- Textures made in code (procedural, M7) use the same `Texture` type and upload path.
- Agents can see a texture, a material, or a model as an image through `asset.preview`.

## Non-goals

- Per-platform compression presets at export (M9). Compression here is a per-texture setting.
- GPU mip generation and render-to-texture mips. CPU mips at import cover file textures, and M7
  adds GPU generation when procedural textures need it.
- Texture streaming, virtual texturing, and texture arrays for terrain splats (M7).
- EXR, cube map sources, and IBL prefiltering (M5 uses `.hdr` from here).

## Design

### Artifacts: KTX2 everywhere

Every texture importer writes a **KTX2** artifact: a standard container holding the format, the
dimensions, and every mip level. Tools like `ktx info` can inspect it, and a source `.ktx2` file
passes through with validation only. Artifacts are written without supercompression. Source KTX2
files with Zstandard supercompression are decoded with a small pure-JS zstd decoder.

### Decoding

- **PNG:** in TypeScript (the decoder moves from `@shard/protocol` into `@shard/texture`),
  including 16-bit, palette, and grayscale. It honors `sRGB`, `gAMA`, and `iCCP` only as far as
  telling sRGB apart from linear; ICC profile conversion is out of scope.
- **JPEG and WebP:** small WASM decoders, loaded lazily the first time an importer needs one.
- **Radiance `.hdr`:** RGBE in TypeScript, stored as `rgba16float`.
- The browser's own decoders (`createImageBitmap`, canvas) are never used. They apply color
  management and premultiplication differently per browser, which would make artifacts and golden
  images depend on the host.

### Import settings

```ts
settings: defineSchema('texture/ImportSettings', {
  usage: t.enum(['color', 'data', 'normal', 'hdr'], {
    description: 'color: sRGB albedo/emissive. data: linear masks (roughness, metallic, AO). ' +
      'normal: tangent-space normal map. hdr: linear float (environment maps).',
  }),
  mipmaps: t.bool({ default: true }),
  compression: t.enum(['none', 'etc1s', 'uastc'], {
    description: 'Basis Universal. uastc: high quality, larger. etc1s: small, lossy. ' +
      'Encoding takes seconds per texture on first import; the cache keeps the result.',
  }),
  maxSize: t.u32({ default: 4096, min: 1, max: 16384, description: 'Downscale larger images.' }),
  flipY: t.bool({ description: 'Flip vertically on import.' }),
  premultiplyAlpha: t.bool(),
})
```

- **Usage defaults** follow the file name when a `.meta` is first created: `*normal*`, `*_n.*` →
  `normal`; `*rough*`, `*metal*`, `*_orm*`, `*occlusion*`, `*_ao*` → `data`; `.hdr` → `hdr`;
  everything else → `color`. Usage decides mip filtering (linear light for `color`, renormalized
  vectors for `normal`) and the default view format.
- **Compression defaults to `none`**, stored as `rgba8unorm` (with mips) or `rgba16float` for `hdr`.
  Encoding UASTC for a 2K texture takes seconds. Paying that on every new texture would stall the
  agent loop, so compression is opt-in per texture until M9 adds export presets.

### Compressed textures

`etc1s` and `uastc` artifacts hold Basis Universal data. At load, a WASM transcoder (loaded only
when a compressed texture appears) targets the best format the device supports:

| Device feature | Color / data | Normal |
|---|---|---|
| `texture-compression-bc` | BC7 | BC5 |
| `texture-compression-astc` | ASTC 4x4 | ASTC 4x4 |
| `texture-compression-etc2` | ETC2 RGBA8 | EAC RG11 |
| none | RGBA8 | RGBA8 |

Basis requires dimensions that are multiples of 4. Other sizes are padded at import with a warning.

### Runtime `Texture`

```ts
const tex = Texture.create({ width: 256, height: 256, format: 'rgba8unorm', usage: 'color',
  mips: [pixels] })                  // procedural: CPU mips generated if `mipmaps: true`
const ref = world.resource(TextureAssets).add(tex, 'noise')
tex.update({ mips: [newPixels] })    // bumps version; the renderer re-uploads
```

- The renderer uploads a texture lazily on first draw and compares versions, as it does for
  meshes. Colors use one `rgba8unorm` texture created with an `rgba8unorm-srgb` view format. A
  slot reads it through the sRGB view when it holds color and through the linear view when it
  holds data. A texture imported with the wrong usage therefore samples correctly and only its
  mips are filtered wrong.
- **CPU pixels are released after upload.** A 4K RGBA8 texture with mips is about 90 MB, and
  keeping a second copy in memory isn't affordable in a browser. After device loss, the asset server reloads
  textures from their artifacts, and draws skip until they're back (0005 recovery, 0014
  readiness). Textures created in code keep their pixels unless created with `cpu: false`.
- Samplers are cached by descriptor. The sampler comes from the material slot (below), not the
  texture, because glTF puts samplers on texture references.

### Material slots

`StandardMaterial` gains five slots, each a `TextureSlot` struct:

```ts
const TextureSlot = t.struct({
  texture: t.handle('Texture'),
  uv: t.u8({ max: 1, description: 'UV set: 0 or 1.' }),
  offset: t.vec2(), scale: t.vec2({ default: [1, 1] }), rotation: t.f32({ unit: 'rad' }),
  wrap: t.enum(['repeat', 'clamp', 'mirror']),
  filter: t.enum(['linear', 'nearest']),
})
// baseColorTexture, metallicRoughnessTexture (G = roughness, B = metallic),
// normalTexture (+ normalScale), occlusionTexture (+ occlusionStrength), emissiveTexture
```

- Empty slots bind 1×1 default textures (white, or a flat normal), so there's one pipeline per
  mesh layout rather than one per slot combination, and binding stays uniform. Factors multiply
  texture values, as in glTF.
- `offset`, `scale`, and `rotation` are `KHR_texture_transform`. They're applied in the vertex
  stage.
- **Tangents:** normal mapping uses the mesh's `TANGENT` attribute (0015). When a mesh has a
  normal texture but no tangents, the glTF importer generates MikkTSpace tangents with a WASM port
  of the reference implementation. MikkTSpace is what baked normal maps expect, and approximating
  it in the shader shows seams.
- The material's layout (`wgslLayout`, 0006) still comes from the schema. Texture and sampler
  bindings are appended in slot order.

### glTF (0015 follow-up)

- Images in buffer views and data URIs become `Texture/<name>` sub-assets of the model. External
  images are separate texture assets referenced by path, which makes them load dependencies.
- `KHR_texture_basisu` sources import as KTX2. `KHR_texture_transform` fills the slot transform.
- A model that uses an image as a normal or data map when the image's usage is `color` gets the
  warning `gltf/texture-usage-mismatch`, with the pointer and a `reimport_asset` hint.
- The glTF importer's version bumps, so models re-import once and gain their textures.

### Previews

`asset.preview { ref, width?, height? }` returns a PNG, the same shape as `render.capture`:

- **Texture:** the top mip, tonemapped for `hdr` and shown as color for `normal`.
- **Material:** a sphere under a neutral light rig.
- **Mesh / Scene:** framed from the asset's bounds, at three-quarter view.

Previews render in a private offscreen world with its own camera and lights, so the game's world,
time, and frame count are untouched. Scene previews reuse `SceneInstance`.

### Agent surface

- MCP `preview_asset` returns image content. An agent can look at a model before placing it and
  check a material after changing it.
- `asset.get` for a texture adds size, format (source and GPU), mip count, usage, compression, and
  GPU memory. `render.describe` adds total texture memory.
- Errors: `texture/decode-failed`, `texture/unsupported-format`, `texture/too-large` (over
  `maxSize` or the device limit), `texture/transcoder-unavailable`.
- `shard docs` lists the texture slots and the usage conventions in `.agents/`.

## Decisions

- **Decode in our own code, never the browser's.** Artifacts are cached by content and shared
  across hosts, so the same bytes have to decode to the same pixels everywhere.
- **KTX2 as the artifact format.** It's the standard GPU texture container, it holds every format
  we need, and existing tools can inspect our cache.
- **Compression off by default.** First-import speed matters more during authoring, and export
  (M9) is where size matters.
- **sRGB is a view, not a copy.** One upload serves both color and data slots, so a wrong usage
  setting can't make a texture unusable.
- **Default textures instead of slot permutations.** One pipeline per mesh layout keeps pipeline
  count and compile hitches low, and sampling a 1×1 texture costs almost nothing.
- **MikkTSpace tangents at import.** They match what baking tools produce, and an import-time cost
  is paid once and cached.

## Acceptance criteria

- [ ] PNG (8/16-bit, palette, gray), JPEG, WebP, KTX2 (raw and zstd), and `.hdr` fixtures decode
      to the same pixels in Node and in the browser (hash-compared).
- [ ] Mips of a `color` checkerboard average in linear light, and each mip of a `normal` map has
      unit-length normals (within 1%).
- [ ] With `uastc`, a fixture transcodes to BC7 under Dawn on desktop and to RGBA8 when compression
      features are disabled. Both render within tolerance of the uncompressed golden image.
- [ ] The Khronos `BoxTextured`, `NormalTangentTest`, `NormalTangentMirrorTest`, and
      `TextureTransformTest` models render as golden images, with generated tangents matching
      the file's own tangents on `NormalTangentTest` (within 1°).
- [ ] Changing a PNG while the app runs updates the rendered texture within two frames, keeping
      its GUID.
- [ ] A texture created in code with `Texture.create` renders, and `update` re-uploads it.
- [ ] After a simulated device loss, textured draws recover without errors once reloads finish.
- [ ] `asset.preview` returns a PNG for a texture, a material, a mesh, and a scene. The scene
      preview frames the model's bounds. The game world's frame count is unchanged afterwards.
- [ ] Loading a 2048² `rgba8` artifact with mips and uploading it takes under 30 ms in Node
      (Dawn), and importing a 2048² PNG takes under 1.5 s.

## Open questions

- None blocking. Deferred: GPU mip generation (M7) and export compression presets (M9).
