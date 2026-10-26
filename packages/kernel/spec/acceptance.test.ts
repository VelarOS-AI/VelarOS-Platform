/**
 * 内核的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 *
 * 改动或删除已有用例要在差量报告里点名并说明理由。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  KernelCallErrorCodes,
  KernelClientErrorCodes,
  KernelErrorCodes,
  KernelUpdaterErrorCodes,
  RemoteNodeLimits,
} from '../src/contract/constants'
import type { KernelPermissionBroker } from '../src/contract/requires'
import { KernelClient } from '../src/impl/client/KernelClient'
import { RemoteNodePairingGate } from '../src/impl/remote-node/RemoteNodePairingGate'
import { KernelModuleHost } from '../src/impl/runtime/KernelModuleHost'
import { AllowLoadedKernelClientAccessBroker } from '../src/impl/serve/AllowLoadedKernelClientAccessBroker'
import { InProcessKernelTransport } from '../src/impl/serve/InProcessKernelTransport'
import { KernelLocalDaemon } from '../src/impl/serve/KernelLocalDaemon'
import { KernelService } from '../src/impl/serve/KernelService'
import { KernelUpdater } from '../src/impl/updater/KernelUpdater'
import { createKernel, kernelModules } from '../src/index'
import type { KernelModulePermissionRequest } from '../src/types/kernel'
import { createDefaultKernelDaemonPaths } from '../src/utils/rpc/descriptor'
import { negotiateKernelProtocol } from '../src/utils/wire/negotiation'
import { artifactOf, createFakeFetch, manifestOf } from '../test/serve/updater/support'

const temporaryDirectories: string[] = []

afterAll(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

/** 开一个只属于本用例的运行目录，收尾时删掉。 */
async function temporaryRuntimeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kernel-spec-'))
  temporaryDirectories.push(directory)
  return directory
}

/** 装一个带两件能力的服务面：会话只绑其中一件，另一件用来验证越界调用会被拒。 */
function serviceWithTwoCapabilities(): KernelService {
  const host = new KernelModuleHost({ apiVersion: 1 })
  host.registerModule(
    kernelModules.define({
      manifest: {
        id: 'spec.session.module',
        version: '1.0.0',
        apiVersion: 1,
        provides: [ProbeCapability, OtherCapability],
        requires: [],
        optionalRequires: [],
        permissions: [],
        isolation: 'in-process' as const,
      },
      activate(context) {
        context.registerService(
          ProbeCapability,
          kernelModules.callable({
            read: { metadata: { permissions: [] }, invoke: () => 'probe' },
          })
        )
        context.registerService(
          OtherCapability,
          kernelModules.callable({
            read: { metadata: { permissions: [] }, invoke: () => 'other' },
          })
        )
        return {}
      },
    })
  )
  return new KernelService({
    host,
    kernelVersion: '0.0.0-spec',
    clientAccessBroker: new AllowLoadedKernelClientAccessBroker(host),
  })
}

const ProbeCapability = kernelModules.token('spec.probe', '1.0.0')
const OtherCapability = kernelModules.token('spec.other', '1.0.0')

/** 造一个提供 `spec.probe` 的模块；`onInvoke` 用来看 provider 代码有没有真的跑到。 */
function probeModule(
  options: {
    readonly onInvoke?: () => void
    readonly permissions?: readonly string[]
    readonly requires?: ReadonlyArray<{ readonly id: string }>
  } = {}
) {
  const permissions = options.permissions ?? ['spec:read']
  return kernelModules.define({
    manifest: {
      id: 'spec.probe.module',
      version: '1.0.0',
      apiVersion: 1,
      provides: [ProbeCapability],
      requires: options.requires ?? [],
      optionalRequires: [],
      permissions,
      isolation: 'in-process' as const,
    },
    activate(context) {
      context.registerService(
        ProbeCapability,
        kernelModules.callable({
          read: {
            metadata: { permissions, reason: '读一次探针值。' },
            invoke: () => {
              options.onInvoke?.()
              return 'probe'
            },
          },
        })
      )
      return {}
    },
  })
}

/** 一个按名单放行的权限裁决，用来观察逐条判权限的顺序。 */
function brokerAllowing(granted: readonly string[], seen: string[]): KernelPermissionBroker {
  return {
    request: async (request) => {
      seen.push(request.permission)
      return granted.includes(request.permission)
        ? { status: 'granted' }
        : { status: 'denied', reason: `权限 "${request.permission}" 不在本次放行名单里` }
    },
  }
}

