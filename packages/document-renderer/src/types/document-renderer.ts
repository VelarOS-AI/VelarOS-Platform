/**
 * 命令协议的对外数据（可移植）：describe 自报什么、一条回执长什么样、跑一次命令行给出什么。
 * 手写，不从 schema 推导；只从常量表 import type，不引任何实现，任何进程都能直接加载。
 */
// 门禁要求可移植文件的常量表 import 写成一行。
import type { DocumentRendererErrorCode, DocumentRendererProtocol } from '../contract/constants.js'

/** 一种渲染操作认的扩展名：describe 把两种操作各报一条。 */
export interface RendererOperationDescriptor {
  /** 操作名，与请求里的 operation 一样。 */
  readonly name: string
  /** 认的输入扩展名，小写、带点。 */
  readonly inputExtensions: readonly string[]
  /** 认的输出扩展名，小写、带点。 */
  readonly outputExtensions: readonly string[]
}

/** describe 的结果：渲染器自报协议、身份、版本与支持的格式，宿主据此判断这个可执行文件对不对得上。 */
export interface RendererDescriptor {
  /** 协议版本。 */
  readonly protocolVersion: typeof DocumentRendererProtocol.version
  /** 产品名，固定是 `velar-document-renderer`。 */
  readonly product: typeof DocumentRendererProtocol.product
  /** 包版本，与 package.json 的 version 一致。 */
  readonly version: string
  /** 传输约定：一个进程一条请求一条回执。 */
  readonly transport: typeof DocumentRendererProtocol.transport
  /** 支持的操作与它们各自认的扩展名。 */
  readonly operations: readonly RendererOperationDescriptor[]
}

/** 一条回执：成功带结果，失败带错误码与一句中文说明；两种都回显 requestId。 */
export type DocumentRendererResponse =
  | {
      /** 协议版本。 */
      readonly protocolVersion: typeof DocumentRendererProtocol.version
      /** 原样回显请求里的 requestId；请求还没解析出来时是 `invalid-request`。 */
      readonly requestId: string
      /** 这一条是成功回执。 */
      readonly status: 'success'
      /** 操作的结果：describe 给描述，两种渲染给落盘后的文件信息。 */
      readonly result: unknown
    }
  | {
      /** 协议版本。 */
      readonly protocolVersion: typeof DocumentRendererProtocol.version
      /** 原样回显请求里的 requestId；请求还没解析出来时是 `invalid-request`。 */
      readonly requestId: string
      /** 这一条是失败回执。 */
      readonly status: 'error'
      /** 失败的原因：码给程序判断，文字给人和模型看。 */
      readonly error: {
        /** 四个错误码之一。 */
        readonly code: DocumentRendererErrorCode
        /** 一句中文说明，字段名、路径、扩展名原样夹在里面。 */
        readonly message: string
      }
    }

/** 跑一次命令行的结果：进程把 text 原样写进 stdout，再用 exitCode 退出。 */
export interface DocumentRendererCliResult {
  /** 退出码：成功 0，失败 1。 */
  readonly exitCode: number
  /** 写给 stdout 的那一条 JSON 回执，末尾带换行。 */
  readonly text: string
}
