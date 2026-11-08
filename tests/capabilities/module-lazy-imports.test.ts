// 在隔离的真实模块目录执行正式门禁，核对懒加载边仍受端口可达性与实现分层约束。
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { expect, test } from 'bun:test'

const repository = resolve(import.meta.dirname, '../..')

for (const scenario of [
  'static',
  'lazy',
  'unregistered',
  'wrong-owner',
  'unused-registration',
  'computed',
  'unused-port',
  'upward',
]) {
  test(`implementation dependency checks retain their boundaries: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'velaros-lazy-imports-'))
    const put = (path: string, content: string): void => {
      const target = join(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    try {
      symlinkSync(
        join(repository, 'node_modules'),
        join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      put('package.json', JSON.stringify({ type: 'module' }))
      for (const name of ['check-module-ownership.mjs', 'test-entrypoints.mjs']) {
        mkdirSync(join(root, 'scripts/ownership'), { recursive: true })
        copyFileSync(
          join(repository, 'scripts/ownership', name),
          join(root, 'scripts/ownership', name)
        )
      }
      const lazyImports = ['static', 'unregistered'].includes(scenario)
        ? []
        : [
            {
              specifier: './Executor.js',
              file: `one/impl/${scenario === 'wrong-owner' ? 'Executor' : 'Operations'}.ts`,
              reason: '实际操作才加载执行器',
            },
          ]
      const layers =
        scenario === 'upward'
          ? [['Executor.ts'], ['Operations.ts']]
          : [['Operations.ts'], ['Executor.ts']]
      put(
        'scripts/ownership/governed-modules.mjs',
        `export const GovernedModules = [{
  directory: 'fixture', unit: 'one', name: '@proof/package/one',
  contract: 'one/contract', types: 'one/types', impl: 'one/impl', utils: 'one/utils',
  surfaceFile: 'one/impl/Operations.ts', hostPort: 'FixtureSpacePort', hostPortField: 'host',
  layers: ${JSON.stringify(layers)}, lazyImports: ${JSON.stringify(lazyImports)},
  invariants: 'one/spec/invariants.md', acceptance: 'one/spec/acceptance.test.ts',
}];
export const ReadmeSections = {required:['用法','入口'], allowed:['用法','入口','约定']};
export const ReadmeMaxLines = 160;
export const InvariantCheckKinds = ['测试','类型','门禁','运行时','文字'];
`
      )
      put(
        'packages/fixture/package.json',
        JSON.stringify({
          name: '@proof/package',
          type: 'module',
          exports: { './one': { types: './dist/one/index.d.ts', import: './dist/one/index.js' } },
          scripts: { test: 'bun test one/spec/acceptance.test.ts' },
        })
      )
      put(
        'packages/fixture/one/contract/provides.ts',
        `/** 本模块提供的操作。 */
export type { OperationsApi } from '../impl/Operations.js';
`
      )
      put(
        'packages/fixture/one/contract/requires.ts',
        `/** 宿主提供的当前正文。 */
export interface FixtureSpacePort {
  /** 读取本次操作的正文。 */
  read: () => string
}
/** 本次操作上下文。 */
export interface FixtureContext {
  /** 唯一宿主端口。 */
  host: FixtureSpacePort
}
`
      )
      put('packages/fixture/one/contract/constants.ts', '// 本模块没有公开常量。\n')
      const body =
        scenario === 'static'
          ? 'return executor.run(context);'
          : scenario === 'unused-registration'
            ? "return '未委托';"
            : scenario === 'computed'
              ? "const target = './Executor.js'; return (await import(target)).executor.run(context);"
              : "return (await import('./Executor.js')).executor.run(context);"
      put(
        'packages/fixture/one/impl/Operations.ts',
        `import type { FixtureContext } from '../contract/requires.js';
${scenario === 'static' ? "import { executor } from './Executor.js';" : ''}
/** 提交本次操作。 */
export interface OperationsApi {
  /** 从宿主取正文。 */
  run(context: FixtureContext): Promise<string>
}
/** 委托执行器读取正文。 */
export class Operations implements OperationsApi {
  public async run(context: FixtureContext): Promise<string> { ${body} }
}
/** 当前操作单例。 */
export const operations: OperationsApi = new Operations();
`
      )
      put(
        'packages/fixture/one/impl/Executor.ts',
        `import type { FixtureContext } from '../contract/requires.js';
/** 实际读取操作。 */
export interface ExecutorApi {
  /** 读取本次正文。 */
  run(context: FixtureContext): string
}
/** 实际调用宿主端口。 */
export class Executor implements ExecutorApi {
  public run(context: FixtureContext): string {
    ${scenario === 'unused-port' ? "return '未调用宿主';" : 'return context.host.read();'}
  }
}
/** 当前执行器单例。 */
export const executor: ExecutorApi = new Executor();
`
      )
      put(
        'packages/fixture/one/index.ts',
        `export type { OperationsApi } from './contract/provides.js';
export type { FixtureContext, FixtureSpacePort } from './contract/requires.js';
export { operations } from './impl/Operations.js';
`
      )
      for (const directory of ['types', 'utils'])
        mkdirSync(join(root, 'packages/fixture/one', directory), { recursive: true })
      put(
        'packages/fixture/one/spec/acceptance.test.ts',
        `import {test} from 'bun:test'; test('INV-1 当前合同', () => {});`
      )
      put(
        'packages/fixture/one/spec/invariants.md',
        '| INV-1 | 宿主提供正文 | 类型 | contract/requires.ts::FixtureSpacePort |'
      )
      put(
        'packages/fixture/one/README.md',
        `# @proof/package/one
向宿主提供读取操作。
## 用法
\`\`\`ts
import {operations} from '@proof/package/one';
\`\`\`
## 入口
\`@proof/package/one\`
`
      )
      const result = spawnSync(process.execPath, ['scripts/ownership/check-module-ownership.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 4_000,
      })
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.error, output).toBeUndefined()
      if (scenario === 'static' || scenario === 'lazy') {
        expect(result.status, output).toBe(0)
      } else {
        expect(result.status, output).toBe(1)
        if (scenario === 'upward') expect(output).toContain('引用了上层的 one/impl/Executor.ts')
        else expect(output).toContain('FixtureSpacePort.read 从模型面入口走不到')
        if (scenario === 'unregistered' || scenario === 'computed')
          expect(output).toContain('用了动态 import()')
        if (scenario === 'wrong-owner') expect(output).toContain('一个懒加载目标只许一处加载')
        if (scenario === 'unused-registration') expect(output).toContain('没有人加载；不用的删掉')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
