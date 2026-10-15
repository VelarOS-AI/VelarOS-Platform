// 用途：验证流式导入评分器接受可发现的文档组织，并继续拒绝缺失指南或不可运行的示例。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const grader = fileURLToPath(new URL('./test_d3_dsv_streaming.mjs', import.meta.url))
const cases = [
  {
    name: 'README links to a guide that documents convenience exports',
    readme: '# Data import\nSee [the guide](./docs/streaming.md).\n',
    guide: 'Use csvParseStream(source) to consume records.\n',
    example: 'console.log("example complete")\n',
    passes: true,
  },
  {
    name: 'README documents the formatter method directly',
    readme: '# Imports\nUse parseRowsStream(source).\n',
    guide: 'parseStream(source) emits objects.\n',
    example: 'console.log("example complete")\n',
    passes: true,
  },
  {
    name: 'an unchanged unrelated README does not document the feature',
    readme: '# Existing synchronous API\n',
    guide: 'Use tsvParseRowsStream(source).\n',
    example: 'console.log("example complete")\n',
    passes: false,
  },
  {
    name: 'a missing guide remains a failed delivery',
    readme: '# Imports\nUse csvParseStream(source).\n',
    example: 'console.log("example complete")\n',
    passes: false,
  },
  {
    name: 'a failing offline example remains a failed delivery',
    readme: '# Imports\nSee docs/streaming.md.\n',
    guide: 'Use tsvParseStream(source).\n',
    example: 'process.exitCode = 1\n',
    passes: false,
  },
]

for (const scenario of cases) {
  test(scenario.name, async () => {
    const root = await mkdtemp(join(tmpdir(), 'd3-streaming-grader-'))
    try {
      for (const directory of ['src', 'docs', 'examples']) await mkdir(join(root, directory))
      await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
      await writeFile(
        join(root, 'src/index.js'),
        [
          'export function csvParseStream() {}',
          'export function csvParseRowsStream() {}',
          'export function tsvParseStream() {}',
          'export function tsvParseRowsStream() {}',
          'export function dsvFormat() { return {parseStream() {}, parseRowsStream() {}}; }',
        ].join('\n')
      )
      await writeFile(join(root, 'README.md'), scenario.readme)
      if (scenario.guide) await writeFile(join(root, 'docs/streaming.md'), scenario.guide)
      await writeFile(join(root, 'examples/streaming-import.js'), scenario.example)
      const environment = { ...process.env }
      delete environment.NODE_TEST_CONTEXT
      const result = spawnSync(
        process.execPath,
        ['--test', '--test-name-pattern=^documentation and runnable offline', grader],
        { cwd: root, encoding: 'utf8', timeout: 20000, env: environment }
      )
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.match(result.stdout, /documentation and runnable offline demonstration are delivered/u)
      assert.equal(result.status === 0, scenario.passes, result.stdout + result.stderr)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
