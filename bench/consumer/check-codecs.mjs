import { CheckpointSchema, MusicProgram, musicBarTicks } from '@aethervtt/shard-audio'
import { GltfImporter } from '@aethervtt/shard-gltf'
import { loadNaga } from '@aethervtt/shard-gpu-webgl2'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { FontSource } from '@aethervtt/shard-text'
import { decodeWebp, encodeBasis, transcodeBasis } from '@aethervtt/shard-texture'

export function check(ok, message) {
  if (!ok) throw new Error(message)
}

export async function checkCodecs(read) {
  check(
    CheckpointSchema.fields && GltfImporter.import,
    'audio checkpoint and glTF importer initialize',
  )
  const program = MusicProgram.deserialize({
    entry: 'main',
    sections: [
      { id: 'main', bars: 1, stems: [{ id: 'stem', clip: { guid: 'test' }, endSample: 48000 }] },
    ],
  })
  check(musicBarTicks(program) === 3840, 'music schema/timing')
  let rejected = false
  try {
    MusicProgram.deserialize({ ...program, denominator: 3 })
  } catch {
    rejected = true
  }
  check(rejected, 'music validation')
  const font = new FontSource(await read('font.ttf'))
  const glyph = font.glyphIndex(65)
  check(
    glyph > 0 && font.advance(glyph) > 0 && font.shape(glyph).contours.length > 0,
    'font outlines and metrics',
  )
  const rgba = new Uint8Array(8 * 8 * 4)
  for (let i = 0; i < rgba.length; i += 4) rgba.set([200, 40, 80, 255], i)
  const basis = []
  for (const mode of ['etc1s', 'uastc']) {
    const encoded = await encodeBasis(rgba, 8, 8, 'color', mode, true)
    const decoded = await transcodeBasis(encoded, 'rgba8')
    check(
      decoded.width === 8 && decoded.height === 8 && decoded.levels.length === 4,
      `${mode} mip dimensions`,
    )
    const pixel = decoded.levels[0]
    check(
      Math.abs(pixel[0] - 200) < 25 && Math.abs(pixel[1] - 40) < 25 && pixel[3] === 255,
      `${mode} decoded pixels`,
    )
    basis.push({ mode, bytes: encoded.length, pixel: Array.from(pixel.slice(0, 4)) })
  }
  const webp = await decodeWebp(await read('pattern.webp'))
  check(webp.width > 0 && webp.data.some((v) => v > 0), 'WebP decode')
  const naga = await loadNaga()
  const shader = naga.translate(
    '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
    'fs',
    'fragment',
    { clipControl: false },
  )
  check(shader.glsl.includes('void main'), 'naga translation')
  await loadNoiseKernel({ simd: false })
  await loadNoiseKernel({ simd: true })
  return { font: font.name, basis, webp: [webp.width, webp.height], naga: naga.version }
}
