import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

import type { SystemConsoleOutputChunk, ToolCallBlock } from '../../packages/ui/src/conversation/contracts'
import {
  type ConversationI18nContextValue,
  ConversationLocalizationProvider,
  conversationZhCNMessages,
} from '../../packages/ui/src/conversation/i18n'
import type { ChatToolRenderCapabilities } from '../../packages/ui/src/conversation/tool-render/chatToolRenderCapabilities'
import { ChatToolRenderCapabilitiesProvider } from '../../packages/ui/src/conversation/tool-render/chatToolRenderCapabilitiesContext'
import { ConsoleToolRender } from '../../packages/ui/src/conversation/tool-render/console/ConsoleToolRender'
import {
  appendConsoleChunk,
  hasConsoleSession,
  interruptConsoleSession,
  resolveConsoleKeyAction,
  resolveConsoleStatus,
  resolveConsoleView,
  submitConsoleInput,
} from '../../packages/ui/src/conversation/tool-render/console/consoleToolRenderModel'

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

/** 一次交互式 system:run 的工具调用块。 */
function consoleToolCall(overrides: { acceptsInput?: boolean } = {}): ToolCallBlock {
  return {
    type: 'tool-call',
    toolCallId: 'run-1',
    toolName: 'system:run',
    args: { command: 'ssh deploy@example.com', interactive: true },
    isRunning: false,
    startedAt: 1_000,
    finishedAt: 1_200,
    result: {
      command: 'ssh deploy@example.com',
      cwd: '/Users/example/work',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      aborted: false,
      truncated: false,
      success: true,
      verification: { kind: 'unknown', status: 'unknown', issues: [] },
      backgroundProcess: {
        taskId: 'task-console-1',
        sessionId: 'session-1',
        pid: 4_242,
        logPath: null,
        ports: [],
        reason: null,
        terminateCommand: 'kill -TERM 4242',
        forceTerminateCommand: 'kill -KILL 4242',
        fallbackTerminateCommand: null,
        requested: true,
        autoStarted: false,
        console: {
          taskId: 'task-console-1',
          channel: 'pipe',
          acceptsInput: overrides.acceptsInput ?? true,
          note: '命令在控制台里跑，正在等用户输入。',
        },
      },
    },
  }
}

function render(node: ReactElement, capabilities: ChatToolRenderCapabilities = {}): string {
  return renderToStaticMarkup(
    <ConversationLocalizationProvider value={i18n}>
      <ChatToolRenderCapabilitiesProvider value={capabilities}>{node}</ChatToolRenderCapabilitiesProvider>
    </ConversationLocalizationProvider>
  )
}

/** 记下每次调用的假控制台能力。 */
function fakeConsoleCapabilities(): {
  capabilities: ChatToolRenderCapabilities
  writes: Array<{ sessionId: string; taskId: string; text: string }>
  interrupts: Array<{ sessionId: string; taskId: string }>
} {
  const writes: Array<{ sessionId: string; taskId: string; text: string }> = []
  const interrupts: Array<{ sessionId: string; taskId: string }> = []
  return {
    writes,
    interrupts,
    capabilities: {
      readConsoleOutput: async (sessionId, taskId, cursor) => ({
        ok: true,
        data: {
          taskId,
          text: '密码：',
          cursor: (cursor ?? 0) + 3,
          droppedChars: 0,
          status: 'running',
          acceptsInput: true,
        },
      }),
      writeConsoleInput: async (sessionId, taskId, text) => {
        writes.push({ sessionId, taskId, text })
        return {
          ok: true,
          data: { taskId, accepted: true, status: 'running', message: '输入已写进控制台。' },
        }
      },
      interruptConsole: async (sessionId, taskId) => {
        interrupts.push({ sessionId, taskId })
        return {
          ok: true,
          data: { taskId, accepted: true, status: 'running', message: '已发送中断（Ctrl+C）。' },
        }
      },
    },
  }
}

