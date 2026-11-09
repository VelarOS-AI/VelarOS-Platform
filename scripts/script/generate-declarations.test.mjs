import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('module selection preserves shared artifacts and rereads transitive source dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'declaration-modules-'))
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const run = (args, status = 0) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/script/generate-declarations.mjs', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
      }
    )
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stdout + result.stderr)
    return result.stdout + result.stderr
  }
  try {
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
    put('package.json', '{"type":"module"}')
    for (const name of ['generate-declarations.mjs', 'operation-contracts.mjs'])
      put(`scripts/script/${name}`, readFileSync(join(repository, 'scripts/script', name), 'utf8'))
    put('scripts/ownership/governed-modules.mjs', 'export const GovernedModules=[]')
    put(
      'scripts/script/surfaces.mjs',
      `
      export const AgentViewTag='@AgentView';
      export const BannedModelFacingAliases={};
      export const CapabilityModulePrefix='velaros:';
      export const HostContextTypes=new Set(['FixtureContext']);
      export const CodeSurfaces=[
        {namespace:'first',directory:'fixture',interfaces:['FirstApi'],templates:'template.js'},
        {namespace:'sibling',directory:'fixture',interfaces:['SiblingApi'],templates:'template.js'},
        {namespace:'other',directory:'other',interfaces:['OtherApi'],templates:'template.js'}
      ];
      export const StandardSurfaces=[
        {namespace:'standard',specifier:'velaros:standard',directory:'standard',interface:'StandardApi',constant:'Standard'},
        {namespace:'standard-sibling',specifier:'velaros:standard-sibling',directory:'standard',interface:'StandardSiblingApi',constant:'StandardSibling'}
      ];
      export const surfaceConstantName=(name)=>name;
    `
    )
    for (const name of ['fixture', 'other', 'standard', 'middle', 'dependency']) {
      put(
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `@velaros-ai/${name}`,
          dependencies:
            name === 'fixture'
              ? { '@velaros-ai/middle': 'workspace:*' }
              : name === 'middle'
                ? { '@velaros-ai/dependency': 'workspace:*' }
                : {},
        })
      )
      put(
        `packages/${name}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, types: [] },
          include: ['src/**/*.ts'],
        })
      )
      put(`packages/${name}/template.js`, '// fixture template')
      mkdirSync(join(root, `packages/${name}/src/contract`), { recursive: true })
    }
    const api = (name, result = 'string') => `/** @AgentView ${name} */
      export interface ${name} {
        /** @AgentView Read.
         * @OperationEffect none
         */
        read(context: FixtureContext): Promise<${result}>
      }`
    put('packages/fixture/src/api.ts', api('FirstApi', 'Payload') + api('SiblingApi'))
    put('packages/other/src/api.ts', api('OtherApi'))
    put('packages/middle/src/index.ts', 'export {}')
    const dependency = '/** @AgentView dependency */\nexport interface Payload { value: string }'
    put('packages/dependency/src/types.ts', dependency)
    put(
      'packages/standard/src/api.ts',
      '/** @AgentView standard */\nexport interface StandardApi {value: string}\n/** @AgentView sibling */\nexport interface StandardSiblingApi {count: number}'
    )
    put(
      'packages/velaros/act/runtime/types/native-tools.ts',
      [
        'NativeExecution',
        'NativeObservation',
        'NativeObservationControl',
        'NativeBlob',
        'NativeDone',
      ]
        .map((name) => `export interface ${name}Input {value: string}`)
        .join('\n')
    )
    mkdirSync(join(root, 'packages/velaros/act/runtime/contract'), { recursive: true })

    assert.match(run(['--write']), /范围：全量/)
    const first = read('baselines/script/first.d.ts')
    const shared = read('packages/fixture/src/contract/surface.ts')
    const standard = read('packages/standard/src/contract/surface.ts')
    const native = read('packages/velaros/act/runtime/contract/surface.ts')
    assert.match(run(['--module', 'first']), /校验：first, sibling/)
    run(['--module', 'first', '--module', 'first', '--write'])
    assert.equal(read('packages/fixture/src/contract/surface.ts'), shared)
    assert.equal(read('baselines/script/first.d.ts'), first)
    run(['--module', 'standard', '--write'])
    assert.equal(read('packages/standard/src/contract/surface.ts'), standard)
    run(['--module', 'native-tools'])
    assert.equal(read('packages/velaros/act/runtime/contract/surface.ts'), native)
    assert.match(
      run(['--module', 'first', '--module', 'standard']),
      /校验：first, sibling, standard, standard-sibling/
    )
    assert.match(run(['--module', 'missing', '--write'], 1), /未知模块：missing/)
    assert.match(run(['--module'], 1), /需要一个登记的 namespace/)
    assert.match(run(['--module', '--write'], 1), /需要一个登记的 namespace/)
    assert.match(run(['--out'], 1), /需要一个目录/)
    assert.match(run(['--module', 'native-tools', '--out', 'isolated'], 1), /不能与 --out/)
    assert.equal(read('packages/fixture/src/contract/surface.ts'), shared)

    put('baselines/script/other.d.ts', 'unrelated sentinel')
    put('baselines/script/retired.d.ts', 'retired sentinel')
    assert.match(run(['--module', 'first', '--write', '--out', 'isolated']), /仅处理/)
    assert.equal(read('isolated/first.d.ts'), first)
    assert.equal(read('isolated/sibling.d.ts'), read('baselines/script/sibling.d.ts'))
    assert.equal(read('packages/fixture/src/contract/surface.ts'), shared)
    run(['--module', 'first'])
    assert.equal(read('baselines/script/other.d.ts'), 'unrelated sentinel')
    assert.equal(read('baselines/script/retired.d.ts'), 'retired sentinel')
    assert.match(run(['--module', 'other'], 1), /other: 生成物与源码不一致/)
    const fullFailure = run([], 1)
    assert.match(fullFailure, /登记表之外的声明/)
    assert.equal(read('baselines/script/retired.d.ts'), 'retired sentinel')
    // 未知产物阶段已验证；清掉自有 sentinel，再进入后续 Stray 审计。
    unlinkSync(join(root, 'baselines/script/retired.d.ts'))

    put('packages/dependency/src/types.ts', dependency.replace('value: string', 'value: number'))
    assert.match(run(['--module', 'first'], 1), /first: 生成物与源码不一致/)
    run(['--module', 'first', '--write'])
    assert.match(read('baselines/script/first.d.ts'), /value: number/)
    assert.notEqual(read('packages/fixture/src/contract/surface.ts'), shared)
    run(['--module', 'first'])
    put('packages/fixture/template.js', '// changed template')
    assert.match(run(['--module', 'first'], 1), /随包|surface.ts/)
    run(['--module', 'first', '--write'])
    const updated = read('packages/fixture/src/contract/surface.ts')
    put('packages/fixture/src/api.ts', api('FirstApi', 'Payload'))
    assert.match(run(['--module', 'first', '--write'], 1), /找不到接口 SiblingApi/)
    assert.equal(read('packages/fixture/src/contract/surface.ts'), updated)
    put('packages/fixture/src/api.ts', api('FirstApi', 'Payload') + api('SiblingApi'))
    put('packages/dependency/src/types.ts', dependency.replace('@AgentView', 'unmarked'))
    assert.match(run(['--module', 'first'], 1), /Payload/)
    put(
      'packages/dependency/src/types.ts',
      dependency + '\n/** @AgentView stray */\nexport interface Stray {unused: string}'
    )
    run(['--module', 'first', '--write'])
    assert.match(run([], 1), /Stray/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('method call examples in AgentView preserve complete comments and every generated operation export', () => {
  const root = mkdtempSync(join(tmpdir(), 'declaration-comments-'))
  try {
    mkdirSync(join(root, 'scripts/script'), { recursive: true })
    mkdirSync(join(root, 'scripts/ownership'), { recursive: true })
    mkdirSync(join(root, 'packages/fixture/src'), { recursive: true })
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    for (const name of ['generate-declarations.mjs', 'operation-contracts.mjs'])
      copyFileSync(join(repository, 'scripts/script', name), join(root, 'scripts/script', name))
    writeFileSync(
      join(root, 'scripts/ownership/governed-modules.mjs'),
      'export const GovernedModules=[]'
    )
    writeFileSync(
      join(root, 'scripts/script/surfaces.mjs'),
      `
      export const AgentViewTag='@AgentView';
      export const BannedModelFacingAliases={};
      export const CapabilityModulePrefix='velaros:';
      export const HostContextTypes=new Set(['FixtureContext']);
      export const StandardSurfaces=[];
      export const CodeSurfaces=[{namespace:'fixture',directory:'fixture',interfaces:['FixtureApi'],templates:'template.js'}];
      export const surfaceConstantName=()=> 'FixtureModule';
    `
    )
    writeFileSync(join(root, 'packages/fixture/package.json'), '{"name":"fixture"}')
    writeFileSync(
      join(root, 'packages/fixture/tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, types: [] },
        include: ['src/**/*.ts'],
      })
    )
    writeFileSync(
      join(root, 'packages/fixture/template.js'),
      "import {save,remove,describe} from 'velaros:fixture';"
    )
    const source = `
      interface FixtureContext { signal: AbortSignal }
      /** @AgentView 样例操作。 */
      export interface FixtureApi {
        /** @AgentView 示例 save(input) 完成之后继续；这里的调用不是方法声明。
         * @OperationEffect write
         */
        save(input: string, context: FixtureContext): Promise<string>
        /** @AgentView 多行示例：
         * remove(input) 后，调用 describe() 核对。
         * @OperationEffect write
         */
        remove(
          input: string,
          context: FixtureContext
        ): Promise<boolean>
        /** @AgentView 普通读取说明。
         * @OperationEffect none
         */
        describe(context: FixtureContext): Promise<string>
      }
    `
    writeFileSync(join(root, 'packages/fixture/src/operations.ts'), source)
    execFileSync(
      process.execPath,
      [join(root, 'scripts/script/generate-declarations.mjs'), '--write', '--out', 'output'],
      {
        cwd: root,
        timeout: 30000,
        encoding: 'utf8',
      }
    )
    const emitted = readFileSync(join(root, 'output/fixture.d.ts'), 'utf8')
    writeFileSync(
      join(root, 'packages/fixture/src/operations.ts'),
      source.replace(/\r?\n/g, '\r\n')
    )
    execFileSync(
      process.execPath,
      [join(root, 'scripts/script/generate-declarations.mjs'), '--write', '--out', 'output-crlf'],
      { cwd: root, timeout: 30000, encoding: 'utf8' }
    )
    assert.equal(readFileSync(join(root, 'output-crlf/fixture.d.ts'), 'utf8'), emitted)
    writeFileSync(join(root, 'output-crlf/fixture.d.ts'), emitted.replace(/\n/g, '\r\n'))
    execFileSync(
      process.execPath,
      [join(root, 'scripts/script/generate-declarations.mjs'), '--out', 'output-crlf'],
      { cwd: root, timeout: 30000, encoding: 'utf8' }
    )
    const input = ts.createSourceFile('operations.ts', source, ts.ScriptTarget.Latest, true)
    const expected = input.statements
      .find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'FixtureApi')
      .members.map((method) => method.name.text)
    const output = ts.createSourceFile('fixture.d.ts', emitted, ts.ScriptTarget.Latest, true)
    assert.deepEqual(output.parseDiagnostics, [])
    const actual = output.statements
      .find(ts.isModuleDeclaration)
      .body.statements.filter(ts.isFunctionDeclaration)
      .filter((method) =>
        method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
      .map((method) => method.name.text)
    assert.deepEqual(actual, expected)
    assert.match(emitted, /save\(input\) 完成之后继续/)
    assert.match(emitted, /remove\(input\) 后，调用 describe\(\) 核对/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 所有权与发布回归都运行正式 CLI 的真实副本，不模拟生成内容或重新实现候选集合。
function artifactFixture(t, shared = false) {
  const root = mkdtempSync(join(tmpdir(), 'declaration-ownership-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const read = (file) => readFileSync(join(root, file), 'utf8')
  const run = (args, status = 0) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/script/generate-declarations.mjs', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
      }
    )
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stdout + result.stderr)
    return result.stdout + result.stderr
  }
  const api = (name, type = 'string') => `/** @AgentView ${name} */
export interface ${name} {
  /** @AgentView Read the actual input.
   * @OperationEffect none
   */
  read(input: ${type}, context: FixtureContext): Promise<${type}>
}`
  const alpha = {
    namespace: 'alpha',
    directory: 'alpha',
    interfaces: ['AlphaApi'],
    templates: 'template.js',
  }
  const beta = {
    namespace: 'beta',
    directory: shared ? 'alpha' : 'beta',
    interfaces: ['BetaApi'],
    templates: 'template.js',
  }
  const register = (surfaces) =>
    put(
      'scripts/script/surfaces.mjs',
      `
export const AgentViewTag='@AgentView';
export const BannedModelFacingAliases={};
export const CapabilityModulePrefix='velaros:';
export const HostContextTypes=new Set(['FixtureContext']);
export const CodeSurfaces=${JSON.stringify(surfaces)};
export const StandardSurfaces=[];
export const surfaceConstantName=(name)=>name+'Module';
`
    )
  const snapshot = () => {
    const files = []
    const visit = (file) => {
      const absolute = join(root, file)
      if (!existsSync(absolute)) return
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) files.push([file, 'link', readlinkSync(absolute)])
      else if (stat.isDirectory()) {
        files.push([file, 'directory'])
        for (const name of readdirSync(absolute).sort()) visit(join(file, name))
      } else files.push([file, 'file', readFileSync(absolute).toString('base64')])
    }
    for (const directory of ['baselines', 'packages']) visit(directory)
    return files
  }
  const retire = () => {
    register([beta])
    put('packages/alpha/src/api.ts', shared ? api('BetaApi') : 'export {}')
  }
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
  put('package.json', '{"type":"module"}')
  for (const name of ['generate-declarations.mjs', 'operation-contracts.mjs'])
    put(`scripts/script/${name}`, readFileSync(join(repository, 'scripts/script', name), 'utf8'))
  put(
    'scripts/ownership/governed-modules.mjs',
    `export const GovernedModules=[
    {directory:'alpha',contract:'src/contract'}, {directory:'beta',contract:'src/contract'}
  ]`
  )
  for (const name of ['alpha', 'beta']) {
    put(`packages/${name}/package.json`, JSON.stringify({ name }))
    put(
      `packages/${name}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, types: [] },
        include: ['src/**/*.ts'],
      })
    )
    put(`packages/${name}/template.js`, '// actual template')
    mkdirSync(join(root, `packages/${name}/src/contract`), { recursive: true })
  }
  put('packages/alpha/src/api.ts', api('AlphaApi') + (shared ? '\n' + api('BetaApi') : ''))
  put('packages/beta/src/api.ts', shared ? 'export {}' : api('BetaApi'))
  put(
    'packages/velaros/act/runtime/types/native-tools.ts',
    ['NativeExecution', 'NativeObservation', 'NativeObservationControl', 'NativeBlob', 'NativeDone']
      .map((name) => `export interface ${name}Input { value: string }`)
      .join('\n')
  )
  mkdirSync(join(root, 'packages/velaros/act/runtime/contract'), { recursive: true })
  register([alpha, beta])
  return { root, put, read, run, api, alpha, beta, register, retire, snapshot }
}

