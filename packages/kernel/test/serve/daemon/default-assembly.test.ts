import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { connectToKernelDaemon } from '../../../src/client/discovery'
import { createKernelCallableCapability } from '../../../src/contracts/abi/callable'
import { createCapabilityToken } from '../../../src/contracts/abi/capability'
import { defineKernelModule } from '../../../src/contracts/abi/module'
import { KernelProtocolVersion } from '../../../src/contracts/protocol/version'
import { bootKernelDaemon } from '../../../src/serve/daemon/boot'
import { createBundledModPack } from '../../../src/serve/daemon/bundled-packs'
import { loadModIndexIntoStore } from '../../../src/serve/daemon/mod-loader'
import { KernelModStore } from '../../../src/serve/daemon/mod-store'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-kernel-boot-'))
  directories.push(directory)
  return directory
}

const EchoToken = createCapabilityToken('velaros.test.echo')
const RemoteOnlyToken = createCapabilityToken('velaros.test.remote-only')

/** 声明了 `remote` 隔离形态、而本次装配没有注入对应适配器的模块：必须被跳过而不是拖垮守护进程。 */
const remoteOnlyModule = defineKernelModule({
  manifest: {
    id: 'velaros.test.remote-only.module',
    version: '1.0.0',
    apiVersion: 1,
    provides: [RemoteOnlyToken],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'remote',
  },
  activate() {},
})

/** 宿主按 `bootKernelDaemon({ modPacks })` 注入的那类编译期能力模块。 */
const echoModule = defineKernelModule({
  manifest: {
    id: 'velaros.test.echo.module',
    version: '1.0.0',
    apiVersion: 1,
    provides: [EchoToken],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate(context) {
    context.registerService(
      EchoToken,
      createKernelCallableCapability({
        echo: {
          metadata: { permissions: [] },
          invoke: (_scope, input) => input,
        },
      }),
    )
  },
})

describe('Kernel 默认装配', () => {
  // Windows 的守护进程走 TCP 回环，Unix socket 路径不适用；冒烟只在类 Unix 上跑。
  test.skipIf(process.platform === 'win32')('缺隔离适配器的模块被跳过，守护进程照常起来并响应一次调用', async () => {
    const runtimeDirectory = await temporaryDirectory()
    const paths = {
      descriptorPath: join(runtimeDirectory, 'velaros-kernel.endpoint.json'),
      lockPath: join(runtimeDirectory, 'velaros-kernel.lock'),
      socketPath: join(runtimeDirectory, 'k.sock'),
    }
    const modStorePaths = {
      userModsDirectory: join(runtimeDirectory, 'mods'),
      indexPath: join(runtimeDirectory, 'mod-index.json'),
    }

    // 与 `serve/main.ts` 相同的装配顺序。
    const modStore = new KernelModStore(modStorePaths)
    await loadModIndexIntoStore(modStore)
    modStore.registerAll([
      {
        ...createBundledModPack({ id: 'system.test.echo', module: echoModule }),
        kind: 'system' as const,
        specifier: 'bundled:velaros.test.echo.module',
        enabled: true,
      },
      {
        ...createBundledModPack({ id: 'system.test.remote-only', module: remoteOnlyModule }),
        kind: 'system' as const,
        specifier: 'bundled:velaros.test.remote-only.module',
        enabled: true,
      },
    ])

    const booted = await bootKernelDaemon({
      kernelVersion: '0.2.3',
      modStorePaths,
      modPacks: modStore.list(),
      paths,
    })

    try {
      // 没有适配器的模块被跳过并如实登记，能激活的模块照常进 handshake。
      expect([...booted.modLoadFailures].map((failure) => failure.id).sort())
        .toEqual(['system.test.remote-only'])
      for (const failure of booted.modLoadFailures) {
        expect(failure.reason).toContain('没有对应的适配器')
      }
      expect(booted.service.handshake().modules.map((module) => module.id))
        .toEqual(['velaros.test.echo.module'])

      // 客户端能连上并真的调一次能力。
      const connected = await connectToKernelDaemon(paths)
      try {
        expect(connected.handshake.kernelVersion).toBe('0.2.3')
        const session = await connected.client.openCapabilitySession({
          requires: [
            { capabilityId: EchoToken.id, operations: null, scope: null },
          ],
        })
        const response = await session.call({
          protocolVersion: KernelProtocolVersion,
          callId: 'call-boot-smoke',
          capabilityId: EchoToken.id,
          operation: 'echo',
          scope: null,
          input: { value: 7 },
        })
        expect(response).toMatchObject({
          status: 'ok',
          output: { value: 7 },
        })
        await session.dispose()
      } finally {
        await connected.client.dispose()
      }
    } finally {
      await booted.stop()
    }
  })
})
