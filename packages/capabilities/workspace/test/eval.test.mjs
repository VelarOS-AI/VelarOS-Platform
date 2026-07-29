import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { test } from 'bun:test'

import { createWorkspace } from '../dist/index.js'
import { runWorkspaceEval } from '../dist/testing/evals.js'

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'velaros-workspace-eval-'))
}

test('workspace eval runner completes the core edit lifecycle', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/eval.ts'), 'export const value = 1\n')
  const workspace = await createWorkspace({ root })
  let transactionId

  const result = await runWorkspaceEval(workspace, {
    name: 'core-edit-lifecycle',
    steps: [
      {
        id: 'read',
        run: () => workspace.read({ path: 'src/eval.ts', maxBytes: 2000 }),
      },
      {
        id: 'prepare',
        async run() {
          const tx = await workspace.prepareEdit({
            operations: [{
              operation: {
                type: 'replace_text',
                path: 'src/eval.ts',
                oldText: 'value = 1',
                newText: 'value = 2',
              },
            }],
          })
          transactionId = tx.transactionId
          return tx
        },
      },
      {
        id: 'validate',
        run: () => workspace.validate({
          transactionId,
          postconditions: [{ type: 'must_contain', value: 'value = 2' }],
        }),
      },
      {
        id: 'apply',
        run: () => workspace.applyEdit({ transactionId }),
      },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.steps.map((step) => step.id), ['read', 'prepare', 'validate', 'apply'])
  assert.match(await fs.readFile(path.join(root, 'src/eval.ts'), 'utf8'), /value = 2/)
})
