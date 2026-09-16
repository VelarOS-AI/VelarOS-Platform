/**
 * 命令协议的外壳零件：读标准输入、把任何异常收成错误码、拼出两种回执。
 * 「一个进程恰好一条 JSON 回执」靠的就是这几件：读不到、抛出来的东西最后都还能变成一条回执。
 */
import { AppError } from '@velaros-ai/core'

import {
  type DocumentRendererErrorCode,
  DocumentRendererErrorCodes,
  DocumentRendererProtocol,
} from '../contract/constants.js'
import type { DocumentRendererResponse } from '../types/document-renderer.js'

/** 把标准输入整段读成 UTF-8 文本；没有输入时给空串。 */
export async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** 把任何异常收成四个错误码之一：带着认得的码就原样用（路径被拒、格式不支持），其余一律 RENDER_FAILED。 */
export function toRendererErrorCode(error: unknown): DocumentRendererErrorCode {
  const { code } = AppError.from(error)
  const known = Object.values(DocumentRendererErrorCodes).find((candidate) => candidate === code)
  return known ?? DocumentRendererErrorCodes.renderFailed
}

/** 成功回执：回显 requestId，带上这次操作的结果。 */
export function successResponse(requestId: string, result: unknown): DocumentRendererResponse {
  return {
    protocolVersion: DocumentRendererProtocol.version,
    requestId,
    status: 'success',
    result,
  }
}

/** 失败回执：回显 requestId，带上错误码与一句中文说明。 */
export function errorResponse(
  requestId: string,
  code: DocumentRendererErrorCode,
  message: string,
): DocumentRendererResponse {
  return {
    protocolVersion: DocumentRendererProtocol.version,
    requestId,
    status: 'error',
    error: { code, message },
  }
}
