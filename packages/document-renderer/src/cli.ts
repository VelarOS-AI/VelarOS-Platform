#!/usr/bin/env node

import { AppError } from '@velaros-ai/core/error'

import type { DocumentRendererResponse } from './protocol'
import { executeRendererRequest, invalidRequestResponse } from './service'

/**
 * 命令协议：一个进程恰好回一条 JSON 回执。
 *
 * 所以**任何**输入错误（`--request-json` 后面没参数、参数不是合法 JSON、标准输入不是 JSON）
 * 都要收成 INVALID_REQUEST 回执写 stdout，而不是抛出去让进程只在 stderr 留一行英文、stdout 空着。
 */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析一段 JSON 文本；失败时把原因收成回执，不抛。 */
function parseRequestJson(
  text: string,
  source: string,
): { ok: true; value: unknown } | { ok: false; response: DocumentRendererResponse } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return {
      ok: false,
      response: invalidRequestResponse(`${source}不是合法的 JSON：${AppError.getMessage(error)}`),
    }
  }
}

async function resolveResponse(
  argv: readonly string[],
  inputText?: string,
): Promise<DocumentRendererResponse> {
  const requestIndex = argv.indexOf('--request-json')
  if (requestIndex >= 0) {
    const json = argv[requestIndex + 1]
    if (!json) return invalidRequestResponse('--request-json 后面要跟一个 JSON 对象。')
    const parsed = parseRequestJson(json, '--request-json 的值')
    return parsed.ok ? executeRendererRequest(parsed.value) : parsed.response
  }

  if (argv[0] === 'describe') return executeRendererRequest({
      protocolVersion: 1,
      requestId: 'describe',
      operation: 'describe',
    })

  const parsed = parseRequestJson(inputText ?? await readStandardInput(), '标准输入')
  return parsed.ok ? executeRendererRequest(parsed.value) : parsed.response
}

export async function runDocumentRendererCli(
  argv: readonly string[],
  inputText?: string,
): Promise<{ exitCode: number; text: string }> {
  const response = await resolveResponse(argv, inputText)
  return {
    exitCode: response.status === 'success' ? 0 : 1,
    text: `${JSON.stringify(response)}\n`,
  }
}

if (import.meta.main) {
  void runDocumentRendererCli(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(result.text)
      process.exitCode = result.exitCode
    },
    (error) => {
      // 兜底：连回执都没做出来（读标准输入失败之类），也要留一条 JSON，不让 stdout 空着。
      const response: DocumentRendererResponse = {
        protocolVersion: 1,
        requestId: 'invalid-request',
        status: 'error',
        error: { code: 'RENDER_FAILED', message: AppError.getMessage(error) },
      }
      process.stdout.write(`${JSON.stringify(response)}\n`)
      process.exitCode = 1
    },
  )
}
