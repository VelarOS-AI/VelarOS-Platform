// 保持 Node 自身的测试隔离和退出状态；仅用受控 reporter 输出完整用例清单。
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
const env = { ...process.env }
// 本入口始终启动独立测试进程，不能继承调用者的测试工作线程标记。
delete env.NODE_TEST_CONTEXT
const child = spawn(
  process.execPath,
  [
    ...(entry === '-' ? [] : ['--import', pathToFileURL(resolve(entry)).href]),
    '--test',
    `--test-reporter=${join(import.meta.dirname, 'node-native-reporter.mjs')}`,
    ...process.argv.slice(3),
  ],
  { stdio: ['ignore', 'inherit', 'inherit'], env }
)
child.on('error', (error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
