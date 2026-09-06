import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'bun:test'

import { AgentTurnHistoryHelper } from '../src/agent/history'
import { ChatStreamProtocol } from '../src/chat/stream/ChatStreamProtocol'
import { translateMcpCallResult } from '../src/tool-library/mcp/mcpCallResult'
import { liftGenericModelContent } from '../src/tools/modelImageLift'

describe('MCP call result media', () => {
  test('preserves ordered text, images, audio, and embedded resource media outside the text result', () => {
    const translated = translateMcpCallResult({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', data: 'image-one', mimeType: 'image/webp' },
        { type: 'audio', data: 'audio-one', mimeType: 'audio/mpeg' },
        {
          type: 'resource',
          resource: { uri: 'memory://notes', mimeType: 'text/plain', text: 'resource text' },
        },
        {
          type: 'resource',
          resource: { uri: 'memory://diagram', mimeType: 'image/png', blob: 'image-two' },
        },
        { type: 'text', text: 'after' },
      ],
    }, 'media-server/read')

    const lifted = liftGenericModelContent({
      toolCallId: 'call-1',
      toolName: 'mcp.media-server:read',
      result: translated,
    }, translated)

    expect(lifted.result).toBe(
      'before\n[MCP resource: memory://notes]\nresource text\n' +
      '[MCP resource: memory://diagram]\nafter'
    )
    expect(lifted.modelContent).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image-data', data: 'image-one', mediaType: 'image/webp' },
      { type: 'file-data', data: 'audio-one', mediaType: 'audio/mpeg' },
      { type: 'text', text: '[MCP resource: memory://notes]\nresource text' },
      { type: 'text', text: '[MCP resource: memory://diagram]' },
      { type: 'image-data', data: 'image-two', mediaType: 'image/png' },
      { type: 'text', text: 'after' },
    ])
    expect(lifted.modelImage).toEqual({ data: 'image-two', mediaType: 'image/png' })
    expect(JSON.stringify(lifted.result)).not.toContain('image-one')
    expect(JSON.stringify(lifted.result)).not.toContain('audio-one')
  })

  test('writes every result media block to the next model turn and retains legacy modelImage', async () => {
    const history: ModelMessage[] = []
    const helper = new AgentTurnHistoryHelper()
    await helper.appendToolResultsToHistory(history, {
      collectAll: async () => [
        {
          toolCallId: 'first',
          toolName: 'mcp.media:first',
          result: 'first result',
          modelContent: [
            { type: 'text' as const, text: 'first result' },
            { type: 'image-data' as const, data: 'first-image', mediaType: 'image/webp' },
            { type: 'file-data' as const, data: 'first-audio', mediaType: 'audio/wav' },
          ],
        },
        {
          toolCallId: 'second',
          toolName: 'legacy:screenshot',
          result: { width: 100 },
          modelImage: { data: 'second-image', mediaType: 'image/png' },
        },
      ],
      getTerminalError: () => null,
    })

    expect(history).toEqual([{
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'first',
          toolName: 'mcp.media:first',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'first result' },
              { type: 'image-data', data: 'first-image', mediaType: 'image/webp' },
              { type: 'file-data', data: 'first-audio', mediaType: 'audio/wav' },
            ],
          },
        },
        {
          type: 'tool-result',
          toolCallId: 'second',
          toolName: 'legacy:screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: '{"width":100}' },
              { type: 'image-data', data: 'second-image', mediaType: 'image/png' },
            ],
          },
        },
      ],
    }])
  })

  test('keeps structured content alongside media without copying base64 into the ordinary result', () => {
    const translated = translateMcpCallResult({
      structuredContent: { ok: true, count: 1 },
      content: [
        { type: 'text', text: 'generated preview' },
        { type: 'image', data: 'structured-image', mimeType: 'image/jpeg' },
      ],
    }, 'media-server/structured')
    const lifted = liftGenericModelContent({
      toolCallId: 'structured',
      toolName: 'mcp.media-server:structured',
      result: translated,
    }, translated)

    expect(lifted.result).toEqual({ ok: true, count: 1, _text: 'generated preview' })
    expect(lifted.modelContent).toEqual([
      { type: 'text', text: 'generated preview' },
      { type: 'image-data', data: 'structured-image', mediaType: 'image/jpeg' },
    ])
    expect(JSON.stringify(lifted.result)).not.toContain('structured-image')
  })

  test('preserves distinct middleware and legacy output images while stripping output bytes', () => {
    const rawOutput = {
      ok: true,
      modelImage: { data: 'output-image', mediaType: 'image/jpeg' },
    }
    const lifted = liftGenericModelContent({
      toolCallId: 'two-images',
      toolName: 'legacy:two-images',
      result: rawOutput,
      modelImage: { data: 'middleware-image', mediaType: 'image/png' },
    }, rawOutput)

    expect(lifted.result).toEqual({ ok: true })
    expect(lifted.modelImage).toEqual({ data: 'middleware-image', mediaType: 'image/png' })
    expect(lifted.modelContent).toEqual([
      { type: 'image-data', data: 'middleware-image', mediaType: 'image/png' },
      { type: 'image-data', data: 'output-image', mediaType: 'image/jpeg' },
    ])
  })

  test('falls back to readable summaries for malformed media and preserves MCP error text', () => {
    expect(translateMcpCallResult({
      content: [
        { type: 'image', data: 'missing-media-type' },
        { type: 'audio', data: 'wrong-media-type', mimeType: 'image/png' },
      ],
    }, 'media-server/malformed')).toBe('[MCP image content]\n[MCP audio content]')

    expect(() => translateMcpCallResult({
      isError: true,
      content: [{ type: 'text', text: 'decoder failed' }],
    }, 'media-server/error')).toThrow('decoder failed')
  })

  test('keeps malformed media summaries in order beside valid media blocks', () => {
    const translated = translateMcpCallResult({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', data: 'missing-media-type' },
        { type: 'audio', data: 'valid-audio', mimeType: 'audio/ogg' },
        { type: 'text', text: 'after' },
      ],
    }, 'media-server/mixed')
    const lifted = liftGenericModelContent({
      toolCallId: 'mixed',
      toolName: 'mcp.media-server:mixed',
      result: translated,
    }, translated)

    expect(lifted.result).toBe('before\n[MCP image content]\nafter')
    expect(lifted.modelContent).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: '[MCP image content]' },
      { type: 'file-data', data: 'valid-audio', mediaType: 'audio/ogg' },
      { type: 'text', text: 'after' },
    ])
  })

  test('carries ordered model content through the stream event protocol', () => {
    const modelContent = [
      { type: 'text' as const, text: 'listen' },
      { type: 'file-data' as const, data: 'audio-data', mediaType: 'audio/ogg' },
    ]
    const outputs = new ChatStreamProtocol().mapAgentEvent({
      type: 'tool-done',
      toolCallId: 'streamed',
      result: 'listen',
      modelContent,
    }, {
      toSerializedError: () => ({ name: 'Error', message: 'unused' }),
    })

    expect(outputs[0]).toMatchObject({
      kind: 'events',
      events: [{ type: 'tool-result', payload: { modelContent } }],
    })
  })
})
