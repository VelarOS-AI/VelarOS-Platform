/**
 * 命令协议的唯一出口：把一条请求（JSON 值、命令行参数或标准输入）变成恰好一条回执。
 * 校验、分派、错误收口都在这里；真正的渲染交给 `OfficeRenderer`，路径判定再往下交给 `RendererPaths`。
 */
import { AppError } from '@velaros-ai/core'

import {
  DocumentRendererErrorCodes,
  DocumentRendererFormats,
  DocumentRendererProtocol,
} from '../contract/constants.js'
import type {
  DocumentRendererCliResult,
  DocumentRendererResponse,
  RendererDescriptor,
} from '../types/document-renderer.js'
import type { DocumentRendererRequest } from '../types/rendering.js'
import {
  errorResponse,
  readStandardInput,
  successResponse,
  toRendererErrorCode,
} from '../utils/command.js'
import { checkDocumentRendererRequest, readRequestId } from '../utils/request.js'

import { officeRenderer, type OfficeRendererApi } from './OfficeRenderer.js'

/**
 * 独立文档渲染器的整件能力：一个进程恰好回一条 JSON 回执。实例是 `documentRenderer`，产品的可执行文件只是它的壳。
 * 三个方法都不抛错：任何失败都收成带错误码的回执，调用方按 `error.code` 判断，不按文字。
 */
export interface DocumentRendererApi {
  /**
   * 执行一次请求。`request` 是还没校验过的任意值（通常是刚 `JSON.parse` 出来的东西）：
   * 不合法给 INVALID_REQUEST 回执，路径越界给 PATH_DENIED，格式不认给 UNSUPPORTED_FORMAT，其余失败给 RENDER_FAILED。
   */
  execute: (request: unknown) => Promise<DocumentRendererResponse>
  /**
   * 按命令行语义跑一次：`--request-json <JSON>` 用参数里的请求，`describe` 自报身份，都没有就读标准输入（`inputText` 可以替它给一段文本）。
   * 参数缺失、JSON 语法错同样回一条 INVALID_REQUEST 回执，退出码 1；成功退出码 0。
   */
  runCli: (argv: readonly string[], inputText?: string) => Promise<DocumentRendererCliResult>
  /** 自报协议、产品名、包版本与两种操作各自认的扩展名；打包脚本按它核对可执行文件的身份。 */
  describe: () => RendererDescriptor
}

class DocumentRenderer implements DocumentRendererApi {
  /** 请求还没解析出来时，回执用的占位身份。 */
  private static readonly InvalidRequestId = 'invalid-request'

  /** 命令行上带请求的那个参数名。 */
  private static readonly RequestJsonFlag = '--request-json'

  /** 命令行上自报身份的那个子命令，与 `describe` 操作同名。 */
  private static readonly DescribeArgument = 'describe'

  public constructor(private readonly renderer: OfficeRendererApi) {}

  public async execute(request: unknown): Promise<DocumentRendererResponse> {
    const checked = checkDocumentRendererRequest(request)
    if (!checked.ok) return errorResponse(
      readRequestId(request, DocumentRenderer.InvalidRequestId),
      DocumentRendererErrorCodes.invalidRequest,
      checked.message,
    )
    try {
      return successResponse(checked.request.requestId, await this.runOperation(checked.request))
    } catch (error) {
      return errorResponse(
        checked.request.requestId,
        toRendererErrorCode(error),
        AppError.getMessage(error),
      )
    }
  }

  public async runCli(
    argv: readonly string[],
    inputText?: string,
  ): Promise<DocumentRendererCliResult> {
    // 连回执都没做出来（读标准输入失败之类）也要留一条 JSON，不让 stdout 空着。
    const response = await this.resolveResponse(argv, inputText).catch((error: unknown) =>
      errorResponse(
        DocumentRenderer.InvalidRequestId,
        toRendererErrorCode(error),
        AppError.getMessage(error),
      ))
    return {
      exitCode: response.status === 'success' ? 0 : 1,
      text: `${JSON.stringify(response)}\n`,
    }
  }

  public describe(): RendererDescriptor {
    return {
      protocolVersion: DocumentRendererProtocol.version,
      product: DocumentRendererProtocol.product,
      version: DocumentRendererProtocol.packageVersion,
      transport: DocumentRendererProtocol.transport,
      operations: [DocumentRendererFormats.renderOffice, DocumentRendererFormats.renderPdfPage],
    }
  }

  /** 按 operation 把请求交给对应的实现；describe 自己回答。 */
  private async runOperation(request: DocumentRendererRequest): Promise<unknown> {
    if (request.operation === DocumentRendererFormats.renderOffice.name) return this.renderer.renderOffice(request)
    if (request.operation === DocumentRendererFormats.renderPdfPage.name) return this.renderer.renderPdfPage(request)
    return this.describe()
  }

  /**
   * 命令行的三条来源：`--request-json` 的值、`describe` 子命令、标准输入。
   * 参数缺失时不抛错，直接给回执——命令协议只认 stdout 上那一条 JSON。
   */
  private async resolveResponse(
    argv: readonly string[],
    inputText?: string,
  ): Promise<DocumentRendererResponse> {
    const requestIndex = argv.indexOf(DocumentRenderer.RequestJsonFlag)
    if (requestIndex >= 0) {
      const json = argv[requestIndex + 1]
      if (!json) return errorResponse(
        DocumentRenderer.InvalidRequestId,
        DocumentRendererErrorCodes.invalidRequest,
        `${DocumentRenderer.RequestJsonFlag} 后面要跟一个 JSON 对象。`,
      )
      return this.executeJsonText(json, `${DocumentRenderer.RequestJsonFlag} 的值`)
    }

    if (argv[0] === DocumentRenderer.DescribeArgument) return this.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: DocumentRenderer.DescribeArgument,
      operation: DocumentRenderer.DescribeArgument,
    })

    return this.executeJsonText(inputText ?? await readStandardInput(), '标准输入')
  }

  /** 解析一段 JSON 文本再执行；解析不了就把原因收成回执，不抛。 */
  private async executeJsonText(text: string, source: string): Promise<DocumentRendererResponse> {
    let request: unknown
    try {
      request = JSON.parse(text)
    } catch (error) {
      return errorResponse(
        DocumentRenderer.InvalidRequestId,
        DocumentRendererErrorCodes.invalidRequest,
        `${source}不是合法的 JSON：${AppError.getMessage(error)}`,
      )
    }
    return this.execute(request)
  }
}

/** 进程里的那一份渲染器。 */
export const documentRenderer: DocumentRendererApi = new DocumentRenderer(officeRenderer)
