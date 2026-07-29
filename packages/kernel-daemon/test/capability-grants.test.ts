import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'
import { KernelHostBridgeRegistry,KernelModuleHost } from '@velaros-ai/core/kernel/host'
import { KernelProtocolVersion } from '@velaros-ai/core/kernel/protocol'
import {
  AllowLoadedKernelClientAccessBroker,
  KernelService,
} from '@velaros-ai/core/kernel/runtime'
import { KernelClient, SocketKernelTransport } from '@velaros-ai/kernel-client'

import {
  installModPackFromDirectory,
  KernelModLoader,
  KernelModStore,
} from '../src/daemon'
import { InProcessKernelTransport } from '../src/internal'
import { KernelLocalRpcServer } from '../src/rpc'

const Token = createCapabilityToken('test.grants')
const AuthToken = 'grant-auth-token-0123456789-abcdefgh'
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function createService(): KernelService {
  const host = new KernelModuleHost({ apiVersion: 1 })
  const definition: KernelModuleDefinition = {
    manifest: {
      id: 'module.grants',
      version: '1.0.0',
      apiVersion: 1,
      provides: [Token],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        Token,
        createKernelCallableCapability({
          read: {
            metadata: { permissions: [] },
            invoke: () => 'granted-output',
          },
          write: {
            metadata: { permissions: [] },
            invoke: () => 'write-output',
          },
        }),
      )
    },
  }
  host.registerModule(definition)
  return new KernelService({
    host,
    kernelVersion: '0.3.0',
    clientAccessBroker: new AllowLoadedKernelClientAccessBroker(host),
  })
}

function callRequest(sessionId: string, operation = 'read') {
  return {
    protocolVersion: KernelProtocolVersion,
    callId: `call-${operation}`,
    sessionId,
    capabilityId: Token.id,
    operation,
    scope: null,
    input: null,
  } as const
}

describe('capability session bind', () => {
  test('rejects call without session, allows after open, rejects after dispose', async () => {
    const service = createService()
    await service.start()
    const transport = new InProcessKernelTransport(service)
    const client = new KernelClient(transport)

    expect(await transport.call(callRequest('missing-session'))).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_GRANTED' },
    })

    const session = await client.openCapabilitySession({
      requires: [
        { capabilityId: Token.id, operations: ['read'], scope: null },
      ],
    })

    expect(await session.call({
      protocolVersion: KernelProtocolVersion,
      callId: 'call-read',
      capabilityId: Token.id,
      operation: 'read',
      scope: null,
      input: null,
    })).toMatchObject({
      status: 'ok',
      output: 'granted-output',
    })
    expect(await session.call({
      protocolVersion: KernelProtocolVersion,
      callId: 'call-write',
      capabilityId: Token.id,
      operation: 'write',
      scope: null,
      input: null,
    })).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_GRANTED' },
    })

    expect(await session.dispose()).toEqual({
      protocolVersion: KernelProtocolVersion,
      closed: true,
    })

    expect(await transport.call(callRequest(session.sessionId, 'read'))).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_GRANTED' },
    })

    await service.dispose()
  })

  test('isolates sessions across RPC connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-grants-'))
    temporaryDirectories.push(directory)
    const service = createService()
    const server = new KernelLocalRpcServer({
      authToken: AuthToken,
      endpoint: { kind: 'unix', path: join(directory, 'kernel.sock') },
      service,
    })
    const endpoint = await server.start()

    const first = new KernelClient(new SocketKernelTransport({
      authToken: AuthToken,
      endpoint,
    }))
    const second = new KernelClient(new SocketKernelTransport({
      authToken: AuthToken,
      endpoint,
    }))

    try {
      const firstSession = await first.openCapabilitySession({
        requires: [
          { capabilityId: Token.id, operations: null, scope: null },
        ],
      })
      expect(await firstSession.call({
        protocolVersion: KernelProtocolVersion,
        callId: 'a',
        capabilityId: Token.id,
        operation: 'read',
        scope: null,
        input: null,
      })).toMatchObject({ status: 'ok', output: 'granted-output' })

      await expect(
        second.openCapabilitySession({
          requires: [
            { capabilityId: Token.id, operations: null, scope: null },
          ],
        }).then(async (session) => session.call({
          protocolVersion: KernelProtocolVersion,
          callId: 'b',
          capabilityId: Token.id,
          operation: 'read',
          scope: null,
          input: null,
        })),
      ).resolves.toMatchObject({ status: 'ok', output: 'granted-output' })
    } finally {
      await first.dispose()
      await second.dispose()
      await server.dispose()
    }
  })

  test('deny-all client access broker blocks session open', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule({
      manifest: {
        id: 'module.denied',
        version: '1.0.0',
        apiVersion: 1,
        provides: [Token],
        requires: [],
        optionalRequires: [],
        permissions: [],
        isolation: 'in-process',
      },
      activate(context) {
        context.registerService(
          Token,
          createKernelCallableCapability({
            read: {
              metadata: { permissions: [] },
              invoke: () => 'nope',
            },
          }),
        )
      },
    })
    const service = new KernelService({ host, kernelVersion: '0.3.0' })
    await service.start()
    const client = new KernelClient(new InProcessKernelTransport(service))

    await expect(
      client.openCapabilitySession({
        requires: [
          { capabilityId: Token.id, operations: null, scope: null },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_BIND_DENIED' })

    await service.dispose()
  })

  test('ModStore installs user packs and ModLoader loads them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-modstore-'))
    temporaryDirectories.push(directory)
    const packDir = join(directory, 'echo-pack')
    await mkdir(packDir)
    await writeFile(
      join(packDir, 'index.mjs'),
      `
export default {
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
    // Sectioned single-file manifest: the Kernel reads `module` and nothing else.
    await writeFile(
      join(packDir, 'velaros.mod.json'),
      JSON.stringify({
        module: {
          id: 'user.echo',
          version: '1.0.0',
          apiVersion: 1,
          entry: './index.mjs',
          provides: [{ id: 'test.user.echo', version: '1.0.0' }],
        },
        agent: { id: 'user.echo', manifestSchemaVersion: 1 },
      }),
    )

    const store = new KernelModStore({
      userModsDirectory: join(directory, 'mods'),
      indexPath: join(directory, 'mod-index.json'),
    })
    const pack = await installModPackFromDirectory(store, packDir)
    expect(pack.id).toBe('user.echo')
    expect(store.listEnabled()).toHaveLength(1)

    const loaded = await new KernelModLoader(store).loadEnabled()
    expect(loaded.modules).toHaveLength(1)
    expect(loaded.modules[0]?.manifest.id).toBe('module.user-echo')
  })

  test('HostBridge registry builds isolation adapters', () => {
    const registry = new KernelHostBridgeRegistry()
    registry.register({
      id: 'velaros.browser',
      isolation: 'sidecar',
      activate: () => ({ dispose() {} }),
    })
    const adapters = registry.toIsolationAdapters()
    expect(adapters).toHaveLength(1)
    expect(adapters[0]?.isolation).toBe('sidecar')
  })
})
