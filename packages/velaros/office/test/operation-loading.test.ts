// 用真实 Node 加载正式包入口；解析钩子只观察或拒绝模块，不替换执行器和文档写入链。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

const operations = [
  {
    method: 'createWord',
    input: { outputPath: 'report.docx', content: '正文' },
    executor: 'Document',
  },
  {
    method: 'createPresentation',
    input: { outputPath: 'deck.pptx', content: '# 标题' },
    executor: 'Document',
  },
  {
    method: 'createSpreadsheet',
    input: { outputPath: 'table.xlsx', content: 'a,b\n1,2' },
    executor: 'Document',
  },
  { method: 'readPdf', input: { inputPath: 'paper.pdf' }, executor: 'Pdf' },
  {
    method: 'wordToPdf',
    input: { inputPath: 'report.docx', outputPath: 'report.pdf' },
    executor: 'Pdf',
  },
  {
    method: 'latexToPdf',
    input: { outputPath: 'paper.pdf', latexSource: 'source' },
    executor: 'Pdf',
  },
  {
    method: 'editPdf',
    input: { inputPath: 'paper.pdf', outputPath: 'edited.pdf' },
    executor: 'Pdf',
  },
  { method: 'preview', input: { inputPath: 'report.docx' }, executor: 'Preview' },
  { method: 'toMarkdown', input: { inputPath: 'report.docx' }, executor: 'Markdown' },
]

const contextSource = String.raw`
let hostCalls = 0;
const effects = [];
const touchHost = () => { hostCalls++; throw new Error('unexpected host operation'); };
const context = (signal) => ({
  abortSignal: signal,
  office: {
    getRootPath: touchHost,
    resolvePath: touchHost,
    inspectEnvironment: touchHost,
    runCommand: touchHost,
    locateMarkItDown: touchHost,
  },
  recordEffect: (effect) => effects.push(effect),
});
`

function probe(source: string): void {
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '--eval',
      `import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
${source}
process.stdout.write('office loading boundary verified');`,
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 4_000,
    }
  )
  expect(output).toContain('office loading boundary verified')
}

test('the public operation entry loads without document, PDF or font engines', () => {
  probe(String.raw`
const heavy = /^(?:docx|exceljs|pdfjs-dist|pdf-lib|@napi-rs\/canvas|mammoth)(?:\/|$)|^#pptxgenjs$/u;
registerHooks({resolve(specifier, context, next) {
  if (heavy.test(specifier)) throw new Error('document engine loaded: ' + specifier);
  return next(specifier, context);
}});
const {officeOperations} = await import('@velaros-ai/velaros/office');
for (const method of ${JSON.stringify(operations.map((operation) => operation.method))})
  assert.equal(typeof officeOperations[method], 'function', method);
// 对同一个真实钩子做负控，不能因为没有匹配到依赖而误报轻量。
await assert.rejects(import('@velaros-ai/velaros/office/renderer'), /document engine loaded:/u);
`)
})

for (const operation of operations) {
  test(`${operation.method} validates and checks cancellation before loading its actual executor`, () => {
    probe(String.raw`
${contextSource}
const operation = ${JSON.stringify(operation)};
const attempted = [];
const blocked = new Error('executor resolution blocked');
registerHooks({resolve(specifier, context, next) {
  if (/^\.\/operations\/Office(?:Document|Pdf|Preview|Markdown)Operations\.js$/u.test(specifier)) {
    attempted.push(specifier);
    throw blocked;
  }
  return next(specifier, context);
}});
const {officeOperations} = await import('@velaros-ai/velaros/office');
await assert.rejects(officeOperations[operation.method]({}, context(new AbortController().signal)),
  (error) => error.code === 'VALIDATION');
assert.deepEqual(attempted, []);
assert.deepEqual(effects, []);
const cancelled = new AbortController();
const reason = new Error('cancel before loading');
cancelled.abort(reason);
await assert.rejects(officeOperations[operation.method](operation.input, context(cancelled.signal)),
  (error) => error === reason);
assert.deepEqual(attempted, []);
assert.deepEqual(effects, []);
await assert.rejects(officeOperations[operation.method](operation.input, context(new AbortController().signal)),
  (error) => error === blocked);
assert.deepEqual(attempted, ['./operations/Office' + operation.executor + 'Operations.js']);
assert.equal(hostCalls, 0);
assert.deepEqual(effects, ['preview', 'toMarkdown'].includes(operation.method) ? ['none'] : []);
`)
  })
}

for (const executor of ['Document', 'Pdf', 'Preview', 'Markdown']) {
  const operation = operations.find((candidate) => candidate.executor === executor)!
  test(`cancellation while the real ${executor} executor loads never reaches the host`, () => {
    probe(String.raw`
${contextSource}
const operation = ${JSON.stringify(operation)};
const controller = new AbortController();
const reason = new Error('cancel during executor loading');
let selected = 0;
registerHooks({resolve(specifier, context, next) {
  if (specifier === './operations/Office' + operation.executor + 'Operations.js') {
    selected++;
    controller.abort(reason);
  }
  return next(specifier, context);
}});
const {officeOperations} = await import('@velaros-ai/velaros/office');
await assert.rejects(officeOperations[operation.method](operation.input, context(controller.signal)),
  (error) => error === reason);
assert.equal(selected, 1);
assert.equal(hostCalls, 0);
assert.deepEqual(effects, ['preview', 'toMarkdown'].includes(operation.method) ? ['none'] : []);
`)
  })
}

test('cold concurrent public Word calls retain every append through the shared writer', () => {
  probe(String.raw`
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import JSZip from 'jszip';
const {officeOperations} = await import('@velaros-ai/velaros/office');
const root = await mkdtemp(join(tmpdir(), 'office-lazy-writer-'));
try {
  const context = {
    abortSignal: new AbortController().signal,
    office: {
      getRootPath: () => root,
      inspectEnvironment: async () => ({commands: []}),
      runCommand: async () => { throw new Error('Word must not run external commands'); },
    },
  };
  const contents = ['seed', 'alpha', 'beta', 'gamma'];
  const results = await Promise.all(contents.map((content) => officeOperations.createWord({
    outputPath: 'report.docx', content, appendMode: true,
  }, context)));
  for (const result of results) assert.equal(result.path, join(root, 'report.docx'));
  const document = await JSZip.loadAsync(await readFile(join(root, 'report.docx')));
  const body = await document.file('word/document.xml').async('string');
  for (const content of contents) assert.ok(body.includes(content), content);
} finally {
  await rm(root, {recursive: true, force: true});
}
`)
})
