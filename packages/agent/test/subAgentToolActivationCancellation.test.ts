import { describe, expect, test } from 'bun:test'

import { createSubAgentContext, type SubAgentContextBase } from '../src/agent/LoopRuntime'

function fixture() {
  const parentAbort = new AbortController()
  const workerAbort = new AbortController()
  const enabled = new Set<string>()
  const writes: string[][] = []
  let requests = 0
  let release!: () => void
  const decisionReady = new Promise<void>((resolve) => {
    release = resolve
  })
  const role = {
    id: 'primary-agent' as const,
    label: 'Worker',
    description: 'Worker',
    nextAllowedRoles: [],
    allowedTools: ['probe:read'],
  }
  const parent: SubAgentContextBase = {
    abortSignal: parentAbort.signal,
    log: {},
    role,
    listTools: () => [
      { name: 'probe:read', description: 'Read', categoryId: 'probe', permissions: [] },
    ],
    listToolCategories: () => [],
    getEnabledToolCategories: () => [],
    getCurrentVisibleToolNames: () => [],
    setCurrentVisibleToolNames: () => {},
    getSupportedModelInputModalities: () => ['text'],
    setSupportedModelInputModalities: () => {},
    codingSession: {
      enableToolCategories: (ids) => {
        writes.push([...ids])
        ids.forEach((id) => enabled.add(id))
        return ids
      },
      getEnabledToolCategories: () => [...enabled],
      hasToolCategoryAccess: (id) => enabled.has(id),
    },
    query: async () => '',
  }
  const child = createSubAgentContext({
    parentCtx: parent,
    log: {},
    roleResolution: role,
    allowedTools: [],
    allowedCategories: [],
    getAllowedSubAgentTools: (tools) => tools ?? [],
    getToolNamesForCategories: () => ['probe:read'],
    requestToolCategories: async (categories) => {
      requests += 1
      await decisionReady
      return {
        enabled: true,
        approved: true,
        requestedCategories: categories,
        enabledCategories: categories,
        skippedCategories: [],
        message: 'Approved',
      }
    },
  })
  // QueryLoop attaches the final worker signal after constructing the child context.
  child.abortSignal = workerAbort.signal
  const request = () => child.requestToolCategoryAccess!(['probe'], 'Read task data')
  return { parentAbort, workerAbort, child, request, release, writes, requestCount: () => requests }
}

describe('sub-agent tool activation ownership', () => {
  test('a stopped worker cannot commit a late decision while its parent remains active', async () => {
    const h = fixture()
    const pending = h.request()
    h.workerAbort.abort(new Error('worker stopped'))
    h.release()

    await expect(pending).rejects.toThrow('worker stopped')
    expect(h.parentAbort.signal.aborted).toBe(false)
    expect(h.writes).toEqual([])
    expect(h.child.getEnabledToolCategories()).toEqual([])
    expect(h.child.getCurrentVisibleToolNames()).toEqual([])
  })

  test('a stopped worker does not open another capability request', async () => {
    const h = fixture()
    h.workerAbort.abort(new Error('already stopped'))
    h.release()

    await expect(h.request()).rejects.toThrow('already stopped')
    expect(h.requestCount()).toBe(0)
    expect(h.writes).toEqual([])
  })

  test('an active worker commits its granted categories and tool scope', async () => {
    const h = fixture()
    const pending = h.request()
    h.release()

    expect(await pending).toMatchObject({ approved: true, enabledCategories: ['probe'] })
    expect(h.writes).toEqual([['probe']])
    expect(h.child.getEnabledToolCategories()).toEqual(['probe'])
    expect(h.child.getCurrentVisibleToolNames()).toEqual(['probe:read'])
  })
})
