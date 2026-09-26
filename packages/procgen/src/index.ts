// Side effects: `procedural:<generator>` refs, generators in the catalog by name, the *.gen.json
// importer, and the GeneratorInstance kind.
import './refs'

export { findNondeterminism, type NondeterministicCall } from './check'
export {
  type ContextState,
  createContext,
  type GenContext,
  guardNondeterminism,
  type LoadedDependency,
  type NoiseApi,
} from './context'
export {
  allGenerators,
  canonicalParams,
  codeHashOf,
  defineGenerator,
  type Fragment,
  type FragmentEntity,
  findGenerator,
  type Generator,
  type GeneratorOptions,
  type GenParams,
  type GenRequest,
  guidOf,
  hashString,
  identityOf,
  type MeshResult,
  type OutputAsset,
  type OutputSpec,
  parseProceduralRef,
  proceduralPath,
  type RunResult,
  requestOf,
  requireGenerator,
  setGeneratorCodeHashes,
  type TextureData,
} from './generator'
export { GeneratorImporter, type GenFile, parseGenFile } from './importer'
export { Generated, GeneratorInstance, instanceRequest } from './instance'
export {
  executeJob,
  type GenJob,
  type GenResult,
  type JobDependency,
  jobError,
} from './job'
export { type MeshBuilderApi, meshBuilder } from './mesh-builder'
export {
  previewOutput,
  procgenMethods,
  type RunSummary,
  resolveGenerator,
  runGenerator,
} from './methods'
export { encodeOutput, type GenOutputAsset, toJson } from './outputs'
export { type ProcgenPluginOptions, procgenPlugin } from './plugin'
export { decodeRecord, encodeRecord, type OutputRecord } from './record'
export {
  type CacheResult,
  configureProcgenHost,
  DataAssetType,
  GeneratedData,
  GeneratorAssetType,
  type GeneratorBinding,
  GeneratorBindings,
  generate,
  mainThreadTurn,
  type ProcgenHost,
  type ProcgenOptions,
  ProcgenResource,
  ProcgenRuntime,
  type ProcgenStats,
  paramHandles,
  procgen,
  procgenHost,
  procgenMainThreadMs,
  runJob,
  warmGeneratorWorkers,
} from './runtime'
export { genFileSchema } from './schema'
export { contactSheet, drawLabel, parseSeeds } from './sheet'