describe('权限与调用路径', () => {
  test('INV-1 没注入权限策略时，任何声明了权限的操作一律拒绝', async () => {
    const kernel = createKernel()
    let invoked = false
    kernel.registerModule(
      probeModule({
        onInvoke: () => {
          invoked = true
        },
      })
    )
    await kernel.start()

    const failure = await kernel
      .invokeCapability({
        capabilityId: ProbeCapability.id,
        operation: 'read',
        input: {},
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error)

    expect((failure as { code?: string }).code).toBe(KernelCallErrorCodes.permissionDenied)
    expect(invoked).toBeFalse()
    await kernel.dispose()
  })

  test('INV-2 未知操作在求权限之前就拒绝', async () => {
    const seen: string[] = []
    const kernel = createKernel({ permissionBroker: brokerAllowing(['spec:read'], seen) })
    kernel.registerModule(probeModule())
    await kernel.start()

    const failure = await kernel
      .invokeCapability({
        capabilityId: ProbeCapability.id,
        operation: 'no-such-operation',
        input: {},
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error)

    expect((failure as { code?: string }).code).toBe(KernelCallErrorCodes.operationNotFound)
    expect(seen).toEqual([])
    await kernel.dispose()
  })

  test('INV-3 声明的每条权限都在 provider 代码运行前逐条判定，一条拒绝就不调用', async () => {
    const seen: string[] = []
    let invoked = false
    const kernel = createKernel({ permissionBroker: brokerAllowing(['spec:read'], seen) })
    kernel.registerModule(
      probeModule({
        permissions: ['spec:read', 'spec:write'],
        onInvoke: () => {
          invoked = true
        },
      })
    )
    await kernel.start()

    const failure = await kernel
      .invokeCapability({
        capabilityId: ProbeCapability.id,
        operation: 'read',
        input: {},
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error)

    expect(seen).toEqual(['spec:read', 'spec:write'])
    expect((failure as { code?: string }).code).toBe(KernelCallErrorCodes.permissionDenied)
    expect(invoked).toBeFalse()
    await kernel.dispose()
  })

  test('INV-5 模块不能冒充模块 id、代数或调用方', async () => {
    const requests: KernelModulePermissionRequest[] = []
    const broker: KernelPermissionBroker = {
      request: async (request) => {
        requests.push(request)
        return { status: 'granted' }
      },
    }
    const kernel = createKernel({ permissionBroker: broker })
    kernel.registerModule(
      kernelModules.define({
        manifest: {
          id: 'spec.forger',
          version: '1.0.0',
          apiVersion: 1,
          provides: [],
          requires: [],
          optionalRequires: [],
          permissions: ['spec:read'],
          isolation: 'in-process' as const,
        },
        activate(context) {
          void context.permissions.request({
            permission: 'spec:read',
            // 模块多塞的键不会透传给宿主：宿主拿到的 moduleId / generation 只由内核填。
            ...({
              moduleId: 'spec.victim',
              generation: 99,
              callerModuleId: 'spec.victim',
            } as object),
          })
          return {}
        },
      })
    )
    await kernel.start()
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ moduleId: 'spec.forger', generation: 1 })
    expect(Reflect.get(requests[0] as object, 'callerModuleId')).toBeUndefined()
    await kernel.dispose()
  })
})

describe('模块图与快照', () => {
  test('INV-4 模块只能解析自己声明过的能力', async () => {
    let failure: unknown
    const kernel = createKernel()
    kernel.registerModule(probeModule())
    kernel.registerModule(
      kernelModules.define({
        manifest: {
          id: 'spec.peeker',
          version: '1.0.0',
          apiVersion: 1,
          provides: [OtherCapability],
          requires: [],
          optionalRequires: [],
          permissions: [],
          isolation: 'in-process' as const,
        },
        activate(context) {
          context.registerService(OtherCapability, { peek: () => 'ok' })
          try {
            context.services.getOptional(ProbeCapability)
          } catch (error) {
            failure = error
          }
          return {}
        },
      })
    )
    await kernel.start()

    expect((failure as { code?: string }).code).toBe(KernelErrorCodes.undeclaredCapabilityAccess)
    await kernel.dispose()
  })

  test('INV-8 组合快照只读、确定、冻结，依赖图解析不了也给得出', async () => {
    const kernel = createKernel({ lifecycleFailureMode: 'degrade' })
    kernel.registerModule(
      kernelModules.define({
        manifest: {
          id: 'spec.needs-missing',
          version: '1.0.0',
          apiVersion: 1,
          provides: [],
          requires: [{ id: 'spec.absent' }],
          optionalRequires: [],
          permissions: [],
          isolation: 'in-process' as const,
        },
        activate: () => ({}),
      })
    )
    await kernel.start()

    const snapshot = kernel.describeComposition()
    expect(Object.isFrozen(snapshot)).toBeTrue()
    expect(snapshot.resolutionError).toBeString()
    expect(snapshot.moduleOrder).toEqual(['spec.needs-missing'])
    expect(kernel.describeComposition()).toEqual(snapshot)
    await kernel.dispose()
  })
})

describe('替换与事件隔离', () => {
  test('INV-6 替换失败不影响现有代；替换成功后旧代句柄立即失效', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(probeModule())
    await host.start()

    const before = host.getServiceHandle(ProbeCapability)
    expect(before.isActive()).toBeTrue()

    // 新代 ready 阶段抛错：整次替换回滚，现有代继续提供服务。
    const failure = await host
      .replaceModule(
        kernelModules.define({
          manifest: {
            id: 'spec.probe.module',
            version: '2.0.0',
            apiVersion: 1,
            provides: [ProbeCapability],
            requires: [],
            optionalRequires: [],
            permissions: ['spec:read'],
            isolation: 'in-process' as const,
          },
          activate(context) {
            context.registerService(ProbeCapability, kernelModules.callable({}))
            return {
              ready: () => {
                throw new Error('新代就绪失败')
              },
            }
          },
        })
      )
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(before.isActive()).toBeTrue()
    expect(host.getModule('spec.probe.module')?.generation).toBe(1)

    // 替换成功：旧句柄立刻失效，新一代接管。
    await host.replaceModule(
      kernelModules.define({
        manifest: {
          id: 'spec.probe.module',
          version: '2.0.0',
          apiVersion: 1,
          provides: [ProbeCapability],
          requires: [],
          optionalRequires: [],
          permissions: ['spec:read'],
          isolation: 'in-process' as const,
        },
        activate(context) {
          context.registerService(ProbeCapability, kernelModules.callable({}))
          return {}
        },
      })
    )
    expect(before.isActive()).toBeFalse()
    expect(host.getModule('spec.probe.module')?.generation).toBe(2)
    await host.dispose()
  })

  test('INV-7 一个事件订阅者失败不影响其他订阅者与发布方', async () => {
    const kernel = createKernel()
    const delivered: string[] = []
    kernel.registerModule(
      kernelModules.define({
        manifest: {
          id: 'spec.publisher',
          version: '1.0.0',
          apiVersion: 1,
          provides: [],
          requires: [],
          optionalRequires: [],
          permissions: [],
          isolation: 'in-process' as const,
        },
        activate(context) {
          context.events.subscribe('spec.ping', () => {
            throw new Error('订阅者自己炸了')
          })
          context.events.subscribe('spec.ping', () => {
            delivered.push('second')
          })
          return {
            async ready() {
              await context.events.publish('spec.ping', { at: 1 })
              delivered.push('publisher-survived')
            },
          }
        },
      })
    )
    await kernel.start()

    expect(delivered).toEqual(['second', 'publisher-survived'])
    await kernel.dispose()
  })
})

