import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readCodecAsset as fetchAsset } from './codecs-browser'

export async function readCodecAsset(url: URL): Promise<Uint8Array<ArrayBuffer>> {
  if (url.protocol !== 'file:') return fetchAsset(url)
  return new Uint8Array(await readFile(url))
}

export function commonJsContext(url: URL): { require: unknown; dirname: string; filename: string } {
  const filename = fileURLToPath(url)
  return { require: createRequire(url), dirname: dirname(filename), filename }
}

export const nodeCodecs = true

export function requireCodec(specifier: string, from: string): unknown {
  return createRequire(from)(specifier)
}

export function readCodecDependency(
  specifier: string,
  relative: string,
  from: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const entry = pathToFileURL(createRequire(from).resolve(specifier))
  return readCodecAsset(new URL(relative, entry))
}
