import { expect, test } from 'bun:test'

import { renderToolDescription } from '../src/tool-contract/ToolDescription'
import { searchToolDiscoveryCards } from '../src/tool-library/builtin/ToolSpaceQueries'
import { replaceToolSpacePages } from '../src/tool-library/builtin/ToolSpaceReplace'

function discoveryFixture() {
  const description = renderToolDescription({
    description: 'Inspect task status.',
    suitable: ['Read task status.'],
    forbidden: ['Do not use this tool for tomography.'],
    usage: ['Pass the task id.'],
    examples: ['{"id":"task-1"}'],
    notes: ['Returns a status.'],
  })
  const descriptor = {
    name: 'probe:status',
    categoryId: 'probe',
    description,
    role: 'inspect',
    permissions: [],
    systemEnabled: true,
  }
  return {
    codingSession: {
      hasToolCategoryAccess: () => true,
      isToolCategoryAllowed: () => true,
      getEnabledPromptFeatures: () => [],
    },
    getCurrentVisibleToolNames: () => ['probe:status'],
    listTools: () => [descriptor],
    listToolCategories: () => [
      {
        category: {
          id: 'probe',
          label: 'Probe',
          toolOs: { domain: 'system' },
          description: 'Inspect task status.',
        },
        enabled: true,
        tools: [descriptor],
      },
    ],
    describeToolInputSchema: () => ({
      profileId: 'default',
      description,
      schema: { type: 'object', properties: { receiptToken: { type: 'string' } } },
    }),
  }
}
const query = (text: string) => ({
  op: 'find' as const,
  query: text,
  kind: 'tool' as const,
  categoryIds: [],
  domainIds: [],
  toolOsStates: [],
  limit: 12,
})

test('discovery never treats a forbidden-only description match as a capability recommendation', () => {
  expect(searchToolDiscoveryCards(discoveryFixture() as never, query('tomography')).pages).toEqual(
    []
  )
})

test('discovery keeps actual capability, parameter and exact name matches', () => {
  for (const text of ['task status', 'probe:status', 'receiptToken']) {
    expect(searchToolDiscoveryCards(discoveryFixture() as never, query(text)).pages[0]?.name).toBe(
      'probe:status'
    )
  }
})

test('cancelled capability approval cannot resume tool page-in or page-out after its late receipt', async () => {
  const abort = new AbortController()
  let finish!: (result: { approved: boolean; enabledCategories: string[] }) => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const writes: string[] = []
  const descriptors = ['alpha', 'beta'].map((categoryId) => ({
    name: `${categoryId}:read`,
    categoryId,
    description: 'Read values.',
    role: 'inspect',
    permissions: [],
    systemEnabled: true,
  }))
  const context = {
    abortSignal: abort.signal,
    codingSession: {
      hasToolCategoryAccess: (id: string) => id === 'beta',
      isToolCategoryAllowed: () => true,
      getEnabledPromptFeatures: () => [],
      enableToolCategories: () => {
        writes.push('categories')
      },
      enableToolNames: () => {
        writes.push('page-in')
      },
      disableToolNames: () => {
        writes.push('page-out')
      },
      disableToolCategories: () => {
        writes.push('disable-categories')
      },
    },
    requestToolCategoryAccess: async () => {
      entered()
      return new Promise<{ approved: boolean; enabledCategories: string[] }>((resolve) => {
        finish = resolve
      })
    },
    getCurrentVisibleToolNames: () => [],
    listTools: () => descriptors,
    listToolCategories: () =>
      descriptors.map((tool) => ({
        category: { id: tool.categoryId, label: tool.categoryId, description: 'Read values.' },
        enabled: tool.categoryId === 'beta',
        tools: [tool],
      })),
  }
  const replacing = replaceToolSpacePages(context as never, {
    op: 'replace',
    pageIn: ['tool:alpha:read'],
    pageOut: ['tool:beta:read'],
    reason: 'inspect',
  })
  await waiting
  abort.abort(new Error('task stopped'))
  finish({ approved: true, enabledCategories: ['alpha'] })
  await expect(replacing).rejects.toThrow('task stopped')
  expect(writes).toEqual([])
})

test('page-in preserves the structured example needed for a correct first call', async () => {
  const fixture = discoveryFixture()
  const context = {
    ...fixture,
    abortSignal: new AbortController().signal,
    getCurrentVisibleToolNames: () => [],
    codingSession: { ...fixture.codingSession, enableToolNames: () => [] },
  }
  const result = await replaceToolSpacePages(context as never, {
    op: 'replace',
    pageIn: ['tool:probe:status'],
    pageOut: [],
    reason: 'inspect task status',
  })
  expect(result.preparedToolExamples).toEqual([
    { tool: 'probe:status', example: '示例：\n- {"id":"task-1"}' },
  ])
})
