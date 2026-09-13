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
import { ConversationTranslatorRuntime } from '../../packages/ui/src/conversation/i18n/conversationTranslator'
import {
  describeToolCallHover,
  doesToolCallHoverAddToRow,
  resolveToolCallHoverContent,
  type ToolCallHover,
  ToolCallHoverDetails,
  type ToolCallHoverDetailsProps,
} from '../../packages/ui/src/conversation/tool-render/ToolCallHoverDetails'

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

const runtime = new ConversationTranslatorRuntime({
  translate: (_locale, key, params) => i18n.t(key, params),
  lookupMessage: (_locale, key) => {
    const message = lookupMessage(key)
    return message === key ? null : message
  },
})

function describeHover(props: ToolCallHoverDetailsProps): ToolCallHover {
  const hover = describeToolCallHover(props, 'zh-CN', runtime)
  assert.ok(hover)
  return hover
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

void describe('when the bubble adds nothing to the row', () => {
  void test('a call that only has its name and duration opens no bubble', () => {
    const block = toolCall('plan-1', 'plan:update', {}, { result: { updated: false, noop: true, plan: [] } })
    const hover = describeHover({ blocks: [block] })

    assert.equal(hover.kind, 'single')
    assert.equal(doesToolCallHoverAddToRow(hover, { label: 'plan:update', status: '2秒' }), false)
    assert.equal(
      resolveToolCallHoverContent({ blocks: [block] }, { label: 'plan:update', status: '2秒' }, 'zh-CN', runtime),
      undefined
    )
  })

  void test('a bubble that only repeats the row text opens no bubble, even when the row cut it short', () => {
    const read = toolCall('read-1', 'project:read', { path: 'src/a.ts' })
    assert.equal(
      doesToolCallHoverAddToRow(describeHover({ blocks: [read] }), { label: 'project:read', detail: 'src/a.ts', status: '2秒' }),
      false
    )
    // 行上只剩截短的对象（带省略号）时，比对去掉省略号；是不是真被 CSS 截断由行自己量、自己弹全文。
    const job = toolCall('job-1', 'job:cancel', { job_id: 'subagent:abc:background:123' })
    assert.equal(
      doesToolCallHoverAddToRow(describeHover({ blocks: [job] }), {
        label: 'job:cancel',
        detail: 'subagent:abc:background:123',
      }),
      false
    )
  })

  void test('an operation, a result or an error that the row does not show opens the bubble', () => {
    const edit = toolCall('edit-1', 'project:edit', {
      operations: [{ operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'a', newText: 'b' } }],
    })
    assert.equal(doesToolCallHoverAddToRow(describeHover({ blocks: [edit] }), { detail: 'src/a.ts' }), true)

    const search = toolCall('search-1', 'project:search', { query: 'contentHash' }, { result: { count: 12 } })
    const searchHover = describeHover({ blocks: [search] })
    assert.equal(doesToolCallHoverAddToRow(searchHover, { detail: 'contentHash' }), true)
    assert.equal(doesToolCallHoverAddToRow(searchHover, { detail: 'contentHash · 找到 12 项结果' }), false)

    const failed = toolCall('read-2', 'project:read', { path: 'src/a.ts' }, { error: 'ENOENT: no such file' })
    const failedHover = describeHover({ blocks: [failed] })
    assert.equal(doesToolCallHoverAddToRow(failedHover, { detail: 'src/a.ts' }), true)
    assert.equal(doesToolCallHoverAddToRow(failedHover, { detail: 'src/a.ts · ENOENT: no such file' }), false)
  })

  void test('matches identifiers on word boundaries, so a chip hidden inside the tool name still counts', () => {
    const recall = toolCall('recall-1', 'context:recall', { query: 'BASE_REVISION_MISMATCH', kind: 'all' })
    const hover = describeHover({ blocks: [recall] })

    // `all` 不能算作出现在 `context:recall` 里。
    assert.equal(
      doesToolCallHoverAddToRow(hover, { label: 'context:recall', detail: 'BASE_REVISION_MISMATCH' }),
      true
    )
    assert.equal(
      doesToolCallHoverAddToRow(hover, { label: 'context:recall', detail: 'all · BASE_REVISION_MISMATCH' }),
      false
    )
  })

  void test('a repeated operation or operations past the list cap always add something', () => {
    const repeated = toolCall('edit-2', 'project:edit', {
      operations: Array.from({ length: 2 }, () => ({
        operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'a', newText: 'b' },
      })),
    })
    assert.equal(
      doesToolCallHoverAddToRow(describeHover({ blocks: [repeated] }), { detail: 'replace_text src/a.ts' }),
      true
    )
  })

  void test('a merged row adds nothing only when every call target is already on the row', () => {
    const blocks = [
      toolCall('read-a', 'project:read', { path: 'src/a.ts' }),
      toolCall('read-b', 'project:read', { path: 'src/b.ts' }, { finishedAt: 9_000 }),
    ]
    const hover = describeHover({ blocks })

    assert.equal(hover.kind, 'merged')
    // 各次调用的耗时不同也不算：只多出耗时不值得弹气泡。
    assert.equal(doesToolCallHoverAddToRow(hover, { label: 'project:read', detail: 'src/a.ts、src/b.ts' }), false)
    assert.equal(doesToolCallHoverAddToRow(hover, { label: 'project:read', detail: 'src/a.ts…' }), true)

    const failing = describeHover({
      blocks: [...blocks, toolCall('read-c', 'project:read', { path: 'src/a.ts' }, { error: 'EACCES' })],
    })
    assert.equal(doesToolCallHoverAddToRow(failing, { label: 'project:read', detail: 'src/a.ts、src/b.ts' }), true)
  })

  void test('returns the bubble content when it adds something', () => {
    const block = toolCall('search-2', 'project:search', { query: 'contentHash', path: 'packages/project/src' })
    const content = resolveToolCallHoverContent(
      { blocks: [block] },
      { label: 'project:search', detail: 'contentHash', status: '2秒' },
      'zh-CN',
      runtime
    )

    assert.ok(content)
    assert.match(render(content), />packages\/project\/src</)
  })

  void test('a plan update row keeps its bubble for the steps the row does not list', () => {
    const block = toolCall('plan-2', 'plan:update', {
      plan: [
        { step: '实现', status: 'completed' },
        { step: '验证', status: 'in_progress' },
      ],
    })
    const content = resolveToolCallHoverContent(
      { blocks: [block] },
      { label: 'plan:update', detail: '1/2 · 验证', status: '2秒' },
      'zh-CN',
      runtime
    )

    assert.ok(content)
    const markup = render(content)
    assert.match(markup, />1\. \[completed\] 实现</)
    assert.match(markup, />2\. \[in_progress\] 验证</)
  })
})
