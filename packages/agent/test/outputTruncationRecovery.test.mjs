/**
 * @test-meta
 * title: 模型输出截断自动续写
 * summary: 长度或重复保护截断会进入续写，内容过滤等结束原因不会被自动绕过。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

const packagePath = new URL('../dist/index.js', import.meta.url)

function finishDiagnostic(normalizedFinishReason) {
  return {
    code: 'provider-finish-reason',
    message: 'provider stopped',
    details: {
      finishReason: normalizedFinishReason,
      normalizedFinishReason,
      finishReasons: [normalizedFinishReason],
      rawFinishReasons: [],
    },
  }
}

test('length and repetition truncation are recoverable', async () => {
  const { isRecoverableOutputTruncationDiagnostic } = await import(packagePath.href)

  assert.equal(isRecoverableOutputTruncationDiagnostic(finishDiagnostic('length')), true)
  assert.equal(
    isRecoverableOutputTruncationDiagnostic(finishDiagnostic('repetition_truncation')),
    true
  )
  assert.equal(isRecoverableOutputTruncationDiagnostic(finishDiagnostic('content_filter')), false)
})

test('truncation recovery uses a dedicated error and continuation prompt', async () => {
  const {
    buildOutputTruncationContinuationPrompt,
    createOutputTruncationError,
    isOutputTruncationError,
  } = await import(packagePath.href)
  const error = createOutputTruncationError(finishDiagnostic('length'), {
    model: 'test-model',
    turn: 3,
  })
  const prompt = buildOutputTruncationContinuationPrompt(true)

  assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED')
  assert.equal(isOutputTruncationError(error), true)
  assert.equal(error.context.source, 'stream-output-truncated')
  assert.match(prompt, /Continue exactly from the cutoff point/u)
  assert.match(prompt, /without repeating/u)
})

test('stream consumer preserves partial text when provider finishes by length', async () => {
  const { StreamConsumer } = await import(packagePath.href)
  const consumer = new StreamConsumer({})
  const textDeltas = []
  let interruptedPartial = null
  const fullStream = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', id: 'text-1', text: '已经输出的前半段' }
      yield {
        type: 'finish',
        finishReason: 'other',
        rawFinishReason: 'max_tokens',
        totalUsage: { outputTokens: 4096 },
      }
    },
  }

  await assert.rejects(
    consumer.consumeAssistantStream(
      fullStream,
      {
        turn: 1,
        hasToolUse: false,
        accumulatedText: '',
        hasVisibleOutput: false,
      },
      {
        abortSignal: new AbortController().signal,
        executor: { enqueue: () => undefined },
        events: {
          emitReasoningDelta: () => undefined,
          emitTextDelta: (text) => textDeltas.push(text),
          emitToolStart: () => undefined,
        },
        model: 'test-model',
        onInterruptedPartial: (partial) => {
          interruptedPartial = partial
        },
      }
    ),
    (error) => error?.code === 'MODEL_OUTPUT_TRUNCATED'
  )

  assert.deepEqual(textDeltas, ['已经输出的前半段'])
  assert.deepEqual(interruptedPartial?.assistantContent, [
    { type: 'text', text: '已经输出的前半段' },
  ])
  assert.equal(interruptedPartial?.hasPendingToolCalls, false)
})

test('final tool input reparses complete JSON strings but rejects truncated strings', async () => {
  const { resolveProviderFinalToolInput } = await import(packagePath.href)

  assert.deepEqual(resolveProviderFinalToolInput('{"type":"html","content":"ok"}'), {
    ok: true,
    input: { type: 'html', content: 'ok' },
    reparsedString: true,
  })
  assert.deepEqual(resolveProviderFinalToolInput('{"type":"html","content":"cut'), {
    ok: false,
    reason: 'final_tool_input_json_parse_failed',
    receivedType: 'string',
    inputChars: 29,
  })
})

test('invalid final tool input may recover only from a completed valid stream draft', async () => {
  const { resolveProviderExecutableToolInput } = await import(packagePath.href)
  const completedDraft = {
    id: 'tool-1',
    toolName: 'project:edit',
    inputText: '{"path":"report.md","content":"complete"}',
    inputEnded: true,
  }

  assert.deepEqual(
    resolveProviderExecutableToolInput('{"path":"report.md","content":"cut', completedDraft),
    {
      ok: true,
      input: { path: 'report.md', content: 'complete' },
      source: 'ended-stream-draft',
    }
  )
  assert.deepEqual(
    resolveProviderExecutableToolInput('{"path":"report.md","content":"cut', {
      ...completedDraft,
      inputEnded: false,
    }),
    {
      ok: false,
      reason: 'final_tool_input_json_parse_failed',
      receivedType: 'string',
      inputChars: 34,
    }
  )
  assert.deepEqual(
    resolveProviderExecutableToolInput('{"path":"report.md","content":"cut', {
      ...completedDraft,
      inputText: '{"path":"report.md","content":"also cut',
    }),
    {
      ok: false,
      reason: 'final_tool_input_json_parse_failed',
      receivedType: 'string',
      inputChars: 34,
    }
  )
})

test('invalid tool input diagnostics expose structure without exposing content', async () => {
  const { diagnoseRejectedProviderToolInput } = await import(packagePath.href)
  const finalInput = '{"path":"private-report.md","content":"line one\nline two'
  const diagnostic = diagnoseRejectedProviderToolInput(finalInput, {
    id: 'tool-1',
    toolName: 'project:write',
    inputText: finalInput,
    inputEnded: true,
  })

  assert.equal(diagnostic.final.startsWithObject, true)
  assert.equal(diagnostic.final.endsWithObject, false)
  assert.equal(diagnostic.final.terminatedInString, true)
  assert.equal(diagnostic.final.rawControlCharactersInString, 1)
  assert.equal(diagnostic.final.parseStatus, 'invalid-json')
  assert.equal(diagnostic.streamDraft.inputEnded, true)
  assert.equal(diagnostic.streamDraft.identicalToFinal, true)
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-report|line one/u)
})

test('capability aliases are absent by default and resolve only when injected', async () => {
  const { ToolExecutionPolicy } = await import(packagePath.href)
  const policy = new ToolExecutionPolicy({
    get: (toolName) => (toolName === 'artifact:produce' ? {} : null),
  })

  assert.equal(policy.resolveCanonicalToolName('artifact:produce'), 'artifact:produce')
  assert.equal(policy.resolveCanonicalToolName('export_workspace_file'), 'export_workspace_file')
  assert.equal(
    policy.resolveCanonicalToolName('EXPORT_WORKSPACE_FILE', {
      toolAliases: { export_workspace_file: 'artifact:produce' },
    }),
    'artifact:produce'
  )
})

test('stream consumer never executes a truncated final tool call', async () => {
  const { StreamConsumer } = await import(packagePath.href)
  const consumer = new StreamConsumer({ get: () => null })
  const enqueued = []
  let interruptedPartial = null
  const fullStream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'artifact:produce',
        input: '{"type":"html","content":"cut',
      }
      yield {
        type: 'finish',
        finishReason: 'length',
        rawFinishReason: 'max_tokens',
        totalUsage: { outputTokens: 8192 },
      }
    },
  }

  await assert.rejects(
    consumer.consumeAssistantStream(
      fullStream,
      {
        turn: 1,
        hasToolUse: false,
        accumulatedText: '',
        hasVisibleOutput: false,
      },
      {
        abortSignal: new AbortController().signal,
        executor: {
          enqueue: (...args) => enqueued.push(args),
        },
        events: {
          emitReasoningDelta: () => undefined,
          emitTextDelta: () => undefined,
          emitToolStart: () => undefined,
        },
        model: 'test-model',
        onInterruptedPartial: (partial) => {
          interruptedPartial = partial
        },
      }
    ),
    (error) =>
      error?.code === 'MODEL_STREAM_INTERRUPTED' &&
      error?.context?.finishReason === 'length'
  )

  assert.deepEqual(enqueued, [])
  assert.equal(interruptedPartial?.hasPendingToolCalls, true)
})

test('HTML Live Preview raises only its own turn output budget floor', async () => {
  const {
    HtmlArtifactMinimumOutputTokens,
    resolveSoloTurnModelRequestOptions,
  } = await import(packagePath.href)
  const compact = {
    requestPolicy: { temperature: 0.15, maxOutputTokens: 8192 },
  }

  assert.equal(resolveSoloTurnModelRequestOptions(compact, []), compact)
  assert.deepEqual(
    resolveSoloTurnModelRequestOptions(compact, ['html-artifact']),
    {
      requestPolicy: {
        temperature: 0.15,
        maxOutputTokens: HtmlArtifactMinimumOutputTokens,
      },
    }
  )
})
