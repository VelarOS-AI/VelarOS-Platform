import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  RemoteNodeClient,
  type RemoteNodeCredentials,
} from '@velaros-ai/remote-host/client'

import { startVelarHost, type VelarHostRuntime } from '../src/host'

/**
 * 远程能力节点的端到端回归门。
 *
 * 这条链路的每一环单看都"应该没问题"，合起来跑才发现问题：确认门、异步 reconcile、
 * 三道拒绝闸的**次序**、审计的异步落盘。所以这里跑真 Host（真 Kernel、真能力模块、
 * 真权限 broker），不用桩。
 */
const hosts: VelarHostRuntime[] = []
const clients: RemoteNodeClient[] = []
const tempRoots: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  for (const host of hosts.splice(0)) await host.stop().catch(() => undefined)
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function startHost(): Promise<VelarHostRuntime> {
  const host = await startVelarHost({
    dataRoot: await createTempRoot('velar-remote-node-'),
    projectRoot: await createTempRoot('velar-remote-node-project-'),
  })
  hosts.push(host)
  return host
}

/** 配置变更触发的是异步 reconcile，监听不是同步就位的。 */
async function waitForAddress(host: VelarHostRuntime): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const address = host.remoteNode.getStatus().address
    if (address !== null) return address
    await Bun.sleep(50)
  }
  throw new Error('remote node never started listening')
}

/** 审计写盘走内部串行队列（有意异步：审计故障不该打死调用路径），所以要等它落完。 */
async function waitForAuditStatuses(
  dataRoot: string,
  expected: readonly string[],
): Promise<ReadonlyArray<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await readAudit(dataRoot)
    const statuses = new Set(rows.map((row) => row.status))
    if (expected.every((status) => statuses.has(status))) return rows
    await Bun.sleep(50)
  }
  return readAudit(dataRoot)
}

async function readAudit(dataRoot: string): Promise<Array<Record<string, unknown>>> {
  const directory = join(dataRoot, 'audit')
  let files: string[]
  try {
    files = await readdir(directory)
  } catch {
    return []
  }
  const rows: Array<Record<string, unknown>> = []
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8')
    for (const line of text.trim().split('\n')) {
      if (line.length > 0) rows.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return rows
}

function enableUpdate(host: VelarHostRuntime, systemExecute: boolean) {
  const value = host.config.snapshot().value
  return {
    capabilities: {
      ...value.capabilities,
      system: { observe: true, read: true, write: false, execute: systemExecute },
    },
    computer: value.computer,
    remoteNode: { ...value.remoteNode, enabled: true },
    confirmations: [
      'remote-node-enable',
      'system-observe',
      'system-read',
      ...(systemExecute ? ['system-execute' as const] : []),
    ],
  } as Parameters<VelarHostRuntime['config']['update']>[0]
}

async function connect(
  host: VelarHostRuntime,
  address: string,
  store: { value: RemoteNodeCredentials | null },
  pairingCode?: string,
) {
  const client = new RemoteNodeClient({
    url: address,
    clientName: 'serve-host-e2e',
    ...(pairingCode === undefined ? {} : { pairingCode }),
    credentials: {
      load: async () => store.value,
      save: async (next) => { store.value = next },
      clear: async () => { store.value = null },
    },
  })
  clients.push(client)
  return { client, session: await client.connect() }
}

describe('velaros serve remote node', () => {
  test('默认关闭，且启用必须显式确认', async () => {
    const host = await startHost()
    expect(host.status.remoteNode.enabled).toBe(false)
    expect(host.status.remoteNode.address).toBeNull()

    const value = host.config.snapshot().value
    // 加宽暴露面必须确认——这是把节点从"本机"变成"可被别的机器驱动"的那一步。
    await expect(
      host.config.update({
        capabilities: value.capabilities,
        computer: value.computer,
        remoteNode: { ...value.remoteNode, enabled: true },
        confirmations: [],
      }),
    ).rejects.toThrow()
  })

  test('配对后可拉清单、真执行工具，且三道闸依次生效', async () => {
    const host = await startHost()
    await host.config.update(enableUpdate(host, true))
    const address = await waitForAddress(host)
    expect(address).toContain('/v1/remote-node/ws')

    const pairing = host.remoteNode.startPairing()
    // 配对码是一次性口令，绝不能落进全局可读的公共状态文件。
    const publicStatus = await readFile(join(host.paths.dataRoot, 'host.json'), 'utf8')
    expect(publicStatus).not.toContain(pairing.code)

    const store: { value: RemoteNodeCredentials | null } = { value: null }
    const { client, session } = await connect(host, address, store, pairing.code)
    expect(session.node.nodeId.length).toBeGreaterThan(0)
    // 私钥留在客户端，永不上线。
    expect(store.value?.privateKey.length ?? 0).toBeGreaterThan(0)

    const runTool = session.manifest.tools.find((tool) => tool.name === 'system:run')
    expect(runTool).toBeDefined()

    const output = await client.invoke({
      capabilityId: runTool!.capabilityId,
      operation: runTool!.operation,
      input: { command: 'echo velaros-remote-node-e2e' },
    })
    // 真执行：标记必须原样从被调机器回来。
    expect(JSON.stringify(output)).toContain('velaros-remote-node-e2e')

    // ① 收窄能力后，携旧 revision 的调用被新鲜度门拒。
    await host.config.update(enableUpdate(host, false))
    await expect(
      client.invoke({
        capabilityId: runTool!.capabilityId,
        operation: runTool!.operation,
        input: { command: 'echo should-not-run' },
      }),
    ).rejects.toThrow()

    // ② 重连拿到新清单，工具已从目录消失。
    client.dispose()
    const reconnected = await connect(host, address, store)
    expect(
      reconnected.session.manifest.tools.some((tool) => tool.name === 'system:run'),
    ).toBe(false)

    // ③ 绕过目录硬调，仍被拒——目录可见性与权限是两道闸，不是一道。
    await expect(
      reconnected.client.invoke({
        capabilityId: runTool!.capabilityId,
        operation: runTool!.operation,
        input: { command: 'echo should-not-run' },
      }),
    ).rejects.toThrow()

    const rows = await waitForAuditStatuses(host.paths.dataRoot, ['success', 'denied'])
    expect(rows.map((row) => row.status)).toContain('success')
    expect(rows.map((row) => row.status)).toContain('denied')
    // 审计只记元数据：跨机链路上流过的可能是 PIN、token 或截图。
    for (const row of rows) {
      expect(row).not.toHaveProperty('input')
      expect(row).not.toHaveProperty('output')
    }
  }, 30_000)
})
