import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ShardError } from '@shard/core'
import type { Workers } from '@shard/platform'
import { configureProcgenHost, setGeneratorCodeHashes } from '@shard/procgen'
import * as esbuild from 'esbuild'

/** What an esbuild metafile says about inputs: each file and what it imports. */
export interface ModuleGraph {
  inputs: Record<string, { imports: readonly { path: string; external?: boolean }[] }>
}

const PROJECT_GENERATOR = /\.generator\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g
const ENGINE_GENERATOR = /\bdefineGenerator\(\s*['"]([a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9]*)['"]/g

/**
 * Each generator's code hash: the hash of the module that defines it and every project module it
 * imports (transitively), from the bundler's module graph. The entry and the module that calls
 * `defineProject` are left out (with what only they import), so editing game systems there never
 * regenerates outputs. Keys are generator names (`<namespace>/<Name>`).
 */
export async function generatorCodeHashes(
  root: string,
  namespace: string,
  entry: string,
  graph: ModuleGraph,
): Promise<Record<string, string>> {
  const scriptsDir = relative(root, dirname(resolve(root, entry)))
    .split('\\')
    .join('/')
  const own = (p: string) =>
    !p.includes('node_modules/') &&
    !p.startsWith('..') &&
    (scriptsDir === '' || p.startsWith(`${scriptsDir}/`))
  const files = Object.keys(graph.inputs).filter(own)
  const text = new Map<string, string>()
  await Promise.all(files.map(async (f) => text.set(f, await readFile(resolve(root, f), 'utf8'))))
  const entryPath = relative(root, resolve(root, entry)).split('\\').join('/')
  const excluded = new Set(
    files.filter((f) => f === entryPath || /\bdefineProject\s*\(/.test(text.get(f)!)),
  )
  const out: Record<string, string> = {}
  for (const file of files) {
    const source = text.get(file)!
    const names: string[] = []
    for (const m of source.matchAll(PROJECT_GENERATOR)) names.push(`${namespace}/${m[1]}`)
    for (const m of source.matchAll(ENGINE_GENERATOR)) names.push(m[1]!)
    if (names.length === 0) continue
    // The defining module and what it reaches, skipping the entry and project modules (unless it is one).
    const seen = new Set<string>([file])
    const stack = [file]
    while (stack.length > 0) {
      const at = stack.pop()!
      for (const imp of graph.inputs[at]?.imports ?? []) {
        if (imp.external || !own(imp.path) || seen.has(imp.path) || excluded.has(imp.path)) continue
        seen.add(imp.path)
        stack.push(imp.path)
      }
    }
    const hash = createHash('sha256')
    for (const f of [...seen].sort()) hash.update(`${f}\n${text.get(f)}\n`)
    const digest = hash.digest('hex').slice(0, 16)
    for (const name of names) out[name] = digest
  }
  return out
}

/** The module graph of a project's code (engine packages external), without writing anything. */
export async function projectModuleGraph(root: string, entry: string): Promise<ModuleGraph> {
  const result = await esbuild.build({
    absWorkingDir: resolve(root),
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@shard/*', 'node:*'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  })
  return result.metafile as ModuleGraph
}

export interface GeneratorWorkerBundle {
  /** `file://` URL of the module, for `configureProcgenHost({ workerModule })`. */
  url: string
  file: string
  hash: string
  ms: number
}

/**
 * Bundles the project's code with `@shard/procgen/worker` into one self-contained module (the
 * engine inlined, so a worker thread loads it with no resolver or loader): what generator jobs run
 * on the worker pool. Written to `.shard/build/procgen-worker.<hash>.mjs`.
 */
export async function buildGeneratorWorker(options: {
  root: string
  entry: string
  outDir?: string
}): Promise<GeneratorWorkerBundle> {
  const start = performance.now()
  const root = resolve(options.root)
  const require = createRequire(import.meta.url)
  const worker = require.resolve('@shard/procgen/worker')
  const entry = resolve(root, options.entry)
  let result: esbuild.BuildResult
  try {
    result = await esbuild.build({
      absWorkingDir: root,
      stdin: {
        contents: `import ${JSON.stringify(entry)}\nexport { runGeneratorJob, warmUp } from ${JSON.stringify(worker)}\n`,
        resolveDir: root,
        sourcefile: 'procgen-worker.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2023',
      // Host-only fallbacks (reading .wasm files from disk) stay dynamic imports that never run here.
      external: ['node:*'],
      write: false,
      logLevel: 'silent',
    })
  } catch (err) {
    const first = (err as esbuild.BuildFailure).errors?.[0]
    throw new ShardError(
      'procgen/worker-bundle-failed',
      `Couldn't bundle the generator worker: ${first?.text ?? (err as Error).message}`,
      { hint: 'The project code has to bundle for browsers (no Node built-ins).', cause: err },
    )
  }
  const code = result.outputFiles![0]!.contents
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16)
  const outDir = resolve(root, options.outDir ?? '.shard/build')
  const file = join(outDir, `procgen-worker.${hash}.mjs`)
  const exists = await access(file).then(
    () => true,
    () => false,
  )
  if (!exists) {
    await mkdir(outDir, { recursive: true })
    await writeFile(file, code)
  }
  return { url: pathToFileURL(file).href, file, hash, ms: performance.now() - start }
}

/**
 * Sets up generators for a Node host: code hashes from the module graph (the project bundle's, or
 * a quick one), and jobs on the platform's worker pool running a bundle of the project's code.
 * Call before the project's generators are used, and again after every rebuild.
 */
let lastWorker: { key: string; building: Promise<GeneratorWorkerBundle> } | undefined

export async function prepareGenerators(options: {
  root: string
  namespace: string
  entry: string
  workers?: Workers
  graph?: ModuleGraph
  /** Build the worker bundle (default true); false runs jobs inline. */
  worker?: boolean
  /**
   * Resolve once the code hashes are set, building the worker bundle behind (hot reloads): jobs
   * wait for the new bundle, and `worker` in the result is a promise.
   */
  background?: boolean
}): Promise<{
  codeHashes: Record<string, string>
  worker: GeneratorWorkerBundle | Promise<GeneratorWorkerBundle> | undefined
}> {
  const graph = options.graph ?? (await projectModuleGraph(options.root, options.entry))
  const codeHashes = await generatorCodeHashes(
    options.root,
    options.namespace,
    options.entry,
    graph,
  )
  setGeneratorCodeHashes(codeHashes)
  let worker: GeneratorWorkerBundle | Promise<GeneratorWorkerBundle> | undefined
  if (options.worker !== false && options.workers && options.workers.size > 0) {
    // Same generator code as the last bundle: it still runs these jobs (fragments are checked
    // against the current schemas on the main thread). One build at a time otherwise.
    const key = `${resolve(options.root)}\n${JSON.stringify(codeHashes)}`
    if (lastWorker?.key !== key) {
      const previous = lastWorker?.building
      lastWorker = {
        key,
        building: (previous ?? Promise.resolve())
          .catch(() => {})
          .then(() => buildGeneratorWorker({ root: options.root, entry: options.entry })),
      }
    }
    const building = lastWorker.building
    // A failed build is tried again next time.
    const mine = lastWorker
    building.catch(() => {
      if (lastWorker === mine) lastWorker = undefined
    })
    if (options.background) {
      worker = building
      const url = building.then((b) => b.url)
      url.catch(() => {})
      configureProcgenHost({ workers: options.workers, workerModule: url })
    } else {
      worker = await building
      configureProcgenHost({ workers: options.workers, workerModule: worker.url })
    }
  } else {
    configureProcgenHost({ workers: undefined, workerModule: undefined })
  }
  return { codeHashes, worker }
}
