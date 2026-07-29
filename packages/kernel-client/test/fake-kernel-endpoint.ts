import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  KernelDaemonEndpointDescriptor,
  KernelDaemonPaths,
  KernelRpcEndpoint,
  KernelRpcServerFrame,
} from '../src/contracts'

export interface ReceivedRequest {
  readonly requestId: string
  readonly authToken: string
  readonly method: string
  readonly params: unknown
}

export type RequestResponder = (
  request: ReceivedRequest,
  connection: FakeKernelConnection,
) => void | Promise<void>

export interface FakeKernelConnection {
  send(frame: KernelRpcServerFrame): void
  sendRaw(line: string): void
  destroy(): void
}

/**
 * Minimal newline-delimited JSON endpoint used to drive the client under test.
 *
 * The client package must be provable without the Kernel runtime, so these
 * tests speak the wire protocol directly instead of booting a real Kernel.
 */
export class FakeKernelEndpoint {
  public readonly received: ReceivedRequest[] = []
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private endpoint?: KernelRpcEndpoint
  private socketPath?: string

  public constructor(private readonly respond: RequestResponder) {
    this.server = createServer((socket) => this.accept(socket))
  }

  public async start(socketPath: string): Promise<KernelRpcEndpoint> {
    this.socketPath = socketPath
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(socketPath, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.endpoint = { kind: 'unix', path: socketPath }
    return this.endpoint
  }

  public getEndpoint(): KernelRpcEndpoint {
    if (this.endpoint === undefined) throw new Error('endpoint not started')
    return this.endpoint
  }

  /** Drops every live connection without closing the listener. */
  public dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  public async dispose(): Promise<void> {
    this.dropConnections()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
    if (this.socketPath !== undefined) {
      await rm(this.socketPath, { force: true })
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    this.sockets.add(socket)
    const connection: FakeKernelConnection = {
      send: (frame) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`)
      },
      sendRaw: (line) => {
        if (!socket.destroyed) socket.write(`${line}\n`)
      },
      destroy: () => socket.destroy(),
    }
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) {
          const parsed = JSON.parse(line) as ReceivedRequest
          this.received.push(parsed)
          void this.respond(parsed, connection)
        }
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => this.sockets.delete(socket))
  }
}

export async function temporaryRuntimeDirectory(
  registry: string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-kernel-client-'))
  registry.push(directory)
  return directory
}

export async function writeDescriptorFile(
  paths: KernelDaemonPaths,
  descriptor: unknown,
): Promise<void> {
  await writeFile(
    paths.descriptorPath,
    `${JSON.stringify(descriptor)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

export function descriptorFor(
  endpoint: KernelRpcEndpoint,
  overrides: Partial<KernelDaemonEndpointDescriptor> = {},
): KernelDaemonEndpointDescriptor {
  return {
    authToken: 'fake-auth-token-0123456789-abcdefgh',
    instanceId: 'fake-instance',
    protocolVersion: 2,
    kernelVersion: '0.3.0',
    pid: process.pid,
    startedAt: 1,
    endpoint,
    ...overrides,
  }
}
