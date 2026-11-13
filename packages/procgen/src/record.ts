import { sha256Hex } from '@aethervtt/shard-assets'
import { isPlainObject, type JsonValue } from '@aethervtt/shard-core'
import type { GenRequest } from './generator'
import type { GenOutputAsset } from './outputs'

/** A generator run's output, as cached: content-addressed by its key. */
export interface OutputRecord {
  key: string
  assets: GenOutputAsset[]
  children: GenRequest[]
  warnings: { message: string; path?: string }[]
  ms: number
  bytes: number
}

const MAGIC = 0x4e474853 // "SHGN"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function recordBytes(assets: readonly GenOutputAsset[]): number {
  let n = 256
  for (const a of assets) {
    n += a.bytes?.byteLength ?? 0
    if (a.json !== undefined) n += JSON.stringify(a.json).length
  }
  return n
}

/** One file per record: magic, header length, JSON header, then each asset's bytes (4-aligned). */
export function encodeRecord(record: OutputRecord): Uint8Array {
  const blobs: Uint8Array[] = []
  let offset = 0
  const assets = record.assets.map((a) => {
    const { bytes, ...rest } = a
    if (!bytes) return rest
    const at = offset
    blobs.push(bytes)
    offset += (bytes.byteLength + 3) & ~3
    return { ...rest, bytes: [at, bytes.byteLength] }
  })
  const header = encoder.encode(
    JSON.stringify({
      key: record.key,
      assets,
      children: record.children,
      warnings: record.warnings,
      ms: record.ms,
    }),
  )
  const head = (8 + header.byteLength + 3) & ~3
  const out = new Uint8Array(head + offset)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, header.byteLength, true)
  out.set(header, 8)
  let at = head
  for (const b of blobs) {
    out.set(b, at)
    at += (b.byteLength + 3) & ~3
  }
  return out
}

export function decodeRecord(data: Uint8Array): OutputRecord | undefined {
  if (data.byteLength < 8) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(0, true) !== MAGIC) return undefined
  const length = view.getUint32(4, true)
  const head = (8 + length + 3) & ~3
  const json = JSON.parse(decoder.decode(data.subarray(8, 8 + length))) as Omit<
    OutputRecord,
    'bytes' | 'assets'
  > & { assets: (Omit<GenOutputAsset, 'bytes'> & { bytes?: [number, number] })[] }
  const assets: GenOutputAsset[] = json.assets.map((a) => {
    if (!a.bytes) return a as GenOutputAsset
    const [at, n] = a.bytes
    // Views into the record (4-aligned), so a record moved from a worker is never copied.
    return {
      ...a,
      bytes: new Uint8Array(data.buffer, data.byteOffset + head + at, n),
    }
  })
  return { ...json, assets, bytes: recordBytes(assets) }
}

/** JSON with object keys sorted and no whitespace: the same text for the same value anywhere. */
function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  // Number to text is exactly specified (the shortest round trip), so engines agree.
  return JSON.stringify(value)
}

/**
 * The SHA-256 (hex) of a record's artifacts: per asset, by label, a canonical JSON header (label,
 * type, the artifact's JSON, its byte length) and then its bytes. The key, timing, warnings, and
 * `info` are left out, so the same output hashes the same on every machine and engine, however
 * it was made (inline, on a worker, from the disk cache).
 */
export function recordHash(record: Pick<OutputRecord, 'assets'>): Promise<string> {
  const assets = [...record.assets].sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
  )
  const parts: Uint8Array[] = []
  let length = 0
  for (const a of assets) {
    const header = encoder.encode(
      `${canonicalJson({ label: a.label, type: a.type, json: a.json ?? null, bytes: a.bytes?.byteLength ?? -1 })}\n`,
    )
    parts.push(header)
    length += header.byteLength
    if (a.bytes) {
      parts.push(a.bytes)
      length += a.bytes.byteLength
    }
  }
  const all = new Uint8Array(length)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.byteLength
  }
  return sha256Hex(all)
}
