// Builds what another repository installs (spec 0056): every @aethervtt/shard-* package as JS with
// its types stripped file by file (no bundling), .d.ts files, and a package.json pointing at them,
// packed with `npm pack`. Inside the monorepo, packages keep exporting their TypeScript source.
//
//   pnpm release                 build and pack every package into dist-release/
//   pnpm release --check         then prove it: bench/consumer installs the tarballs outside the repo,
//                                and coin-rush runs with the published CLI
//   pnpm release --cli-check     only the published-CLI part of --check
//   pnpm release --version 0.0.2 (default: the root package.json version)

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
// Apps published with the engine (0093). The rest (Studio, the playground) stay private.
const apps = ['cli']

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

function inside(path) {
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

// tsc points preserved path references back at the original .d.ts in src. The release copies
// those files into dist with the same layout, so references must follow the shipped copy.
function rewriteDeclarationReferences(code, file, sourceRoot, outputRoot) {
  return code.replace(
    /(^\s*\/\/\/\s*<reference\s+path=)(['"])([^'"]+)\2/gm,
    (_, prefix, quote, path) => {
      let referenced = resolve(dirname(file), path)
      const sourceRelative = relative(sourceRoot, referenced)
      if (inside(sourceRelative)) referenced = join(outputRoot, sourceRelative)
      if (!inside(relative(outputRoot, referenced)) || !existsSync(referenced)) {
        throw new Error(`Unshipped declaration reference in ${relative(out, file)}: ${path}`)
      }
      const published = relative(dirname(file), referenced).split(sep).join('/')
      return `${prefix}${quote}${published.startsWith('.') ? '' : './'}${published}${quote}`
    },
  )
}

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
  if (typeof source !== 'string') {
    return Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, exportTarget(value)]),
    )
  }
  // "./src/foo.ts" -> { types: "./dist/foo.d.ts", default: "./dist/foo.js" }
  const rel = source.replace(/^\.\/src\//, './dist/')
  if (rel.endsWith('.ts')) {
    return { types: `${rel.slice(0, -3)}.d.ts`, default: `${rel.slice(0, -3)}.js` }
  }
  return rel
}

function buildPackage(name, { app = false } = {}) {
  const dir = app ? join(repo, 'apps', name) : join(packagesDir, name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const target = join(out, app ? 'apps' : 'packages', name)
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

  // Types: tsc over the package's source, declarations only. Apps are commands, not libraries.
  if (!app) emitDeclarations(dir, name, target)

  // Files loaded at runtime by URL, next to dist as they are next to src. An app also ships its
  // entry point (bin/) and the pages it serves (the CLI's runner/, compiled by Vite at run time).
  const extra = []
  for (const sub of app ? ['bin', 'runner'] : ['wasm', 'vendor']) {
    if (existsSync(join(dir, sub))) {
      cpSync(join(dir, sub), join(target, sub), {
        recursive: true,
        filter: (src) => !src.endsWith('tsconfig.json'),
      })
      extra.push(sub)
    }
  }
  return pack(name, manifest, target, extra, { app })
}

function emitDeclarations(dir, name, target) {
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
    const code = rewriteSpecifiers(readFileSync(file, 'utf8'), source)
    writeFileSync(
      file,
      rewriteDeclarationReferences(code, file, join(dir, 'src'), join(target, 'dist')),
    )
  }
}

