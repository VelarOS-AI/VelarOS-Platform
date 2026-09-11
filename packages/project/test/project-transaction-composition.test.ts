import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createProjectKernel,
  type EditIntent,
  type ProjectKernel,
  type ProjectPlugin,
  typescriptPlugin,
} from '../src/index'
import {
  FileProjectTransactionStateStore,
  type ProjectTransactionPendingOperation,
} from '../src/transaction-state'
import type { Diagnostic } from '../src/types/common'
import { unifiedDiff } from '../src/utils/diff'

type KernelFactory = (root: string, plugins?: ProjectPlugin[]) => Promise<ProjectKernel>

// Workbench 只装 corePlugin；Desktop 额外装 TypeScript 插件。两条装配路径的组合语义必须一致。
const kernelVariants: Array<{ name: string; create: KernelFactory }> = [
  {
    name: 'core kernel',
    create: (root, plugins = []) => createProjectKernel({ root, plugins }),
  },
  {
    name: 'kernel with TypeScript plugin',
    create: (root, plugins = []) => createProjectKernel({ root, plugins: [typescriptPlugin(), ...plugins] }),
  },
]

async function withRoot(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-project-composition-'))
  try {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, relative)), { recursive: true })
      await writeFile(join(root, relative), content)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function replace(path: string, oldText: string, newText: string): EditIntent {
  return { operation: { type: 'replace_text', path, oldText, newText } }
}

const Greek = 'alpha\nbeta\ngamma\n'

function capturingValidator(seen: Map<string, string | undefined>): ProjectPlugin {
  return {
    name: 'test/capturing-validator',
    version: '0.0.0',
    setup(ctx) {
      ctx.registerValidator({
        id: 'test.capture',
        canValidate: () => true,
        async validate(input, context) {
          const tx = input.transactionId ? context.getTransaction(input.transactionId) : undefined
          for (const path of tx?.changedFiles ?? []) seen.set(path, await context.readFile(path))
          return { ok: true, diagnostics: [], checks: [{ id: 'test.capture', ok: true }] }
        },
      })
    },
  }
}

function failingValidator(diagnostics: Diagnostic[]): ProjectPlugin {
  return {
    name: 'test/failing-validator',
    version: '0.0.0',
    setup(ctx) {
      ctx.registerValidator({
        id: 'test.failing',
        canValidate: () => true,
        validate: () => ({ ok: false, diagnostics, checks: [{ id: 'test.failing', ok: false, diagnostics }] }),
      })
    },
  }
}

