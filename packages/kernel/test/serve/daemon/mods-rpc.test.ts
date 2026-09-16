import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { KernelClient, SocketKernelTransport } from '@velaros-ai/kernel/client'
import {
  createCapabilityToken,
  defineKernelModule,
} from '@velaros-ai/kernel/contracts/abi'
import { KernelProtocolVersion } from '@velaros-ai/kernel/contracts/protocol'
import { KernelModuleHost, KernelService } from '@velaros-ai/kernel/runtime'

import { bootKernelDaemon } from '../../../src/serve/daemon/boot'
import { InProcessKernelTransport } from '../../../src/serve/internal/in-process-transport'
import { KernelLocalRpcServer } from '../../../src/serve/rpc'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('mods RPC', () => {
  test('lists, installs, and toggles packs through KernelClient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-mods-rpc-'))
    directories.push(root)
    const packDir = join(root, 'echo-pack')
    await mkdir(packDir, { recursive: true })
    await writeFile(
      join(packDir, 'index.mjs'),
      `export default {
  manifest: {
    id: 'module.user-echo',
    version: '1.0.0',
    apiVersion: 1,
    provides: [{ id: 'test.user.echo', version: '1.0.0' }],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate() {},
}
`,
    )
    await writeFile(
      join(packDir, 'velaros.mod.json'),
      JSON.stringify({
        module: {
          id: 'user.echo',
          version: '1.0.0',
          apiVersion: 1,
          entry: './index.mjs',
          // Shape tolerance: a bare capability id means the same as {id, version}.
          provides: ['test.user.echo'],
        },
      }),
    )

    const booted = await bootKernelDaemon({
      kernelVersion: '0.3.0-test',
      modStorePaths: {
        userModsDirectory: join(root, 'mods'),
        indexPath: join(root, 'mod-index.json'),
      },
      modules: [
        defineKernelModule({
          manifest: {
            id: 'module.seed',
            version: '1.0.0',
            apiVersion: 1,
            provides: [createCapabilityToken('test.seed')],
            requires: [],
            optionalRequires: [],
            permissions: [],
            isolation: 'in-process',
          },
          activate() {},
        }),
      ],
    })

    const client = new KernelClient(new InProcessKernelTransport(booted.service))
    const before = await client.listMods()
    expect(before.packs.some((pack) => pack.id === 'user.echo')).toBe(false)

    const installed = await client.installModFromDirectory(packDir)
    expect(installed.pack.id).toBe('user.echo')
    expect(installed.reloadRequired).toBe(true)

    const listed = await client.listMods()
    expect(listed.packs.some((pack) => pack.id === 'user.echo' && pack.enabled)).toBe(true)

    const disabled = await client.setModEnabled('user.echo', false)
    expect(disabled.ok).toBe(true)
    expect(disabled.reloadRequired).toBe(true)
    const afterDisable = await client.listMods()
    expect(afterDisable.packs.find((pack) => pack.id === 'user.echo')?.enabled).toBe(false)

    await booted.stop()
  })

  test.skipIf(process.platform === 'win32')('mods 失败带码下发，不再被吞成可重试的 INTERNAL_ERROR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-mods-rpc-codes-'))
    directories.push(root)

    // ① 本 Kernel 没接 ModStore。
    const bare = new KernelService({
      host: new KernelModuleHost({ apiVersion: 1 }),
      kernelVersion: '0.3.0-test',
    })
    await bare.start()
    await expectRpcFailure(
      root,
      'bare',
      bare,
      (transport) => transport.listMods({ protocolVersion: KernelProtocolVersion }),
      { code: 'MODS_UNAVAILABLE', retryable: false },
    )
    await bare.dispose()

    // ② 安装失败：原因必须回到调用方，而不是只进守护进程日志。
    const failing = new KernelService({
      host: new KernelModuleHost({ apiVersion: 1 }),
      kernelVersion: '0.3.0-test',
      modCatalog: {
        list: () => [],
        setEnabled: async () => ({ ok: false, reloadRequired: false }),
        installFromDirectory: async () => {
          throw new Error('velaros.mod.json 不存在')
        },
      },
    })
    await failing.start()
    await expectRpcFailure(
      root,
      'failing',
      failing,
      (transport) =>
        transport.installModFromDirectory({
          protocolVersion: KernelProtocolVersion,
          directory: join(root, 'missing-pack'),
        }),
      {
        code: 'MOD_INSTALL_FAILED',
        retryable: false,
        details: {
          directory: join(root, 'missing-pack'),
          reason: 'velaros.mod.json 不存在',
        },
      },
    )
    await failing.dispose()
  })
})

const RpcAuthToken = 'mods-rpc-auth-token-0123456789-abc'

/** 经真实的本机 RPC 一跳发一次请求，断言失败帧的码、可重试位与 details。 */
async function expectRpcFailure(
  root: string,
  name: string,
  service: KernelService,
  send: (transport: SocketKernelTransport) => Promise<unknown>,
  expected: Readonly<Record<string, unknown>>,
): Promise<void> {
  const server = new KernelLocalRpcServer({
    authToken: RpcAuthToken,
    endpoint: { kind: 'unix', path: join(root, `${name}.sock`) },
    service,
  })
  const endpoint = await server.start()
  const transport = new SocketKernelTransport({
    authToken: RpcAuthToken,
    endpoint,
  })
  try {
    await expect(send(transport)).rejects.toMatchObject({
      name: 'KernelRpcClientError',
      rpcError: expected,
    })
  } finally {
    await transport.dispose()
    await server.dispose()
  }
}
