// `velar:knowledge` 只是工具那一层，知识库引擎是 `@velaros-ai/knowledge`：velar 单元不依赖引擎包，端口上的形状各写各的。
// 这条测试守住两边接得上——引擎的领域门面结构上满足端口的三个知识方法（编译探针文件、断言零诊断），
// 两边的来源类型一模一样；谁改了一边而没同步另一边，这里立刻红。
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'
import ts from 'typescript'

import { KnowledgeSourceKinds as EngineSourceKinds } from '../../packages/knowledge/src/contract/constants'
import { KnowledgeSourceKinds as SurfaceSourceKinds } from '../../packages/velar/knowledge/contract/constants'

const Here = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(Here, '../..')
const ProbePath = resolve(Here, 'fixtures/knowledge-port-conformance.probe.ts')
const GlobalsPath = resolve(RepoRoot, 'types/velaros-globals.d.ts')

describe('velar:knowledge 与知识库引擎的接缝', () => {
  it('引擎的领域门面结构上满足空间端口的三个知识方法', () => {
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
  }, 60_000)

  it('两边的来源类型一模一样', () => {
    expect([...SurfaceSourceKinds]).toEqual([...EngineSourceKinds])
  })
})