for (const variant of kernelVariants) {
  describe(`same-file transaction composition (${variant.name})`, () => {
    test('keeps every same-file replace_text of one transaction', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA'), replace('greek.txt', 'gamma', 'GAMMA')],
        })

        expect(transaction.patches[1]?.oldContent).toBe(transaction.patches[0]?.newContent)
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n')
      })
    })

    test('lets a later operation anchor on text inserted by an earlier one', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            {
              operation: {
                type: 'insert_text_at_anchor',
                path: 'greek.txt',
                anchorText: 'alpha\n',
                position: 'after',
                text: 'inserted\n',
              },
            },
            replace('greek.txt', 'inserted', 'INSERTED'),
          ],
        })

        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('alpha\nINSERTED\nbeta\ngamma\n')
      })
    })

    test('composes an insert and a replace on the same file', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            {
              operation: {
                type: 'insert_text_at_anchor',
                path: 'greek.txt',
                anchorText: 'gamma\n',
                position: 'before',
                text: 'between\n',
              },
            },
            replace('greek.txt', 'alpha', 'ALPHA'),
          ],
        })

        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA\nbeta\nbetween\ngamma\n')
      })
    })

    test('appends to a file created earlier in the same transaction and rolls both back', async () => {
      await withRoot({}, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            { operation: { type: 'create_file', path: 'notes/new.md', content: '# Title\n' } },
            { operation: { type: 'append_text', path: 'notes/new.md', text: 'body\n' } },
          ],
        })

        expect(transaction.changedFiles).toEqual(['notes/new.md'])
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'notes/new.md'), 'utf8')).toBe('# Title\nbody\n')

        await project.rollback({ transactionId: transaction.transactionId })
        await expect(readFile(join(root, 'notes/new.md'), 'utf8')).rejects.toThrow()
      })
    })

    test('amends operations on top of patches already staged for the same file', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA')],
        })
        const amended = await project.amendEdit({
          transactionId: transaction.transactionId,
          operations: [replace('greek.txt', 'ALPHA', 'ALPHA-2'), replace('greek.txt', 'gamma', 'GAMMA')],
        })

        expect(amended.patches).toHaveLength(3)
        expect(amended.diff).toBe(unifiedDiff('greek.txt', Greek, 'ALPHA-2\nbeta\nGAMMA\n'))
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA-2\nbeta\nGAMMA\n')
      })
    })

    test('rolls a multi-operation file back to its original content', async () => {
      await withRoot({ 'greek.txt': Greek, 'other.txt': 'other\n' }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            replace('greek.txt', 'alpha', 'ALPHA'),
            replace('other.txt', 'other', 'OTHER'),
            replace('greek.txt', 'beta', 'BETA'),
            replace('greek.txt', 'gamma', 'GAMMA'),
          ],
        })
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA\nBETA\nGAMMA\n')

        await project.rollback({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(Greek)
        expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('other\n')
      })
    })

    test('refuses rollback when a multi-operation file changed after apply', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA'), replace('greek.txt', 'gamma', 'GAMMA')],
        })
        await project.applyEdit({ transactionId: transaction.transactionId })
        await writeFile(join(root, 'greek.txt'), 'ALPHA\nexternal\nGAMMA\n')

        await expect(project.rollback({ transactionId: transaction.transactionId })).rejects.toMatchObject({
          reason: 'CONFLICT_WITH_EXTERNAL_EDIT',
          details: { path: 'greek.txt' },
        })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA\nexternal\nGAMMA\n')
      })
    })

    test('re-derives every same-file patch when an unrelated region changed before apply', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA'), replace('greek.txt', 'gamma', 'GAMMA')],
        })
        await writeFile(join(root, 'greek.txt'), 'alpha\nexternal\ngamma\n')

        const applied = await project.applyEdit({ transactionId: transaction.transactionId })
        expect(applied.rebasedFiles).toEqual(['greek.txt'])
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA\nexternal\nGAMMA\n')
        expect(project.getTransaction(transaction.transactionId)?.diff).toBe(
          unifiedDiff('greek.txt', 'alpha\nexternal\ngamma\n', 'ALPHA\nexternal\nGAMMA\n'),
        )

        await project.rollback({ transactionId: transaction.transactionId })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('alpha\nexternal\ngamma\n')
      })
    })

    test('fails with a revision conflict instead of dropping a patch that cannot follow the rebase', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA'), replace('greek.txt', 'gamma', 'GAMMA')],
        })
        await writeFile(join(root, 'greek.txt'), 'alpha\nbeta\ndelta\n')

        await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toMatchObject({
          reason: 'BASE_REVISION_MISMATCH',
          details: { path: 'greek.txt' },
        })
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('alpha\nbeta\ndelta\n')
        expect(project.getTransaction(transaction.transactionId)?.patches[0]?.oldContent).toBe(Greek)
        expect((await project.status()).locks).toHaveLength(0)
      })
    })

    test('validators see exactly the content that apply writes', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const seen = new Map<string, string | undefined>()
        const project = await variant.create(root, [capturingValidator(seen)])
        const transaction = await project.prepareEdit({
          operations: [
            replace('greek.txt', 'alpha', 'ALPHA'),
            { operation: { type: 'append_text', path: 'greek.txt', text: 'delta\n' } },
            replace('greek.txt', 'beta', 'BETA'),
          ],
        })

        await project.applyEdit({ transactionId: transaction.transactionId })
        const written = await readFile(join(root, 'greek.txt'), 'utf8')
        expect(written).toBe('ALPHA\nBETA\ngamma\ndelta\n')
        expect(seen.get('greek.txt')).toBe(written)
      })
    })

    test('describes the net per-file change in the returned diff', async () => {
      await withRoot({ 'greek.txt': Greek, 'other.txt': 'other\n' }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            replace('greek.txt', 'alpha', 'ALPHA'),
            replace('other.txt', 'other', 'OTHER'),
            replace('greek.txt', 'ALPHA', 'omega'),
            replace('greek.txt', 'gamma', 'GAMMA'),
          ],
        })

        const expected = [
          unifiedDiff('greek.txt', Greek, 'omega\nbeta\nGAMMA\n'),
          unifiedDiff('other.txt', 'other\n', 'OTHER\n'),
        ].join('\n')
        expect(transaction.diff).toBe(expected)
        expect(transaction.diff).not.toContain('+ALPHA')
        expect(transaction.changedLines).toBe(6)
        expect(transaction.changedFiles).toEqual(['greek.txt', 'other.txt'])
        expect(project.changeFeed.get(transaction.transactionId)?.diff).toBe(expected)
        expect((await project.diff({ transactionId: transaction.transactionId })).diff).toBe(expected)
      })
    })

    test('treats ./, absolute and bare spellings of a path as one file', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            { operation: { type: 'create_file', path: './n.txt', content: 'created\n' } },
            { operation: { type: 'append_text', path: 'n.txt', text: 'appended\n' } },
            { operation: { type: 'create_file', path: join(root, 'm.txt'), content: 'created\n' } },
            { operation: { type: 'append_text', path: 'm.txt', text: 'appended\n' } },
            replace('greek.txt', 'alpha', 'ALPHA'),
            replace(join(root, 'greek.txt'), 'gamma', 'GAMMA'),
            replace('./greek.txt', 'beta', 'BETA'),
          ],
        })

        expect(transaction.changedFiles).toEqual(['n.txt', 'm.txt', 'greek.txt'])
        expect(transaction.diff).toBe([
          unifiedDiff('n.txt', '', 'created\nappended\n'),
          unifiedDiff('m.txt', '', 'created\nappended\n'),
          unifiedDiff('greek.txt', Greek, 'ALPHA\nBETA\nGAMMA\n'),
        ].join('\n'))

        const applied = await project.applyEdit({ transactionId: transaction.transactionId })
        expect(applied.rebasedFiles).toBeUndefined()
        expect(await readFile(join(root, 'n.txt'), 'utf8')).toBe('created\nappended\n')
        expect(await readFile(join(root, 'm.txt'), 'utf8')).toBe('created\nappended\n')
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe('ALPHA\nBETA\nGAMMA\n')

        await project.rollback({ transactionId: transaction.transactionId })
        await expect(readFile(join(root, 'n.txt'), 'utf8')).rejects.toThrow()
        await expect(readFile(join(root, 'm.txt'), 'utf8')).rejects.toThrow()
        expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(Greek)
      })
    })

    test('chains a json_patch spelled ./ onto an earlier text edit of the same file', async () => {
      await withRoot({ 'cfg.json': '{\n  "a": 1,\n  "b": 2\n}\n' }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            replace('cfg.json', '"a": 1', '"a": 10'),
            { operation: { type: 'json_patch', path: './cfg.json', patches: [{ op: 'replace', path: '/b', value: 20 }] } },
          ],
        })

        expect(transaction.changedFiles).toEqual(['cfg.json'])
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(JSON.parse(await readFile(join(root, 'cfg.json'), 'utf8'))).toEqual({ a: 10, b: 20 })
      })
    })

    test('keeps the rename-target guard when the target is spelled differently', async () => {
      await withRoot({ 'a.txt': 'A\n' }, async (root) => {
        const project = await variant.create(root)
        await expect(project.prepareEdit({
          operations: [
            { operation: { type: 'create_file', path: 'b.txt', content: 'B\n' } },
            { operation: { type: 'rename_file', from: 'a.txt', to: './b.txt' } },
          ],
        })).rejects.toMatchObject({ reason: 'CONFLICT_WITH_EXTERNAL_EDIT', details: { path: 'b.txt' } })
        await expect(readFile(join(root, 'b.txt'), 'utf8')).rejects.toThrow()
      })
    })

    test('enforces baseRevisions keyed by another spelling of the path', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const project = await variant.create(root)
        await expect(project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA')],
          baseRevisions: { './greek.txt': 'stale-revision' },
        })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH', details: { path: 'greek.txt' } })
      })
    })

    test('validators see the rebased content that apply writes', async () => {
      await withRoot({ 'greek.txt': Greek }, async (root) => {
        const seen = new Map<string, string | undefined>()
        const project = await variant.create(root, [capturingValidator(seen)])
        const transaction = await project.prepareEdit({
          operations: [replace('greek.txt', 'alpha', 'ALPHA'), replace('greek.txt', 'gamma', 'GAMMA')],
        })
        await writeFile(join(root, 'greek.txt'), 'alpha\nexternal\ngamma\n')

        const applied = await project.applyEdit({ transactionId: transaction.transactionId })
        expect(applied.rebasedFiles).toEqual(['greek.txt'])
        const written = await readFile(join(root, 'greek.txt'), 'utf8')
        expect(written).toBe('ALPHA\nexternal\nGAMMA\n')
        expect(seen.get('greek.txt')).toBe(written)
      })
    })

    test('refuses to write rebased content that fails validation', async () => {
      const original = 'export const a = 1\nexport const b = 2\n'
      await withRoot({ 'mod.ts': original }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('mod.ts', 'export const b = 2', 'export const b = 3')],
        })
        const external = 'export const a = (\nexport const b = 2\n'
        await writeFile(join(root, 'mod.ts'), external)

        let failure: any
        try {
          await project.applyEdit({ transactionId: transaction.transactionId })
        } catch (error) {
          failure = error
        }

        expect(failure?.reason).toBe('VALIDATION_FAILED')
        expect(failure.details.rebasedFiles).toEqual(['mod.ts'])
        expect(failure.details.diagnosticCount).toBeGreaterThan(0)
        expect(await readFile(join(root, 'mod.ts'), 'utf8')).toBe(external)
        expect(project.getTransaction(transaction.transactionId)?.patches[0]?.oldContent).toBe(original)
        expect((await project.status()).locks).toHaveLength(0)
      })
    })

    test('chains structural symbol edits on the same TypeScript file', async () => {
      const source = [
        'export function first(): number {',
        '  return 1',
        '}',
        '',
        'export function second(): number {',
        '  return 2',
        '}',
        '',
      ].join('\n')
      await withRoot({ 'symbols.ts': source }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [
            {
              operation: {
                type: 'replace_symbol',
                path: 'symbols.ts',
                symbol: { kind: 'function', name: 'first' },
                replacement: 'export function first(): number {\n  return 10\n}',
              },
            },
            {
              operation: {
                type: 'replace_symbol',
                path: 'symbols.ts',
                symbol: { kind: 'function', name: 'second' },
                replacement: 'export function second(): number {\n  return 20\n}',
              },
            },
          ],
        })

        await project.applyEdit({ transactionId: transaction.transactionId })
        const written = await readFile(join(root, 'symbols.ts'), 'utf8')
        expect(written).toContain('return 10')
        expect(written).toContain('return 20')
      })
    })
  })
}

