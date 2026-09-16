// 可移植数据文件不许 import，所以 `@velaros-ai/agent` 的 types/agent.ts 里放了
// `@velaros-ai/core/error` 三个错误类型的同名同形副本。这条测试守住两边一直一模一样：
// 谁改了 core 的形状而没同步副本，这里立刻红。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'
import ts from 'typescript'

const RepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CoreErrorPath = resolve(RepoRoot, 'packages/core/src/error.ts')
const AgentPortablePath = resolve(RepoRoot, 'packages/agent/src/types/agent.ts')
const MirroredNames = ['ErrorCode', 'ErrorContext', 'SerializedError'] as const

/** 取一个文件里指定顶层类型声明的规范化文本（去注释、去修饰符、压空白）。 */
function declarationShapes(path: string, names: readonly string[]): Map<string, string> {
  const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const shapes = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue
    const name = statement.name.text
    if (!names.includes(name)) continue
    const text = sourceFile.text.slice(statement.name.getStart(sourceFile), statement.getEnd())
    shapes.set(name, text.replace(/\/\/[^\n]*/gu, '').replace(/\s+/gu, ' ').trim())
  }
  return shapes
}

describe('agent 可移植文件里的 core 错误类型副本', () => {
  it('与 @velaros-ai/core/error 同名同形', () => {
    const core = declarationShapes(CoreErrorPath, MirroredNames)
    const agent = declarationShapes(AgentPortablePath, MirroredNames)
    for (const name of MirroredNames) {
      expect(core.get(name), `packages/core/src/error.ts 里找不到 ${name}`).toBeDefined()
      expect(agent.get(name), `packages/agent/src/types/agent.ts 里找不到 ${name} 的本地副本`).toBeDefined()
      expect(agent.get(name)).toBe(core.get(name) as string)
    }
  })
})
