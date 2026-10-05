// 通过项目自身的 AVA CLI 运行；与 npm test 一样给派生命令提供本地工具路径。
import { delimiter, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = resolve(process.argv[2])
process.argv = [process.execPath, entry, '--tap', ...process.argv.slice(3)]
process.env.PATH = [resolve('node_modules/.bin'), process.env.PATH].filter(Boolean).join(delimiter)
await import(pathToFileURL(entry).href)