test('full generation retires only proven old artifacts and check stays read-only', (t) => {
  const f = artifactFixture(t)
  f.run(['--write'])
  const beta = f.read('packages/beta/src/contract/surface.ts')
  const baseline = f.read('baselines/script/beta.d.ts')
  f.put('packages/alpha/assets/surface.ts', 'human asset sentinel')
  f.put('baselines/script/nested/extra.d.ts', 'nested baseline sentinel')
  f.retire()
  const before = f.snapshot()
  const check = f.run([], 1)
  assert.match(check, /退役：.*alpha\.d\.ts/)
  assert.match(check, /退役：.*alpha.*surface\.ts/)
  assert.deepEqual(f.snapshot(), before)
  f.run(['--write'])
  assert.equal(existsSync(join(f.root, 'baselines/script/alpha.d.ts')), false)
  assert.equal(existsSync(join(f.root, 'packages/alpha/src/contract/surface.ts')), false)
  assert.equal(f.read('packages/beta/src/contract/surface.ts'), beta)
  assert.equal(f.read('baselines/script/beta.d.ts'), baseline)
  assert.equal(f.read('packages/alpha/assets/surface.ts'), 'human asset sentinel')
  assert.equal(f.read('baselines/script/nested/extra.d.ts'), 'nested baseline sentinel')
  f.run([])
})

