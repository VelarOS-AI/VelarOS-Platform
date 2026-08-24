import type { ProjectToolContext } from '@velaros-ai/project/agent'

import type { DevelopmentToolApi } from '../Development.tool'
import {
  type DevelopmentIndexQuery,
  type DevelopmentLanguageQuery,
  type DevelopmentQuery,
  isDevelopmentLanguageQuery,
} from '../query-schema'

import { executeDevelopmentOperation } from './DevelopmentResult'
import { developmentLanguageOperations } from './LanguageOperations'

interface DevelopmentCodeIndexApi {
  isAvailable(): boolean
  query(input: DevelopmentIndexQuery, context: ProjectToolContext): Promise<unknown>
}

async function executeDevelopmentLanguageQuery(
  input: DevelopmentLanguageQuery,
  context: ProjectToolContext
): Promise<unknown> {
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

function createDevelopmentToolApi(codeIndex: DevelopmentCodeIndexApi): DevelopmentToolApi {
  return Object.freeze({
    isCodeQueryAvailable: () => codeIndex.isAvailable(),
    queryCode: (input: DevelopmentQuery, context: ProjectToolContext) =>
      isDevelopmentLanguageQuery(input)
        ? executeDevelopmentLanguageQuery(input, context)
        : codeIndex.query(input, context),
  })
}

export { createDevelopmentToolApi, executeDevelopmentLanguageQuery }
export type { DevelopmentCodeIndexApi, DevelopmentIndexQuery }
export * from './ExternalLanguageService'
