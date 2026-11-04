import { PRESET_LOOKS, TREE_LOOKS, TREE_PRESETS, type TreeLook } from './presets'

/** One file `shard nature init` writes: JSON text, or a file copied from the package's `assets/`. */
export type StarterFile = { path: string; text: string } | { path: string; copy: string }

/** The texture files a look uses, relative to the package's `assets/`. */
export function lookTextures(look: TreeLook): { bark: Record<string, string>; leaves: string } {
  const { bark, leaves } = TREE_LOOKS[look]
  return {
    bark: {
      color: `textures/bark/${bark}_Color.jpg`,
      normal: `textures/bark/${bark}_NormalGL.jpg`,
      roughness: `textures/bark/${bark}_Roughness.jpg`,
    },
    leaves: `textures/leaves/${leaves}.png`,
  }
}

/** A look's `nature/Tree` material file, with textures under `dir`. */
export function lookMaterial(look: TreeLook, dir: string): Record<string, unknown> {
  const l = TREE_LOOKS[look]
  const tex = lookTextures(look)
  const slot = (path: string) => ({ texture: { path: `${dir}/${path}` } })
  return {
    type: 'nature/Tree',
    baseColorTexture: slot(tex.bark.color!),
    normalTexture: slot(tex.bark.normal!),
    metallicRoughnessTexture: slot(tex.bark.roughness!),
    roughness: 1,
    alphaMode: 'mask',
    alphaCutoff: l.alphaCutoff,
    doubleSided: true,
    leafTexture: { path: `${dir}/${tex.leaves}` },
    barkTint: l.barkTint,
    leafTint: l.leafTint,
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Everything a project needs to grow and draw the presets, under `dir` (default `assets/nature`):
 * `species/<preset>.tree.json`, `materials/<look>.material.json`, the textures they use, and the
 * third-party notice. Paths are project-relative with `/` separators.
 */
export function natureStarterFiles(dir = 'assets/nature'): StarterFile[] {
  const files: StarterFile[] = []
  for (const [name, species] of Object.entries(TREE_PRESETS))
    files.push({ path: `${dir}/species/${name}.tree.json`, text: json(species) })
  for (const look of Object.keys(TREE_LOOKS) as TreeLook[]) {
    files.push({
      path: `${dir}/materials/${look}.material.json`,
      text: json(lookMaterial(look, dir)),
    })
  }
  const textures = new Set<string>()
  for (const look of Object.keys(TREE_LOOKS) as TreeLook[]) {
    const tex = lookTextures(look)
    for (const path of Object.values(tex.bark)) textures.add(path)
    textures.add(tex.leaves)
  }
  for (const path of [...textures].sort()) files.push({ path: `${dir}/${path}`, copy: path })
  files.push({ path: `${dir}/THIRD-PARTY.md`, copy: 'THIRD-PARTY.md' })
  return files
}

/** The material file (`materials/<look>.material.json`) a preset is drawn with. */
export function presetMaterialPath(
  preset: keyof typeof TREE_PRESETS,
  dir = 'assets/nature',
): string {
  return `${dir}/materials/${PRESET_LOOKS[preset]}.material.json`
}
