import { Texture, toHalf } from '@aethervtt/shard-texture'

// The dice's image-based light (0054): a small procedural studio, an equirectangular HDR of a soft
// gradient and two soft boxes. Metal and glass reflect it; nothing of it shows (the dice view
// clears to alpha, 0052).

interface SoftBox {
  /** Direction: azimuth and elevation, degrees. */
  azimuth: number
  elevation: number
  /** Half size, degrees. */
  width: number
  height: number
  intensity: number
  color: [number, number, number]
}

const BOXES: SoftBox[] = [
  { azimuth: -35, elevation: 58, width: 26, height: 16, intensity: 7, color: [1, 0.97, 0.92] },
  { azimuth: 140, elevation: 30, width: 34, height: 6, intensity: 3.2, color: [0.85, 0.92, 1] },
  { azimuth: 60, elevation: 12, width: 10, height: 10, intensity: 1.6, color: [1, 0.9, 0.8] },
]

/** A 256 × 128 rgba16float equirectangular studio: EnvironmentMap texture (usage 'hdr'). */
export function studioEnvironment(): Texture {
  const width = 256
  const height = 128
  const f = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const elevation = 90 - ((y + 0.5) / height) * 180
    const up = Math.sin((elevation * Math.PI) / 180)
    // A bright ceiling, a dim floor, a soft horizon between.
    const sky = up > 0 ? 0.35 + 0.45 * up : 0.12 + 0.2 * (1 + up)
    for (let x = 0; x < width; x++) {
      const azimuth = ((x + 0.5) / width) * 360 - 180
      let r = sky * 0.96
      let g = sky * 0.98
      let b = sky
      for (const box of BOXES) {
        let da = Math.abs(azimuth - box.azimuth)
        if (da > 180) da = 360 - da
        const dx = da / box.width
        const dy = Math.abs(elevation - box.elevation) / box.height
        // A soft-edged rectangle.
        const k = Math.max(0, 1 - Math.max(dx, dy) ** 6)
        if (k <= 0) continue
        r += box.color[0] * box.intensity * k
        g += box.color[1] * box.intensity * k
        b += box.color[2] * box.intensity * k
      }
      const o = (y * width + x) * 4
      f[o] = r
      f[o + 1] = g
      f[o + 2] = b
      f[o + 3] = 1
    }
  }
  return Texture.create({
    width,
    height,
    format: 'rgba16float',
    usage: 'hdr',
    mips: [new Uint8Array(toHalf(f).buffer)],
  })
}