test('shared surface retirement blocks partial writes and namespace moves retain their baseline', (t) => {
  const f = artifactFixture(t, true)
  f.run(['--write'])
  f.retire()
  const before = f.snapshot()
  assert.match(f.run(['--module', 'beta', '--write'], 1), /共享 surface.*全量/)
  assert.deepEqual(f.snapshot(), before)
  f.run(['--write'])
  assert.match(f.read('packages/alpha/src/contract/surface.ts'), /namespace: 'beta'/)
  assert.doesNotMatch(f.read('packages/alpha/src/contract/surface.ts'), /namespace: 'alpha'/)
  assert.equal(existsSync(join(f.root, 'baselines/script/alpha.d.ts')), false)
  f.register([{ ...f.beta, directory: 'beta' }])
  f.put('packages/alpha/src/api.ts', 'export {}')
  f.put('packages/beta/src/api.ts', f.api('BetaApi'))
  const baseline = f.read('baselines/script/beta.d.ts')
  f.run(['--write'])
  assert.equal(f.read('baselines/script/beta.d.ts'), baseline)
  assert.equal(existsSync(join(f.root, 'packages/alpha/src/contract/surface.ts')), false)
  assert.match(f.read('packages/beta/src/contract/surface.ts'), /namespace: 'beta'/)
  f.run([])
})

