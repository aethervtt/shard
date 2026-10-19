import { ShardError } from '@aethervtt/shard-core'

/** Package-owned codec assets, using the URLs emitted by the browser bundler. */
export async function readCodecAsset(url: URL): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url)
  if (!response.ok)
    throw new ShardError('platform/codec-fetch', `HTTP ${response.status}`, { path: url.href })
  return new Uint8Array(await response.arrayBuffer())
}

export function commonJsContext(_url: URL): {
  require: unknown
  dirname: string
  filename: string
} {
  return { require: undefined, dirname: '', filename: '' }
}

export const nodeCodecs = false

/** Node-only importers reject explicitly; browser codecs use readCodecAsset. */
export function requireCodec(_specifier: string, _from: string): unknown {
  throw new ShardError('platform/node-codec', 'This codec requires a Node host')
}

export async function readCodecDependency(
  _specifier: string,
  _relative: string,
  _from: string,
): Promise<Uint8Array<ArrayBuffer>> {
  throw new ShardError('platform/node-codec', 'Dependency file resolution requires a Node host')
}
