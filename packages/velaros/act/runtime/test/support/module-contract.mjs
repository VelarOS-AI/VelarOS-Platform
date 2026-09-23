import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import ts from 'typescript'

import { createOperationRuntime } from '@velaros-ai/kernel'
import { codeProgramChecker, scriptPackageCompiler } from '@velaros-ai/script'

// 装配时唯一会读取的宿主信息是搜索档位；调用处理器不在这里执行。
export const definitionHost = { agentProfiles: () => [], search: { profiles: () => ['example'] } }

export async function verifyModule(factory, templateUrl) {
  const definition = factory.create(definitionHost)
  const runtime = createOperationRuntime({ modules: [definition], journal: {} })
  try {
    const description = runtime.describe(definition.binding.moduleId)
    assert.equal(description.template, readFileSync(templateUrl, 'utf8').trim())
    const syntax = ts.createSourceFile(
      'template.js',
      description.template,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    const isSystem = description.template.includes("from 'velaros:system'")
    const names = isSystem
      ? syntax.statements
          .filter(ts.isVariableStatement)
          .flatMap((node) =>
            node.declarationList.declarations
              .filter((item) => ts.isObjectBindingPattern(item.name))
              .flatMap((item) =>
                item.name.elements.map((element) => element.propertyName?.text ?? element.name.text)
              )
          )
      : syntax.statements
          .filter(
            (node) =>
              ts.isImportDeclaration(node) &&
              node.moduleSpecifier.text === definition.binding.moduleId
          )
          .flatMap((node) =>
            [...node.importClause.namedBindings.elements].map(
              (item) => item.propertyName?.text ?? item.name.text
            )
          )
    assert.deepEqual(
      names.sort(),
      Object.keys(description.operations).sort(),
      '模板必须覆盖真实模块的每个操作'
    )
    const modules = [
      { namespace: definition.binding.moduleId, declarations: description.declarations },
    ]
    const granted = isSystem
      ? scriptPackageCompiler.compile(
          [
            {
              specifier: 'velaros:system',
              exports: {
                [definition.binding.moduleId === 'velaros:system-goal'
                  ? 'goal'
                  : definition.binding.moduleId.startsWith('velaros:system-memory')
                    ? 'memory'
                    : definition.binding.moduleId.startsWith('velaros:system-store')
                      ? 'store'
                      : definition.binding.moduleId.split(':')[1]]: definition.binding.moduleId,
              },
            },
          ],
          modules
        ).granted
      : scriptPackageCompiler.compile([], modules).granted
    const checked = codeProgramChecker.check({ source: description.template, granted })
    assert.equal(checked.ok, true, JSON.stringify(checked))
  } finally {
    await runtime.dispose()
  }
}