void describe('控制台卡片', () => {
  void test('只有带 console 的 system:run 结果才走控制台卡片', () => {
    assert.equal(hasConsoleSession(consoleToolCall().result), true)
    assert.equal(hasConsoleSession({ command: 'ls', backgroundProcess: { taskId: 'task-2' } }), false)
    assert.equal(hasConsoleSession({ command: 'ls' }), false)
    assert.equal(hasConsoleSession(null), false)

    const view = resolveConsoleView(consoleToolCall())
    assert.equal(view?.command, 'ssh deploy@example.com')
    assert.equal(view?.cwd, '/Users/example/work')
    assert.equal(view?.session.taskId, 'task-console-1')
    assert.equal(view?.session.channel, 'pipe')
  })

  void test('增量输出按顺序接起来，被挤掉的部分明说', () => {
    const chunk = (text: string, droppedChars = 0): SystemConsoleOutputChunk => ({
      taskId: 'task-console-1',
      text,
      cursor: 10,
      droppedChars,
      status: 'running',
      acceptsInput: true,
    })
    const dropped = (count: number) => `……中间省略 ${count} 个字符……`

    assert.equal(appendConsoleChunk('密码：', chunk('\n登录成功\n'), dropped), '密码：\n登录成功\n')
    assert.equal(
      appendConsoleChunk('开头', chunk('结尾', 12), dropped),
      '开头\n……中间省略 12 个字符……\n结尾'
    )
  })

  void test('回车提交、Ctrl+C 中断，别的键交给输入框自己', () => {
    assert.equal(resolveConsoleKeyAction({ key: 'Enter', ctrlKey: false, shiftKey: false }), 'submit')
    assert.equal(resolveConsoleKeyAction({ key: 'Enter', ctrlKey: false, shiftKey: true }), 'none')
    assert.equal(resolveConsoleKeyAction({ key: 'c', ctrlKey: true, shiftKey: false }), 'interrupt')
    assert.equal(resolveConsoleKeyAction({ key: 'C', ctrlKey: true, shiftKey: false }), 'interrupt')
    assert.equal(resolveConsoleKeyAction({ key: 'a', ctrlKey: false, shiftKey: false }), 'none')
  })

  void test('状态按「还能不能输入」和「宿主给没给写入通道」来定', () => {
    assert.equal(resolveConsoleStatus(true, true), 'awaiting-input')
    assert.equal(resolveConsoleStatus(true, false), 'running')
    assert.equal(resolveConsoleStatus(false, true), 'ended')
  })

  void test('宿主给了控制台能力：卡片显示命令、等待输入状态和输入框', () => {
    const { capabilities } = fakeConsoleCapabilities()
    const markup = render(
      <ConsoleToolRender block={consoleToolCall()} sessionId="session-1" />,
      capabilities
    )

    assert.match(markup, />system:run</)
    assert.match(markup, /ssh deploy@example\.com/)
    assert.match(markup, />等待输入</)
    assert.match(markup, /placeholder="输入后回车发送，Ctrl\+C 发送中断"/)
    assert.match(markup, /aria-label="控制台输出"/)
    assert.match(markup, />中断</)
  })

  void test('宿主没给控制台能力：降级成只读，不出现输入框', () => {
    const markup = render(<ConsoleToolRender block={consoleToolCall()} sessionId="session-1" />)

    assert.match(markup, /当前运行环境没有提供控制台输入通道/)
    assert.doesNotMatch(markup, /<input/)
    assert.match(markup, />运行中</)
  })

  void test('进程结束后卡片标成已结束', () => {
    const { capabilities } = fakeConsoleCapabilities()
    const markup = render(
      <ConsoleToolRender block={consoleToolCall({ acceptsInput: false })} sessionId="session-1" />,
      capabilities
    )

    assert.match(markup, />已结束</)
  })

  void test('输入和中断都带着会话与任务 id 交给宿主；缺能力时什么都不做', async () => {
    const { capabilities, writes, interrupts } = fakeConsoleCapabilities()

    const written = await submitConsoleInput(capabilities, 'session-1', 'task-console-1', 'velaros')
    assert.equal(written?.accepted, true)
    assert.deepEqual(writes, [{ sessionId: 'session-1', taskId: 'task-console-1', text: 'velaros' }])

    const interrupted = await interruptConsoleSession(capabilities, 'session-1', 'task-console-1')
    assert.equal(interrupted?.accepted, true)
    assert.deepEqual(interrupts, [{ sessionId: 'session-1', taskId: 'task-console-1' }])

    // 没有会话身份、或宿主没注入能力时，卡片不该凭空造一次调用。
    assert.equal(await submitConsoleInput(capabilities, null, 'task-console-1', 'velaros'), null)
    assert.equal(await submitConsoleInput({}, 'session-1', 'task-console-1', 'velaros'), null)
    assert.equal(await interruptConsoleSession({}, 'session-1', 'task-console-1'), null)
    assert.equal(writes.length, 1)
  })
})
