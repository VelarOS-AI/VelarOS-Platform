/**
 * @test-meta
 * title: Chat Completions 供应商的思考参数与退档重发
 * summary: 模型运行时 · 兼容网关、DeepSeek、Grok、通义等按厂商写思考参数；型号不认就往下退档重发，退到底不带思考参数，并记住。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import { ReasoningFallback } from '../src/impl/adapters/ReasoningFallback'
import { chatReasoningFields } from '../src/utils/wire/chat-reasoning'

const ChatUrl = 'https://gateway.test/v1/chat/completions'

/** 发出去的请求体，以及每一次按顺序给出的响应。 */
function recordingFetch(respond: (body: Record<string, unknown>) => Response) {
  const bodies: Array<Record<string, unknown>> = []
  const fetch = async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    return respond(body)
  }
  return { bodies, fetch }
}

function send(fetch: ReturnType<ReasoningFallback['chatFetch']>, model: string, extra = {}) {
  return fetch(ChatUrl, {
    method: 'POST',
    body: JSON.stringify({ model, messages: [], ...extra }),
  })
}

const rejected = (message: string) => Response.json({ error: { message } }, { status: 400 })

describe('Chat Completions 的思考参数', () => {
  test('按厂商写：通义开思考带预算，DeepSeek 高档以上才写，其余按型号名认推理型号', () => {
    expect(chatReasoningFields('qwen', 'qwen3.6-plus', 'medium')).toEqual({
      enable_thinking: true,
      thinking_budget: 4096,
    })
    expect(chatReasoningFields('deepseek', 'deepseek-v4-pro', 'low')).toBeNull()
    expect(chatReasoningFields('deepseek', 'deepseek-v4-pro', 'high')).toEqual({
      reasoning_effort: 'high',
    })
    expect(chatReasoningFields('deepseek', 'deepseek-v4-pro', 'xhigh')).toEqual({
      reasoning_effort: 'max',
    })
    expect(chatReasoningFields('openai-compatible-gateway', 'gpt-5.5', 'max')).toEqual({
      reasoning_effort: 'xhigh',
    })
    expect(chatReasoningFields('xai', 'grok-4.20', 'max')).toEqual({ reasoning_effort: 'high' })
    expect(chatReasoningFields('openai-compatible-gateway', 'llama-3.3-70b', 'high')).toBeNull()
  })

  test('型号不认这一档：往下退一档重发；同一个型号之后直接从能用的那一档发', async () => {
    const { bodies, fetch } = recordingFetch((body) =>
      body.reasoning_effort === 'xhigh'
        ? rejected(
            "Unsupported value: 'reasoning_effort' does not support 'xhigh' with this model."
          )
        : Response.json({ ok: true })
    )
    const chat = new ReasoningFallback().chatFetch({
      provider: 'openai-compatible-gateway',
      level: 'max',
      fetch,
    })

    expect((await send(chat, 'gpt-5.5')).status).toBe(200)
    expect((await send(chat, 'gpt-5.5')).status).toBe(200)
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['xhigh', 'high', 'high'])
  })

  test('型号整个不认思考参数：退到底不带思考参数发，之后不再试', async () => {
    const { bodies, fetch } = recordingFetch((body) =>
      'reasoning_effort' in body
        ? rejected('Argument not supported on this model: reasoning_effort')
        : Response.json({ ok: true })
    )
    const chat = new ReasoningFallback().chatFetch({ provider: 'xai', level: 'high', fetch })

    expect((await send(chat, 'grok-4')).status).toBe(200)
    expect((await send(chat, 'grok-4')).status).toBe(200)
    expect(bodies.map((body) => body.reasoning_effort ?? null)).toEqual([
      'high',
      'medium',
      'low',
      null,
      null,
    ])
  })

  test('与思考无关的 400 原样交出，不重发；调用方写死的字段优先', async () => {
    const { bodies, fetch } = recordingFetch(() => rejected('maximum context length exceeded'))
    const chat = new ReasoningFallback().chatFetch({ provider: 'xai', level: 'high', fetch })

    expect((await send(chat, 'grok-4.20')).status).toBe(400)
    expect(bodies).toHaveLength(1)

    const kept = recordingFetch(() => Response.json({ ok: true }))
    const explicit = new ReasoningFallback().chatFetch({
      provider: 'xai',
      level: 'high',
      fetch: kept.fetch,
    })
    await send(explicit, 'grok-4.20', { reasoning_effort: 'low' })
    expect(kept.bodies[0]?.reasoning_effort).toBe('low')
  })
})