describe('same-file transaction guards', () => {
  test('rejects a disk-bound targetId on a path already modified in the transaction', async () => {
    await withRoot({ 'greek.txt': Greek }, async (root) => {
      const project = await createProjectKernel({ root })
      const resolved = await project.resolveTarget({
        path: 'greek.txt',
        target: { exactSnippet: 'gamma' },
      })
      expect(resolved.status).toBe('resolved')
      if (resolved.status !== 'resolved') return

      await expect(project.prepareEdit({
        operations: [
          replace('greek.txt', 'alpha', 'ALPHA'),
          { targetId: resolved.target.targetId, operation: { type: 'replace_text', newText: 'GAMMA' } },
        ],
      })).rejects.toMatchObject({
        reason: 'INVALID_INPUT',
        details: { path: 'greek.txt', targetId: resolved.target.targetId },
      })
    })
  })

  test('rejects editing a file the transaction already deleted, but allows recreating it', async () => {
    await withRoot({ 'greek.txt': Greek }, async (root) => {
      const project = await createProjectKernel({ root })
      await expect(project.prepareEdit({
        operations: [
          { operation: { type: 'delete_file', path: 'greek.txt' } },
          { operation: { type: 'append_text', path: './greek.txt', text: 'more\n' } },
        ],
      })).rejects.toMatchObject({
        reason: 'TARGET_NOT_FOUND',
        details: { path: 'greek.txt', operation: 'append_text' },
      })

      const recreated = await project.prepareEdit({
        operations: [
          { operation: { type: 'delete_file', path: 'greek.txt' } },
          { operation: { type: 'create_file', path: 'greek.txt', content: 'fresh\n' } },
        ],
      })
      expect(recreated.changedFiles).toEqual(['greek.txt'])
      expect(recreated.diff).toContain('+fresh')
      expect((await project.validate({ transactionId: recreated.transactionId })).ok).toBe(true)
    })
  })
})

