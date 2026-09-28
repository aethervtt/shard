// Builds what another repository installs (spec 0056): every @aethervtt/shard-* package as JS with
// its types stripped file by file (no bundling), .d.ts files, and a package.json pointing at them,
// packed with `npm pack`. Inside the monorepo, packages keep exporting their TypeScript source.
//
//   pnpm release                 build and pack every package into dist-release/
//   pnpm release --check         then prove it: bench/consumer installs the tarballs outside the repo
//   pnpm release --version 0.0.2 (default: the root package.json version)

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'packages/node/package.json'))
const esbuild = require('esbuild')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const rootManifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const version = option('--version') ?? rootManifest.version
if (!version)
  throw new Error('No version: set "version" in the root package.json or pass --version')
const out = resolve(repo, option('--out') ?? 'dist-release')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

const packagesDir = join(repo, 'packages')
const names = readdirSync(packagesDir).filter((n) =>
  existsSync(join(packagesDir, n, 'package.json')),
)

// --- specifiers --------------------------------------------------------------------------------

/**
 * Relative specifiers get the extension Node's ESM loader needs: `./forward` becomes
 * `./forward.js` (or `./dir/index.js`), and `./x.ts` becomes `./x.js`. Bundlers resolve either.
 */
function rewriteSpecifiers(code, sourceFile) {
  const fromDir = dirname(sourceFile)
  const fix = (spec) => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return spec
    if (spec.endsWith('.ts') && !spec.endsWith('.d.ts')) return `${spec.slice(0, -3)}.js`
    if (/\.[a-z0-9]+$/i.test(spec) && !spec.endsWith('.ts')) return spec
    const base = resolve(fromDir, spec)
    if (existsSync(`${base}.ts`) || existsSync(`${base}.js`)) return `${spec}.js`
    if (existsSync(join(base, 'index.ts'))) return `${spec}/index.js`
    return spec
  }
  return code
    .replace(
      /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g,
      (_, pre, q, spec) => `${pre}${q}${fix(spec)}${q}`,
    )
    .replace(
      /(new URL\(\s*)(['"`])([^'"`]+)\2(\s*,\s*import\.meta\.url)/g,
      (_, pre, q, spec, post) => `${pre}${q}${fix(spec)}${q}${post}`,
    )
}

// --- one package -------------------------------------------------------------------------------

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

const isTest = (path) => /\.(test|bench)\.[tj]s$/.test(path) || path.includes('__golden__')

function exportTarget(source) {
  // "./src/foo.ts" -> { types: "./dist/foo.d.ts", default: "./dist/foo.js" }
  const rel = source.replace(/^\.\/src\//, './dist/')
  if (rel.endsWith('.ts')) {
    return { types: `${rel.slice(0, -3)}.d.ts`, default: `${rel.slice(0, -3)}.js` }
  }
  return rel
}

function buildPackage(name) {
  const dir = join(packagesDir, name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const target = join(out, 'packages', name)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(join(target, 'dist'), { recursive: true })

  // JS: types stripped per file; plain JS and declaration files copied.
  for (const file of walk(join(dir, 'src'))) {
    if (isTest(file)) continue
    const rel = relative(join(dir, 'src'), file)
    const dest = join(target, 'dist', rel)
    mkdirSync(dirname(dest), { recursive: true })
    if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'es2023',
        sourcefile: file,
      })
      writeFileSync(`${dest.slice(0, -3)}.js`, rewriteSpecifiers(code, file))
    } else if (file.endsWith('.js')) {
      writeFileSync(dest, rewriteSpecifiers(readFileSync(file, 'utf8'), file))
    } else {
      cpSync(file, dest)
    }
  }

  // Types: tsc over the package's source, declarations only.
  const tsconfig = join(dir, 'tsconfig.release.json')
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: './tsconfig.json',
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.bench.test.ts'],
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: 'src',
        outDir: join(target, 'dist'),
      },
    }),
  )
  try {
    execFileSync(join(repo, 'node_modules/.bin/tsc'), ['-p', tsconfig], { cwd: dir, stdio: 'pipe' })
  } catch (err) {
    throw new Error(`Declarations failed for ${name}:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
  } finally {
    rmSync(tsconfig, { force: true })
  }
  for (const file of walk(join(target, 'dist'))) {
    if (!file.endsWith('.d.ts')) continue
    const source = join(dir, 'src', relative(join(target, 'dist'), file)).replace(/\.d\.ts$/, '.ts')
    writeFileSync(file, rewriteSpecifiers(readFileSync(file, 'utf8'), source))
  }

  // Files loaded at runtime by URL, next to dist as they are next to src.
  const extra = []
  for (const sub of ['wasm', 'vendor']) {
    if (existsSync(join(dir, sub))) {
      cpSync(join(dir, sub), join(target, sub), { recursive: true })
      extra.push(sub)
    }
  }
  cpSync(join(repo, 'LICENSE'), join(target, 'LICENSE'))
  writeFileSync(
    join(target, 'README.md'),
    `# ${manifest.name}\n\nPart of [Shard](https://github.com/aethervtt/shard), a WebGPU-first 2D/3D game engine in TypeScript. See the repository for documentation.\n`,
  )

  const pin = (deps) =>
    deps &&
    Object.fromEntries(
      Object.entries(deps).map(([dep, range]) => [
        dep,
        String(range).startsWith('workspace:') ? version : range,
      ]),
    )
  const exportsField = Object.fromEntries(
    Object.entries(manifest.exports ?? { '.': './src/index.ts' }).map(([key, source]) => [
      key,
      exportTarget(source),
    ]),
  )
  const sideEffects = Array.isArray(manifest.sideEffects)
    ? manifest.sideEffects.map((p) => p.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js'))
    : manifest.sideEffects
  const released = {
    name: manifest.name,
    version,
    description: manifest.description,
    license: 'MIT',
    type: 'module',
    sideEffects,
    exports: exportsField,
    files: ['dist', ...extra, 'LICENSE', 'README.md'],
    dependencies: pin(manifest.dependencies),
    repository: {
      type: 'git',
      url: 'git+https://github.com/aethervtt/shard.git',
      directory: `packages/${name}`,
    },
    publishConfig: { access: 'public', provenance: true },
    shard: { buildSha: sha },
  }
  // The Node WebGPU backend is optional: only `@aethervtt/shard-gpu/node` needs it.
  if (name === 'gpu') {
    released.peerDependencies = { webgpu: manifest.devDependencies.webgpu }
    released.peerDependenciesMeta = { webgpu: { optional: true } }
  }
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(released, null, 2)}\n`)
  const tarball = execFileSync(
    'npm',
    ['pack', '--silent', '--pack-destination', join(out, 'tarballs')],
    {
      cwd: target,
      encoding: 'utf8',
    },
  ).trim()
  return { name: manifest.name, tarball: join(out, 'tarballs', tarball.split('\n').pop()) }
}

// --- checks --------------------------------------------------------------------------------------

function checkOutput(built) {
  const problems = []
  for (const { name } of built) {
    const target = join(out, 'packages', name.replace('@aethervtt/shard-', ''))
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      for (const file of typeof value === 'string' ? [value] : Object.values(value)) {
        if (!existsSync(join(target, file)))
          problems.push(`${name} exports ${key} -> missing ${file}`)
      }
    }
    for (const dep of Object.values({ ...manifest.dependencies })) {
      if (String(dep).startsWith('workspace:')) problems.push(`${name} depends on ${dep}`)
    }
    for (const file of walk(join(target, 'dist'))) {
      if (!/\.(js|d\.ts)$/.test(file)) continue
      const code = readFileSync(file, 'utf8')
      if (/from\s*['"]\.{1,2}\/[^'"]*\.ts['"]/.test(code) || /from\s*['"]workspace:/.test(code)) {
        problems.push(`${relative(out, file)} imports a .ts path or workspace: specifier`)
      }
    }
  }
  return problems
}

function consumerCheck(built) {
  const work = join(out, 'consumer')
  rmSync(work, { recursive: true, force: true })
  cpSync(join(repo, 'bench/consumer'), work, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'))
  manifest.dependencies = {
    ...manifest.dependencies,
    ...Object.fromEntries(built.map(({ name, tarball }) => [name, `file:${tarball}`])),
  }
  writeFileSync(join(work, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const run = (cmd, cmdArgs) => {
    console.log(`  $ ${cmd} ${cmdArgs.join(' ')}`)
    // loglevel=error: a user's global npm config can make npx warn about keys it doesn't know.
    execFileSync(cmd, cmdArgs, {
      cwd: work,
      stdio: 'inherit',
      env: { ...process.env, npm_config_loglevel: 'error' },
    })
  }
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'])
  run('npx', ['tsc', '--noEmit', '-p', '.'])
  run('npx', ['vite', 'build', '--logLevel', 'warn'])
  run('bun', ['build', './main.ts', '--outdir', 'dist-bun', '--target', 'browser'])
  run('node', ['headless.mjs'])
}

// --- main --------------------------------------------------------------------------------------

rmSync(join(out, 'tarballs'), { recursive: true, force: true })
mkdirSync(join(out, 'tarballs'), { recursive: true })
const built = []
for (const name of names) {
  process.stdout.write(`${name} `)
  built.push(buildPackage(name))
}
console.log(
  `\nPacked ${built.length} packages at ${version} (${sha.slice(0, 7)}) into ${relative(repo, out)}/tarballs`,
)
const problems = checkOutput(built)
if (problems.length > 0) {
  console.error(`\nProblems:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
if (flag('--check')) {
  console.log('\nConsumer check (bench/consumer, installed from the tarballs):')
  consumerCheck(built)
  console.log('\nThe release installs, builds with Vite and Bun, typechecks, and runs.')
}
