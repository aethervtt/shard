// Loaded into every test file by testFiles() when SHARD_WGSL_LOG is set (see wgsl-identity.mjs):
// records each shader variant the tests link as `key<TAB>sha256 of its WGSL`, one file per worker.

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ShaderLibrary } from '../packages/shader/src/library.ts'

const dir = process.env.SHARD_WGSL_LOG
if (dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${process.pid}.tsv`)
  const link = ShaderLibrary.prototype.link
  ShaderLibrary.prototype.link = function (request) {
    const linked = link.call(this, request)
    linked.then(
      ({ key, code }) =>
        appendFileSync(file, `${key}\t${createHash('sha256').update(code).digest('hex')}\n`),
      () => {},
    )
    return linked
  }
}