function pack(name, manifest, target, extra, { app }) {
  const dir = app ? join(repo, 'apps', name) : join(packagesDir, name)
  cpSync(join(repo, 'LICENSE'), join(target, 'LICENSE'))
  writeFileSync(
    join(target, 'README.md'),
    `# ${manifest.name}\n\nPart of [Shard](https://github.com/aethervtt/shard), a WebGPU-first 2D/3D game engine in TypeScript. See the repository for documentation.\n`,
  )

  if (existsSync(join(dir, 'README.md'))) cpSync(join(dir, 'README.md'), join(target, 'README.md'))

  const pin = (deps) =>
    deps &&
    Object.fromEntries(
      Object.entries(deps).map(([dep, range]) => [
        dep,
        String(range).startsWith('workspace:') ? version : range,
      ]),
    )
  const exportsField = Object.fromEntries(
    Object.entries(manifest.exports ?? { '.': './src/index.ts' }).map(([key, source]) => {
      const exported = exportTarget(source)
      // Apps ship no declarations.
      return [key, app && typeof exported === 'object' ? { default: exported.default } : exported]
    }),
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
    ...(manifest.bin ? { bin: manifest.bin } : {}),
    files: ['dist', ...extra, 'LICENSE', 'README.md'],
    dependencies: pin(manifest.dependencies),
    repository: {
      type: 'git',
      url: 'git+https://github.com/aethervtt/shard.git',
      directory: `${app ? 'apps' : 'packages'}/${name}`,
    },
    publishConfig: { access: 'public', provenance: true },
    shard: { buildSha: sha },
  }
  // The Node WebGPU backend is optional: only `@aethervtt/shard-gpu/node` needs it.
  if (name === 'gpu' && !app) {
    released.peerDependencies = { webgpu: manifest.devDependencies.webgpu }
    released.peerDependenciesMeta = { webgpu: { optional: true } }
  }
  // Only browser-driven commands (capture, audio preview) need Playwright: an optional peer.
  if (app && released.dependencies?.playwright) {
    released.peerDependencies = { playwright: released.dependencies.playwright }
    released.peerDependenciesMeta = { playwright: { optional: true } }
    delete released.dependencies.playwright
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
  return {
    name: manifest.name,
    target,
    tarball: join(out, 'tarballs', tarball.split('\n').pop()),
  }
}

// --- checks --------------------------------------------------------------------------------------

function checkOutput(built) {
  const problems = []
  for (const { name, target } of built) {
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      const targets = (entry) =>
        typeof entry === 'string' ? [entry] : Object.values(entry).flatMap(targets)
      for (const file of targets(value)) {
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
  mkdirSync(join(work, 'public'), { recursive: true })
  cpSync(join(repo, 'packages/text/fixtures/Inter-Regular.ttf'), join(work, 'public/font.ttf'))
  cpSync(join(repo, 'packages/texture/fixtures/pattern.webp'), join(work, 'public/pattern.webp'))
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
  run('node', ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'])
  run('node', [
    'node_modules/vite6/bin/vite.js',
    'build',
    '--config',
    'vite6.config.mjs',
    '--logLevel',
    'warn',
  ])
  run('bun', ['build', './main.ts', '--outdir', 'dist-bun', '--target', 'browser'])
  run('node', ['headless.mjs'])
  run('node', ['import-orders.mjs'])
  run('node', ['codecs.mjs'])
  run('bun', ['codecs.mjs'])
  run('npx', ['webpack', '--config', 'webpack.config.mjs'])
  run('npx', ['next', 'build', '--webpack'])
  run('node', ['browser.mjs'])
}

/**
 * The published CLI (0093), installed from the tarballs outside the repository: a multiplayer
 * project (coin-rush) validates, runs single player and with clients, writes docs with the engine's
 * error codes, passes its tests, and serves a dev page whose import map points at installed dist
 * files. `shard init` writes a project pinned to this version.
 */
async function cliCheck(built) {
  // Outside the repository: inside it, `shard init` (rightly) writes workspace:* dependencies.
  const work = mkdtempSync(join(tmpdir(), 'shard-cli-'))
  const game = join(work, 'game')
  cpSync(join(repo, 'examples/coin-rush'), game, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.shard)([\\/]|$)/.test(src),
  })
  const manifest = JSON.parse(readFileSync(join(game, 'package.json'), 'utf8'))
  manifest.dependencies = Object.fromEntries(
    built.map(({ name, tarball }) => [name, `file:${tarball}`]),
  )
  manifest.devDependencies = {
    '@types/node': '^26.6.2',
    '@webgpu/types': '^0.1.74',
    typescript: '^7.0.2',
    vitest: '^5.0.1',
  }
  writeFileSync(join(game, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const env = { ...process.env, npm_config_loglevel: 'error' }
  const shard = (cmdArgs, cwd = game) => {
    console.log(`  $ shard ${cmdArgs.join(' ')}`)
    return execFileSync(join(game, 'node_modules/.bin/shard'), cmdArgs, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  }
  console.log('  $ npm install (coin-rush, from the tarballs)')
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: game,
    env,
    stdio: 'inherit',
  })
  shard(['validate'])
  shard(['run', '--frames', '60'])
  const net = JSON.parse(shard(['run', '--net', 'clients=2,latency=0.05,loss=0.05', '--json']))
  if (!net.converged) throw new Error(`run --net didn't converge: ${net.differences.join('; ')}`)
  shard(['docs'])
  const errors = readFileSync(join(game, '.agents/errors.md'), 'utf8')
  if (!errors.includes('net/schema-mismatch') || !errors.includes('ecs/dead-entity')) {
    throw new Error('shard docs wrote an error catalog without the engine codes')
  }
  shard(['test'])
  shard(['init', 'fresh', '--template', 'empty'], work)
  const fresh = JSON.parse(readFileSync(join(work, 'fresh/package.json'), 'utf8'))
  if (fresh.dependencies['@aethervtt/shard-core'] !== `^${version}`) {
    throw new Error(`shard init pinned ${fresh.dependencies['@aethervtt/shard-core']}`)
  }

  // shard dev: the page's import map points into node_modules, at dist entries.
  const { spawn } = await import('node:child_process')
  console.log('  $ shard dev --port 5293')
  const child = spawn(join(game, 'node_modules/.bin/shard'), ['dev', '--port', '5293', '--json'], {
    cwd: game,
    env,
  })
  try {
    const info = await new Promise((resolveInfo, reject) => {
      let text = ''
      child.stdout.on('data', (d) => {
        text += d
        try {
          resolveInfo(JSON.parse(text))
        } catch {}
      })
      child.on('exit', (code) => reject(new Error(`shard dev exited ${code}`)))
    })
    const html = await (await fetch(info.url)).text()
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)[1])
    const core = map.imports['@aethervtt/shard-core'] ?? ''
    if (!core.includes('node_modules') || !core.endsWith('/dist/index.js')) {
      throw new Error(`shard dev maps @aethervtt/shard-core to ${core}`)
    }
    const page = await fetch(new URL('/main.ts', info.url))
    if (!page.ok) throw new Error(`shard dev couldn't serve its runner: ${page.status}`)
  } finally {
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGINT')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  }
  // Vite may still be writing its cache: retry.
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

// --- main --------------------------------------------------------------------------------------

rmSync(join(out, 'tarballs'), { recursive: true, force: true })
mkdirSync(join(out, 'tarballs'), { recursive: true })
const built = []
for (const name of names) {
  process.stdout.write(`${name} `)
  built.push(buildPackage(name))
}
for (const name of apps) {
  process.stdout.write(`apps/${name} `)
  built.push(buildPackage(name, { app: true }))
}
console.log(
  `\nPacked ${built.length} packages at ${version} (${sha.slice(0, 7)}) into ${relative(repo, out)}/tarballs`,
)
const problems = checkOutput(built)
if (problems.length > 0) {
  console.error(`\nProblems:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
if (flag('--cli-check') && !flag('--check')) {
  console.log('\nCLI check (coin-rush with the published CLI, installed from the tarballs):')
  await cliCheck(built)
  console.log('\nThe published CLI installs and runs outside the repository.')
}
if (flag('--check')) {
  console.log('\nConsumer check (bench/consumer, installed from the tarballs):')
  consumerCheck(built)
  console.log('\nCLI check (coin-rush with the published CLI, installed from the tarballs):')
  await cliCheck(built)
  console.log(
    '\nPacked packages pass types, Node/Bun codecs, Vite/webpack/Next builds, and Chromium presentation/worker checks.',
  )
}
