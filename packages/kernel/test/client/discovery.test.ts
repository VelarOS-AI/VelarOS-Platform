import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { KernelProtocolVersion } from '@velaros-ai/kernel/contracts/protocol'

import { createDefaultKernelDaemonPaths } from '../../src/client/contracts'
import {
  connectToKernelDaemon,
  discoverKernelDaemon,
} from '../../src/client/discovery'

import {
  descriptorFor,
  FakeKernelEndpoint,
  type ReceivedRequest,
  temporaryRuntimeDirectory,
  writeDescriptorFile,
} from './fake-kernel-endpoint'

const directories: string[] = []
const endpoints: FakeKernelEndpoint[] = []

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.dispose()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function handshakeResponder(handshake: {
  protocolVersion: number
  kernelVersion: string
}) {
  return (
    request: ReceivedRequest,
    connection: { send(frame: unknown): void },
  ) => {
    if (request.method !== 'handshake') return
    connection.send({
      type: 'response',
      requestId: request.requestId,
      status: 'ok',
      result: { ...handshake, modules: [] },
    })
  }
}

async function startKernel(handshake: {
  protocolVersion: number
  kernelVersion: string
}) {
  const directory = await temporaryRuntimeDirectory(directories)
  const endpoint = new FakeKernelEndpoint(
    handshakeResponder(handshake) as ConstructorParameters<
      typeof FakeKernelEndpoint
    >[0],
  )
  endpoints.push(endpoint)
  await endpoint.start(join(directory, 'kernel.sock'))
  const paths = createDefaultKernelDaemonPaths('test-kernel', directory)
  return { endpoint, paths }
}

describe('kernel daemon discovery', () => {
  test('returns a stable error when no Kernel is running', async () => {
    const directory = await temporaryRuntimeDirectory(directories)
    const paths = createDefaultKernelDaemonPaths('test-kernel', directory)

    await expect(discoverKernelDaemon(paths)).rejects.toMatchObject({
      name: 'KernelClientError',
      code: 'DAEMON_NOT_RUNNING',
    })
    await expect(connectToKernelDaemon(paths)).rejects.toMatchObject({
      code: 'DAEMON_NOT_RUNNING',
    })
  })

  test('rejects a descriptor that is not valid JSON', async () => {
    const directory = await temporaryRuntimeDirectory(directories)
    const paths = createDefaultKernelDaemonPaths('test-kernel', directory)
    await Bun.write(paths.descriptorPath, 'not json at all\n')

    await expect(discoverKernelDaemon(paths)).rejects.toMatchObject({
      code: 'DAEMON_DESCRIPTOR_INVALID',
    })
  })

  test('rejects structurally invalid descriptors', async () => {
    const { endpoint, paths } = await startKernel({
      protocolVersion: KernelProtocolVersion,
      kernelVersion: '0.3.0',
    })
    const valid = descriptorFor(endpoint.getEndpoint())

    const invalidVariants: Record<string, unknown> = {
      'missing instanceId': { ...valid, instanceId: '' },
      'short auth token': { ...valid, authToken: 'too-short' },
      'non-integer pid': { ...valid, pid: 1.5 },
      'unknown endpoint kind': {
        ...valid,
        endpoint: { kind: 'pipe', path: '/tmp/x' },
      },
      'non-loopback tcp host': {
        ...valid,
        endpoint: { kind: 'tcp', host: '0.0.0.0', port: 1234 },
      },
    }

    for (const [label, descriptor] of Object.entries(invalidVariants)) {
      await writeDescriptorFile(paths, descriptor)
      const rejection = discoverKernelDaemon(paths)
      await expect(rejection, label).rejects.toMatchObject({
        code: 'DAEMON_DESCRIPTOR_INVALID',
      })
    }
  })

  test('connects and verifies the handshake against the descriptor', async () => {
    const { endpoint, paths } = await startKernel({
      protocolVersion: KernelProtocolVersion,
      kernelVersion: '0.3.0',
    })
    await writeDescriptorFile(paths, descriptorFor(endpoint.getEndpoint()))

    const connected = await connectToKernelDaemon(paths)
    try {
      expect(connected.handshake.kernelVersion).toBe('0.3.0')
      expect(connected.descriptor.instanceId).toBe('fake-instance')
    } finally {
      await connected.client.dispose()
    }
  })

  test('refuses even an adjacent protocol version with upgrade guidance', async () => {
    const futureVersion = KernelProtocolVersion + 1
    const { endpoint, paths } = await startKernel({
      protocolVersion: futureVersion,
      kernelVersion: '9.0.0',
    })
    await writeDescriptorFile(
      paths,
      descriptorFor(endpoint.getEndpoint(), {
        protocolVersion: futureVersion,
        kernelVersion: '9.0.0',
      }),
    )

    const rejection = await connectToKernelDaemon(paths).catch(
      (error: unknown) => error,
    )
    expect(rejection).toMatchObject({
      name: 'KernelClientError',
      code: 'PROTOCOL_VERSION_MISMATCH',
    })
    expect((rejection as { guidance?: string }).guidance).toContain(
      `v${futureVersion}`,
    )
  })

  test('refuses a descriptor whose kernel version drifted from the live endpoint', async () => {
    const { endpoint, paths } = await startKernel({
      protocolVersion: KernelProtocolVersion,
      kernelVersion: '0.3.0',
    })
    await writeDescriptorFile(
      paths,
      descriptorFor(endpoint.getEndpoint(), { kernelVersion: '0.2.0' }),
    )

    await expect(connectToKernelDaemon(paths)).rejects.toMatchObject({
      code: 'DAEMON_DESCRIPTOR_INVALID',
    })
  })
})
