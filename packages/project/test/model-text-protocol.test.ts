import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'

import { finalizeProjectModelResult } from '../src/agent/presentation/source-window'
import { projectPlannerResolver } from '../src/agent/tools/planner-resolver'
import { executeProjectRead } from '../src/agent/tools/read'
import type { ProjectToolContext } from '../src/agent/Types'
import { compileProjectEdit } from '../src/editing/planner/index'
import { createProjectKernel } from '../src/index'
import { typescriptPlugin } from '../src/plugins/typescript'
import { encodeProjectTextBuffer } from '../src/utils/text'

test.each(['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030'] as const)(
  '%s uses the same visible lines, semantic parsing, literal edit and byte-exact undo', async (encoding) => {
    const root = await mkdtemp(join(tmpdir(), 'project-model-text-'))
    try {
      const original = 'export const message = "中文🙂\\n";\r\nexport const count = 1;\n'
      const bytes = encodeProjectTextBuffer(original, encoding)
      await writeFile(join(root, 'source.ts'), bytes)
      const kernel = await createProjectKernel({ root, plugins: [typescriptPlugin()] })
      const context: ProjectToolContext = {
        sessionId: 'text-protocol', codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore(),
        abortSignal: new AbortController().signal,
        project: {
          getRootPath: () => root, kernel: async () => kernel,
          runInDirectory: async (_path, action) => action(), runWithApproval: async (action) => action(),
          prepareMutation: async () => ({ approved: true, rootPath: root }),
          queryCode: async () => ({}), runCommand: async () => ({}) as never,
        },
        system: { canStartBackgroundCommands: () => false }, approval: {} as never,
      }
      const visible = async () => await finalizeProjectModelResult(context, await executeProjectRead({ path: 'source.ts' }, context)) as {
        files: Array<{ fileRef: string; lines: Array<[number, string]> }>
      }
      const before = (await visible()).files[0]
      expect(before.lines).toEqual([[1, 'export const message = "中文🙂\\n";'], [2, 'export const count = 1;'], [3, '']])
      expect((await kernel.listSymbols('source.ts')).map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['message', 'count']))
      const plan = await compileProjectEdit({ files: [{ fileRef: before.fileRef, edits: [{ op: 'replace', range: 2, match: 'count = 1', text: 'count = 2' }] }] }, projectPlannerResolver(context))
      const tx = await kernel.prepareEdit(plan)
      await kernel.applyEdit({ transactionId: tx.transactionId })
      expect((await visible()).files[0].lines).toEqual([[1, 'export const message = "中文🙂\\n";'], [2, 'export const count = 2;'], [3, '']])
      expect(await readFile(join(root, 'source.ts'))).toEqual(encodeProjectTextBuffer(original.replace('count = 1', 'count = 2'), encoding))
      await kernel.rollback({ transactionId: tx.transactionId })
      expect(await readFile(join(root, 'source.ts'))).toEqual(bytes)
    } finally { await rm(root, { recursive: true, force: true }) }
  },
)
