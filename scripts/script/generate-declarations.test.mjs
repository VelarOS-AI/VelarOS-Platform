import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
