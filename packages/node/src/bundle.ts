import { createHash } from 'node:crypto'
import { watch as fsWatch } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ShardError } from '@aethervtt/shard-core'
import { inlineSourceMap, type SourceMap } from '@aethervtt/shard-project'
import * as esbuild from 'esbuild'

export interface BuiltBundle {
  /** Content hash of the bundle. */
  hash: string
  /** Absolute path of the written file. */
  file: string
  /** `file://` URL, for `import()`. */
  url: string
  code: string
  map: SourceMap | undefined
  ms: number
  /** Inputs and their imports (esbuild's metafile): generators' code hashes come from it. */
  graph: { inputs: Record<string, { imports: { path: string; external?: boolean }[] }> }
}

export interface BundlerOptions {
  /** Project folder. */
  root: string
  /** Entry module, project-relative (the manifest's `entry`). */
  entry: string
  /** Where bundles are written. Default `.shard/build`. */
  outDir?: string
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

/** Fails the build on Node built-ins: project code has to run in a browser export too. */
const noNodeBuiltins: esbuild.Plugin = {
  name: 'shard-no-node-builtins',
  setup(build) {
    build.onResolve({ filter: /^[a-z:/_]+$/ }, (args) => {
      if (!BUILTINS.has(args.path)) return undefined
      return {
        errors: [
          {
            text: `"${args.path}" is a Node built-in; project code must run in browsers too`,
            detail: 'project/node-builtin',
          },
        ],
      }
    })
  },
}

/** Turns esbuild's first error into a ShardError with a `source` location. */
function bundleError(root: string, failure: esbuild.BuildFailure | Error): ShardError {
  const first = (failure as esbuild.BuildFailure).errors?.[0]
  if (!first) {
    return new ShardError('project/bundle-failed', failure.message, { cause: failure })
  }
  const code =
    first.detail === 'project/node-builtin' ? 'project/node-builtin' : 'project/bundle-failed'
  const loc = first.location
  const file = loc ? relative(root, resolve(root, loc.file)).split('\\').join('/') : undefined
  const source = loc ? `${file}:${loc.line}:${loc.column + 1}` : undefined
  const err = new ShardError(code, source ? `${source}: ${first.text}` : first.text, {
    path: file,
    hint:
      code === 'project/node-builtin'
        ? 'Use @aethervtt/shard-platform services (files, storage) instead of Node APIs.'
        : 'Fix the error and save; the last good code keeps running.',
    cause: failure,
  })
  return Object.assign(err, { source })
}

/**
 * Bundles a project's entry into one ESM file with `@aethervtt/shard-*` left external, so the engine's module
 * instances are shared. Keeps an incremental esbuild context for fast rebuilds.
 */
export async function createBundler(options: BundlerOptions) {
  const root = resolve(options.root)
  const outDir = resolve(root, options.outDir ?? '.shard/build')
  let last: BuiltBundle | undefined
  const context = await esbuild.context({
    absWorkingDir: root,
    entryPoints: [resolve(root, options.entry)],
    // Only names the output so source-map paths are relative to it; nothing is written by esbuild.
    outfile: join(outDir, 'main.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    sourcemap: 'inline',
    sourcesContent: false,
    external: ['@aethervtt/shard-*'],
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [noNodeBuiltins],
  })

  const build = async (): Promise<BuiltBundle> => {
    const start = performance.now()
    let result: esbuild.BuildResult
    try {
      result = await context.rebuild()
    } catch (err) {
      throw bundleError(root, err as esbuild.BuildFailure)
    }
    const code = result.outputFiles![0]!.text
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 16)
    const file = join(outDir, `main.${hash}.mjs`)
    if (last?.hash !== hash) {
      await mkdir(outDir, { recursive: true })
      await writeFile(file, code)
    }
    last = {
      hash,
      file,
      url: pathToFileURL(file).href,
      code,
      map: inlineSourceMap(code),
      ms: performance.now() - start,
      graph: result.metafile as BuiltBundle['graph'],
    }
    return last
  }

  let imports = 0
  return {
    root,
    get last(): BuiltBundle | undefined {
      return last
    },
    /**
     * A URL for importing a bundle that no module cache has seen. Identical code rebuilds to the same
     * file (content hash), and without this a revert would import a stale, earlier module instance.
     */
    importUrl(bundle: BuiltBundle): string {
      return `${bundle.url}?r=${++imports}`
    },
    build,
    /**
     * Rebuilds (debounced) when anything under the entry's folder changes. `onBuild` gets the bundle
     * or the error. Returns a stop function.
     */
    watch(onBuild: (result: BuiltBundle | ShardError) => void, debounceMs = 50): () => void {
      const dir = dirname(resolve(root, options.entry))
      let timer: ReturnType<typeof setTimeout> | undefined
      const watcher = fsWatch(dir, { recursive: true }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          build().then(onBuild, (err) => onBuild(err as ShardError))
        }, debounceMs)
      })
      return () => {
        if (timer) clearTimeout(timer)
        watcher.close()
      }
    },
    /** Removes bundles other than the latest from the output folder. */
    async prune(): Promise<void> {
      const files = await readdir(outDir).catch(() => [] as string[])
      await Promise.all(
        files
          .filter(
            (f) => f.startsWith('main.') && f.endsWith('.mjs') && join(outDir, f) !== last?.file,
          )
          .map((f) => rm(join(outDir, f), { force: true })),
      )
    },
    dispose: () => context.dispose(),
  }
}

export type Bundler = Awaited<ReturnType<typeof createBundler>>