describe('会话与守护进程', () => {
  test('INV-14 会话之外的调用一律 CAPABILITY_NOT_GRANTED', async () => {
    const service = serviceWithTwoCapabilities()
    await service.start()
    const client = new KernelClient(new InProcessKernelTransport(service))
    const session = await client.openCapabilitySession({
      requires: [{ capabilityId: ProbeCapability.id, operations: null, scope: null }],
    })

    const granted = await session.call({
      protocolVersion: 2,
      callId: 'spec-call-1',
      capabilityId: ProbeCapability.id,
      operation: 'read',
      scope: null,
      input: {},
    })
    expect(granted).toMatchObject({ status: 'ok', output: 'probe' })

    const denied = await session.call({
      protocolVersion: 2,
      callId: 'spec-call-2',
      capabilityId: OtherCapability.id,
      operation: 'read',
      scope: null,
      input: {},
    })
    expect(denied).toMatchObject({
      status: 'error',
      error: { code: KernelCallErrorCodes.capabilityNotGranted },
    })

    await session.dispose()
    await client.dispose()
    await service.dispose()
  })

  test.skipIf(process.platform === 'win32')(
    'INV-15 POSIX descriptor 与锁文件 0600、运行目录 0700',
    async () => {
      const runtimeDirectory = join(await temporaryRuntimeDirectory(), 'runtime')
      const paths = createDefaultKernelDaemonPaths('velaros-kernel-spec', runtimeDirectory)
      const service = serviceWithTwoCapabilities()
      await service.start()
      const daemon = new KernelLocalDaemon({ paths, service })
      try {
        await daemon.start()
        expect((await stat(runtimeDirectory)).mode & 0o777).toBe(0o700)
        expect((await stat(paths.descriptorPath)).mode & 0o777).toBe(0o600)
        expect((await stat(paths.lockPath)).mode & 0o777).toBe(0o600)
      } finally {
        try {
          await daemon.dispose()
        } finally {
          await service.dispose()
        }
      }
    }
  )

  test('INV-16 单实例锁：活着的持有者不会被抢', async () => {
    const runtimeDirectory = join(await temporaryRuntimeDirectory(), 'runtime')
    const paths = createDefaultKernelDaemonPaths('velaros-kernel-spec', runtimeDirectory)
    const first = serviceWithTwoCapabilities()
    await first.start()
    const holder = new KernelLocalDaemon({ paths, service: first })
    await holder.start()

    const second = serviceWithTwoCapabilities()
    await second.start()
    const intruder = new KernelLocalDaemon({ paths, service: second })
    const failure = await intruder.start().catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toBe(KernelClientErrorCodes.daemonAlreadyRunning)

    await intruder.dispose()
    await second.dispose()
    await holder.dispose()
    await first.dispose()
  })
})

