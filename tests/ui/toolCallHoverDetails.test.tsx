import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

import type { ToolCallBlock } from '../../packages/ui/src/conversation/contracts'
import {
  type ConversationI18nContextValue,
  ConversationLocalizationProvider,
  conversationZhCNMessages,
} from '../../packages/ui/src/conversation/i18n'
import { ToolCallHoverDetails } from '../../packages/ui/src/conversation/tool-render/ToolCallHoverDetails'

function lookupMessage(key: string): string {
  let node: unknown = conversationZhCNMessages
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part]
  }
  return typeof node === 'string' ? node : key
}

const i18n: ConversationI18nContextValue = {
  locale: 'zh-CN',
  setLocale: async () => undefined,
  t: (key, params) =>
    lookupMessage(key).replaceAll(/\{(\w+)\}/gu, (placeholder, name: string) =>
      String(params?.[name] ?? placeholder)
    ),
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <ConversationLocalizationProvider value={i18n}>{node}</ConversationLocalizationProvider>
  )
}

function toolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  extra: Partial<ToolCallBlock> = {}
): ToolCallBlock {
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    args,
    isRunning: false,
    startedAt: 1_000,
    finishedAt: 3_000,
    ...extra,
  }
}

function countMatches(markup: string, pattern: RegExp): number {
  return [...markup.matchAll(pattern)].length
}

void describe('ToolCallHoverDetails', () => {
  void test('lists each operation of a project:edit batch with its target and the call duration', () => {
    const markup = render(
      <ToolCallHoverDetails
        blocks={[
          toolCall('edit-1', 'project:edit', {
            operations: [
              { operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'a', newText: 'b' } },
              { operation: { type: 'insert_text_at_anchor', path: 'src/b.ts', anchorText: 'x', text: 'y' } },
              { operation: { type: 'rename_file', from: 'src/old.ts', to: 'src/new.ts' } },
            ],
          }),
        ]}
        detail={['src/a.ts', 'src/b.ts', 'src/old.ts', 'src/new.ts']}
        summary="已写入 · tx: tx-1"
      />
    )

    assert.match(markup, /data-slot="tool-call-hover-details"/)
    assert.match(markup, />project:edit</)
    assert.match(markup, />2秒</)
    assert.match(markup, /<code[^>]*>replace_text<\/code><span[^>]*>src\/a\.ts<\/span>/)
    assert.match(markup, /<code[^>]*>insert_text_at_anchor<\/code><span[^>]*>src\/b\.ts<\/span>/)
    assert.match(markup, /<code[^>]*>rename_file<\/code><span[^>]*>src\/old\.ts → src\/new\.ts<\/span>/)
    assert.match(markup, />已写入 · tx: tx-1</)
    // 变更文件已由操作行点名，不再重复成独立的详情行。
    assert.equal(countMatches(markup, /src\/a\.ts/gu), 1)
  })

  void test('folds repeated operations on one target and caps long batches', () => {
    const repeated = Array.from({ length: 3 }, () => ({
      operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'a', newText: 'b' },
    }))
    const distinct = Array.from({ length: 24 }, (_, index) => ({
      operation: { type: 'delete_file', path: `src/file-${index}.ts` },
    }))
    const markup = render(
      <ToolCallHoverDetails blocks={[toolCall('edit-2', 'project:edit', { operations: [...repeated, ...distinct] })]} />
    )

    assert.match(markup, /<code[^>]*>replace_text<\/code><span[^>]*>src\/a\.ts<\/span><span[^>]*>×3<\/span>/)
    // 1 行合并后的 replace_text + 19 行 delete_file，剩余 5 项折成计数。
    assert.equal(countMatches(markup, /<li/gu), 20)
    assert.match(markup, /另有 5 项操作/)
  })

  void test('shows a project:query-code action with what it looked up and its result count', () => {
    const markup = render(
      <ToolCallHoverDetails
        blocks={[
          toolCall(
            'query-1',
            'project:query-code',
            { action: 'find_references', symbol: 'UserService', path: 'src/user.ts' },
            { result: { count: 12 } }
          ),
        ]}
      />
    )

    assert.match(markup, /<code[^>]*>find_references<\/code><span[^>]*>UserService · src\/user\.ts<\/span>/)
    assert.match(markup, />找到 12 项结果</)
    assert.equal(countMatches(markup, /src\/user\.ts/gu), 1)
  })

  void test('keeps the full command and the error of a failed call readable', () => {
    const command = 'bun run check && bun run typecheck && bun run lint --max-warnings=0'
    const markup = render(
      <ToolCallHoverDetails
        blocks={[
          toolCall('run-1', 'project:run', { command }, { error: 'Command failed with exit code 1' }),
        ]}
        detail={[command]}
      />
    )

    assert.ok(markup.includes(`>${command.replaceAll('&', '&amp;')}<`))
    assert.match(markup, /data-tone="error"[^>]*>Command failed with exit code 1</)
    assert.doesNotMatch(markup, /未找到结果/)
  })

  void test('lists a merged group call by call in call order with durations and failures', () => {
    const markup = render(
      <ToolCallHoverDetails
        blocks={[
          toolCall('run-a', 'project:run', { command: 'bun run check' }, { finishedAt: 13_000 }),
          toolCall('run-b', 'project:run', { command: 'bun run typecheck && bun run lint' }),
          toolCall(
            'run-c',
            'project:run',
            { command: 'bun test tests/ui', background: true },
            { error: 'exit 1' }
          ),
        ]}
      />
    )

    assert.match(markup, />project:run</)
    assert.match(markup, /3 次调用/)
    const checkIndex = markup.indexOf('bun run check')
    const typecheckIndex = markup.indexOf('bun run typecheck &amp;&amp; bun run lint')
    const testIndex = markup.indexOf('bun test tests/ui')
    assert.ok(checkIndex >= 0 && checkIndex < typecheckIndex && typecheckIndex < testIndex)
    assert.match(markup, />12秒</)
    assert.match(markup, /<li[^>]*data-tone="error"[^>]*><div[^>]*><code[^>]*>background<\/code>/)
    assert.match(markup, />exit 1</)
  })

  void test('caps a very long merged group and counts the calls left out', () => {
    const blocks = Array.from({ length: 23 }, (_, index) =>
      toolCall(`read-${index}`, 'project:read', { path: `src/file-${index}.ts` })
    )
    const markup = render(<ToolCallHoverDetails blocks={blocks} />)

    assert.equal(countMatches(markup, /<li/gu), 20)
    assert.match(markup, /23 次调用/)
    assert.match(markup, /另有 3 次调用/)
  })

  void test('renders nothing without a call', () => {
    assert.equal(render(<ToolCallHoverDetails blocks={[]} />), '')
  })
})
