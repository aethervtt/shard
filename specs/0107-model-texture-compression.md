# 0107 — Compressed textures for imported models

- **Status:** implemented
- **Packages:** `@aethervtt/shard-gltf`, `@aethervtt/shard-texture`, `@aethervtt/shard-protocol`
- **Depends on:** 0015, 0016, 0103

## Context

0016 made Basis Universal compression a per-texture setting in an image's `.meta`. Images embedded
in a `.glb` (or in a data URI) have no `.meta` of their own, so the glTF importer imported every one
of them as RGBA8 with mips, at up to 4096. A character from Tripo carries three 2048² textures (base
color, normal, metallic-roughness): 22.4 MB each after import, 67 MB per character, for a figure a
hundred pixels tall.

Compressing turned up a 0016 bug. Basis transcodes BC5 and EAC RG11 from red and **alpha**
(its normal-map convention keeps Y there), and the importer kept normals in RGB. On any device with
BC or ETC2, every compressed normal map read Y = 1 and shaded flat.

## Goals

- A model's `.meta` chooses Basis compression for its embedded images, and a size cap.
- Each image gets the mode its role tolerates: normal and packed data maps stay clear of etc1s
  artifacts.
- Models that don't ask keep today's output.
- Works with skinned meshes, generated LODs (0103), and `KHR_texture_basisu` sources.
- What was chosen is visible in `asset.get`.

## Non-goals

- Per-image overrides inside one model. One mode per model, or `auto` per role, covers the cases
  seen so far.
- Re-encoding KTX2 sources (decode, resize, encode again).
- Export presets per platform (still M9).

## Design

### Settings

Two fields on `gltf/ImportSettings`:

```jsonc
// characters/player/player.glb.meta
{ "settings": { "textureCompression": "auto", "textureMaxSize": 1024 } }
```

- `textureCompression`: `none` (default) | `auto` | `etc1s` | `uastc`. `auto` is etc1s for color
  (base color, emissive) and uastc for normal and data maps (metallic-roughness, occlusion).
- `textureMaxSize`: default 4096, the old hard-coded value. Larger images are halved until both
  sides fit.

External images (`uri` to a file) are their own assets and keep using their own `.meta`.

### Normal maps keep Y in alpha too

When the texture importer compresses a normal map it copies G into A before encoding and tags the
KTX2 `shard.normalY = alpha`. At load, `transcodeTarget` picks BC5 / EAC RG11 only for a tagged
normal map. Anything else, such as a Basis normal map made elsewhere with Y in green only, goes to
BC7 / ASTC / ETC2 RGBA, which keep RGB. Four-channel targets and the RGBA8 fallback read RGB as
before. Previews force alpha to 255 for tagged maps.

### KHR_texture_basisu

- The extension is supported. A file that requires it imports instead of failing, and one that only
  uses it no longer warns that it's ignored.
- A KTX2 image passes through as it is. `textureCompression` and `textureMaxSize` don't apply; a
  KTX2 larger than the cap warns.
- A basisu texture's fallback `source` (usually a PNG) isn't imported unless another texture uses
  that image directly.

### Agent surface

`asset.get` (MCP `get_asset`) on a texture sub-asset (`player.glb#Texture/...`), also stored in
`.shard/catalog.json`. `reimport_asset` with `{ "settings": { "textureCompression": "auto" } }`
changes the setting:

| key | meaning |
|---|---|
| `compression` | `none`, `etc1s` or `uastc` |
| `width`, `height` | stored size |
| `sourceWidth`, `sourceHeight` | the image's own size, present when it was capped |
| `bytes` | the artifact: download and cache size |
| `gpuBytes` | GPU memory with a block format (BC7/BC5/ASTC/ETC2). The RGBA8 fallback is 4× this for a compressed texture |
| `usage`, `source`, `mips` | as before |

## Decisions

- **Off by default.** Encoding takes seconds per texture (about 7 s for a character at 1024), and
  0016's reason holds: first imports shouldn't stall the agent loop. Characters opt in per model.
- **`auto` = etc1s for color only.** ETC1S applies one intensity offset across RGB per texel. On
  NormalTangentMirrorTest's packed occlusion/roughness/metallic map it draws visible rings, and on
  normals it bends vectors. UASTC costs more on disk (about 1.1 MB vs 0.17 MB at 1024²) and the
  same on the GPU (both transcode to 16-byte blocks). `etc1s` remains for the smallest files.
- **Y in alpha, not transcoder channel arguments.** The vendored Basis build hard-codes red and alpha
  for UASTC → BC5 / EAC RG11 too, and ETC1S can't pick channels at all. Writing Y in alpha works
  for both modes and leaves every other reader unchanged.
- **Importer version 5.** The basisu fallback skip changes output for those files.

## Acceptance criteria

- [x] NormalTangentMirrorTest with `auto` and cap 256: color and data etc1s / uastc, normal uastc,
      all 256² with their 2048² source size reported, from over 65 MB to under 200 KB. Transcoded
      to BC7/BC5/BC7 on Dawn, and renders within 1.5 (mean per channel) of the RGBA8 import, with
      and without compressed formats on the device.
- [x] CesiumMan (skinned, generated LODs) with `etc1s` and cap 512 renders within 1.5 of the
      uncompressed import.
- [x] A `KHR_texture_basisu` BoxTextured, with the extension used and required, imports one texture
      (the KTX2, uastc) and matches the BoxTextured golden image.
- [x] Compressed normal maps (uastc and etc1s) transcoded to BC5 hold X and Y in its two channels.
      An untagged Basis normal map transcodes to BC7.
- [x] The playground's animation demo imports CesiumMan compressed, so the browser tests run it on
      WebGPU and WebGL2.

## Implementation notes

- ygo's player.glb (Tripo, three 2048² textures) with `auto` and 1024: textures 67.1 MB → 1.70 MB
  on disk, 4.19 MB on the GPU (BC5 + 2× BC7), import 1.1 s → 7.8 s. Renders at 256 px are within
  0.34 of the uncompressed import on BC and within 0.33 on RGBA8.
- Checked by hand in Chromium: WebGL2 with BC extensions (BC7) and `?gl=minimum` (RGBA8) both draw
  the compressed CesiumMan with health ok.