describe('协议协商', () => {
  test('INV-13 协议只接受完全相同的版本，异版本给出升级方向', () => {
    expect(negotiateKernelProtocol({ protocolVersion: 2 }, 2).status).toBe('accepted')
    const older = negotiateKernelProtocol({ protocolVersion: 1 }, 2)
    const newer = negotiateKernelProtocol({ protocolVersion: 3 }, 2)
    expect(older).toMatchObject({ status: 'rejected', reason: 'peer-too-old' })
    expect(newer).toMatchObject({ status: 'rejected', reason: 'peer-too-new' })
  })
})

describe('配对与更新器', () => {
  test('INV-20 配对码失败锁定，重开窗口不清零失败计数', () => {
    const timers = new TimerScope('kernel-spec-pairing')
    let now = 1_700_000_000_000
    const gate = new RemoteNodePairingGate({
      timers,
      now: () => now,
      pairingCode: '123456',
    })
    try {
      gate.open()
      expect(gate.available).toBeTrue()
      for (let attempt = 0; attempt < RemoteNodeLimits.pairingFailureLimit; attempt += 1) {
        expect(gate.accept('000000')).toBeFalse()
      }
      // 连续失败到上限：进锁定窗口，码不再展示。
      expect(gate.available).toBeFalse()
      expect(gate.code).toBeNull()

      // 重开窗口不清零失败计数：锁定期内仍然不可用，正确的码也不放行。
      gate.open()
      expect(gate.available).toBeFalse()
      expect(gate.accept('123456')).toBeFalse()

      // 锁定窗口过去之后才重新可用。
      now += RemoteNodeLimits.pairingLockoutMs + 1
      gate.open()
      expect(gate.available).toBeTrue()
      expect(gate.accept('123456')).toBeTrue()
    } finally {
      gate.cancel()
      timers.dispose()
    }
  })

  test('INV-21 摘要对不上不落位；健康检查不过回滚指针', async () => {
    const root = join(await temporaryRuntimeDirectory(), 'kernel-home')
    const good = artifactOf('https://cdn.example.com/kernel-1.0.0.bin', 'kernel-1.0.0')
    const tampered = artifactOf('https://cdn.example.com/kernel-1.1.0.bin', 'kernel-1.1.0')
    const manifestSource = 'https://updates.example.com/kernel.json'
    const manifest = manifestOf([
      { version: '1.0.0', artifacts: { 'linux-x64': good.descriptor } },
      // 清单声明的 sha256 是好制品的，下载到的却是另一份字节：必须在落位之前拒掉。
      {
        version: '1.1.0',
        artifacts: { 'linux-x64': { ...tampered.descriptor, sha256: good.descriptor.sha256 } },
      },
    ])
    const updater = new KernelUpdater({
      root,
      target: 'linux-x64',
      manifestSource,
      fetch: createFakeFetch({
        [manifestSource]: JSON.stringify(manifest),
        [good.descriptor.url]: good.bytes,
        [tampered.descriptor.url]: tampered.bytes,
      }),
    })

    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')
    expect(await updater.getActiveVersion()).toBe('1.0.0')

    const rejected = await updater.ensureInstalled('1.1.0').catch((error: unknown) => error)
    expect((rejected as { code?: string }).code).toBe(KernelUpdaterErrorCodes.digestMismatch)
    expect((await updater.listInstalledVersions()).filter((entry) => entry.complete)).toHaveLength(
      1
    )

    // 健康检查不过：指针恢复成切换前那一个。
    await updater.ensureInstalled('1.0.0')
    const unhealthy = await updater
      .activateVersion('1.0.0', { healthCheck: () => Promise.resolve(false) })
      .catch((error: unknown) => error)
    expect((unhealthy as { code?: string }).code).toBe(KernelUpdaterErrorCodes.healthCheckFailed)
    expect(await updater.getActiveVersion()).toBe('1.0.0')
  })
})

describe('类型钉死的承诺', () => {
  test('INV-23 KernelModulePermissionRequest 没有 callerModuleId 字段', () => {
    // 编译期就钉死：多写一个 callerModuleId 会让下面这行过不了 tsc。
    const request: KernelModulePermissionRequest = { permission: 'spec:read' }
    expect(Object.keys(request)).toEqual(['permission'])
  })
})
