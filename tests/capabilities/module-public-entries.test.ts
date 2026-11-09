// 在隔离的真实模块目录运行正式所有权 CLI，核对接口只能从本模块清单登记的入口公开。
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { expect, test } from 'bun:test'

const repository = resolve(import.meta.dirname, '../..')

for (const placement of ['root', 'locator', 'unregistered', 'peer']) {
  test(`public interfaces require their module's declared entry: ${placement}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'velaros-public-entries-'))
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
      put(
        'scripts/ownership/governed-modules.mjs',
        `
export const GovernedModules = [{
  directory: 'fixture', unit: 'one', name: '@proof/package/one',
  contract: 'one/contract', types: 'one/types', impl: 'one/impl', utils: 'one/utils',
  layers: [['Locator.ts']], invariants: 'one/spec/invariants.md', acceptance: 'one/spec/acceptance.test.ts',
}];
export const ReadmeSections = {required:['用法','入口'], allowed:['用法','入口','约定']};
export const ReadmeMaxLines = 160;
export const InvariantCheckKinds = ['测试','类型','门禁','运行时','文字'];
`
      )
      const exports: Record<string, { types: string; import: string }> = {
        './one': { types: './dist/one/index.d.ts', import: './dist/one/index.js' },
      }
      if (placement === 'locator')
        exports['./one/locator'] = {
          types: './dist/one/locator.d.ts',
          import: './dist/one/locator.js',
        }
      if (placement === 'peer')
        exports['./two'] = { types: './dist/two/index.d.ts', import: './dist/two/index.js' }
      put(
        'packages/fixture/package.json',
        JSON.stringify({
          name: '@proof/package',
          type: 'module',
          exports,
          scripts: { test: 'bun test one/spec/acceptance.test.ts' },
        })
      )
      put(
        'packages/fixture/one/contract/provides.ts',
        `/** 本模块交付的定位能力。 */
export type { LocatorApi } from '../impl/Locator.js';
`
      )
      put(
        'packages/fixture/one/contract/requires.ts',
        `/** 宿主提供的定位配置。 */
export interface LocatorOptions {
  /** 宿主名称。 */
  readonly name?: string
}
`
      )
      put('packages/fixture/one/contract/constants.ts', '// 本模块没有公开常量。\n')
      put(
        'packages/fixture/one/impl/Locator.ts',
        `import type { LocatorOptions } from '../contract/requires.js';
/** 本机定位结果。 */
export interface LocatorApi {
  /** 宿主名称。 */
  readonly name: string
}
/** 保存本次宿主配置。 */
export class Locator implements LocatorApi {
  public readonly name: string;
  constructor(options: LocatorOptions) { this.name = options.name ?? ''; }
}
/** 创建本模块的定位能力。 */
export function createLocator(options: LocatorOptions = {}): LocatorApi { return new Locator(options); }
`
      )
      const publicExports = `export type { LocatorApi } from './contract/provides.js';
export type { LocatorOptions } from './contract/requires.js';
export { createLocator } from './impl/Locator.js';
`
      put(
        'packages/fixture/one/index.ts',
        placement === 'root' ? publicExports : `export type {} from './contract/provides.js';`
      )
      if (placement === 'locator') put('packages/fixture/one/locator.ts', publicExports)
      if (placement === 'unregistered') put('packages/fixture/one/unregistered.ts', publicExports)
      if (placement === 'peer')
        put('packages/fixture/two/index.ts', publicExports.replaceAll("'./", "'../one/"))
      for (const directory of ['types', 'utils'])
        mkdirSync(join(root, 'packages/fixture/one', directory), { recursive: true })
      put(
        'packages/fixture/one/spec/acceptance.test.ts',
        `import {test} from 'bun:test'; test('INV-1 当前合同', () => {});`
      )
      put(
        'packages/fixture/one/spec/invariants.md',
        '| INV-1 | 定位器按配置返回名称 | 类型 | contract/requires.ts::LocatorOptions |'
      )
      put(
        'packages/fixture/one/README.md',
        `# @proof/package/one
向宿主提供本机定位能力。
## 用法
\`\`\`ts
import type {LocatorOptions} from '@proof/package/one';
\`\`\`
## 入口
\`@proof/package/one\`
${placement === 'locator' ? '`@proof/package/one/locator`' : ''}
`
      )
      const result = spawnSync(process.execPath, ['scripts/ownership/check-module-ownership.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 4_000,
      })
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.error, output).toBeUndefined()
      if (placement === 'root' || placement === 'locator') expect(result.status, output).toBe(0)
      else {
        expect(result.status, output).toBe(1)
        expect(output).toContain('LocatorOptions 没有从本模块已登记的公开入口导出')
        expect(output).toContain('provides.ts 登记的 LocatorApi 没有从本模块已登记的公开入口导出')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
