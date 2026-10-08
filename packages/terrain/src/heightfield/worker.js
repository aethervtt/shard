// Pool jobs for heightfield terrain (spec 0071). Plain JavaScript: workers import it with no bundler
// or loader. The noise kernel comes by URL with its compiled module, so a worker samples exactly as
// the main thread does.
import { bakeBlock as bake, LEAF_SIDE, leafNormals, pageTexels, readPage, SIDE } from './kernel.js'

const kernels = new Map()

/**
 * This worker's noise kernel: imported once per URL and instantiated from the first module posted
 * (every job posts the same build; a posted module arrives as a new object each time).
 */
function noiseFor(url, module) {
  let k = kernels.get(url)
  if (!k) {
    k = import(url).then((m) => ({
      state: m.instantiate(module),
      computeOrigins: m.computeOrigins,
      evalProgram: m.evalProgram,
    }))
    kernels.set(url, k)
  }
  return k
}

/** Bakes one block (kernel.js bakeBlock) on this thread. */
export async function bakeBlock(url, module, stack, layout, bx, bz) {
  return bake(await noiseFor(url, module), stack, layout, bx, bz)
}

/**
 * Inflates and decodes a page, and lays it out as the GPU pool holds it: what streaming needs
 * from a read, off the main thread. Leaves' normals come from their heights here.
 */
export function loadPage(packed, leaf, cells, lo, hi, spacing) {
  const page = readPage(packed, leaf, cells)
  const normals =
    page.normals ?? leafNormals(page.heights, lo, hi, spacing, new Uint8Array(SIDE * SIDE * 2))
  const texels = pageTexels(
    { heights: page.heights, normals, control: page.control },
    leaf,
    lo,
    hi,
    spacing,
    new Uint8Array(LEAF_SIDE * LEAF_SIDE * 4),
  )
  return { heights: page.heights, normals, control: page.control, texels }
}
