import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { WebSocket } from 'ws'

import {
  ExternalAgentBridgeProtocolVersion,
} from '@velaros-ai/agent/protocol'
import type { ComputerRuntimePort } from '@velaros-ai/computer/runtime'
import { ProviderSurfaceProtocolVersion } from '@velaros-ai/surface-protocol'

import { startVelarHost, type VelarHostRuntime } from '../src/host'
import {
  callVelarHostManagement,
  type VelarHostManagementOperation,
} from '../src/management-ipc'
import { runServeCli } from '../src/serve-cli'

class MessageInbox {
  private readonly messages: Array<Record<string, unknown>> = []
  private readonly waiters: Array<{
    type: string
    resolve(value: Record<string, unknown>): void
    reject(error: Error): void
    timeout: ReturnType<typeof setTimeout>
  }> = []

  public constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type)
      if (waiterIndex < 0) {
        this.messages.push(message)
        return
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timeout)
      waiter.resolve(message)
    })
  }

  public next(type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const queuedIndex = this.messages.findIndex((message) => message.type === type)
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0])
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`Timed out waiting for ${type}`))
      }, timeoutMs)
      this.waiters.push({ type, resolve, reject, timeout })
    })
  }
}

function openExtensionSocket(endpoint: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint, {
    headers: { Origin: `chrome-extension://${'a'.repeat(32)}` },
  })
  socket.on('error', () => undefined)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  socket.send(JSON.stringify({ version: ExternalAgentBridgeProtocolVersion, ...message }))
}

async function expectToolProgress(
  socket: WebSocket,
  inbox: MessageInbox,
  expected: { surfaceId: string; toolCallId: string },
): Promise<void> {
  const message = await inbox.next('command')
  const command = message.command as Record<string, unknown>
  expect(command.type).toBe('provider_surface_tool_progress')
  expect(command.payload).toMatchObject({ ...expected, phase: 'running' })
  send(socket, { type: 'ack', sequence: command.sequence })
}