test('unproven ownership and byte mismatches fail before any formal file changes', (t) => {
  const f = artifactFixture(t)
  f.run(['--write'])
  f.retire()
  const surface = f.read('packages/alpha/src/contract/surface.ts')
  const baseline = f.read('baselines/script/alpha.d.ts')
  const executionSentinel = join(f.root, 'executed-old-surface')
  for (const damage of [
    () => f.put('packages/alpha/src/contract/surface.ts', 'human sentinel'),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        surface +
          `\nprocess.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(executionSentinel)}, 'executed');`
      ),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        surface.replace("namespace: 'alpha'", "namespace: 'elsewhere'")
      ),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        surface.replace("namespace: 'alpha'", "namespace: 'alpha', namespace: 'alpha'")
      ),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        surface.replace("namespace: 'alpha'", 'namespace: process.env.OWNER')
      ),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        surface.replace("namespace: 'alpha'", "...{namespace: 'alpha'}")
      ),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        surface.replace("namespace: 'alpha'", "get namespace() { return 'alpha' }")
      ),
    () =>
      f.put(
        'packages/alpha/src/contract/surface.ts',
        Buffer.concat([Buffer.from(surface), Buffer.from([0xff])])
      ),
    () => f.put('baselines/script/alpha.d.ts', baseline + ' '),
    () => f.put('baselines/script/alpha.d.ts', baseline.replace(/\n/g, '\r\n')),
    () => f.put('baselines/script/unknown.d.ts', 'human declaration sentinel'),
    () => f.put('packages/beta/src/contract/surface.ts', surface),
  ]) {
    f.put('packages/alpha/src/contract/surface.ts', surface)
    f.put('baselines/script/alpha.d.ts', baseline)
    const beta = f.read('packages/beta/src/contract/surface.ts')
    damage()
    const before = f.snapshot()
    f.run(['--write'], 1)
    assert.deepEqual(f.snapshot(), before)
    assert.equal(existsSync(executionSentinel), false)
    f.put('packages/beta/src/contract/surface.ts', beta)
    rmSync(join(f.root, 'baselines/script/unknown.d.ts'), { force: true })
  }
  f.put('packages/alpha/src/contract/surface.ts', surface)
  f.put('baselines/script/alpha.d.ts', baseline)
  unlinkSync(join(f.root, 'packages/alpha/src/contract/surface.ts'))
  mkdirSync(join(f.root, 'packages/alpha/src/contract/surface.ts'))
  f.put('packages/alpha/src/contract/surface.ts/sentinel', 'human directory sentinel')
  const before = f.snapshot()
  f.run(['--write'], 1)
  assert.deepEqual(f.snapshot(), before)
})

