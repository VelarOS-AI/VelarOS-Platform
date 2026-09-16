#!/usr/bin/env node
// 命令行可执行入口：把 argv 交给 dist/exports 里的 agentLabCli，再把它给回来的两段文字写出去。
// 动态 import 只许写在这里：`run --runtime <模块>` 要按路径加载一份套件运行时，src 下一律静态 import。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { agentLabCli } from '../dist/exports/index.js'

const loadRuntime = {
  load: async (modulePath) => {
    const imported = await import(pathToFileURL(resolve(modulePath)).href)
    const factory = imported.createAgentLabRuntime ?? imported.default
    if (typeof factory !== 'function') {
      throw new Error('运行时模块必须导出 createAgentLabRuntime 或一个默认工厂函数')
    }
    return factory()
  },
}

const result = await agentLabCli.run(process.argv.slice(2), { loadRuntime })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exitCode = result.exitCode
