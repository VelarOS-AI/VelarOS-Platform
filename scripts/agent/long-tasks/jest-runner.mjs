// 使用项目自带的 Jest API；测试进程的 argv 保持普通 Node 脚本形状。
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const entry = resolve(process.argv[2])
const paths = process.argv.slice(3)
process.argv = process.argv.slice(0, 2)
const { runCLI } = createRequire(import.meta.url)(entry)
const { results } = await runCLI({ runInBand: true, json: true, _: paths, $0: 'jest' }, [
  process.cwd(),
])
process.exitCode = results.success ? 0 : 1