test('missing baseline can retire its owner but an ownerless baseline cannot be deleted', (t) => {
  const f = artifactFixture(t)
  f.run(['--write'])
  f.retire()
  const surface = f.read('packages/alpha/src/contract/surface.ts')
  unlinkSync(join(f.root, 'packages/alpha/src/contract/surface.ts'))
  const before = f.snapshot()
  assert.match(f.run(['--write'], 1), /无法证明生成归属/)
  assert.deepEqual(f.snapshot(), before)
  f.put('packages/alpha/src/contract/surface.ts', surface)
  unlinkSync(join(f.root, 'baselines/script/alpha.d.ts'))
  f.run(['--write'])
  assert.equal(existsSync(join(f.root, 'packages/alpha/src/contract/surface.ts')), false)
  f.run([])
})

for (const boundary of ['surface-file', 'contract-directory', 'baseline-directory'])
  test(`generation rejects a linked ${boundary} without changing external bytes`, (t) => {
    const f = artifactFixture(t)
    f.run(['--write'])
    f.retire()
    const external = mkdtempSync(join(tmpdir(), 'declaration-external-'))
    t.after(() => rmSync(external, { recursive: true, force: true }))
    writeFileSync(join(external, 'sentinel'), 'external owner')
    let link
    let target
    let kind
    if (boundary === 'surface-file') {
      link = join(f.root, 'packages/alpha/src/contract/surface.ts')
      target = join(external, 'sentinel')
      unlinkSync(link)
      kind = 'file'
    } else {
      link = join(
        f.root,
        boundary === 'contract-directory' ? 'packages/alpha/src/contract' : 'baselines/script'
      )
      rmSync(link, { recursive: true })
      target = external
      kind = process.platform === 'win32' ? 'junction' : 'dir'
    }
    try {
      symlinkSync(target, link, kind)
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code))
        return t.skip('This host cannot create the required link')
      throw error
    }
    const before = f.snapshot()
    assert.match(f.run(['--write'], 1), /不能是链接/)
    assert.deepEqual(f.snapshot(), before)
    assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'external owner')
    assert.deepEqual(readdirSync(external), ['sentinel'])
  })

