// `@velaros-ai/agent` 的可移植数据文件按标准一个 import 都不许有，所以工具协议类型
// （ToolPermission、ToolCapabilitySchema、ToolExposurePolicy…）在 `@velaros-ai/tool-contract`
// 的可移植文件里是同形副本。这条测试编译探针文件，守住两边一直互相可赋值：谁改了一边的形状
// 而没同步另一边，这里立刻红。
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'
import ts from 'typescript'

const Here = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(Here, '../..')
const ProbePath = resolve(Here, 'fixtures/tool-contract-protocol-mirror.probe.ts')
const GlobalsPath = resolve(RepoRoot, 'types/velaros-globals.d.ts')

describe('工具协议类型的同形副本', () => {
  it('tool-contract 与 agent 两边互相可赋值', () => {
    const program = ts.createProgram([GlobalsPath, ProbePath], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['lib.esnext.d.ts'],
    })
    const diagnostics = [
      ...program.getSemanticDiagnostics(),
      ...program.getSyntacticDiagnostics(),
    ].map((diagnostic) => {
      const file = diagnostic.file ? relative(RepoRoot, diagnostic.file.fileName) : '(无文件)'
      return `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
    })
    expect(diagnostics).toEqual([])
  })
})
