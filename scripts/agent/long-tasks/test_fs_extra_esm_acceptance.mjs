import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { safePackPackage } from '../../release/safe-package-pack.mjs'

const execute = promisify(execFile)
const workspace = process.cwd()
const contract = JSON.parse(
  await readFile(new URL('./fs-extra-esm-contract.json', import.meta.url))
)
const requireProject = createRequire(join(workspace, 'package.json'))
const sourcePath = (file) =>
  file === 'lib/esm.mjs' ? 'src/esm.js' : file.replace(/^lib\//u, 'src/')
const sourceFiles = contract.productionFiles.map(sourcePath)
const keys = (value) => Object.keys(value).sort()
const hash = (value) => createHash('sha256').update(value).digest('hex')
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
const run = (command, args, cwd = workspace) =>
  execute(command, args, { cwd, env, timeout: 90000, maxBuffer: 4_000_000 })

async function temporary(t, name) {
  const root = await mkdtemp(join(tmpdir(), `fs-extra-esm-${name}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function maintained(file) {
  const path = join(workspace, file)
  const stat = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') assert.fail('Maintained native ESM source must exist: ' + file)
    throw error
  })
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Maintained modules must be regular source files')
  return readFile(path, 'utf8')
}

function visit(node, fn) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') fn(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue
    if (Array.isArray(value)) for (const child of value) visit(child, fn)
    else if (value && typeof value === 'object') visit(value, fn)
  }
}

for (const file of sourceFiles) {
  test(`maintained ESM module: ${file}`, async () => {
    const text = await maintained(file)
    const { parse } = requireProject('acorn')
    const ast = parse(text, { ecmaVersion: 2022, sourceType: 'module' })
    assert(
      ast.body.some((node) => /^(Import|Export)/u.test(node.type)),
      'Native ESM declarations required'
    )
    const specifiers = []
    visit(ast, (node) => {
      if (
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
      ) {
        if (node.source) specifiers.push(node.source.value)
      }
      if (node.type === 'ImportExpression' && node.source.type === 'Literal')
        specifiers.push(node.source.value)
      if (
        (node.type === 'CallExpression' || node.type === 'NewExpression') &&
        node.callee.type === 'Identifier'
      ) {
        assert(
          !['require', 'eval', 'Function', 'createRequire'].includes(node.callee.name),
          'Runtime CommonJS/evaluation loaders are not maintained ESM'
        )
      }
      if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
        const property = node.computed ? node.property.value : node.property.name
        assert(
          !(node.object.name === 'module' && ['exports', 'require', '_compile'].includes(property)),
          'CommonJS module operations remain'
        )
      }
    })
    for (const specifier of specifiers) {
      assert.equal(typeof specifier, 'string')
      if (specifier.startsWith('.')) {
        assert(/\.(?:mjs|js)$/u.test(specifier), 'Internal ESM imports need explicit paths')
        const target = resolve(workspace, dirname(file), specifier)
        const path = relative(join(workspace, 'src'), target)
        assert(
          path && !path.startsWith('..') && !isAbsolute(path),
          'Source imports must stay inside src'
        )
        assert((await lstat(target)).isFile(), 'Source import must resolve to a file')
      } else {
        const name = specifier.replace(/^node:/u, '').split('/')[0]
        assert(
          !isAbsolute(specifier) &&
            (builtinModules.includes(name) || keys(contract.package.dependencies).includes(name)),
          'Source delegates outside runtime dependencies'
        )
      }
    }
    await import(pathToFileURL(join(workspace, file)))
  })
}

test('package identity, runtime dependencies, build command and explicit exports remain compatible', async () => {
  const pkg = JSON.parse(await readFile(join(workspace, 'package.json')))
  for (const [key, value] of Object.entries(contract.package))
    assert.deepEqual(pkg[key], value, key)
  assert(
    pkg.exports && pkg.exports['.'] && pkg.exports['./esm'],
    'Explicit package exports required'
  )
  assert.equal(typeof pkg.scripts.build, 'string', 'A build command is required')
  assert(
    pkg.scripts.build.includes('scripts/build.mjs'),
    'npm run build must use the maintained Node build entry'
  )
  assert((await lstat(join(workspace, 'scripts/build.mjs'))).isFile())
  let boundary = pkg
  try {
    boundary = JSON.parse(await readFile(join(workspace, 'src/package.json')))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  assert.equal(boundary.type, 'module', 'Native sources need an explicit ESM package boundary')
})

async function apiFor(kind) {
  if (kind === 'require-root') return requireProject('fs-extra')
  if (kind === 'import-root')
    return (await import(pathToFileURL(join(workspace, 'lib/index.js')))).default
  if (kind === 'published-esm')
    return (await import(pathToFileURL(join(workspace, 'lib/esm.mjs')))).default
  return (
    await import(
      pathToFileURL(join(workspace, kind === 'source-root' ? 'src/index.js' : 'src/esm.js'))
    )
  ).default
}

for (const kind of ['require-root', 'import-root', 'published-esm', 'source-root', 'source-esm']) {
  const extraOnly = kind.endsWith('esm')
  test(`${kind}: API inventory, aliases and graceful-fs integration`, async () => {
    const api = await apiFor(kind)
    assert.deepEqual(keys(api), extraOnly ? contract.extraKeys : contract.rootKeys)
    for (const [a, b] of contract.aliases) assert.equal(api[a], api[b], `${a}/${b}`)
    if (!extraOnly) {
      const fs = requireProject('graceful-fs')
      for (const key of contract.gracefulIdentity) assert.equal(api[key], fs[key], key)
    }
  })
  test(`${kind}: Promise filesystem workflow`, async (t) => {
    const api = await apiFor(kind),
      root = await temporary(t, 'promise')
    await api.outputJson(join(root, 'input/a.json'), { hello: ['world', 3] })
    await api.copy(join(root, 'input'), join(root, 'copy'))
    await api.move(join(root, 'copy/a.json'), join(root, 'deep/moved.json'))
    assert.deepEqual(await api.readJson(join(root, 'deep/moved.json')), { hello: ['world', 3] })
    await api.ensureFile(join(root, 'ensured/empty'))
    await api.ensureLink(join(root, 'input/a.json'), join(root, 'links/hard.json'))
    await api.ensureSymlink(join(root, 'input/a.json'), join(root, 'links/symbolic.json'))
    assert.deepEqual(await api.readJson(join(root, 'links/symbolic.json')), { hello: ['world', 3] })
    await api.emptyDir(join(root, 'input'))
    assert.deepEqual(await readdir(join(root, 'input')), [])
    await api.remove(join(root, 'deep'))
    assert.equal(await api.pathExists(join(root, 'deep')), false)
  })
  test(`${kind}: callback and synchronous filesystem workflow`, async (t) => {
    const api = await apiFor(kind),
      root = await temporary(t, 'callback')
    const callback = (name, ...args) =>
      new Promise((resolveResult, reject) =>
        api[name](...args, (error, value) => (error ? reject(error) : resolveResult(value)))
      )
    await callback('outputFile', join(root, 'input/data.txt'), 'test')
    await callback('copy', join(root, 'input'), join(root, 'copy'))
    await callback('move', join(root, 'copy'), join(root, 'moved'))
    assert.equal(await callback('pathExists', join(root, 'moved/data.txt')), true)
    api.outputJsonSync(join(root, 'sync/data.json'), { sync: true })
    api.copySync(join(root, 'sync'), join(root, 'sync-copy'))
    api.moveSync(join(root, 'sync-copy'), join(root, 'sync-move'))
    assert.deepEqual(api.readJsonSync(join(root, 'sync-move/data.json')), { sync: true })
    api.ensureFileSync(join(root, 'sync/file'))
    api.emptyDirSync(join(root, 'sync'))
    assert.deepEqual(await readdir(join(root, 'sync')), [])
    api.removeSync(join(root, 'sync'))
    assert.equal(api.pathExistsSync(join(root, 'sync')), false)
  })
  test(`${kind}: compatible missing-file and invalid-JSON errors`, async (t) => {
    const api = await apiFor(kind),
      root = await temporary(t, 'errors'),
      missing = join(root, 'missing.json')
    await assert.rejects(api.readJson(missing), { code: 'ENOENT', path: missing })
    await new Promise((resolveResult) =>
      api.readJson(missing, (error) => {
        assert.equal(error.code, 'ENOENT')
        assert.equal(error.path, missing)
        resolveResult()
      })
    )
    assert.throws(() => api.readJsonSync(missing), { code: 'ENOENT', path: missing })
    await writeFile(join(root, 'bad.json'), '{broken')
    await assert.rejects(api.readJson(join(root, 'bad.json')), SyntaxError)
    assert.equal(await api.readJson(join(root, 'bad.json'), { throws: false }), null)
  })
}

test('published ESM and CommonJS share method identities and named exports', async () => {
  const root = requireProject('fs-extra'),
    esm = await import(pathToFileURL(join(workspace, 'lib/esm.mjs')))
  assert.deepEqual(keys(esm), ['default', ...contract.extraKeys].sort())
  for (const key of contract.extraKeys) {
    assert.equal(esm[key], root[key], key)
    assert.equal(esm.default[key], root[key], key)
  }
})

test('native source entries share method identities and named exports', async () => {
  const root = await apiFor('source-root'),
    esm = await import(pathToFileURL(join(workspace, 'src/esm.js')))
  assert.deepEqual(keys(esm), ['default', ...contract.extraKeys].sort())
  for (const key of contract.extraKeys) {
    assert.equal(esm[key], root[key], key)
    assert.equal(esm.default[key], root[key], key)
  }
})

test('clean deterministic rebuild regenerates every module and propagates actual source edits', async (t) => {
  const root = await temporary(t, 'rebuild'),
    copy = join(root, 'project')
  await cp(workspace, copy, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) =>
      !relative(workspace, path)
        .split('/')
        .some((part) => ['.git', 'node_modules', '.nyc_output', 'coverage'].includes(part)),
  })
  await cp(join(workspace, 'node_modules'), join(copy, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
  })
  for (const file of contract.productionFiles) await rm(join(copy, file), { force: true })
  await run(process.execPath, ['scripts/build.mjs'], copy)
  const inventory = async () =>
    Object.fromEntries(
      await Promise.all(
        contract.productionFiles.map(async (file) => {
          const text = await readFile(join(copy, file), 'utf8')
          assert(
            /generated|do not edit/iu.test(text.slice(0, 1200)),
            'Generated file needs a clear marker: ' + file
          )
          return [file, hash(text)]
        })
      )
    )
  const first = await inventory()
  await run(process.execPath, ['scripts/build.mjs'], copy)
  assert.deepEqual(await inventory(), first, 'Repeat builds must be deterministic')
  const marker = '__fsExtraProbe' + randomUUID().replaceAll('-', '')
  for (const file of sourceFiles)
    await writeFile(
      join(copy, file),
      `\nglobalThis.${marker} ??= []; globalThis.${marker}.push(${JSON.stringify(file)});\n`,
      { flag: 'a' }
    )
  await run(process.execPath, ['scripts/build.mjs'], copy)
  const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); for(const file of ${JSON.stringify(contract.productionFiles.filter((file) => file.endsWith('.js')))})require('./'+file); await import('./lib/esm.mjs'); process.stdout.write(JSON.stringify([...new Set(globalThis.${marker}??[])].sort()))`
  const output = await run(process.execPath, ['--input-type=module', '-e', script], copy)
  assert.deepEqual(
    JSON.parse(output.stdout),
    [...sourceFiles].sort(),
    'Every generated module must reflect its maintained source'
  )
})

test('packed artifact is complete and works in an independent consumer without build dependencies', async (t) => {
  const root = await temporary(t, 'consumer'),
    archives = join(root, 'archives'),
    consumer = join(root, 'consumer')
  await mkdir(archives)
  await mkdir(join(consumer, 'node_modules'), { recursive: true })
  await safePackPackage({
    packageDirectory: workspace,
    filename: join(archives, 'fs-extra.tgz'),
    timeoutMs: 90000,
  })
  const archive = join(archives, 'fs-extra.tgz')
  const listing = (await run('tar', ['-tzf', archive])).stdout
    .trim()
    .split('\n')
    .map((file) => file.replace(/^package\//u, ''))
  for (const file of [...sourceFiles, ...contract.productionFiles, 'scripts/build.mjs'])
    assert(listing.includes(file), 'Missing packed file: ' + file)
  assert(
    !listing.some((file) => /(^|\/)(?:__tests__|fixtures|node_modules)(?:\/|$)/u.test(file)),
    'Tests, fixtures and dependencies must not be packed'
  )
  await run('tar', ['-xzf', archive, '-C', consumer])
  await rename(join(consumer, 'package'), join(consumer, 'node_modules/fs-extra'))
  const packed = join(consumer, 'node_modules/fs-extra')
  const { parse } = requireProject('acorn')
  for (const file of [...sourceFiles, ...contract.productionFiles]) {
    const path = join(packed, file)
    assert((await lstat(path)).isFile(), 'Published runtime modules must be regular files')
    const ast = parse(await readFile(path, 'utf8'), {
      ecmaVersion: 'latest',
      sourceType: file.startsWith('src/') || file.endsWith('.mjs') ? 'module' : 'script',
    })
    visit(ast, (node) => {
      const specifier =
        node.type === 'ImportDeclaration' ||
        node.type.startsWith('Export') ||
        node.type === 'ImportExpression'
          ? node.source?.value
          : node.type === 'CallExpression' &&
              node.callee.type === 'Identifier' &&
              node.callee.name === 'require'
            ? node.arguments[0]?.value
            : undefined
      if (typeof specifier !== 'string') return
      assert(
        !isAbsolute(specifier) && !specifier.startsWith('file:'),
        'Published module references an external checkout'
      )
      if (specifier.startsWith('.')) {
        const target = relative(packed, resolve(dirname(path), specifier))
        assert(
          !target.startsWith('..') && !isAbsolute(target),
          'Published relative import escapes package'
        )
      }
    })
  }
  for (const dependency of keys(contract.package.dependencies))
    await cp(
      join(workspace, 'node_modules', dependency),
      join(consumer, 'node_modules', dependency),
      { recursive: true, verbatimSymlinks: true }
    )
  await writeFile(join(consumer, 'package.json'), '{"type":"module","private":true}')
  const script = `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import fs from 'fs-extra'; import extras,* as named from 'fs-extra/esm'; const require=createRequire(import.meta.url); assert.equal(fs,require('fs-extra')); assert.deepEqual(Object.keys(fs).sort(),${JSON.stringify(contract.rootKeys)}); assert.deepEqual(Object.keys(extras).sort(),${JSON.stringify(contract.extraKeys)}); for(const key of ${JSON.stringify(contract.extraKeys)}){assert.equal(named[key],fs[key]);assert.equal(extras[key],fs[key])} await extras.outputJson('output/data.json',{packed:true});assert.deepEqual(await fs.readJson('output/data.json'),{packed:true});await fs.remove('output');assert.throws(()=>require('fs-extra/lib/index.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});assert.throws(()=>require('esbuild'),{code:'MODULE_NOT_FOUND'});console.log('isolated package ok')`
  await run(process.execPath, ['--input-type=module', '-e', script], consumer)
})
