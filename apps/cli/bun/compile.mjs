// Run by Bun for `shard export --compile` and `--sidecar` (0111): compiles a server into one
// executable with nothing to install. `bun compile.mjs <entry> <outfile> <target>`.
//
// Bun embeds only files imported `with { type: "file" }`, and the engine names its WASM with
// `new URL('./x.wasm', import.meta.url)`, which inside the executable points nowhere. This plugin
// turns each such URL to an existing non-code file into an embedded import, in the entry's code
// and the engine's alike (a project's own server compiles from source and node_modules).

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const [entry, outfile, target] = process.argv.slice(2)
if (!entry || !outfile || !target) {
  console.error('usage: bun compile.mjs <entry> <outfile> <bun target>')
  process.exit(3)
}

// Quoted any way a minifier writes it, backticks included (never with `${`).
const FILE_URL = /new URL\(\s*(['"`])(\.{1,2}\/[^'"`$]+)\1\s*,\s*import\.meta\.url\s*\)/g
const CODE = /\.[mc]?[jt]sx?$/

const embedFiles = {
  name: 'shard-embed-files',
  setup(build) {
    build.onLoad({ filter: /\.[mc]?[jt]sx?$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      if (!source.includes('import.meta.url')) return undefined
      const imports = []
      const code = source.replace(FILE_URL, (match, _quote, rel) => {
        if (CODE.test(rel) || !existsSync(resolve(dirname(args.path), rel))) return match
        const id = `__shard_embedded_${imports.length}`
        imports.push(`import ${id} from ${JSON.stringify(rel)} with { type: "file" };`)
        return `__shard_file_url(${id})`
      })
      if (imports.length === 0) return undefined
      const loader = args.path.endsWith('.tsx') ? 'tsx' : /\.[mc]?ts$/.test(args.path) ? 'ts' : 'js'
      return {
        contents: `import { pathToFileURL as __shard_file_url } from "node:url";\n${imports.join('\n')}\n${code}`,
        loader,
      }
    })
  },
}

const result = await Bun.build({
  entrypoints: [entry],
  compile: { target, outfile },
  minify: true,
  plugins: [embedFiles],
  // ws's optional native speedups: it runs without them.
  external: ['bufferutil', 'utf-8-validate'],
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
