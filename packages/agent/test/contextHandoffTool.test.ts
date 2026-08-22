import { describe, expect, test } from 'bun:test'

import { contextHandoffTools } from '../src/tool-library/builtin/ContextHandoff.tool'

describe('context:handoff', () => {
  test('only requests the host card when the model explicitly executes the tool', async () => {
    const requests: string[] = []
    const result = await contextHandoffTools['context:handoff'].execute(
      { reason: '安全压缩后仍无法保留后续执行所需上下文。' },
      {
        sessionId: 'session-1',
        abortSignal: new AbortController().signal,
        conversation: {
          requestHandoff: async ({ reason }: { reason: string }) => {
            requests.push(reason)
            return { requested: true, sessionId: 'session-1', reason }
          },
        },
      } as never
    )

    expect(requests).toEqual(['安全压缩后仍无法保留后续执行所需上下文。'])
    expect(result).toEqual({
      requested: true,
      sessionId: 'session-1',
      reason: '安全压缩后仍无法保留后续执行所需上下文。',
    })
  })

  test('fails closed when a host does not provide the approval-card port', async () => {
    const result = await contextHandoffTools['context:handoff'].execute(
      { reason: '需要交接。' },
      {
        sessionId: 'session-2',
        abortSignal: new AbortController().signal,
        conversation: {},
      } as never
    )

    expect(result).toEqual({
      requested: false,
      sessionId: 'session-2',
      reason: '需要交接。',
      unavailableReason: '当前宿主不支持会话交接卡。',
    })
  })
})
