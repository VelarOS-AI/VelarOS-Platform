// 使用冻结项目自己的 TAP parser 读取原测试的逐项结果，崩溃与不完整计划保留为失败。
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(resolve('package.json'))
const Parser = require('tap-parser')
// 不同 TAP 主版本的 CLI 开关不同；只关闭项目自身明确支持的旧 ESM loader。
const help = spawnSync(process.execPath, [process.argv[2], '--help'], {
  encoding: 'utf8',
  timeout: 10000,
  maxBuffer: 1_000_000,
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (help.status !== 0) {
  process.stderr.write(`TAP option discovery failed: ${help.error?.message ?? help.stderr}\n`)
  process.exit(1)
}
const supportsEsm = /(?:^|\s)--(?:no-)?esm(?:\s|=|$)/u.test(help.stdout)
const parser = new Parser({ strict: true })
const cases = []
const occurrences = new Map()
const stableName = (value) => String(value).replace(/\s+# time=[\d.]+ms$/u, '')
function attach(stream, path) {
  stream.on('child', (child) => attach(child, [...path, stableName(child.name)]))
  stream.on('assert', (item) => {
    const name = [...path, stableName(item.name || '(unnamed)')].join('::')
    const ordinal = (occurrences.get(name) ?? 0) + 1
    occurrences.set(name, ordinal)
    cases.push({
      id: `tap::${name}::${ordinal}`,
      outcomes:
        item.skip || item.todo
          ? [{ kind: 'skipped', message: String(item.skip || item.todo), text: '' }]
          : item.ok
            ? []
            : [
                {
                  kind: 'failure',
                  message: item.name || 'TAP failure',
                  text: JSON.stringify(item.diag || {}),
                },
              ],
    })
  })
}
attach(parser, [])
let summary
parser.on('complete', (result) => {
  summary = result
})
const child = spawn(
  process.execPath,
  [
    process.argv[2],
    ...(supportsEsm ? ['--no-esm'] : []),
    '--no-coverage',
    '--reporter=tap',
    '--jobs=1',
    ...process.argv.slice(3),
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] }
)
child.stdout.pipe(parser)
child.on('error', (error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
child.on('close', (code) => {
  const complete = Boolean(
    summary && summary.count > 0 && !summary.bailout && summary.plan?.end === summary.count
  )
  process.stdout.write(
    JSON.stringify({ schema: 'tap-regression-1', complete, ok: Boolean(summary?.ok), cases }) + '\n'
  )
  process.exitCode = code === 0 && complete && summary?.ok ? 0 : 1
})
