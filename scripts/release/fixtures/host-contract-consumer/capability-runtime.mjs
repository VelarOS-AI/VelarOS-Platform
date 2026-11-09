import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createNodeRuntime } from '@velaros-ai/velaros/node'
import { createProjectKernel, createProjectCapabilityModule } from '@velaros-ai/capabilities/project'

const extensionRequire = createRequire(import.meta.resolve('@velaros-ai/capabilities/project'))
assert.equal(extensionRequire.resolve('@velaros-ai/velaros/package.json'), fileURLToPath(import.meta.resolve('@velaros-ai/velaros/package.json')))

const root = await mkdtemp(join(tmpdir(), 'velaros-installed-capability-'))
const cwd = join(root, 'project')
await mkdir(cwd)
await writeFile(join(cwd, 'example.txt'), 'before\n')
const kernel = await createProjectKernel({ root: cwd })
const runtime = await createNodeRuntime({
  cwd,
  stateDirectory: join(root, 'state'),
  binding: { executionIdentity: 'extension-consumer', authorizationScope: 'project-test-policy-v1' },
  localHost: { processConfinement: { mode: 'danger-full-access' } },
  modules: [createProjectCapabilityModule({ instanceId: cwd, project: { getRootPath: () => cwd, kernel: async () => kernel } })],
})
try {
  const session = await runtime.openSession('explicit-project')
  await session.context.append({kind: 'user', body: 'Update the explicitly mounted project file.'})
  const receipt = await session.execute({ source: "import {commit} from 'velaros:project';await commit({changes:[{path:'example.txt',oldText:'before',newText:'after'}]});" })
  assert.equal(receipt.result.failed, undefined, JSON.stringify(receipt))
  assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'after\n')
  console.log(JSON.stringify({ platform: process.platform, explicitProject: true, sharedRuntime: true, actualFileChange: true }))
} finally {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
}
