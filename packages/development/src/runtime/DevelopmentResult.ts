import { isPlainObject } from '@velaros-ai/core'

import type { LanguageToolContext } from './LanguageService'

function withCodeQuerySource(source: 'codegraph' | 'language-service', result: unknown) {
  if (isPlainObject(result)) return { source, ...(result as Record<string, unknown>) }

  return { source, result }
}

async function executeDevelopmentOperation<TInput extends Record<string, unknown>>(
  operation: (input: TInput, ctx: LanguageToolContext) => Promise<unknown>,
  args: TInput,
  ctx: LanguageToolContext
) {
  return withCodeQuerySource('language-service', await operation(args, ctx))
}

export { executeDevelopmentOperation, withCodeQuerySource }
