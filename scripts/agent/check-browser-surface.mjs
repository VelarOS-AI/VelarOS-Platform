#!/usr/bin/env node
// 用途：真实打包 Agent 的 browser-safe 公共面，阻止 Node 内建模块通过转导出泄漏给客户端。
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

import { build } from 'vite'

const RepositoryRoot = resolve(import.meta.dirname, '../..')
const BrowserEntries = {
  chat: resolve(RepositoryRoot, 'packages/agent/src/chat/index.ts'),
  'chat-stream': resolve(RepositoryRoot, 'packages/agent/src/chat/stream/index.ts'),
  protocol: resolve(RepositoryRoot, 'packages/agent/src/protocol/index.ts'),
}
const NodeBuiltinSpecifiers = new Set(
  builtinModules.flatMap((specifier) => {
    const bare = specifier.replace(/^node:/u, '')
    return [bare, `node:${bare}`]
  })
)

function isNodeBuiltin(specifier) {
  const root = specifier.replace(/^node:/u, '').split('/')[0]
  return NodeBuiltinSpecifiers.has(specifier) || NodeBuiltinSpecifiers.has(root)
}

function rejectNodeBuiltins() {
  return {
    name: 'velaros-agent-browser-builtins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!isNodeBuiltin(source)) return null
      this.error(
        `Agent browser surface imports Node builtin ${source}` +
          (importer ? ` from ${importer}` : '')
      )
    },
  }
}

await build({
  configFile: false,
  root: RepositoryRoot,
  logLevel: 'silent',
  plugins: [rejectNodeBuiltins()],
  build: {
    target: 'es2022',
    write: false,
    minify: false,
    lib: {
      entry: BrowserEntries,
      formats: ['es'],
    },
    rollupOptions: {
      treeshake: false,
    },
  },
})

process.stdout.write(
  `OK: Agent browser surface bundled without Node builtins (${Object.keys(BrowserEntries).join(', ')}).\n`
)
