import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel/contracts/abi'

import {
  createSystemKernelModule,
  SystemCapability,
  type SystemCapabilityService,
  SystemToolCategoryByName,
  type SystemToolContext,
} from '../src'
import { createSystemBundledModDefinition } from '../src/composition'
import type { SystemCommandResult } from '../src/SystemContracts'

function captureService(
  capture: (tokenId: string, service: object) => void,
): KernelModuleActivateContext {
  return {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('System Kernel module', () => {
  test('keeps every tool in one concrete responsibility category', () => {
    expect(SystemToolCategoryByName).toEqual({
      'system:read': 'system-files',
      'system:write': 'system-files',
      'system:edit': 'system-files',
      'system:list': 'system-files',
      'system:search': 'system-files',
      'system:run': 'system-execution',
      'system:refresh-environment': 'system-execution',
      'system:processes': 'system-processes',
      'system:list-tasks': 'system-processes',
      'system:terminate-task': 'system-processes',
      'system:open': 'system-desktop',
    })
  })

  test('registers the precise canonical tool collection', async () => {
    let service: SystemCapabilityService | undefined
    const module = createSystemKernelModule()
    await module.activate(captureService((tokenId, registered) => {
      expect(tokenId).toBe(SystemCapability.id)
      service = registered as SystemCapabilityService
    }))

    expect(module.manifest.id).toBe('velaros.system')
    expect(Object.keys(service?.tools ?? {})).toEqual([
      'system:read',
      'system:write',
      'system:edit',
      'system:list',
      'system:search',
      'system:run',
      'system:refresh-environment',
      'system:processes',
      'system:list-tasks',
      'system:terminate-task',
      'system:open',
    ])
    expect(service?.getOperationMetadata('system:list-tasks')).toBeUndefined()
    expect(service?.tools['system:edit']?.description).toContain('保留已有文件的权限位')
    expect(service?.tools['system:run']?.description).toContain('复制、移动、删除、归档、解压')
    expect(module.manifest.permissions).not.toContain('*')
  })

  test('keeps the system execution triangle resident without pinning the whole domain', () => {
    const tools = createSystemBundledModDefinition().manifest.contributes.tools
    expect(
      tools.flatMap((tool) => (tool.residentInSpaces?.includes('system') ? [tool.name] : [])),
    ).toEqual(['system:read', 'system:write', 'system:run'])
  })

  test('uses strict schemas before resolving a host context', async () => {
    let service: SystemCapabilityService | undefined
    let resolverCalls = 0
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) => {
        resolverCalls += 1
        return {
          abortSignal: signal,
          system: { listBackgroundTasks: async () => [] },
        } as unknown as SystemToolContext
      },
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    await expect(service?.invoke(
      'system:list-tasks',
      undefined,
      { unexpected: true },
      new AbortController().signal,
    )).rejects.toThrow('System capability input is invalid')
    expect(resolverCalls).toBe(0)
  })

  test('exposes an authoritative tail window and a session-log continuation for truncated output', async () => {
    let service: SystemCapabilityService | undefined
    const commandResult: SystemCommandResult = {
      command: 'printf lots',
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      stdout: 'last line\n',
      stderr: '',
      logPath: '/tmp/vela-system-command-123.log',
      durationMs: 10,
      timedOut: false,
      aborted: false,
      truncated: true,
      success: true,
      verification: { kind: 'unknown', status: 'unknown', issues: [] },
    }
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) =>
        ({
          abortSignal: signal,
          system: {
            runCommand: async () => commandResult,
            canStartBackgroundCommands: () => true,
          },
          approval: { awaitConfirmation: async () => undefined },
        }) as unknown as SystemToolContext,
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    const result = (await service?.invoke(
      'system:run',
      undefined,
      { command: 'printf lots', maxOutputChars: 100 },
      new AbortController().signal,
    )) as SystemCommandResult

    expect(result.outputWindow).toEqual({
      retained: 'tail',
      complete: false,
      endPreserved: true,
    })
    expect(result.outputContinuation).toEqual({
      kind: 'session-terminal-log',
      query: 'vela-system-command-123.log',
    })
  })
})