test('out and unrelated partial generation never gain retirement permissions', (t) => {
  const f = artifactFixture(t)
  f.run(['--write'])
  f.retire()
  f.put('output/extra.d.ts', 'output sentinel')
  const before = f.snapshot()
  f.run(['--module', 'beta', '--out', 'output', '--write'])
  assert.equal(f.read('output/extra.d.ts'), 'output sentinel')
  assert.deepEqual(f.snapshot(), before)
  f.run(['--module', 'beta', '--out', 'baselines/script', '--write'])
  assert.deepEqual(f.snapshot(), before)
  f.run(['--out', 'baselines/script', '--write'], 1)
  assert.deepEqual(f.snapshot(), before)
  f.run(['--module', 'beta', '--write'])
  assert.deepEqual(f.snapshot(), before)
  f.run(['--module', 'alpha', '--write'], 1)
  f.run(['--module'], 1)
  f.run(['--out'], 1)
  assert.deepEqual(f.snapshot(), before)
})

test('invalid CLI options cannot turn output experiments into formal writes or retirement', (t) => {
  const f = artifactFixture(t)
  f.run(['--write'])
  f.retire()
  f.put('packages/beta/src/api.ts', f.api('BetaApi', 'number'))
  const external = mkdtempSync(join(tmpdir(), 'declaration-cli-external-'))
  t.after(() => rmSync(external, { recursive: true, force: true }))
  const sentinel = join(external, 'beta.d.ts')
  writeFileSync(sentinel, 'human external declaration')
  const before = f.snapshot()
  for (const args of [
    ['--outt', external, '--write'],
    ['--unknown', '--write'],
    [external, '--write'],
    ['--out', external, '--out', 'output', '--write'],
    ['--write', '--write'],
    ['--module'],
    ['--out', '--write'],
    ['--module', '--out', external, '--write'],
    ['--', '--outt', external, '--write'],
  ]) {
    assert.match(f.run(args, 1), /未知参数|不允许重复|需要一个/)
    assert.deepEqual(f.snapshot(), before)
    assert.equal(readFileSync(sentinel, 'utf8'), 'human external declaration')
    assert.deepEqual(readdirSync(external), ['beta.d.ts'])
  }
  // package.json 的正式 Node argv：固定 --write 后只转发登记选项，module 可重复去重。
  f.run(['--write', '--module', 'beta', '--module', 'beta', '--out', 'output'])
  assert.match(f.read('output/beta.d.ts'), /input: number/)
  assert.deepEqual(f.snapshot(), before)
  f.run(['--write', '--module', 'beta'])
  assert.equal(existsSync(join(f.root, 'baselines/script/alpha.d.ts')), true)
  f.run(['--write'])
  assert.equal(existsSync(join(f.root, 'baselines/script/alpha.d.ts')), false)
  assert.equal(readFileSync(sentinel, 'utf8'), 'human external declaration')
  f.run([])
})

