// 定位器从真实宿主子路径加载；解析钩子拒绝文档和字体引擎，防止轻量入口重新转发整个 Office。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

test('the public locator entry works without loading document, PDF or font engines', () => {
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '--eval',
      String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const heavy = /^(?:docx|exceljs|pdfjs-dist|@napi-rs\/canvas|mammoth)(?:\/|$)|^#pptxgenjs$/u;
registerHooks({resolve(specifier, context, next) {
  if (heavy.test(specifier)) throw new Error('document engine loaded: ' + specifier);
  return next(specifier, context);
}});
const entry = await import('@velaros-ai/velaros/office/locator');
assert.deepEqual(Object.keys(entry), ['createMarkItDownLocator']);
assert.equal(entry.createMarkItDownLocator({resourceRoots: []}).resolve(), null);
await assert.rejects(import('@velaros-ai/velaros/office'), /document engine loaded:/u);
process.stdout.write('locator dependency boundary verified\n');
`,
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 4_000,
    }
  )
  expect(output).toContain('locator dependency boundary verified')
})
