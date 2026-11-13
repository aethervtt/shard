// The 0113 test town, for other packages' tests (the playground's cross-browser hash check).
export { ENGINE_COMPONENTS } from './fixtures/engine-components'
export {
  Container,
  Contents,
  Door,
  defineTown,
  Prop,
  Shell,
  TownCell,
  TownLoot,
  type TownOptions,
} from './fixtures/town'

/** The 20 cells around the origin at both levels that hash checks compare. */
export const HASH_CELLS: [number, number, string][] = []
for (let x = -2; x <= 2; x++)
  for (let z = -2; z <= 1; z++) for (const level of ['full', 'far']) HASH_CELLS.push([x, z, level])
