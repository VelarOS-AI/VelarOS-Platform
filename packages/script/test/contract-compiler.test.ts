import { spawnSync } from 'node:child_process'

import { expect, test } from 'bun:test'

const compilerUrl = new URL('../dist/index.js', import.meta.url).href

for (const directory of ['C:\\work\\project', 'D:\\项目目录\\project with spaces']) {
  test(`Skill 合同在 Windows 工作目录 ${directory} 中绑定虚拟声明文件`, () => {
    // Node 与 Bun 的 path.resolve 对被替换 cwd 的读取方式不同，使用产品实际的 Node。
    const result = spawnSync('node', ['--input-type=module'], {
      encoding: 'utf8',
      timeout: 10_000,
      input: `
        import assert from 'node:assert/strict';
        import {scriptContractCompiler} from ${JSON.stringify(compilerUrl)};
        process.cwd = () => ${JSON.stringify(directory)};
        const contract = scriptContractCompiler.compile(
          '/** @OperationEffect none */ export function identity(): { cwd: string; pid: number };',
          'skill:windows-contract'
        );
        assert.deepEqual(contract.methods, ['identity']);
        assert.equal(contract.operations.identity.effects, 'none');
        assert.deepEqual(contract.operations.identity.input, {type:'null'});
        const schema = contract.operations.identity.output;
        const definition = schema.definitions[schema.$ref.split('/').at(-1)];
        assert.deepEqual({...definition.properties}, {cwd:{type:'string'},pid:{type:'number'}});
      `,
    })
    expect(result.status, result.stderr || result.error?.message).toBe(0)
  })
}
