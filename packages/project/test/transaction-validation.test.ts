import { describe, expect, test } from 'bun:test'

import { DEFAULT_CORE_POLICY } from '../src/core/defaults'
import { TransactionValidation } from '../src/core/transaction-validation'
import type { FileAdapter } from '../src/types/adapter'
import type { Diagnostic } from '../src/types/common'
import type { CommandProvider, ProjectProviders } from '../src/types/provider'
import type { FileSnapshot } from '../src/types/snapshot'
import type { StoredTransaction } from '../src/types/transaction'
import type { ValidationResult } from '../src/types/validation'

function snapshot(path: string, content?: string): FileSnapshot {
  return {
    path,
    absPath: `/workspace/${path}`,
    exists: true,
    isDirectory: false,
    isBinary: false,
    content,
    size: content?.length ?? 0,
    sha256: `sha:${path}`,
    revision: `rev:${path}`,
    mtimeMs: 1,
    adapterIds: [],
  }
}

function transaction(changedFiles: string[]): StoredTransaction {
  return {
    transactionId: 'tx_validation',
    status: 'prepared',
    patches: [],
    changedFiles,
    diff: '',
    changedLines: 0,
    risk: 'low',
    createdAt: 1,
    baseSnapshots: [],
  }
}

function validationResult(options: {
  diagnostics?: Diagnostic[]
  checks?: ValidationResult['checks']
} = {}): ValidationResult {
  return {
    ok: true,
    diagnostics: [...(options.diagnostics ?? [])],
    checks: [...(options.checks ?? [])],
  }
}

const policy = {
  ...DEFAULT_CORE_POLICY,
  approval: { ...DEFAULT_CORE_POLICY.approval },
  generatedFiles: [...DEFAULT_CORE_POLICY.generatedFiles],
  protectedFiles: [...DEFAULT_CORE_POLICY.protectedFiles],
  readDeny: [...DEFAULT_CORE_POLICY.readDeny],
  writeDeny: [...DEFAULT_CORE_POLICY.writeDeny],
}
const command: CommandProvider = {
  run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
}
const providers: ProjectProviders & { command: CommandProvider } = { command }

