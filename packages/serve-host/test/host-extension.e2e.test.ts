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

function controlAuth(runtime: VelarHostRuntime): { endpoint: string; token: string } {
  const url = new URL(runtime.controlUrl)
  const token = new URLSearchParams(url.hash.slice(1)).get('token')
  if (token === null) throw new Error('Control URL is missing its fragment token')
  return { endpoint: url.origin, token }
}

function controlFetch(
  runtime: VelarHostRuntime,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { endpoint, token } = controlAuth(runtime)
  return fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: endpoint,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
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
      workspaceRoot,
      dataRoot,
      portStart: 0,
      portEnd: 0,
      pairingCode: '123456',
    })
    expect(runtime.status.kernel.moduleIds).toEqual([
      'velaros.computer.sidecar',
      'velaros.office.tools',
      'velaros.system.tools',
      'velaros.workspace.default',
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
    expect(toolCatalog.tools.some((tool) => tool.name === 'ws_read')).toBe(true)
    expect(toolCatalog.tools.some((tool) => tool.name === 'computer_screenshot')).toBe(false)
    expect(toolCatalog.tools.every((tool) => tool.readOnly === true)).toBe(true)
    expect(toolCatalog.tools.some((tool) => tool.name === 'ws_commit_edit')).toBe(false)
    expect(runtime.status.extension.surfaceCount).toBe(1)
    expect(runtime.status.extension.activity?.eventType).toBe('provider_surface_prepare')
    send(socket, { type: 'ack', sequence: contractEnvelope.sequence })

    const readCall = {
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'tool-read-1',
      toolName: 'ws_read',
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
      toolName: 'ws_read',
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
          toolName: 'ws_commit_edit',
          input: { path: 'proof.txt', content: 'MUTATED\n' },
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
      workspaceRoot,
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
      expect(contractPayload.toolCatalog.tools.some((tool) => tool.name === 'ws_status'))
        .toBe(true)
      expect(contractPayload.toolCatalog.tools.some((tool) => tool.name === 'computer_screenshot'))
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
            toolName: 'ws_status',
            input: {},
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
        result: { status: string; output: { root: string } }
      }).result
      expect(result.status).toBe('success')
      expect(result.output.root).toBe(workspaceRoot)
      send(socket, { type: 'ack', sequence: resultEnvelope.sequence })
    }

    expect(runtime.status.extension.activity).toMatchObject({
      eventType: 'provider_surface_tool_result',
      toolName: 'ws_status',
      status: 'success',
    })
    socket.terminate()
  })

  test('uses the control plane to grant Computer tools and returns screenshots as artifacts', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-computer-e2e-'))
    const workspaceRoot = join(temporaryRoot, 'workspace')
    const dataRoot = join(temporaryRoot, 'data')
    const computer = new FakeComputerRuntime()
    await Bun.write(join(workspaceRoot, 'proof.txt'), 'CONTROL_PLANE_OK\n')

    runtime = await startVelarHost({
      workspaceRoot,
      dataRoot,
      portStart: 0,
      portEnd: 0,
      controlPortStart: 0,
      controlPortEnd: 0,
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

    const page = await fetch(runtime.status.control.endpoint)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const pageHtml = await page.text()
    expect(pageHtml).toContain('Velar Host')
    expect(pageHtml).toContain('浏览器插件')
    expect(pageHtml).toContain('详细信息')
    expect(pageHtml).toContain('>保存<')
    expect(pageHtml).not.toContain('Desktop')
    expect(pageHtml).not.toContain('聊天输入')
    expect((await fetch(`${runtime.status.control.endpoint}/v1/status`)).status).toBe(401)

    const unsafeUpdate = {
      capabilities: {
        workspace: { read: true, write: true },
        system: { observe: true, read: true, write: true, execute: true },
        computer: { observe: true, control: true },
      },
      computer: { resourceRoots: [] },
      confirmations: [],
    }
    const rejected = await controlFetch(runtime, '/v1/config', {
      method: 'PUT',
      body: JSON.stringify(unsafeUpdate),
    })
    expect(rejected.status).toBe(400)

    const enabled = await controlFetch(runtime, '/v1/config', {
      method: 'PUT',
      body: JSON.stringify({
        ...unsafeUpdate,
        confirmations: [
          'workspace-write',
          'system-observe',
          'system-read',
          'system-write',
          'system-execute',
          'computer-observe',
          'computer-control',
        ],
      }),
    })
    expect(enabled.status).toBe(200)
    const enabledPayload = await enabled.json() as {
      config: { value: { capabilities: { computer: { control: boolean } } } }
    }
    expect(enabledPayload.config.value.capabilities.computer.control).toBe(true)

    const probe = await controlFetch(runtime, '/v1/computer/probe', { method: 'POST' })
    expect((await probe.json() as { computerAvailability: { available: boolean } })
      .computerAvailability.available).toBe(true)

    const installed = await controlFetch(runtime, '/v1/computer/install', { method: 'POST' })
    expect(installed.status).toBe(200)
    expect((await installed.json() as { installation: { installed: boolean } })
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
      tools: Array<{ name: string }>
    }
    expect(binding.workspaceSpace).toBe('system')
    expect(catalog.tools.some((tool) => tool.name === 'computer_screenshot')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'computer_click')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'get_system_overview')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'read')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'write')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'bash')).toBe(true)
    expect(catalog.tools.some((tool) => tool.name === 'ws_read')).toBe(false)
    expect(catalog.tools.some((tool) => tool.name === 'ws_commit_edit')).toBe(false)
    send(socket, { type: 'ack', sequence: contractEnvelope.sequence })

    const overviewResult = await callProviderTool({
      socket,
      inbox,
      eventId: 'system-overview',
      surfaceId: 'surface-computer',
      contractId: binding.toolContract.id,
      catalogRevision: binding.toolContract.catalogRevision,
      toolCallId: 'system-overview-1',
      toolName: 'get_system_overview',
      toolInput: {},
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
      toolName: 'write',
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
      toolName: 'read',
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
      toolName: 'bash',
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
          toolName: 'computer_screenshot',
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
          toolName: 'computer_click',
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
      eventId: 'office-prepare',
      event: {
        type: 'provider_surface_prepare',
        correlationId: 'office-prepare-1',
        surfaceId: 'surface-office',
        workspaceBindingId: projectWorkspaceBindingId,
        providerConversationId: null,
        providerParentMessageId: null,
        message: null,
      },
    })
    const officeContractCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const officeContractEnvelope = officeContractCommand.command as Record<string, unknown>
    const officeContractPayload = officeContractEnvelope.payload as {
      binding: { toolContract: { id: string; catalogRevision: string } }
      toolCatalog: { tools: Array<{ name: string }> }
    }
    expect(officeContractPayload.toolCatalog.tools.some((tool) =>
      tool.name === 'create_word_document')).toBe(true)
    expect(officeContractPayload.toolCatalog.tools.some((tool) =>
      tool.name === 'convert_document_to_markdown')).toBe(false)
    send(socket, { type: 'ack', sequence: officeContractEnvelope.sequence })

    send(socket, {
      type: 'event',
      eventId: 'office-word',
      event: {
        type: 'provider_surface_tool_call',
        correlationId: 'office-word-1',
        surfaceId: 'surface-office',
        call: {
          protocolVersion: ProviderSurfaceProtocolVersion,
          contractId: officeContractPayload.binding.toolContract.id,
          catalogRevision: officeContractPayload.binding.toolContract.catalogRevision,
          toolCallId: 'office-word-1',
          toolName: 'create_word_document',
          input: {
            outputPath: 'reports/host-e2e.docx',
            title: 'Host E2E',
            content: '# Host E2E\n\nOffice capability is callable through Kernel.',
          },
        },
      },
    })
    await expectToolProgress(socket, inbox, {
      surfaceId: 'surface-office',
      toolCallId: 'office-word-1',
    })
    const officeResultCommand = await inbox.next('command')
    await inbox.next('event_ack')
    const officeResultEnvelope = officeResultCommand.command as Record<string, unknown>
    const officeResult = (officeResultEnvelope.payload as {
      result: { status: string; output: { kind: string; bytes: number } }
    }).result
    expect(officeResult).toMatchObject({ status: 'success', output: { kind: 'docx' } })
    expect(officeResult.output.bytes).toBeGreaterThan(1_000)
    const wordBytes = await readFile(join(workspaceRoot, 'reports', 'host-e2e.docx'))
    expect(wordBytes.subarray(0, 2).toString()).toBe('PK')
    send(socket, { type: 'ack', sequence: officeResultEnvelope.sequence })
    socket.terminate()
  })
})
