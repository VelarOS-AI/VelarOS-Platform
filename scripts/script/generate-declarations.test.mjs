import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
      ['NativeExecution', 'NativeObservation', 'NativeBlob', 'NativeDone']
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
    const fullFailure = run([], 1)
    assert.match(fullFailure, /other: 生成物与源码不一致/)
    assert.match(fullFailure, /登记表之外的声明/)

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
