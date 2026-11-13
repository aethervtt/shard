// Pool jobs for navmesh tiles (0112). Plain JavaScript: workers import it with no bundler or
// loader, and build with tile-build.js, the code the main thread builds with. Recast resolves
// from here as it does for the nav package (Node: its node_modules).
import { buildTile } from './tile-build.js'

let recast

function load() {
  recast ??= import('recast-navigation').then(async (R) => {
    await R.init()
    return R
  })
  return recast
}

/**
 * Builds one tile. Returns `{ bytes }` (null when nothing is walkable), or `{ error }` with the
 * failure's message, code and hint, since a thrown Error loses its code crossing threads. A worker
 * that can't load Recast rejects instead (the main thread then builds inline).
 */
export async function buildNavTile(settings, tx, ty, yMin, yMax, positions, areas, links, gates) {
  const R = await load()
  const count = areas.length
  const triangles = new Int32Array(count)
  for (let i = 0; i < count; i++) triangles[i] = i
  try {
    const bytes = buildTile(
      R,
      settings,
      tx,
      ty,
      yMin,
      yMax,
      { positions, areas },
      triangles,
      count,
      links,
      gates,
    )
    return { bytes }
  } catch (err) {
    return { error: { message: err.message, code: err.code, hint: err.hint } }
  }
}