describe('batch conflicts with composed transactions', () => {
  function prepareTask(id: string, operations: EditIntent[]) {
    return { id, op: { kind: 'prepare' as const, input: { operations } } }
  }

  test('does not expose intermediate offsets that would hide a cross-transaction overlap', async () => {
    await withRoot({ 'greek.txt': Greek }, async (root) => {
      const project = await createProjectKernel({ root })
      const result = await project.runBatch({
        mode: 'prepare-then-apply',
        conflictCheck: true,
        tasks: [
          prepareTask('a', [replace('greek.txt', 'gamma', 'gamma-from-A')]),
          prepareTask('b', [
            {
              operation: {
                type: 'insert_text_at_anchor',
                path: 'greek.txt',
                anchorText: 'alpha\n',
                position: 'after',
                text: `${'x'.repeat(100)}\n`,
              },
            },
            replace('greek.txt', 'gamma', 'GAMMA-from-B'),
          ]),
        ],
      })

      expect(result.ok).toBe(false)
      expect(result.conflicts).toContainEqual(expect.objectContaining({ taskA: 'a', taskB: 'b', file: 'greek.txt' }))
      const composed = result.preparedTransactions?.find((tx) => tx.patches.length === 2)
      expect(composed?.patches[0]?.metadata?.startOffset).toBe(6)
      expect(composed?.patches[1]?.metadata).not.toHaveProperty('startOffset')
      expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(Greek)
    })
  })

  test('still tells disjoint single-operation transactions apart', async () => {
    await withRoot({ 'greek.txt': Greek }, async (root) => {
      const project = await createProjectKernel({ root })
      const result = await project.runBatch({
        mode: 'prepare-then-apply',
        conflictCheck: true,
        tasks: [
          prepareTask('a', [replace('greek.txt', 'alpha', 'ALPHA')]),
          prepareTask('b', [replace('greek.txt', 'gamma', 'GAMMA')]),
        ],
      })

      expect(result.conflicts).toBeUndefined()
      expect(result.ok).toBe(true)
    })
  })
})

