// 使用项目自身的 Vitest API；诊断走 stderr，stdout 只输出一次完整任务与错误记录。
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serializeVitest, vitestReport } from './vitest-report.mjs'

const entry = resolve(process.argv[2])
const paths = process.argv.slice(3)
process.argv = process.argv.slice(0, 2)
const { startVitest } = await import(pathToFileURL(entry).href)
let finished = 0
const context = await startVitest(
  'test',
  paths,
  {
    watch: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporters: [
      {
        onFinished() {
          finished++
        },
        onUserConsoleLog(log) {
          process.stderr.write(log.content)
        },
      },
    ],
  },
  undefined,
  { stdout: process.stderr, stderr: process.stderr }
)
assert(context, 'Vitest did not create a context')
await context.close()
const stdout = JSON.stringify(
  serializeVitest(context.state.getFiles(), context.state.getUnhandledErrors(), {
    workspace: process.cwd(),
    finished,
    cancelled: context.isCancelling,
  })
)
console.log(stdout)
try {
  const { cases, summary } = vitestReport({ exitCode: process.exitCode ?? 0, stdout })
  if (!cases.length || summary.failed || summary.errors) process.exitCode ||= 1
} catch (error) {
  console.error(error.message)
  process.exitCode ||= 1
}
