import { type Rng, t } from '@aethervtt/shard-core'
import { defineGenerator, type MeshBuilderApi, type MeshResult } from '@aethervtt/shard-procgen'
import { TREE_PRESETS } from './presets'
import { type TreeSpeciesValue, validateSpecies } from './species'
import { FULL_DETAIL, growTree, meshTree } from './tree'

/**
 * A species grown from `rng` and meshed at full detail and at each of its LODs, scaled by `scale`,
 * with tangents (bark normal maps). What `nature/Tree` returns.
 */
export function buildTree(
  species: TreeSpeciesValue,
  rng: Rng,
  scale: number,
  finish: MeshBuilderApi['finish'],
): MeshResult {
  validateSpecies(species)
  const skeleton = growTree(species, rng)
  const mesh = (detail: typeof FULL_DETAIL) => {
    const b = meshTree(skeleton, species, detail)
    if (scale !== 1) b.scale(scale)
    return finish(b, { tangents: true }).mesh
  }
  return {
    kind: 'mesh',
    mesh: mesh({ ...FULL_DETAIL, billboard: species.leaves.billboard }),
    lods: species.lods.map(mesh),
  }
}

export const TreeGenerator = defineGenerator('nature/Tree', {
  description:
    'A tree or bush grown from a species (nature/TreeSpecies, *.tree.json) and the seed (experimental, spec 0095): EZ-Tree’s branching, bark rings and leaf cards in one mesh, with LODs meshed from the same skeleton. uv1.x is the part: bark 0 (trunk) to 0.3 (twigs), leaves 1. Draw it with a nature/Tree material.',
  params: {
    species: t.handle('nature/TreeSpecies', {
      description: 'The species (default: the built-in oak_medium).',
    }),
    scale: t.f32({ default: 1, min: 0.01, description: 'Uniform size multiplier.' }),
  },
  output: 'mesh',
  // Bump when growing or meshing changes: the cache keys on run's source, not tree.ts.
  version: 1,
  run(ctx, p) {
    const species = p.species ? ctx.load<TreeSpeciesValue>(p.species) : TREE_PRESETS.oak_medium
    return buildTree(species, ctx.rng, p.scale, ctx.mesh.finish)
  },
})
