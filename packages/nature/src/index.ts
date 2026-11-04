export { splitTreeMesh, treeGlbScene } from './export'
export { buildTree, TreeGenerator } from './generator'
export { NATURE_SHADERS, TreeMaterial } from './material'
export { naturePlugin } from './plugin'
export {
  PRESET_LOOKS,
  TREE_LOOKS,
  TREE_PRESETS,
  type TreeLook,
  type TreePreset,
} from './presets'
export {
  MAX_TREE_LEVELS,
  TreeSpecies,
  TreeSpeciesFields,
  type TreeSpeciesValue,
  validateSpecies,
} from './species'
export {
  lookMaterial,
  lookTextures,
  natureStarterFiles,
  presetMaterialPath,
  type StarterFile,
} from './starter'
export {
  BARK_PART_MAX,
  EZ_UNIT,
  estimateTriangles,
  FULL_DETAIL,
  growTree,
  MAX_TREE_TRIANGLES,
  meshTree,
  type SkeletonBranch,
  type TreeDetail,
  type TreeSkeleton,
} from './tree'
