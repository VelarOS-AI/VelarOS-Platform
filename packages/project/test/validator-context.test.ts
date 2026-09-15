import { describe, expect, test } from 'bun:test'

import { ProjectPolicyDefaults } from '../src/contract/constants'
import type { ProjectProviders, ProjectValidator } from '../src/contract/requires.js'
import { PostconditionValidator } from '../src/impl/plugins/PostconditionValidator'
import { ScopeValidator } from '../src/impl/plugins/ScopeValidator'
import { TypeScriptSyntaxValidator } from '../src/impl/plugins/TypeScriptSyntaxValidator'
import { ValidatorRegistry } from '../src/impl/registries/ValidatorRegistry'
import type { ProjectValidationContext, ProjectValidationTransaction } from '../src/types/validation'
import { createCorePolicy } from '../src/utils/kernel/policy'

function transaction(overrides: Partial<ProjectValidationTransaction> = {}): ProjectValidationTransaction {
  return {
    transactionId: 'tx_context',
    changedFiles: ['source.ts'],
    changedLines: 1,
    ...overrides,
  }
}

function context(options: {
  transaction?: ProjectValidationTransaction
  providers?: ProjectProviders
  protectedFiles?: readonly string[]
  readFile?: (path: string) => Promise<string | undefined>
} = {}): ProjectValidationContext {
  const command = options.providers?.command ?? {
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  }
  return {
    root: '/workspace',
    policy: createCorePolicy({ protectedFiles: [...(options.protectedFiles ?? ProjectPolicyDefaults.protectedFiles)] }),
    providers: { ...options.providers, command },
    getTransaction: (transactionId) =>
      transactionId === options.transaction?.transactionId ? options.transaction : undefined,
    readFile: options.readFile ?? (async () => undefined),
  }
}

describe('ProjectValidationContext', () => {
  test('ValidatorRegistry passes the exact typed context and aggregates results', async () => {
    const registry = new ValidatorRegistry()
    const validationContext = context()
    let receivedContext: ProjectValidationContext | undefined
    const validator: ProjectValidator = {
      id: 'custom.context',
      canValidate: () => true,
      validate(_input, currentContext) {
        receivedContext = currentContext
        return {
          ok: true,
          diagnostics: [],
          checks: [],
          toolRequirements: [{ kind: 'missing-command', command: 'custom-tool' }],
        }
      },
    }
    registry.register(validator)

    const result = await registry.validate({}, validationContext)

    expect(receivedContext).toBe(validationContext)
    expect(result).toEqual({
      ok: true,
      diagnostics: [],
      checks: [{ id: 'custom.context', ok: true, diagnostics: [] }],
      toolRequirements: [{ kind: 'missing-command', command: 'custom-tool' }],
    })
  })

  test('built-in validators consume the minimal transaction projection and overlay reader', async () => {
    const tx = transaction({
      changedFiles: ['protected.ts'],
      changedLines: ProjectPolicyDefaults.maxChangedLinesPerTransaction + 1,
    })
    const validationContext = context({
      transaction: tx,
      protectedFiles: ['protected.ts'],
      readFile: async () => 'future content',
    })

    const scope = await new ScopeValidator().validate(
      { transactionId: tx.transactionId },
      validationContext,
    )
    const postcondition = await new PostconditionValidator().validate(
      {
        transactionId: tx.transactionId,
        postconditions: [{ type: 'must_contain', value: 'future content' }],
      },
      validationContext,
    )

    expect(scope.ok).toBe(false)
    expect(scope.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining('变更行数'),
      expect.stringContaining('受保护文件'),
    ])
    expect(postcondition.ok).toBe(true)
  })

  test('TypeScript validator derives paths from the shared transaction view', async () => {
    const tx = transaction({ changedFiles: ['valid.ts', 'ignored.md'] })
    const reads: string[] = []
    const validationContext = context({
      transaction: tx,
      readFile: async (path) => {
        reads.push(path)
        return 'export const value = 1\n'
      },
    })

    const result = await new TypeScriptSyntaxValidator().validate(
      { transactionId: tx.transactionId },
      validationContext,
    )

    expect(result.ok).toBe(true)
    expect(reads).toEqual(['valid.ts'])
    expect(result.checks.map((check) => check.id)).toEqual(['typescript.syntax:valid.ts'])
  })

  test('Registry selects the TypeScript validator through its id and every declared check alias', async () => {
    for (const check of [
      'velaros.typescript.syntax-validator',
      'typescript.syntax',
      'parse',
      'syntax',
    ]) {
      const reads: string[] = []
      const registry = new ValidatorRegistry()
      registry.register(new TypeScriptSyntaxValidator())
      const result = await registry.validate(
        { paths: ['valid.ts'], checks: [check] },
        context({
          readFile: async (path) => {
            reads.push(path)
            return 'export const value = 1\n'
          },
        }),
      )

      expect(reads).toEqual(['valid.ts'])
      expect(result.checks).toEqual([{
        id: 'velaros.typescript.syntax-validator',
        metadata: { evidenceKey: expect.any(String), reused: false },
        ok: true,
        diagnostics: [],
      }])
    }

    const emptyChecksReads: string[] = []
    const emptyChecksRegistry = new ValidatorRegistry()
    emptyChecksRegistry.register(new TypeScriptSyntaxValidator())
    const emptyChecksResult = await emptyChecksRegistry.validate(
      { paths: ['valid.ts'], checks: [] },
      context({
        readFile: async (path) => {
          emptyChecksReads.push(path)
          return 'export const value = 1\n'
        },
      }),
    )
    expect(emptyChecksReads).toEqual(['valid.ts'])
    expect(emptyChecksResult.checks).toHaveLength(1)

    const registry = new ValidatorRegistry()
    registry.register(new TypeScriptSyntaxValidator())
    const skipped = await registry.validate(
      { paths: ['valid.ts'], checks: ['unrelated'] },
      context(),
    )
    expect(skipped.checks).toEqual([])
  })
})
