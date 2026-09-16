import { describe, expect, test } from 'bun:test'

import type { SubAgentContextBase } from '../src/types/loop.js'
import { createSubAgentContext } from '../src/utils/loop/loop-runtime'

type CommandPort = {
  runCommand: (command: string, options?: { background?: boolean }) => Promise<string>
  getRootPath?: () => string
}

function childOf(ports: { system: CommandPort; project: CommandPort }) {
  const role = { id: 'primary-agent' as const, label: 'Worker', description: 'Worker', nextAllowedRoles: [], allowedTools: [] }
  const parent: SubAgentContextBase & { system: CommandPort; project: CommandPort } = {
    abortSignal: new AbortController().signal,
    log: {},
    role,
    listTools: () => [],
    listToolCategories: () => [],
    getEnabledToolCategories: () => [],
    getCurrentVisibleToolNames: () => [],
    setCurrentVisibleToolNames: () => {},
    getSupportedModelInputModalities: () => ['text'],
    setSupportedModelInputModalities: () => {},
    codingSession: { enableToolCategories: (ids) => ids, getEnabledToolCategories: () => [], hasToolCategoryAccess: () => false },
    query: async () => '',
    ...ports,
  }
  return createSubAgentContext({
    parentCtx: parent,
    log: {},
    roleResolution: role,
    allowedTools: [],
    allowedCategories: [],
    getAllowedSubAgentTools: (tools) => tools ?? [],
    getToolNamesForCategories: () => [],
  })
}

function recordingPort(calls: string[], label: string): CommandPort {
  return {
    runCommand: async (command, options) => {
      calls.push(`${label}:${command}:${options?.background === true ? 'bg' : 'fg'}`)
      return 'ran'
    },
    getRootPath: () => `/${label}`,
  }
}

describe('sub-agent background command boundary', () => {
  test('system and project ports both refuse background commands and forward foreground ones', async () => {
    const calls: string[] = []
    const child = childOf({ system: recordingPort(calls, 'system'), project: recordingPort(calls, 'project') })

    for (const port of [child.system, child.project]) {
      expect(() => port.runCommand('bun run dev', { background: true })).toThrow(expect.objectContaining({ code: 'PERMISSION' }))
      expect(await port.runCommand('bun test')).toBe('ran')
    }
    expect(calls).toEqual(['system:bun test:fg', 'project:bun test:fg'])
    // 端口的其它成员原样保留。
    expect(child.project.getRootPath?.()).toBe('/project')
  })
})
