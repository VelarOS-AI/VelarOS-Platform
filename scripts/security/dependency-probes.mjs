// 用途：按实际解析的生产依赖闭包验证安全修复，供源码与独立安装包共用。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const bracesFiles = {
  'lib/constants.js': '324a67b20e7981a627248cfc9bbe842c18e429487784fcb57cb913ea1e8e2aac',
  'lib/parse.js': 'fe0e70cb3f8360542ded4fdfa8308e6c06261cf5e19a1efab89d07e90e5357d4',
  'lib/compile.js': 'e8a37910ff800e0b33a0bbd9851555af9c46bc287dcb4f81e9cd5c3a0539bcb2',
  'lib/expand.js': '7d26b542cbdaba1769efa220fb15be83cdeb12e04d450a3f8e5c57e449e6ff25',
  'lib/stringify.js': 'f38d08f36d4cb1bd40069f6fd9fbb4b88143df943e633e5ee3b8540afc4beb73',
}

// GHSA-g3hv-75wg-m249：10.x 回移上游 77a0f5c；旧版没有受影响的预处理优化。
const minimatchFiles = {
  'dist/esm/index.js': '6883402b74e5a804293e1626b883d617bfceb4f9219f531bc85112d3d19e8365',
  'dist/commonjs/index.js': '92049786b577b2f62818f1c2ed2dbcbb7d190862b726cbd36e0e386ff4f9d9be',
}
const legacyMinimatchFiles = {
  '3.1.5': '746849f267c4868a53729225bd85c7dccd387712136fb305fcc0a3eadd4a3d9d',
  '5.1.9': '1339bca8b70e33847860daa8fc3ccfa62487e143670da01a3b718d40d5fd424f',
}

/** 核对所有实际可达副本，不能仅凭忽略公告放过新引入的版本或丢失补丁。 */
export function assertMinimatchProtection(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'minimatch')
  const files =
    manifest.version === '10.2.6'
      ? minimatchFiles
      : { 'minimatch.js': legacyMinimatchFiles[manifest.version] }
  for (const [path, expected] of Object.entries(files)) {
    assert(expected, `minimatch ${manifest.version} 尚未核验放大保护`)
    const source = readFileSync(join(root, path))
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      expected,
      `minimatch 保护内容变化：${root}/${path}`
    )
    if (manifest.version !== '10.2.6') assert(!source.includes('firstPhasePreProcess'))
  }
  const loaded = createRequire(join(root, 'package.json'))('./')
  const match = typeof loaded === 'function' ? loaded : loaded.minimatch
  assert(match('src/a.ts', 'src/**/*.ts'))
  assert(!match('src/a.js', 'src/**/*.ts'))
  if (manifest.version === '10.2.6') {
    const mm = new loaded.Minimatch('a/**/../b/'.repeat(14) + 'file.ts', {
      optimizationLevel: 2,
      braceExpandMax: 64,
    })
    assert(mm.globParts.length <= 64)
    const many = Array.from({ length: 1001 }, (_, i) => [String(i), '**', 'x'])
    assert.equal(mm.secondPhasePreProcess(many), many)
  }
}

/** 从消费者的真实解析路径查找，避免读取根目录碰巧存在的另一份依赖。 */
function dependencyManifest(name, parent) {
  const localRequire = createRequire(parent)
  for (const path of localRequire.resolve.paths(`${name}/package.json`) ?? []) {
    const manifest = join(path, name, 'package.json')
    if (existsSync(manifest)) return realpathSync(manifest)
  }
}

/** 只走实际可达包；根包包含开发依赖，传递依赖遵循生产和已安装的 peer/optional 图。 */
export function installedDependencyGraph(manifests) {
  const roots = new Set(manifests.map((path) => realpathSync(path)))
  const visited = new Map()
  const visit = (path) => {
    if (visited.has(path)) return
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    visited.set(path, { root: dirname(path), manifest })
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      ...(roots.has(path) ? manifest.devDependencies : {}),
    }
    for (const name of Object.keys(dependencies)) {
      const resolved = dependencyManifest(name, path)
      if (resolved) visit(resolved)
    }
  }
  for (const root of roots) visit(root)
  return [...visited.values()]
}

/** 内容身份核对使版本号告警只对审过的补丁成立；任何未打补丁的可达副本都失败。 */
export function assertBracesPatch(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'braces')
  assert.equal(manifest.version, '3.0.3', 'braces 版本变化，需要重新审查深度防护')
  for (const [path, expected] of Object.entries(bracesFiles)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex')
    assert.equal(actual, expected, `braces 安全补丁缺失或内容变化：${join(root, path)}`)
  }
}

/** 复核正常语义与字符串/手写 AST 的攻击入口，避免只保护高层 globby 调用。 */
export function assertBracesBehavior(braces) {
  assert.deepEqual(braces.expand('src/{a,b}/{01..03}.js'), [
    'src/a/01.js',
    'src/a/02.js',
    'src/a/03.js',
    'src/b/01.js',
    'src/b/02.js',
    'src/b/03.js',
  ])
  assert.deepEqual(
    braces.expand('{'.repeat(128) + 'a,b' + '}'.repeat(128)),
    ['a', 'b'].map((value) => '{'.repeat(127) + value + '}'.repeat(127))
  )
  assert.doesNotThrow(() => braces.parse('\\{'.repeat(1000)))
  const expected = { name: 'SyntaxError', message: /maximum depth/u }
  for (const depth of [129, 4000]) {
    for (const [open, close] of [
      ['{', '}'],
      ['(', ')'],
    ]) {
      const pattern = open.repeat(depth) + 'x' + close.repeat(depth)
      for (const operation of ['parse', 'compile', 'expand', 'stringify'])
        assert.throws(() => braces[operation](pattern), expected, `${operation}: ${open} ${depth}`)
    }
  }
  for (const operation of ['compile', 'expand', 'stringify']) {
    let child = { type: 'text', value: 'x' }
    for (let depth = 0; depth < 256; depth++) {
      const parent = { type: 'brace', nodes: [child] }
      child.parent = parent
      child = parent
    }
    const root = { type: 'root', nodes: [child] }
    child.parent = root
    assert.throws(() => braces[operation](root), expected, `${operation}: supplied AST`)
  }
}

/** 安装包与源码使用同一核验，补丁和兼容升级必须真正到达所有消费者。 */
export function assertInstalledDependencyRepairs(manifests) {
  const packages = installedDependencyGraph(manifests)
  const braces = packages.filter(({ manifest }) => manifest.name === 'braces')
  assert(braces.length > 0, '需要核验默认 globby 的真实 braces 依赖')
  assert(
    !packages.some(({ manifest }) => manifest.name === 'sprintf-js'),
    'sprintf-js 仍在依赖闭包中'
  )
  for (const { root } of braces) {
    assertBracesPatch(root)
    assertBracesBehavior(createRequire(join(root, 'package.json'))('./'))
  }
  for (const { root } of packages.filter(({ manifest }) => manifest.name === 'minimatch'))
    assertMinimatchProtection(root)
  return braces.length
}
