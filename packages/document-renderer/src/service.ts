import { isObject, isString } from '@velaros-ai/core'

import { RendererPathDeniedError } from './path-policy'
import {
  type DocumentRendererErrorCode,
  DocumentRendererProtocolVersion,
  DocumentRendererRequestSchema,
  type DocumentRendererResponse,
} from './protocol'
import {
  describeRenderer,
  renderOfficeDocument,
  renderPdfPage,
  UnsupportedRendererFormatError,
} from './renderer'

function errorResponse(
  requestId: string,
  code: DocumentRendererErrorCode,
  message: string,
): DocumentRendererResponse {
  return {
    protocolVersion: DocumentRendererProtocolVersion,
    requestId,
    status: 'error',
    error: { code, message },
  }
}

export async function executeRendererRequest(input: unknown): Promise<DocumentRendererResponse> {
  const parsed = DocumentRendererRequestSchema.safeParse(input)
  if (!parsed.success) {
    const requestId = isObject(input)
      && 'requestId' in input && isString(input.requestId)
      ? input.requestId
      : 'invalid-request'
    return errorResponse(requestId, 'INVALID_REQUEST', parsed.error.message)
  }
  const request = parsed.data
  try {
    const result = request.operation === 'describe'
      ? describeRenderer()
      : request.operation === 'render-office'
        ? await renderOfficeDocument(request)
        : await renderPdfPage(request)
    return {
      protocolVersion: DocumentRendererProtocolVersion,
      requestId: request.requestId,
      status: 'success',
      result,
    }
  } catch (error) {
    if (error instanceof RendererPathDeniedError) return errorResponse(request.requestId, 'PATH_DENIED', error.message)
    if (error instanceof UnsupportedRendererFormatError) return errorResponse(request.requestId, 'UNSUPPORTED_FORMAT', error.message)
    return errorResponse(
      request.requestId,
      'RENDER_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }
}
