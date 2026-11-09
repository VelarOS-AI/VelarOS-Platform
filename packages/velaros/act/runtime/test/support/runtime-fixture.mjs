import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localContextStorage } from '@velaros-ai/context/node'

import { createRuntime } from '../../../../dist/act/runtime/index.js'
import { createNodeExecutionEnvironment } from '../../../../dist/act/runtime/node.js'
import { createLocalShellHost } from '../../../../dist/execution/local.js'

/** 测试显式拥有的执行身份；生产宿主必须按其真实权限域绑定。 */
export const testBinding = Object.freeze({
  executionIdentity: 'runtime-test-process',
  authorizationScope: 'runtime-test-full-access',
})

/** 为机制测试提供真实 Node 进程；领域能力与持久存储由每个测试明确装配。 */
export async function createTestRuntime(options, execution = {}) {
  if (options.node || options.runner) return createRuntime({ binding: testBinding, ...options })
  const directory = await mkdtemp(join(tmpdir(), 'velaros-runtime-test-node-'))
  const cwd = execution.cwd ?? process.cwd()
  const host = createLocalShellHost({
    cwd,
    processConfinement: { mode: 'danger-full-access' },
  })
  const resource = {
    async close() {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
  try {
    return await createRuntime({
      binding: testBinding,
      ...options,
      node: createNodeExecutionEnvironment({ cwd, directory, host }),
      resources: [...(options.resources ?? []), resource],
    })
  } catch (error) {
    await resource.close()
    throw error
  }
}

/** 每次打开独立连接，恢复测试不借用已关闭的 SQLite 句柄。 */
export async function createTestStorage(directory) {
  await mkdir(directory, { recursive: true })
  return localContextStorage({ path: join(directory, 'context.sqlite') })
}
