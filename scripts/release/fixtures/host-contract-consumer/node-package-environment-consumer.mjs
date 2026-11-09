import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeExecutionEnvironment, createNodeRuntime } from '@velaros-ai/velaros/node'
import { createEnvironmentRegistry } from '@velaros-ai/velaros/act/system'

const root = await mkdtemp(join(tmpdir(), 'velaros-installed-package-query-'))
let runtime
try {
  // This proves query wiring; no successful read-only process is claimed.
  class QueryHost {
    #support = { available: false, reason: 'initial installed host restriction' }
    queries = 0
    observationSupport() { this.queries++; return this.#support }
    setSupport(value) { this.#support = value }
    async runCommand() { throw Error('Support query must not start a command') }
    async runObservationCommand() { throw Error('Support query must not start a read-only command') }
  }
  const host = new QueryHost()
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const node = createNodeExecutionEnvironment({ cwd, directory: join(root, 'runs'), host })
  const packageEnvironment = createEnvironmentRegistry({ directory: join(root, 'packages'), npm: node.npm })
  runtime = await createNodeRuntime({ cwd, stateDirectory: join(root, 'state'), host, packageEnvironment, protocol: { transport: 'text' }, binding: { executionIdentity: 'installed-query', authorizationScope: 'installed-query-scope' } })
  let index = 0
  for (const support of [{ available: false, reason: 'installed host denied policy' }, { available: true }, { available: false, reason: 'installed host changed policy' }]) {
    host.setSupport(support)
    const before = host.queries
    const session = await runtime.openSession(`query-${index++}`)
    assert(host.queries > before, 'The actual package environment must reach the host query')
    const manifest = session.instructionManifest()
    assert.equal(manifest.blocks.find((block) => block.id === 'platform.runtime.snapshot-plans').enabled, support.available)
    if (!support.available) assert(manifest.text.includes(support.reason), 'The exact host reason must reach the public manifest')
  }
  const replacement = { available: false, reason: 'installed replacement query' }
  host.observationSupport = function () { assert.equal(this, host); return replacement }
  const session = await runtime.openSession('replacement')
  assert(session.instructionManifest().text.includes(replacement.reason))
  console.log(JSON.stringify({ packageEnvironmentObservationQuery: true, liveReports: 3, methodReplacement: true, receiver: true, commands: 0 }))
} finally {
  await runtime?.close()
  await rm(root, { recursive: true, force: true })
}
