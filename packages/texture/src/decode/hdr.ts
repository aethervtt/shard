import { ShardError } from '@shard/core'
import type { Image } from '../image'

/** Radiance RGBE (.hdr), flat or new-style run-length encoded, into linear RGBA floats. */
export function decodeHdr(bytes: Uint8Array): Image {
  const text = new TextDecoder('latin1')
  let pos = 0
  const line = () => {
    const start = pos
    while (pos < bytes.length && bytes[pos] !== 0x0a) pos++
    return text.decode(bytes.subarray(start, pos++))
  }
  const magic = line()
  if (!magic.startsWith('#?'))
    throw new ShardError('texture/decode-failed', 'Not a Radiance .hdr file')
  for (let l = line(); l !== ''; l = line()) {
    if (l.startsWith('FORMAT=') && l !== 'FORMAT=32-bit_rle_rgbe') {
      throw new ShardError(
        'texture/unsupported-format',
        `.hdr ${l} isn't supported (need 32-bit_rle_rgbe)`,
      )
    }
    if (pos >= bytes.length) throw new ShardError('texture/decode-failed', '.hdr header never ends')
  }
  const size = /^-Y (\d+) \+X (\d+)$/.exec(line())
  if (!size)
    throw new ShardError(
      'texture/unsupported-format',
      'Only "-Y h +X w" .hdr orientation is supported',
    )
  const height = Number(size[1])
  const width = Number(size[2])
  const rgbe = new Uint8Array(width * height * 4)
  const scan = new Uint8Array(width * 4)
  for (let y = 0; y < height; y++) {
    const rle =
      width >= 8 &&
      width < 32768 &&
      bytes[pos] === 2 &&
      bytes[pos + 1] === 2 &&
      !(bytes[pos + 2]! & 0x80)
    if (!rle) {
      rgbe.set(bytes.subarray(pos, pos + width * 4), y * width * 4)
      pos += width * 4
      continue
    }
    pos += 4
    for (let c = 0; c < 4; c++) {
      let x = 0
      while (x < width) {
        let count = bytes[pos++]!
        if (count > 128) {
          count -= 128
          const v = bytes[pos++]!
          for (let k = 0; k < count; k++) scan[x++ * 4 + c] = v
        } else {
          for (let k = 0; k < count; k++) scan[x++ * 4 + c] = bytes[pos++]!
        }
      }
    }
    rgbe.set(scan, y * width * 4)
  }
  const out = new Float32Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3]!
    const f = e === 0 ? 0 : 2 ** (e - 136)
    out[i * 4] = rgbe[i * 4]! * f
    out[i * 4 + 1] = rgbe[i * 4 + 1]! * f
    out[i * 4 + 2] = rgbe[i * 4 + 2]! * f
    out[i * 4 + 3] = 1
  }
  return { width, height, kind: 'f32', data: out }
}
