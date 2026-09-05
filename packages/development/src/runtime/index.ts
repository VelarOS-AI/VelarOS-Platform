import { AppError } from '@velaros-ai/core/error'
import type { ProjectToolContext } from '@velaros-ai/project/agent'
import {
  isProjectCodeLanguageQuery,
  type ProjectCodeIndexQuery,
  type ProjectCodeLanguageQuery,
  type ProjectCodeQuery,
} from '@velaros-ai/project/contracts'

import { executeDevelopmentOperation, withCodeQuerySource } from './DevelopmentResult'
import { developmentLanguageOperations } from './LanguageOperations'
import type { LanguageToolContext } from './LanguageService'

interface ProjectCodeIndexApi {
  isAvailable(): boolean
  query(input: ProjectCodeIndexQuery, context: ProjectToolContext): Promise<unknown>
}

async function executeProjectCodeLanguageQuery(
  input: ProjectCodeLanguageQuery,
  context: LanguageToolContext
): Promise<unknown> {
  context.abortSignal.throwIfAborted()
  switch (input.action) {
    case 'find_symbols': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(developmentLanguageOperations.find_symbols, args, context)
    }
    case 'list_exports': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(developmentLanguageOperations.list_exports, args, context)
    }
    case 'find_imports': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(developmentLanguageOperations.find_imports, args, context)
    }
    case 'find_importers': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(developmentLanguageOperations.find_importers, args, context)
    }
    case 'find_references': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(developmentLanguageOperations.find_references, args, context)
    }
    case 'language_diagnostics': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(
        developmentLanguageOperations.language_diagnostics,
        args,
        context
      )
    }
    case 'analyze_symbol_impact': {
      const { action: _action, ...args } = input
      return executeDevelopmentOperation(
        developmentLanguageOperations.analyze_symbol_impact,
        args,
        context
      )
    }
  }
}

function createProjectCodeQuery(
  codeIndex: ProjectCodeIndexApi
): (input: ProjectCodeQuery, context: ProjectToolContext) => Promise<unknown> {
  return async (input, context) => {
    if (isProjectCodeLanguageQuery(input)) return executeProjectCodeLanguageQuery(input, context)
    if (!codeIndex.isAvailable()) {
      throw new AppError(
        'UNAVAILABLE',
        '此代码图谱查询需要安装并启用 CodeGraph；内置符号、引用和诊断 action 仍可使用。'
      )
    }
    return codeIndex.query(input, context).then((result) => withCodeQuerySource('codegraph', result))
  }
}

export { createProjectCodeQuery, executeProjectCodeLanguageQuery }
export type { ProjectCodeIndexApi, ProjectCodeIndexQuery }
export * from './ExternalLanguageService'
export type { LanguageReadPort, LanguageToolContext } from './LanguageService'