describe('TransactionValidation', () => {
  test('validates transaction changed files against staged snapshots and exposes the overlay reader', async () => {
    const tx = transaction(['staged.ts'])
    const stagedSnapshots: Array<[string, string]> = []
    const workspaceSnapshots: string[] = []
    const adapterInputs: Array<{ content?: string; changedContent?: string }> = []
    let registeredRead: string | undefined

    const adapter: FileAdapter = {
      id: 'staged-adapter',
      kind: 'code',
      capabilities: ['validate'],
      async validate(input) {
        adapterInputs.push({
          content: input.snapshot.content,
          changedContent: input.changedContent,
        })
        return validationResult({ checks: [{ id: 'adapter', ok: true }] })
      },
    }
    const validation = new TransactionValidation({
      root: '/workspace',
      policy,
      providers,
      getTransaction: (transactionId) => transactionId === tx.transactionId ? tx : undefined,
      buildOverlay: async () => ({
        contentByPath: new Map([['staged.ts', 'future content']]),
        diagnostics: [],
      }),
      createReader: (contentByPath) => async (path) => contentByPath.get(path) ?? undefined,
      validateRegistered: async (_input, context) => {
        expect(context.root).toBe('/workspace')
        expect(context.policy).toEqual(policy)
        expect(context.policy).not.toBe(policy)
        expect(context.providers).not.toBe(providers)
        expect(context.providers).toEqual({ command: expect.any(Object) })
        expect(Object.isFrozen(context)).toBe(true)
        expect(Object.isFrozen(context.policy)).toBe(true)
        expect(Object.isFrozen(context.policy.approval)).toBe(true)
        expect(Object.isFrozen(context.policy.protectedFiles)).toBe(true)
        expect(Object.isFrozen(context.providers)).toBe(true)
        const transactionView = context.getTransaction(tx.transactionId)
        expect(transactionView).toEqual({
          transactionId: tx.transactionId,
          changedFiles: tx.changedFiles,
          changedLines: tx.changedLines,
        })
        expect(transactionView).not.toBe(tx)
        expect(Object.isFrozen(transactionView)).toBe(true)
        expect(Object.isFrozen(transactionView?.changedFiles)).toBe(true)
        registeredRead = await context.readFile('staged.ts')
        return validationResult({ checks: [{ id: 'registered', ok: true }] })
      },
      createAdapters: async () => [adapter],
      snapshotStaged: async (path, content) => {
        stagedSnapshots.push([path, content])
        return snapshot(path, content)
      },
      snapshotWorkspace: async (path) => {
        workspaceSnapshots.push(path)
        return snapshot(path, 'workspace content')
      },
    })

    const result = await validation.run({ transactionId: tx.transactionId })

    expect(registeredRead).toBe('future content')
    expect(stagedSnapshots).toEqual([['staged.ts', 'future content']])
    expect(workspaceSnapshots).toEqual([])
    expect(adapterInputs).toEqual([{ content: 'future content', changedContent: 'future content' }])
    expect(result).toEqual({
      ok: true,
      diagnostics: [],
      checks: [
        { id: 'registered', ok: true },
        { id: 'adapter', ok: true },
      ],
    })
  })

  test('exposes frozen policy, provider, and transaction views without mutating dependencies', async () => {
    const localPolicy = {
      ...policy,
      approval: { ...policy.approval },
      generatedFiles: [...policy.generatedFiles],
      protectedFiles: ['protected.ts'],
      readDeny: [...policy.readDeny],
      writeDeny: [...policy.writeDeny],
    }
    const commandWithState = {
      calls: 0,
      run() {
        this.calls += 1
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const codeIntelligence = {
      available: true,
      isProjectEnabled() {
        return this.available
      },
      listSymbols: async () => [],
      getDefinition: async () => [],
    }
    const localProviders = {
      command: commandWithState,
      codeIntelligence,
    }
    const originalRun = commandWithState.run
    const tx = transaction(['protected.ts'])
    const validation = new TransactionValidation({
      root: '/workspace',
      policy: localPolicy,
      providers: localProviders,
      getTransaction: () => tx,
      buildOverlay: async () => ({ contentByPath: new Map(), diagnostics: [] }),
      createReader: () => async () => undefined,
      validateRegistered: async (_input, context) => {
        const transactionView = context.getTransaction(tx.transactionId)!
        expect(Reflect.set(context, 'root', '/other')).toBe(false)
        expect(Reflect.set(context.policy, 'maxChangedLinesPerTransaction', 0)).toBe(false)
        expect(Reflect.set(context.policy.protectedFiles, '0', 'changed.ts')).toBe(false)
        expect(Reflect.set(context.providers, 'command', {})).toBe(false)
        expect(context.providers.codeIntelligence?.available).toBe(true)
        expect(context.providers.codeIntelligence?.isProjectEnabled('/workspace')).toBe(true)
        expect(Reflect.set(context.providers.codeIntelligence!, 'available', false)).toBe(false)
        await context.providers.command.run({ command: 'probe' })
        expect(Reflect.set(context.providers.command, 'run', async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'mutated',
        }))).toBe(false)
        expect(Reflect.set(transactionView, 'changedLines', 999)).toBe(false)
        expect(Reflect.set(transactionView.changedFiles, '0', 'changed.ts')).toBe(false)
        return validationResult()
      },
      createAdapters: async () => [],
      snapshotStaged: async (path, content) => snapshot(path, content),
      snapshotWorkspace: async (path) => snapshot(path, 'workspace'),
    })

    await validation.run({ transactionId: tx.transactionId })

    expect(localPolicy.maxChangedLinesPerTransaction).toBe(policy.maxChangedLinesPerTransaction)
    expect(localPolicy.protectedFiles).toEqual(['protected.ts'])
    expect(commandWithState.run).toBe(originalRun)
    expect(commandWithState.calls).toBe(1)
    expect(codeIntelligence.available).toBe(true)
    expect(tx.changedFiles).toEqual(['protected.ts'])
    expect(tx.changedLines).toBe(0)
  })

  test('skips deleted paths and reads explicit untouched paths from the workspace', async () => {
    const workspaceSnapshots: string[] = []
    const adapterPaths: string[] = []
    const validation = new TransactionValidation({
      root: '/workspace',
      policy,
      providers,
      getTransaction: () => undefined,
      buildOverlay: async () => ({
        contentByPath: new Map([['deleted.ts', null]]),
        diagnostics: [],
      }),
      createReader: () => async () => undefined,
      validateRegistered: async () => validationResult(),
      createAdapters: async (value) => {
        adapterPaths.push(value.path)
        return [{
          id: 'no-validation',
          kind: 'text',
          capabilities: ['read'],
        }]
      },
      snapshotStaged: async (path, content) => snapshot(path, content),
      snapshotWorkspace: async (path) => {
        workspaceSnapshots.push(path)
        return snapshot(path, 'workspace')
      },
    })

    const result = await validation.run({ paths: ['deleted.ts', 'workspace.ts'] })

    expect(workspaceSnapshots).toEqual(['workspace.ts'])
    expect(adapterPaths).toEqual(['workspace.ts'])
    expect(result.ok).toBe(true)
  })

  test('merges replay and adapter diagnostics and recalculates the final ok value', async () => {
    const replayDiagnostic: Diagnostic = {
      severity: 'error',
      path: 'broken.ts',
      source: 'core.transaction-replay',
      message: 'patch chain is broken',
    }
    const adapterDiagnostic: Diagnostic = {
      severity: 'warning',
      path: 'broken.ts',
      source: 'adapter',
      message: 'adapter warning',
    }
    const validation = new TransactionValidation({
      root: '/workspace',
      policy,
      providers,
      getTransaction: () => transaction(['broken.ts']),
      buildOverlay: async () => ({
        contentByPath: new Map([['broken.ts', 'future']]),
        diagnostics: [replayDiagnostic],
      }),
      createReader: () => async () => 'future',
      validateRegistered: async () => ({
        ...validationResult({ checks: [{ id: 'registered', ok: true }] }),
        toolRequirements: [{ kind: 'missing-command', command: 'tsc', reason: 'typecheck' }],
      }),
      createAdapters: async () => [{
        id: 'warning-adapter',
        kind: 'code',
        capabilities: ['validate'],
        validate: async () => validationResult({
          diagnostics: [adapterDiagnostic],
          checks: [{ id: 'adapter', ok: true }],
        }),
      }],
      snapshotStaged: async (path, content) => snapshot(path, content),
      snapshotWorkspace: async (path) => snapshot(path, 'workspace'),
    })

    const result = await validation.run({ transactionId: 'tx_validation' })

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([replayDiagnostic, adapterDiagnostic])
    expect(result.checks).toEqual([
      { id: 'registered', ok: true },
      {
        id: 'core.transaction-replay',
        ok: false,
        diagnostics: [replayDiagnostic],
      },
      { id: 'adapter', ok: true },
    ])
    expect(result.toolRequirements).toEqual([
      { kind: 'missing-command', command: 'tsc', reason: 'typecheck' },
    ])
  })

  test('keeps empty staged content and invokes adapters serially with the complete input', async () => {
    const calls: string[] = []
    const stagedSnapshots: Array<[string, string]> = []
    const workspaceSnapshots: string[] = []
    const adapter = (id: string): FileAdapter => ({
      id,
      kind: 'code',
      capabilities: ['validate'],
      async validate(input) {
        calls.push(id)
        expect(input.snapshot.content).toBe('')
        expect(input.transactionId).toBe('tx_validation')
        expect(input.changedContent).toBe('')
        return {
          ...validationResult({ checks: [{ id, ok: true }] }),
          toolRequirements: [{ kind: 'missing-command', command: id }],
        }
      },
    })
    const validation = new TransactionValidation({
      root: '/workspace',
      policy,
      providers,
      getTransaction: () => transaction(['empty.ts']),
      buildOverlay: async () => ({
        contentByPath: new Map([['empty.ts', '']]),
        diagnostics: [],
      }),
      createReader: () => async () => '',
      validateRegistered: async () => validationResult(),
      createAdapters: async () => [adapter('first'), adapter('second')],
      snapshotStaged: async (path, content) => {
        stagedSnapshots.push([path, content])
        return snapshot(path, content)
      },
      snapshotWorkspace: async (path) => {
        workspaceSnapshots.push(path)
        return snapshot(path, 'workspace')
      },
    })

    const result = await validation.run({ transactionId: 'tx_validation' })

    expect(stagedSnapshots).toEqual([['empty.ts', '']])
    expect(workspaceSnapshots).toEqual([])
    expect(calls).toEqual(['first', 'second'])
    expect(result.checks).toEqual([
      { id: 'first', ok: true },
      { id: 'second', ok: true },
    ])
    // 保持抽取前语义：只有 registered validators 汇总 toolRequirements。
    expect(result.toolRequirements).toBeUndefined()
  })

  test('propagates dependency failures without wrapping them', async () => {
    for (const failingStage of ['overlay', 'registered', 'snapshot', 'adapter'] as const) {
      const failure = new Error(`failed:${failingStage}`)
      const validation = new TransactionValidation({
        root: '/workspace',
        policy,
        providers,
        getTransaction: () => undefined,
        buildOverlay: async () => {
          if (failingStage === 'overlay') throw failure
          return { contentByPath: new Map(), diagnostics: [] }
        },
        createReader: () => async () => undefined,
        validateRegistered: async () => {
          if (failingStage === 'registered') throw failure
          return validationResult()
        },
        createAdapters: async () => [{
          id: 'throwing-adapter',
          kind: 'code',
          capabilities: ['validate'],
          validate: async () => {
            if (failingStage === 'adapter') throw failure
            return validationResult()
          },
        }],
        snapshotStaged: async (path, content) => snapshot(path, content),
        snapshotWorkspace: async (path) => {
          if (failingStage === 'snapshot') throw failure
          return snapshot(path, 'workspace')
        },
      })

      try {
        await validation.run({ paths: ['file.ts'] })
        throw new Error(`expected ${failingStage} to fail`)
      } catch (error) {
        expect(error).toBe(failure)
      }
    }
  })

  test('lets adapter errors turn an otherwise successful registered result into a failure', async () => {
    const validation = new TransactionValidation({
      root: '/workspace',
      policy,
      providers,
      getTransaction: () => undefined,
      buildOverlay: async () => ({ contentByPath: new Map(), diagnostics: [] }),
      createReader: () => async () => undefined,
      validateRegistered: async () => validationResult(),
      createAdapters: async () => [{
        id: 'error-adapter',
        kind: 'code',
        capabilities: ['validate'],
        validate: async () => validationResult({
          diagnostics: [{ severity: 'error', path: 'file.ts', message: 'invalid' }],
          checks: [{ id: 'adapter', ok: false }],
        }),
      }],
      snapshotStaged: async (path, content) => snapshot(path, content),
      snapshotWorkspace: async (path) => snapshot(path, 'workspace'),
    })

    const result = await validation.run({ paths: ['file.ts'] })

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      { severity: 'error', path: 'file.ts', message: 'invalid' },
    ])
  })
})
