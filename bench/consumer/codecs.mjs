import { readFile } from 'node:fs/promises'
import { checkCodecs } from './check-codecs.mjs'

console.log(
  JSON.stringify(
    await checkCodecs(
      async (file) => new Uint8Array(await readFile(new URL(`./public/${file}`, import.meta.url))),
    ),
  ),
)
