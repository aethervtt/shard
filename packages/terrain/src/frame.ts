import { affine64, type Entity, type World } from '@aethervtt/shard-core'
import { GlobalTransform, GridFramesResource } from '@aethervtt/shard-transform'

/**
 * A planet's frame against the floating origin, in f64: planet coordinates are its grid's
 * (`cell × cellSize + offset`), which is where chunks, anchors, and the camera are compared.
 * Taken from the grid frames transform propagation solved this frame (spec 0040).
 */
export class PlanetFrame {
  /** Planet frame → origin frame (affine, 12 f64). */
  readonly toOrigin = affine64.create()
  /** Origin frame → planet frame. */
  readonly toPlanet = affine64.create()

  update(world: World, planet: Entity): void {
    const frames = world.tryResource(GridFramesResource)
    const slot = frames?.active ? frames.slotOf.get(planet) : undefined
    if (frames && slot !== undefined && !Number.isNaN(frames.a[slot * 12]!)) {
      const cs = frames.cellSize[slot]!
      affine64.translateAt(
        this.toOrigin,
        0,
        frames.a,
        slot * 12,
        -frames.ref[slot * 3]! * cs,
        -frames.ref[slot * 3 + 1]! * cs,
        -frames.ref[slot * 3 + 2]! * cs,
      )
    } else if (world.has(planet, GlobalTransform)) {
      const m = world.get(planet, GlobalTransform).matrix
      for (let i = 0; i < 12; i++) this.toOrigin[i] = m[i]!
    } else affine64.identity(this.toOrigin)
    if (!affine64.invert(this.toPlanet, this.toOrigin)) affine64.identity(this.toPlanet)
  }

  /** An origin-frame point into the planet frame, at `out[o]`. */
  pointToPlanet(x: number, y: number, z: number, out: Float64Array, o = 0): Float64Array {
    const m = this.toPlanet
    out[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
    out[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
    out[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
    return out
  }

  /** An origin-frame direction into the planet frame (rotation only). */
  vectorToPlanet(x: number, y: number, z: number, out: Float64Array, o = 0): Float64Array {
    const m = this.toPlanet
    out[o] = m[0]! * x + m[1]! * y + m[2]! * z
    out[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z
    out[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z
    return out
  }

  /** A planet-frame point into the origin frame. */
  pointToOrigin(x: number, y: number, z: number, out: Float64Array | Float32Array, o = 0) {
    const m = this.toOrigin
    out[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
    out[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
    out[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
    return out
  }

  /** A planet-frame direction into the origin frame. */
  vectorToOrigin(x: number, y: number, z: number, out: Float64Array | Float32Array, o = 0) {
    const m = this.toOrigin
    out[o] = m[0]! * x + m[1]! * y + m[2]! * z
    out[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z
    out[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z
    return out
  }
}