test('full generation failures in later interfaces, templates or tag audit publish nothing', (t) => {
  const f = artifactFixture(t)
  f.run(['--write'])
  f.retire()
  for (const damage of [
    () => f.put('packages/beta/src/api.ts', 'export {}'),
    () => f.put('packages/beta/template.js', ''),
    () =>
      f.put(
        'packages/alpha/src/api.ts',
        '/** @AgentView orphan */\nexport interface Orphan { unused: string }'
      ),
    () => f.put('baselines/script/unowned.d.ts', 'unowned sentinel'),
  ]) {
    f.put('packages/beta/src/api.ts', f.api('BetaApi', 'number'))
    f.put('packages/beta/template.js', '// changed template')
    f.put('packages/alpha/src/api.ts', 'export {}')
    damage()
    const before = f.snapshot()
    f.run(['--write'], 1)
    assert.deepEqual(f.snapshot(), before)
    rmSync(join(f.root, 'baselines/script/unowned.d.ts'), { force: true })
  }
})

// 只在独占 fixture 副本替换私有文件操作参数；正式 CLI 不增加测试入口或环境开关。
function injectPublication(f, operations) {
  const file = 'scripts/script/generate-declarations.mjs'
  const source = f.read(file)
  assert.equal(source.split('publishArtifacts(publishPlan)').length, 2)
  f.put(
    file,
    source.replace(
      'publishArtifacts(publishPlan)',
      `publishArtifacts(publishPlan, { ...publishFileSystem, ${operations} })`
    )
  )
}

test('staging failures publish no files and ordinary rename failures restore the prior batch', (t) => {
  for (const fault of ['staging', 'write', 'remove']) {
    const f = artifactFixture(t)
    f.run(['--write'])
    if (fault === 'remove') f.retire()
    else f.put('packages/alpha/src/api.ts', f.api('AlphaApi', 'number'))
    f.put('packages/beta/src/api.ts', f.api('BetaApi', 'number'))
    const before = f.snapshot()
    injectPublication(
      f,
      fault === 'staging'
        ? `stageArtifact: (() => { let count=0; return (...args) => { if (++count===2) throw new Error('fixture staging failure'); return stageArtifact(...args) } })()`
        : `renameSync: (() => { let count=0; return (...args) => { if (++count===2) throw new Error('fixture rename failure'); return renameSync(...args) } })()`
    )
    assert.match(f.run(['--write'], 1), /fixture (?:staging|rename) failure/)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('rollback failures retain recoverable bytes and never overwrite a new external owner', (t) => {
  for (const external of [false, true]) {
    const f = artifactFixture(t)
    f.run(['--write'])
    const old = f.read('baselines/script/alpha.d.ts')
    f.put('packages/alpha/src/api.ts', f.api('AlphaApi', 'number'))
    f.put('packages/beta/src/api.ts', f.api('BetaApi', 'number'))
    const target = join(f.root, 'baselines/script/alpha.d.ts')
    injectPublication(
      f,
      `renameSync: (() => { let count=0; return (...args) => {
      count++;
      if (count===2) { ${external ? `writeFileSync(${JSON.stringify(target)}, 'external owner bytes');` : ''} throw new Error('fixture publish failure') }
      if (count===3 && ${!external}) throw new Error('fixture rollback failure');
      return renameSync(...args)
    } })()`
    )
    const failure = f.run(['--write'], 1)
    assert.match(failure, /fixture publish failure/)
    assert.match(failure, /回滚失败/)
    if (external) assert.equal(f.read('baselines/script/alpha.d.ts'), 'external owner bytes')
    else assert.match(f.read('baselines/script/alpha.d.ts'), /input: number/)
    const backups = readdirSync(join(f.root, 'baselines/script')).filter((name) =>
      name.startsWith('.alpha.d.ts.generate-')
    )
    assert.equal(backups.length, 1)
    assert.equal(f.read(`baselines/script/${backups[0]}`), old)
  }
})
