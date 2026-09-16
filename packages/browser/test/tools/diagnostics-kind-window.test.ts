// 用途：钉住诊断的 limit 与 clear 按种类算。
// 历史事故：limit 先作用在「所有种类的最近 N 条」上、再在工具里过滤种类——一个 console
// 刷屏的页面 list_network_events {failedOnly:true} 一条失败请求都拿不到（失败请求就在更早的
// 诊断里）；clear=true 又会把 console 与页面异常一起清空。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ToolContext } from '../../src/contract/requires.js'
import { browserTools } from '../../src/impl/BrowserTools'
import type { BrowserPageDiagnosticEntry } from '../../src/types/browser.js'
import { clearBrowserDiagnosticEntries, takeBrowserDiagnosticWindow } from '../../src/utils/diagnostics.js'

function createEntry(
  kind: BrowserPageDiagnosticEntry['kind'],
  capturedAt: number,
  overrides: Partial<BrowserPageDiagnosticEntry> = {}
): BrowserPageDiagnosticEntry {
  return {
    kind,
    level: 'info',
    message: `${kind}-${capturedAt}`,
    url: 'https://example.test/',
    line: null,
    column: null,
    code: null,
    capturedAt,
    ...overrides,
  }
}

/** 一个 console 刷屏的页面：最早有一个 404，之后 200 条 console。 */
function createNoisyBuffer(): BrowserPageDiagnosticEntry[] {
  return [
    createEntry('network', 1, { level: 'error', code: 404, details: { status: 404 } }),
    ...Array.from({ length: 200 }, (_, index) => createEntry('console', index + 2)),
    createEntry('page-error', 500, { level: 'error' }),
  ]
}

/** 仿真的诊断引擎：按新口径先过滤种类、再取窗口，clear 只清所选种类。 */
function createDiagnosticsContext(buffer: BrowserPageDiagnosticEntry[]) {
  const calls: Array<Record<string, unknown>> = []
  const browser = {
    isActive: () => true,
    getContext: () => ({ url: 'https://example.test/', workspaceRoot: '/tmp/site' }),
    getPageDiagnostics: async (options: Record<string, unknown> = {}) => {
      calls.push(options)
      const kinds = options.kinds as Array<BrowserPageDiagnosticEntry['kind']> | undefined
      const entries = takeBrowserDiagnosticWindow(buffer, (options.limit as number) ?? 100, kinds)
      if (options.clear) clearBrowserDiagnosticEntries(buffer, kinds)
      return {
        url: 'https://example.test/',
        title: null,
        entries,
        summary: { total: entries.length, byLevel: {}, byKind: {}, byOrigin: {}, byStatus: {}, byResourceType: {} },
        capturedAt: 0,
      }
    },
  }

  return { calls, ctx: { browser, abortSignal: new AbortController().signal } as unknown as ToolContext }
}

void describe('诊断按种类取窗口', () => {
  void test('console 刷屏的页面仍然列得出更早的失败请求', async () => {
    const buffer = createNoisyBuffer()
    const { ctx, calls } = createDiagnosticsContext(buffer)

    const result = (await browserTools['browser:list_network_events']!.execute(
      { limit: 50, failedOnly: true },
      ctx
    )) as { entries: BrowserPageDiagnosticEntry[]; networkTotal: number }

    assert.deepEqual(calls[0]?.kinds, ['network'])
    assert.equal(result.networkTotal, 1)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]?.kind, 'network')
  })

  void test('clear 只清这次读的种类', async () => {
    const buffer = createNoisyBuffer()
    const { ctx } = createDiagnosticsContext(buffer)

    await browserTools['browser:list_network_events']!.execute({ limit: 50, clear: true }, ctx)

    assert.equal(buffer.some((entry) => entry.kind === 'network'), false)
    assert.equal(buffer.filter((entry) => entry.kind === 'console').length, 200)
    assert.equal(buffer.some((entry) => entry.kind === 'page-error'), true)
  })

  void test('console 与页面异常各自只读自己的种类', async () => {
    const buffer = createNoisyBuffer()
    const { ctx, calls } = createDiagnosticsContext(buffer)

    const consoleResult = (await browserTools['browser:list_console_events']!.execute(
      { limit: 5 },
      ctx
    )) as { entries: BrowserPageDiagnosticEntry[] }
    const errorResult = (await browserTools['browser:list_page_errors']!.execute(
      { limit: 5 },
      ctx
    )) as { entries: BrowserPageDiagnosticEntry[]; pageErrorTotal: number }

    assert.deepEqual(calls[0]?.kinds, ['console'])
    assert.deepEqual(calls[1]?.kinds, ['page-error'])
    assert.equal(consoleResult.entries.length, 5)
    assert.ok(consoleResult.entries.every((entry) => entry.kind === 'console'))
    assert.equal(errorResult.pageErrorTotal, 1)
  })

  void test('不给种类时窗口与清空都覆盖全部种类', async () => {
    const buffer = createNoisyBuffer()

    assert.equal(takeBrowserDiagnosticWindow(buffer, 3).length, 3)
    clearBrowserDiagnosticEntries(buffer)
    assert.equal(buffer.length, 0)
  })
})