describe('validation failure envelope', () => {
  const numberedSource = Array.from({ length: 10 }, (_, index) => `export const v${index + 1} = ${index + 1}\n`).join('')

  for (const variant of kernelVariants) {
    test(`reports compact, locatable diagnostics (${variant.name})`, async () => {
      await withRoot({ 'b.ts': numberedSource }, async (root) => {
        const project = await variant.create(root)
        const transaction = await project.prepareEdit({
          operations: [replace('b.ts', 'export const v8 = 8', 'export const v8 = ;')],
        })

        let failure: any
        try {
          await project.applyEdit({ transactionId: transaction.transactionId })
        } catch (error) {
          failure = error
        }

        expect(failure?.reason).toBe('VALIDATION_FAILED')
        expect(failure.message).toStartWith('事务校验失败，未写入磁盘：b.ts:8')
        expect(failure.message).toMatch(/（共 \d+ 条）$/)
        expect(failure.details.transactionId).toBe(transaction.transactionId)
        expect(failure.details.checks).toBeUndefined()
        expect(failure.details.failedChecks).toContain('jsts.syntax')
        expect(failure.details.diagnosticCount).toBe(failure.details.diagnostics.length)
        expect(failure.details.diagnostics[0]).toMatchObject({
          severity: 'error',
          path: 'b.ts',
          line: 8,
          column: 19,
        })
        expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe(numberedSource)
      })
    })
  }

  test('counts a syntax error once even when several validators report it', async () => {
    await withRoot({ 'b.ts': numberedSource }, async (root) => {
      const project = await createProjectKernel({ root, plugins: [typescriptPlugin()] })
      const transaction = await project.prepareEdit({
        operations: [replace('b.ts', 'export const v8 = 8', 'export const v8 = ;')],
      })

      let failure: any
      try {
        await project.applyEdit({ transactionId: transaction.transactionId })
      } catch (error) {
        failure = error
      }

      const positions = failure.details.diagnostics.map((diagnostic: Diagnostic) =>
        [diagnostic.path, diagnostic.line, diagnostic.column, diagnostic.message].join('|'))
      expect(new Set(positions).size).toBe(positions.length)
      expect(failure.details.diagnosticCount).toBe(positions.length)
      expect(failure.message).toEndWith(`（共 ${positions.length} 条）`)
    })
  })

  test('keeps only the leading diagnostics and truncates oversized messages', async () => {
    const diagnostics: Diagnostic[] = [
      { severity: 'warning', message: 'style nit', path: 'note.txt', line: 1 },
      { severity: 'error', message: 'unlocated failure', source: 'test.failing' },
      ...Array.from({ length: 12 }, (_, index): Diagnostic => ({
        severity: 'error',
        message: index === 0 ? `huge output\n${'x'.repeat(10_000)}` : `failure ${index}`,
        path: 'note.txt',
        line: index + 2,
        column: 3,
        source: 'test.failing',
        data: { code: 1000 + index },
      })),
    ]
    await withRoot({ 'note.txt': 'before\n' }, async (root) => {
      const project = await createProjectKernel({ root, plugins: [failingValidator(diagnostics)] })
      const transaction = await project.prepareEdit({ operations: [replace('note.txt', 'before', 'after')] })

      let failure: any
      try {
        await project.applyEdit({ transactionId: transaction.transactionId })
      } catch (error) {
        failure = error
      }

      expect(failure?.reason).toBe('VALIDATION_FAILED')
      expect(failure.message).toBe('事务校验失败，未写入磁盘：note.txt:2:3 huge output（共 14 条）')
      expect(failure.details.diagnosticCount).toBe(14)
      expect(failure.details.diagnostics).toHaveLength(10)
      expect(failure.details.diagnostics[0].data).toEqual({ code: 1000 })
      expect(failure.details.diagnostics[0].message.length).toBeLessThan(2100)
      expect(failure.details.failedChecks).toEqual(['test.failing'])
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before\n')
    })
  })
})

