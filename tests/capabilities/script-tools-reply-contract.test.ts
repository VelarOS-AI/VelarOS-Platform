/**
 * 门的回执与 agent 历史层之间的约定：四个脚本工具交回 `{ result, modelContent }`，result 与内容块里的文字逐字一致，
 * agent 认出这一点就把内容块原样交给模型——不转义、不截断（裸字符串结果会被截到 2000 字、再套一层 JSON 转义）。
 * 两边互不引用，这条约定属于仓库层，所以测试放在这里。
 */

import { describe, expect, test } from 'bun:test'

import { appendToolResultsToHistory } from '../../packages/agent/src/utils/history/turn'
import { liftGenericModelContent } from '../../packages/agent/src/utils/tools/model-image-lift'
import type { CodeGateReply, CodeProgramGateApi } from '../../packages/script/src/index'
import { codeSurfaceTools, type CodeSurfaceToolContext } from '../../packages/velaros/script/index'

/** 一扇只回固定回执的门：这里测的是回执怎么到模型那里，不是门怎么办事。 */
function gateReplying(reply: CodeGateReply, text: string): CodeProgramGateApi {
  return { describe: () => '', exec: async () => reply, history: async () => text, show: async () => text, diff: async () => text, forget: () => {} }
}

/** 像 agent 的执行器那样收下工具的原始返回，再像历史层那样写成一条 tool 消息，交回模型看到的那一格 output。 */
async function outputSeenByModel(toolName: string, raw: unknown): Promise<unknown> {
  const lifted = liftGenericModelContent({ toolCallId: 'call-1', toolName, args: {}, result: raw }, raw)
  const history: Parameters<typeof appendToolResultsToHistory>[0] = []
  await appendToolResultsToHistory(history, { collectAll: async () => [lifted], getTerminalError: () => null })
  const message = history[0] as { content: Array<{ output: unknown }> }
  return message.content[0]!.output
}

describe('script tools reply reaches the model as-is', () => {
  const text = JSON.stringify({ value: { note: '引号"反斜杠\\\\换行\n', lines: Array.from({ length: 400 }, (_, index) => `第 ${index} 行`) } })
  const pixels = Buffer.from('fake-png-bytes').toString('base64')
  const context = (reply: CodeGateReply, modalities: readonly string[]): CodeSurfaceToolContext => ({
    abortSignal: new AbortController().signal,
    sessionId: 's1',
    gate: gateReplying(reply, text),
    space: { modules: [], capabilities: { listOperations: () => ({}), invoke: async () => ({ value: null }) }, timeline: { directory: '/unused' } },
    getSupportedModelInputModalities: () => modalities,
  })
  const steps = [{ op: 'run', program: 'export default 1' }]

  test('a long exec reply with images arrives as the same content blocks, untruncated and unescaped', async () => {
    expect(text.length).toBeGreaterThan(2_000)
    const reply: CodeGateReply = { text, images: [{ type: 'image-data', mediaType: 'image/png', data: pixels, label: '截图 1' }], call: 'C1', steps: [] }
    const raw = await codeSurfaceTools['script:exec'].execute({ steps }, context(reply, ['text', 'image']))
    expect(await outputSeenByModel('script:exec', raw)).toEqual({
      type: 'content',
      value: [
        { type: 'text', text },
        { type: 'text', text: '截图 1' },
        { type: 'image-data', data: pixels, mediaType: 'image/png' },
      ],
    })
  })

  test('without images the exec reply is still one untruncated text block', async () => {
    const reply: CodeGateReply = { text, images: [], call: 'C1', steps: [] }
    const raw = await codeSurfaceTools['script:exec'].execute({ steps }, context(reply, ['text']))
    expect(await outputSeenByModel('script:exec', raw)).toEqual({ type: 'content', value: [{ type: 'text', text }] })
  })

  test('history, show and diff each arrive as one untruncated text block', async () => {
    const reply: CodeGateReply = { text: 'unused', images: [], call: 'C1', steps: [] }
    for (const [name, input] of [['script:history', {}], ['script:show', { ref: 'C1.1' }], ['script:diff', { from: 'C1' }]] as const) {
      const raw = await codeSurfaceTools[name].execute(input, context(reply, ['text']))
      expect(await outputSeenByModel(name, raw)).toEqual({ type: 'content', value: [{ type: 'text', text }] })
    }
  })
})
