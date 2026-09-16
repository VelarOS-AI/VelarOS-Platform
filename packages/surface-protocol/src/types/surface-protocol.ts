/**
 * 线格式数据（可移植）：provider 自持代理面在桥上传的每一种载荷，外加校验结果的形状。
 * 手写，不从 schema 推导；schema 在 `utils/wire.ts` 里逐个 `satisfies z.ZodType<…>` 对齐这里的类型，对不上编译就红。
 * 只从常量表 import type，不引任何实现，浏览器与扩展都能加载。
 */
// 门禁要求可移植文件的常量表 import 写成一行。
import type { ProviderSurfaceArtifactMediaType, ProviderSurfaceProtocol, ProviderSurfaceToolResultStatus, ProviderSurfaceWorkspaceSpace } from '../contract/constants.js'

/** 校验失败时指出哪一处不合法：只有路径与错误码，不带载荷值。 */
export interface ProviderSurfaceIssue {
  /** 出问题的字段路径，点号连接（例如 `artifacts.0.data`）；整条载荷本身出问题时是空串。 */
  path: string
  /** 错误码（zod 的 issue code，例如 `invalid_type`、`unrecognized_keys`）；两端按码判断，不按文字。 */
  code: string
}

/** 一次严格校验的结果：要么给出定型后的值，要么给出问题列表。 */
export type ProviderSurfaceCheck<T> =
  | { ok: true, value: T }
  | { ok: false, issues: ProviderSurfaceIssue[] }

/** 一个可选的工作区：provider 侧让用户挑挂到哪个空间。 */
export interface ProviderSurfaceWorkspaceOption {
  /** 工作区身份，provider 侧原样回传。 */
  id: string
  /** 这个工作区属于哪个空间。 */
  space: ProviderSurfaceWorkspaceSpace
  /** 给人看的名字。 */
  label: string
  /** 给人看的补充说明，没有就是 null。 */
  description: Nullable<string>
}

/** 工作区目录：一次性把可选的工作区连同它的版本交给 provider。 */
export interface ProviderSurfaceWorkspaceCatalog {
  /** 这份目录的版本；内容变了版本就变。 */
  revision: string
  /** 可选的工作区，顺序即展示顺序。 */
  workspaces: ProviderSurfaceWorkspaceOption[]
}

/** 工具合同的绑定状态：provider 手里这份工具目录还算不算数。 */
export interface ProviderSurfaceToolContractBinding {
  /** 合同身份，调用时原样回传。 */
  id: string
  /** 合同对应的工具目录版本。 */
  catalogRevision: string
  /** 上次续期的时间戳（毫秒）。 */
  renewedAt: number
  /** provider 确认收到的时间戳（毫秒），没确认就是 null。 */
  acknowledgedAt: Nullable<number>
  /** 自上次刷新以来过了几个回合。 */
  turnsSinceRefresh: number
  /** 是不是该重新拿一份目录了。 */
  needsRefresh: boolean
}

/** provider 自持的绑定：一个 provider 会话挂在哪个空间、选了什么模型、工具合同是什么状态。 */
export interface ProviderSurfaceBinding {
  /** provider 身份（例如 `chatgpt`），不能为空。 */
  provider: string
  /** 代理面归谁：固定是 provider 自持。 */
  surfaceOwner: 'provider'
  /** 挂在哪个空间。 */
  workspaceSpace: ProviderSurfaceWorkspaceSpace
  /** provider 侧的会话身份，还没开就是 null。 */
  providerConversationId: Nullable<string>
  /** provider 侧的父消息身份，还没有就是 null。 */
  providerParentMessageId: Nullable<string>
  /** 用户选的模型身份，没选就是 null。 */
  selectedModelId: Nullable<string>
  /** 用户选的推理力度，没选就是 null。 */
  selectedReasoningEffort: Nullable<string>
  /** 各项能力开关的当下取值，值只能是布尔或字符串。 */
  capabilityValues: Record<string, boolean | string>
  /** provider 适配器的版本，未知就是 null。 */
  adapterRevision: Nullable<string>
  /** 工具合同的绑定状态，还没建立就是 null。 */
  toolContract: Nullable<ProviderSurfaceToolContractBinding>
  /** 建立时间戳（毫秒）。 */
  createdAt: number
  /** 最近一次更新的时间戳（毫秒）。 */
  updatedAt: number
}

/** 一个工具在目录里的样子。 */
export interface ProviderSurfaceToolDescriptor {
  /** 工具名，调用时原样回传。 */
  name: string
  /** 给模型看的说明。 */
  description: string
  /** 入参的 JSON Schema，原样透传给 provider。 */
  inputSchema: Record<string, unknown>
  /** 工具分类，没有就不带这个字段。 */
  category?: string
  /** 是不是只读工具，未标注就不带这个字段。 */
  readOnly?: boolean
}

/** 工具目录：载荷里叫 `revision`，调用回执里回显成 `catalogRevision`。 */
export interface ProviderSurfaceToolCatalog {
  /** 协议版本。 */
  protocolVersion: (typeof ProviderSurfaceProtocol)['version']
  /** 这份目录的版本。 */
  revision: string
  /** 目录里的工具。 */
  tools: ProviderSurfaceToolDescriptor[]
}

/** 一条入站的工具调用。 */
export interface ProviderSurfaceToolCall {
  /** 协议版本。 */
  protocolVersion: (typeof ProviderSurfaceProtocol)['version']
  /** 工具合同身份。 */
  contractId: string
  /** 调用基于哪一版工具目录；对不上就该先刷新目录。 */
  catalogRevision: string
  /** 这次调用的身份，回执原样回传。 */
  toolCallId: string
  /** 要调的工具名。 */
  toolName: string
  /** 工具入参，形状由工具自己的 schema 定。 */
  input: Record<string, unknown>
}

/** 回执携带的附件：目前只有图片一种。 */
export interface ProviderSurfaceArtifact {
  /** 附件种类，目前固定是图片。 */
  kind: 'image'
  /** 图片类型。 */
  mediaType: ProviderSurfaceArtifactMediaType
  /** 标准 base64 编码的图片内容，长度受上限约束。 */
  data: string
  /** 文件名，长度受上限约束。 */
  name: string
}

/** 一条工具调用的回执。 */
export interface ProviderSurfaceToolResult {
  /** 协议版本。 */
  protocolVersion: (typeof ProviderSurfaceProtocol)['version']
  /** 工具合同身份，与调用一致。 */
  contractId: string
  /** 工具目录版本，与调用一致。 */
  catalogRevision: string
  /** 对应哪一次调用。 */
  toolCallId: string
  /** 对应哪个工具。 */
  toolName: string
  /** 这次调用的结局。 */
  status: ProviderSurfaceToolResultStatus
  /** 工具的文本或结构化输出，没有就不带这个字段。 */
  output?: unknown
  /** 附件，没有就不带这个字段；条数与大小受上限约束。 */
  artifacts?: ProviderSurfaceArtifact[]
  /** 失败原因，成功时不带这个字段。 */
  error?: string
}