async function callProviderTool(input: {
  socket: WebSocket
  inbox: MessageInbox
  eventId: string
  surfaceId: string
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  send(input.socket, {
    type: 'event',
    eventId: input.eventId,
    event: {
      type: 'provider_surface_tool_call',
      correlationId: `${input.eventId}-correlation`,
      surfaceId: input.surfaceId,
      call: {
        protocolVersion: ProviderSurfaceProtocolVersion,
        contractId: input.contractId,
        catalogRevision: input.catalogRevision,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.toolInput,
      },
    },
  })
  await expectToolProgress(input.socket, input.inbox, {
    surfaceId: input.surfaceId,
    toolCallId: input.toolCallId,
  })
  const command = await input.inbox.next('command')
  await input.inbox.next('event_ack')
  const envelope = command.command as Record<string, unknown>
  const result = (envelope.payload as { result: Record<string, unknown> }).result
  send(input.socket, { type: 'ack', sequence: envelope.sequence })
  return result
}

class FakeComputerRuntime implements ComputerRuntimePort {
  public readonly calls: string[] = []

  public isReady(): boolean {
    return true
  }

  public ensureAvailable() {
    this.calls.push('ensure_available')
    return Promise.resolve({
      available: true as const,
      reason: 'available' as const,
      detail: null,
      permissions: { platform: 'test', accessibility: true, screenRecording: true },
    })
  }

  public screenSize() {
    this.calls.push('screen_size')
    return Promise.resolve({
      displayId: 1,
      width: 1280,
      height: 720,
      scaleFactor: 1,
      originX: 0,
      originY: 0,
    })
  }

  public screenshot() {
    this.calls.push('screenshot')
    return Promise.resolve({
      base64: 'aW1hZ2U=',
      format: 'jpeg' as const,
      width: 1280,
      height: 720,
      displayWidth: 1280,
      displayHeight: 720,
      displayId: 1,
      originX: 0,
      originY: 0,
      scaleFactor: 1,
    })
  }

  public mouseMove(x: number, y: number) {
    this.calls.push(`mouse_move:${x}:${y}`)
    return Promise.resolve({ x, y })
  }

  public leftClick(
    x: number,
    y: number,
    options: { button?: 'left' | 'right' | 'middle'; count?: number } = {},
  ) {
    this.calls.push(`left_click:${x}:${y}`)
    return Promise.resolve({
      x,
      y,
      button: options.button ?? 'left',
      count: options.count ?? 1,
    })
  }

  public typeText(text: string) {
    this.calls.push(`type:${text}`)
    return Promise.resolve({ typed: text.length })
  }

  public key(keys: string) {
    this.calls.push(`key:${keys}`)
    return Promise.resolve({ pressed: keys.split('+') })
  }

  public dispose(): void {
    this.calls.push('dispose')
  }
}

function manage<Result = unknown>(
  runtime: VelarHostRuntime,
  operation: VelarHostManagementOperation,
  payload?: unknown,
): Promise<Result> {
  return callVelarHostManagement<Result>(runtime.status.management.endpoint, operation, payload)
}

describe('Velar Host extension journey without Desktop', () => {
  let runtime: VelarHostRuntime | undefined
  let temporaryRoot: string | undefined

  afterEach(async () => {
    await runtime?.stop()
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('pairs, reads through Kernel, denies writes, and resumes without Desktop', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-e2e-'))
    const workspaceRoot = join(temporaryRoot, 'workspace')
    const dataRoot = join(temporaryRoot, 'data')
    await Bun.write(join(workspaceRoot, 'proof.txt'), 'VELAR_HOST_EXTENSION_E2E_OK\n')

    runtime = await startVelarHost({
      projectRoot: workspaceRoot,
      dataRoot,
      portStart: 0,
      portEnd: 0,
      pairingCode: '123456',
    })
    expect(runtime.status.kernel.moduleIds).toEqual([
      'velaros.computer.sidecar',
      'velaros.project',
      'velaros.system',
    ])
    expect(runtime.status.extension.pairingCode).toBe('123456')

    const socket = await openExtensionSocket(runtime.status.extension.endpoint)
    const inbox = new MessageInbox(socket)
    send(socket, { type: 'probe' })
    const hello = await inbox.next('hello')
    expect(hello.service).toBe('velaros-external-agent')
    expect(hello.pairingAvailable).toBe(true)

    send(socket, {
      type: 'pair',
      code: '123456',
      provider: 'chatgpt',
      capabilities: ['chat'],
      tabUrl: 'https://chatgpt.com/',
      modelLabel: null,
      providerSnapshot: null,
    })
    const paired = await inbox.next('paired')
    const token = String(paired.token)
    const device = paired.device as Record<string, unknown>
    expect(token.length).toBeGreaterThan(32)
    expect(device.provider).toBe('chatgpt')
    expect(runtime.status.extension.connected).toBe(true)

    send(socket, {
      type: 'event',
      eventId: 'event-catalog',
      event: { type: 'provider_workspace_catalog', correlationId: 'catalog-1' },
    })
    const catalogCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const catalogEnvelope = catalogCommand.command as Record<string, unknown>
    const catalogPayload = catalogEnvelope.payload as Record<string, unknown>
    const workspaceCatalog = catalogPayload.catalog as {
      workspaces: Array<{ id: string; space: string }>
    }
    expect(workspaceCatalog.workspaces.map((workspace) => workspace.space))
      .toEqual(['system', 'project'])
    const workspaceBindingId = workspaceCatalog.workspaces
      .find((workspace) => workspace.space === 'project')!.id
    send(socket, { type: 'ack', sequence: catalogEnvelope.sequence })

    send(socket, {
      type: 'event',
      eventId: 'event-prepare',
      event: {
        type: 'provider_surface_prepare',
        correlationId: 'prepare-1',
        surfaceId: 'surface-1',
        workspaceBindingId,
        providerConversationId: null,
        providerParentMessageId: null,
        message: null,
      },
    })
    const contractCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const contractEnvelope = contractCommand.command as Record<string, unknown>
    const contractPayload = contractEnvelope.payload as Record<string, unknown>
    const binding = contractPayload.binding as {
      surfaceOwner: string
      workspaceSpace: string
      toolContract: { id: string; catalogRevision: string }
    }
    const toolCatalog = contractPayload.toolCatalog as {
      revision: string
      tools: Array<{ name: string; readOnly?: boolean }>
    }
    expect(binding.surfaceOwner).toBe('provider')
    expect(binding.workspaceSpace).toBe('project')
    expect(toolCatalog.tools.some((tool) => tool.name === 'project:read')).toBe(true)
    expect(toolCatalog.tools.some((tool) => tool.name === 'computer:screenshot')).toBe(false)
    expect(toolCatalog.tools.every((tool) => tool.readOnly === true)).toBe(true)
    expect(toolCatalog.tools.some((tool) => tool.name === 'project:edit')).toBe(false)
    expect(runtime.status.extension.surfaceCount).toBe(1)
    expect(runtime.status.extension.activity?.eventType).toBe('provider_surface_prepare')
    send(socket, { type: 'ack', sequence: contractEnvelope.sequence })

    const readCall = {
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'tool-read-1',
      toolName: 'project:read',
      input: { path: 'proof.txt', maxChars: 200 },
    }
    send(socket, {
      type: 'event',
      eventId: 'event-read',
      event: {
        type: 'provider_surface_tool_call',
        correlationId: 'tool-correlation-1',
        surfaceId: 'surface-1',
        call: readCall,
      },
    })
    await expectToolProgress(socket, inbox, {
      surfaceId: 'surface-1',
      toolCallId: 'tool-read-1',
    })
    const resultCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const resultEnvelope = resultCommand.command as Record<string, unknown>
    const resultPayload = resultEnvelope.payload as Record<string, unknown>
    const result = resultPayload.result as {
      status: string
      output: { files: Array<{ content: string }> }
    }
    expect(result.status).toBe('success')
    expect(result.output.files[0].content).toBe('VELAR_HOST_EXTENSION_E2E_OK\n')
    expect(runtime.status.extension.activity).toMatchObject({
      eventType: 'provider_surface_tool_result',
      toolName: 'project:read',
      status: 'success',
    })
    send(socket, { type: 'ack', sequence: resultEnvelope.sequence })

    send(socket, {
      type: 'event',
      eventId: 'event-write-denied',
      event: {
        type: 'provider_surface_tool_call',
        correlationId: 'tool-correlation-2',
        surfaceId: 'surface-1',
        call: {
          ...readCall,
          toolCallId: 'tool-write-1',
          toolName: 'project:edit',
          input: {
            operations: [{ type: 'replace_text', path: 'proof.txt', search: 'E2E', replacement: 'MUTATED' }],
          },
        },
      },
    })
    await expectToolProgress(socket, inbox, {
      surfaceId: 'surface-1',
      toolCallId: 'tool-write-1',
    })
    const deniedCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const deniedEnvelope = deniedCommand.command as Record<string, unknown>
    const deniedPayload = deniedEnvelope.payload as Record<string, unknown>
    const deniedResult = deniedPayload.result as { status: string }
    expect(deniedResult.status).toBe('denied')
    expect(await readFile(join(workspaceRoot, 'proof.txt'), 'utf8'))
      .toBe('VELAR_HOST_EXTENSION_E2E_OK\n')
    send(socket, { type: 'ack', sequence: deniedEnvelope.sequence })

    socket.terminate()
    const resumedSocket = await openExtensionSocket(runtime.status.extension.endpoint)
    const resumedInbox = new MessageInbox(resumedSocket)
    send(resumedSocket, { type: 'probe' })
    const resumedHello = await resumedInbox.next('hello')
    expect(resumedHello.deviceId).toBe(device.id)
    send(resumedSocket, {
      type: 'resume',
      token,
      deviceId: device.id,
      after: Number(deniedEnvelope.sequence),
    })
    const resumed = await resumedInbox.next('resumed')
    expect(resumed.after).toBe(Number(deniedEnvelope.sequence))

    const credential = JSON.parse(await readFile(runtime.paths.credentialPath, 'utf8'))
    expect(credential.device.id).toBe(device.id)
    expect((await stat(runtime.paths.credentialPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(runtime.paths.statusPath, 'utf8')).not.toContain(token)
    resumedSocket.terminate()
  })

  test('renews the project contract across provider context replacement', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-context-e2e-'))
    const workspaceRoot = join(temporaryRoot, 'workspace')
    const dataRoot = join(temporaryRoot, 'data')
    await Bun.write(join(workspaceRoot, 'anchor.txt'), 'COMPACTION_ANCHOR_OK\n')

    runtime = await startVelarHost({
      projectRoot: workspaceRoot,
      dataRoot,
      portStart: 0,
      portEnd: 0,
      pairingCode: '112233',
    })
    const socket = await openExtensionSocket(runtime.status.extension.endpoint)
    const inbox = new MessageInbox(socket)
    send(socket, {
      type: 'pair',
      code: '112233',
      provider: 'chatgpt',
      capabilities: ['chat'],
      tabUrl: 'https://chatgpt.com/',
      modelLabel: null,
      providerSnapshot: null,
    })
    await inbox.next('paired')

    send(socket, {
      type: 'event',
      eventId: 'context-catalog',
      event: { type: 'provider_workspace_catalog', correlationId: 'context-catalog-1' },
    })
    const catalogCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const catalogEnvelope = catalogCommand.command as Record<string, unknown>
    const catalogPayload = catalogEnvelope.payload as {
      catalog: { workspaces: Array<{ id: string; space: string }> }
    }
    const projectWorkspaceBindingId = catalogPayload.catalog.workspaces
      .find((workspace) => workspace.space === 'project')!.id
    send(socket, { type: 'ack', sequence: catalogEnvelope.sequence })

    for (let turn = 0; turn < 24; turn += 1) {
      send(socket, {
        type: 'event',
        eventId: `context-prepare-${turn}`,
        event: {
          type: 'provider_surface_prepare',
          correlationId: `context-prepare-correlation-${turn}`,
          surfaceId: 'surface-context',
          workspaceBindingId: projectWorkspaceBindingId,
          providerConversationId: 'conversation-context',
          providerParentMessageId:
            turn < 12 ? `parent-${turn}` : `compacted-parent-${turn}`,
          message: turn === 12
            ? {
                id: 'compaction-anchor-message',
                role: 'user',
                text: 'Continue using the current project after provider context replacement.',
                timestamp: turn,
              }
            : null,
        },
      })
      const contractCommand = await inbox.next('command')
      await inbox.next('event_ack')
      const contractEnvelope = contractCommand.command as Record<string, unknown>
      const contractPayload = contractEnvelope.payload as {
        binding: {
          workspaceSpace: string
          providerParentMessageId: string
          toolContract: { id: string; catalogRevision: string }
        }
        toolCatalog: { tools: Array<{ name: string }> }
      }
      expect(contractPayload.binding.workspaceSpace).toBe('project')
      expect(contractPayload.binding.providerParentMessageId)
        .toBe(turn < 12 ? `parent-${turn}` : `compacted-parent-${turn}`)
      expect(contractPayload.toolCatalog.tools.some((tool) => tool.name === 'project:list'))
        .toBe(true)
      expect(contractPayload.toolCatalog.tools.some((tool) => tool.name === 'computer:screenshot'))
        .toBe(false)
      send(socket, { type: 'ack', sequence: contractEnvelope.sequence })

      send(socket, {
        type: 'event',
        eventId: `context-tool-${turn}`,
        event: {
          type: 'provider_surface_tool_call',
          correlationId: `context-tool-correlation-${turn}`,
          surfaceId: 'surface-context',
          call: {
            protocolVersion: ProviderSurfaceProtocolVersion,
            contractId: contractPayload.binding.toolContract.id,
            catalogRevision: contractPayload.binding.toolContract.catalogRevision,
            toolCallId: `context-status-${turn}`,
            toolName: 'project:list',
            input: { path: '.', limit: 10 },
          },
        },
      })
      await expectToolProgress(socket, inbox, {
        surfaceId: 'surface-context',
        toolCallId: `context-status-${turn}`,
      })
      const resultCommand = await inbox.next('command')
      await inbox.next('event_ack')
      const resultEnvelope = resultCommand.command as Record<string, unknown>
      const result = (resultEnvelope.payload as {
        result: { status: string; output: { rootPath: string } }
      }).result
      expect(result.status).toBe('success')
      expect(result.output.rootPath).toBe(workspaceRoot)
      send(socket, { type: 'ack', sequence: resultEnvelope.sequence })
    }

    expect(runtime.status.extension.activity).toMatchObject({
      eventType: 'provider_surface_tool_result',
      toolName: 'project:list',
      status: 'success',
    })
    socket.terminate()
  })

  test('uses local management IPC to grant Computer tools and returns screenshots as artifacts', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-computer-e2e-'))
    const workspaceRoot = join(temporaryRoot, 'workspace')
    const dataRoot = join(temporaryRoot, 'data')
    const computer = new FakeComputerRuntime()
    await Bun.write(join(workspaceRoot, 'proof.txt'), 'MANAGEMENT_IPC_OK\n')
    await Bun.write(join(dataRoot, 'control', 'token'), 'retired-token\n')

    runtime = await startVelarHost({
      projectRoot: workspaceRoot,
      dataRoot,
      portStart: 0,
      portEnd: 0,
      pairingCode: '654321',
      computerRuntime: computer,
      computerInstaller: () => Promise.resolve({
        installed: true,
        resourceRoot: join(dataRoot, 'resources'),
        packageRoot: join(dataRoot, 'resources', 'computer-use', 'computeruse-test'),
        pythonCommand: join(dataRoot, 'resources', 'computer-use', 'computeruse-test', 'python'),
        replacedPath: null,
      }),
    })

    expect(runtime.status.management.endpoint.startsWith('http')).toBe(false)
    expect(runtime.status.management.kind).toBe(process.platform === 'win32' ? 'pipe' : 'unix')
    if (process.platform !== 'win32') {
      expect((await stat(runtime.status.management.endpoint)).isSocket()).toBe(true)
    }
    const publicStatus = JSON.parse(await readFile(runtime.paths.statusPath, 'utf8')) as {
      schemaVersion: number
      management?: unknown
      control?: unknown
    }
    expect(publicStatus.schemaVersion).toBe(3)
    expect(publicStatus.management).toBeDefined()
    expect(publicStatus.control).toBeUndefined()
    await expect(stat(join(dataRoot, 'control', 'token'))).rejects.toMatchObject({ code: 'ENOENT' })

    const statusCli = await runServeCli(['status', '--data-root', dataRoot, '--json'])
    expect(statusCli.exitCode).toBe(0)
    expect(JSON.parse(statusCli.text)).toMatchObject({
      running: true,
      host: { pid: process.pid, schemaVersion: 3 },
    })
    const configCli = await runServeCli(['config', 'show', '--data-root', dataRoot, '--json'])
    expect(configCli.exitCode).toBe(0)
    expect(JSON.parse(configCli.text)).toMatchObject({
      capabilities: { project: { read: true } },
      confirmations: [],
    })
    const remotePairCli = await runServeCli(['remote', 'pair', '--data-root', dataRoot, '--json'])
    expect(remotePairCli.exitCode).toBe(1)
    expect(remotePairCli.error?.code).toBe('REQUEST_ERROR')

    const unsafeUpdate = {
      capabilities: {
        project: { read: true, write: true, execute: true },
        system: { observe: true, read: true, write: true, execute: true },
        computer: { observe: true, control: true },
      },
      computer: { resourceRoots: [] },
      // 远程节点保持关闭：本用例验证的是网页插件这一条链路，不该顺带把能力面开到本机之外。
      remoteNode: {
        enabled: false,
        bindHost: '127.0.0.1',
        portStart: 43_180,
        portEnd: 43_190,
      },
      confirmations: [],
    }
    await expect(manage(runtime, 'config.apply', unsafeUpdate)).rejects.toMatchObject({
      code: 'REQUEST_ERROR',
    })

    const enabledPayload = await manage<{
      config: { value: { capabilities: { computer: { control: boolean } } } }
    }>(runtime, 'config.apply', {
        ...unsafeUpdate,
        confirmations: [
          'project-write',
          'project-execute',
          'system-observe',
          'system-read',
          'system-write',
          'system-execute',
          'computer-observe',
          'computer-control',
        ],
    })
    expect(enabledPayload.config.value.capabilities.computer.control).toBe(true)

    const probe = await manage<{ computerAvailability: { available: boolean } }>(
      runtime,
      'computer.probe',
    )
    expect(probe
      .computerAvailability.available).toBe(true)

    const installed = await manage<{ installation: { installed: boolean } }>(
      runtime,
      'computer.install',
    )
    expect(installed
      .installation.installed).toBe(true)

    const socket = await openExtensionSocket(runtime.status.extension.endpoint)
    const inbox = new MessageInbox(socket)
    send(socket, { type: 'pair', code: '654321', provider: 'chatgpt', capabilities: ['chat'], tabUrl: 'https://chatgpt.com/', modelLabel: null, providerSnapshot: null })
    const paired = await inbox.next('paired')
    expect(String(paired.token).length).toBeGreaterThan(32)

    send(socket, {
      type: 'event',
      eventId: 'computer-catalog',
      event: { type: 'provider_workspace_catalog', correlationId: 'computer-catalog-1' },
    })
    const workspaceCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const workspaceEnvelope = workspaceCommand.command as Record<string, unknown>
    const workspacePayload = workspaceEnvelope.payload as {
      catalog: { workspaces: Array<{ id: string; space: string }> }
    }
    const workspaceBindingId = workspacePayload.catalog.workspaces
      .find((workspace) => workspace.space === 'system')!.id
    const projectWorkspaceBindingId = workspacePayload.catalog.workspaces
      .find((workspace) => workspace.space === 'project')!.id
    send(socket, { type: 'ack', sequence: workspaceEnvelope.sequence })

    send(socket, {
      type: 'event',
      eventId: 'computer-prepare',
      event: {
        type: 'provider_surface_prepare',
        correlationId: 'computer-prepare-1',
        surfaceId: 'surface-computer',
        workspaceBindingId,
        providerConversationId: null,
        providerParentMessageId: null,
        message: null,
      },
    })
    const contractCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const contractEnvelope = contractCommand.command as Record<string, unknown>
    const contractPayload = contractEnvelope.payload as Record<string, unknown>
    const binding = contractPayload.binding as {
      workspaceSpace: string
      toolContract: { id: string; catalogRevision: string }
    }
    const catalog = contractPayload.toolCatalog as {
      tools: Array<{ name: string; category?: string }>
    }
    expect(binding.workspaceSpace).toBe('system')
    expect(catalog.tools.some((tool) => tool.name === 'computer:screenshot')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'computer:click')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'system:processes')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'system:read')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'system:write')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'system:run')).toBe(true)
    expect(catalog.tools.find((tool) => tool.name === 'system:read')?.category).toBe(
      'system-files',
    )
    expect(catalog.tools.find((tool) => tool.name === 'system:run')?.category).toBe(
      'system-execution',
    )
    expect(catalog.tools.find((tool) => tool.name === 'system:processes')?.category).toBe(
      'system-processes',
    )
    expect(catalog.tools.some((tool) => tool.name === 'project:read')).toBe(false)
    expect(catalog.tools.some((tool) => tool.name === 'project:edit')).toBe(false)
    send(socket, { type: 'ack', sequence: contractEnvelope.sequence })

    const overviewResult = await callProviderTool({
      socket,
      inbox,
      eventId: 'system-overview',
      surfaceId: 'surface-computer',
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'system-overview-1',
      toolName: 'system:processes',
      toolInput: { limit: 10 },
    })
    expect(overviewResult.status).toBe('success')

    const outsideNote = join(temporaryRoot, 'outside-note.txt')
    const systemWriteResult = await callProviderTool({
      socket,
      inbox,
      eventId: 'system-write',
      surfaceId: 'surface-computer',
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'system-write-1',
      toolName: 'system:write',
      toolInput: { path: outsideNote, content: 'SYSTEM_TOOL_OK\n' },
    })
    expect(systemWriteResult.status).toBe('success')
    const systemReadResult = await callProviderTool({
      socket,
      inbox,
      eventId: 'system-read',
      surfaceId: 'surface-computer',
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'system-read-1',
      toolName: 'system:read',
      toolInput: { path: outsideNote, endLine: 10 },
    })
    expect(systemReadResult).toMatchObject({
      status: 'success',
      output: { content: 'SYSTEM_TOOL_OK\n' },
    })
    const systemCommandResult = await callProviderTool({
      socket,
      inbox,
      eventId: 'system-command',
      surfaceId: 'surface-computer',
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'system-command-1',
      toolName: 'system:run',
      toolInput: { command: 'node --version', cwd: temporaryRoot },
    })
    expect(systemCommandResult).toMatchObject({
      status: 'success',
      output: { success: true },
    })

    send(socket, {
      type: 'event',
      eventId: 'computer-screenshot',
      event: {
        type: 'provider_surface_tool_call',
        correlationId: 'computer-call-1',
        surfaceId: 'surface-computer',
        call: {
          protocolVersion: ProviderSurfaceProtocolVersion,
          contractId: binding.toolContract.id,
          catalogRevision: binding.toolContract.catalogRevision,
          toolCallId: 'computer-shot-1',
          toolName: 'computer:screenshot',
          input: {},
        },
      },
    })
    await expectToolProgress(socket, inbox, {
      surfaceId: 'surface-computer',
      toolCallId: 'computer-shot-1',
    })
    const screenshotCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const screenshotEnvelope = screenshotCommand.command as Record<string, unknown>
    const screenshotResult = (screenshotEnvelope.payload as {
      result: {
        status: string
        output: Record<string, unknown>
        artifacts: Array<{ kind: string; mediaType: string; data: string; name: string }>
      }
    }).result
    expect(screenshotResult.status).toBe('success')
    expect('base64' in screenshotResult.output).toBe(false)
    expect(screenshotResult.artifacts).toEqual([{
      kind: 'image',
      mediaType: 'image/jpeg',
      data: 'aW1hZ2U=',
      name: 'desktop-screenshot.jpg',
    }])
    expect(computer.calls).toContain('screenshot')
    send(socket, { type: 'ack', sequence: screenshotEnvelope.sequence })

    send(socket, {
      type: 'event',
      eventId: 'computer-click',
      event: {
        type: 'provider_surface_tool_call',
        correlationId: 'computer-call-2',
        surfaceId: 'surface-computer',
        call: {
          protocolVersion: ProviderSurfaceProtocolVersion,
          contractId: binding.toolContract.id,
          catalogRevision: binding.toolContract.catalogRevision,
          toolCallId: 'computer-click-1',
          toolName: 'computer:click',
          input: { x: 40, y: 50 },
        },
      },
    })
    await expectToolProgress(socket, inbox, {
      surfaceId: 'surface-computer',
      toolCallId: 'computer-click-1',
    })
    const clickCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const clickEnvelope = clickCommand.command as Record<string, unknown>
    const clickResult = (clickEnvelope.payload as { result: { status: string } }).result
    expect(clickResult.status).toBe('success')
    expect(computer.calls).toContain('left_click:40:50')
    send(socket, { type: 'ack', sequence: clickEnvelope.sequence })

    send(socket, {
      type: 'event',
      eventId: 'project-write-prepare',
      event: {
        type: 'provider_surface_prepare',
        correlationId: 'project-write-prepare-1',
        surfaceId: 'surface-project-write',
        workspaceBindingId: projectWorkspaceBindingId,
        providerConversationId: null,
        providerParentMessageId: null,
        message: null,
      },
    })
    const projectContractCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const projectContractEnvelope = projectContractCommand.command as Record<string, unknown>
    const projectContractPayload = projectContractEnvelope.payload as {
      binding: { toolContract: { id: string; catalogRevision: string } }
      toolCatalog: { tools: Array<{ name: string }> }
    }
    expect(projectContractPayload.toolCatalog.tools.some((tool) =>
      tool.name === 'project:write')).toBe(true)
    expect(projectContractPayload.toolCatalog.tools.some((tool) =>
      tool.name.startsWith('office:'))).toBe(false)
    send(socket, { type: 'ack', sequence: projectContractEnvelope.sequence })

    const projectWriteResult = await callProviderTool({
      socket,
      inbox,
      eventId: 'project-write-report',
      surfaceId: 'surface-project-write',
      contractId: projectContractPayload.binding.toolContract.id,
      catalogRevision: projectContractPayload.binding.toolContract.catalogRevision,
      toolCallId: 'project-write-report-1',
      toolName: 'project:write',
      toolInput: {
        path: 'reports/host-write-e2e.md',
        content: '# Host write E2E\n\nProject write is available through the Host catalog.\n',
        mode: 'create',
      },
    })
    expect(projectWriteResult.status).toBe('success')
    expect(await readFile(join(workspaceRoot, 'reports', 'host-write-e2e.md'), 'utf8'))
      .toContain('Project write is available')

    socket.terminate()
    const managementEndpoint = runtime.status.management.endpoint
    await runtime.stop()
    runtime = undefined
    if (process.platform !== 'win32') {
      await expect(stat(managementEndpoint)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
