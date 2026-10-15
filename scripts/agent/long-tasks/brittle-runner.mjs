// 使用项目自己的 Brittle Node 入口与原生 TAP 输出，不注入其他框架的 CLI 开关。
import { delimiter, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = resolve(process.argv[2])
process.argv = [process.execPath, entry, ...process.argv.slice(3)]
process.env.PATH = [resolve('node_modules/.bin'), process.env.PATH].filter(Boolean).join(delimiter)
await import(pathToFileURL(entry).href)