describe('durable write-ahead plan for composed files', () => {
  test('records the final content as owned state and recovers an interrupted multi-operation apply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-composition-durable-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    await mkdir(root)
    await writeFile(join(root, 'greek.txt'), Greek)

    const pendingPlans: ProjectTransactionPendingOperation[] = []
    const originalCommit = FileProjectTransactionStateStore.prototype.commit
    FileProjectTransactionStateStore.prototype.commit = function (input) {
      if (input.pending) pendingPlans.push(structuredClone(input.pending))
      return originalCommit.call(this, input)
    }
    try {
      const project = await createProjectKernel({ root, transactionStatePath: statePath })
      const transaction = await project.prepareEdit({
        operations: [replace('greek.txt', 'alpha', 'ALPHA'), replace('greek.txt', 'gamma', 'GAMMA')],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })
      const final = 'ALPHA\nbeta\nGAMMA\n'
      expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(final)

      const applyPlan = pendingPlans.find((plan) => plan.kind === 'apply')
      const applyEntry = applyPlan?.restore.find((entry) => entry.path === 'greek.txt')
      expect(applyEntry?.content).toBe(Greek)
      expect(applyEntry?.ownedStates.at(-1)).toEqual({ exists: true, content: final })

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(Greek)
      const rollbackEntry = pendingPlans
        .find((plan) => plan.kind === 'rollback')
        ?.restore.find((entry) => entry.path === 'greek.txt')
      expect(rollbackEntry?.content).toBe(final)
      expect(rollbackEntry?.ownedStates.at(-1)).toEqual({ exists: true, content: Greek })

      // 模拟 re-apply 写到一半中断：磁盘停在第一个补丁的产出，下一次 owner 启动必须还原。
      const store = new FileProjectTransactionStateStore({ path: statePath, root })
      const snapshot = store.snapshot()
      store.commit({
        transactions: snapshot.transactions,
        projections: snapshot.projections,
        pending: { ...applyPlan!, previousStatus: 'rolled_back' },
      })
      const intermediate = applyEntry!.ownedStates[0]
      expect(intermediate?.content).toBe('ALPHA\nbeta\ngamma\n')
      await writeFile(join(root, 'greek.txt'), intermediate!.content!)

      const reopened = await createProjectKernel({ root, transactionStatePath: statePath })
      expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(Greek)
      await reopened.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'greek.txt'), 'utf8')).toBe(final)
    } finally {
      FileProjectTransactionStateStore.prototype.commit = originalCommit
      await rm(directory, { recursive: true, force: true })
    }
  })
})
