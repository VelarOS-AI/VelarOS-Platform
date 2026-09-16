import { isArray, isBlank, isEmpty,isNonBlankString, isPresent, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

// 值导入必须指向具体模块：`from '..'` 在 dist 里会解析成目录 import
// （fix-esm-extensions 只改写带 `/` 的相对说明符），Node ESM 直接报 ERR_UNSUPPORTED_DIR_IMPORT。
import type { MemoryStoreBackend } from '../../contract/requires'
import type { MemoryHostScopeResolver } from '../../contract/requires'
import type {
  MemoryComputerUseObservationInput,
  MemoryExecutionObservationInput,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessageEvent,
  MemoryWorkspaceToolObservationInput,
} from '../../types/host'
import type { MemoryEvidenceInput } from '../../types/memory'
import { supportsMemoryBackendVerb } from '../../utils/backends'
import {
  describeComputerUseObservation,
  describeWorkspaceObservation,
  titleFromContent,
} from '../../utils/capture'
import { MemoryTuning } from '../../utils/tuning'

/** 一个证据采集桥要什么。 */
export interface MemoryEvidenceBridgeOptions {
  /** 自动记忆总开关。 */
  isEnabled: () => boolean
  /** 后台生长开关；关掉后照常采集，只是不触发即时整理。 */
  isGrowthEnabled?: () => boolean
  /** 聊天消息采集开关。 */
  isChatCaptureEnabled?: () => boolean
  /** 工作区工具观察采集开关。 */
  isWorkspaceCaptureEnabled?: () => boolean
  /** 桌面操作观察采集开关。 */
  isComputerUseCaptureEnabled?: () => boolean
  /** 执行生命周期采集开关。 */
  isExecutionCaptureEnabled?: () => boolean
  /**
   * 单条会话的采集豁免（宿主态，逐会话覆盖全局采集开关）。
   *
   * 与四个 `is*CaptureEnabled` 是**并列的门，不是替代**：那四个答「这一类事件要不要记」，
   * 本门答「这一条会话要不要记」。缺席 = 不豁免（宿主没有会话级策略时行为与从前一致）。
   */
  isSessionCaptureAllowed?: (sessionId: string) => boolean
  /** 上下文 → 作用域的解析器。 */
  resolveScope: MemoryHostScopeResolver
  /** 环境上下文块的起始标签；带这个前缀的正文块不按用户陈述采集。 */
  environmentContextBlockOpenTag?: string
}

/**
 * Chat/Workspace 等宿主事件进入长期记忆的唯一主进程桥。
 *
 * Renderer 不再判断“什么值得记”，这里只把获授权的原始事件规范化为 Evidence；
 * 去重由 `(source_type, source_id)` 保证，意义提炼由 MemoryDream 负责。
 *
 * 写入落到哪个后端由 capability token 解析决定（`./MemoryStoreCapability`）。本桥只认窄端口
 * 的 capture / dream / govern 三个动词：后端没有整理管线（如 `memory-files`）时 dream 动词
 * 缺席，采集照常，不走「降级」分支。
 */
export interface MemoryEvidenceBridgeApi {
  /** 采集一批用户或助手消息。 */
  captureUserMessage(payload: MemoryHostUserMessageEvent): void
  /** 采集一次会话快照（整段对话）。 */
  captureSessionSnapshot(snapshot: MemoryHostSessionSnapshot): void
  /** 采集一次桌面操作观察。 */
  captureComputerUseObservation(input: MemoryComputerUseObservationInput): void
  /** 采集一次工作区工具观察。 */
  captureWorkspaceToolObservation(input: MemoryWorkspaceToolObservationInput): void
  /** 采集一次执行生命周期观察。 */
  captureExecutionObservation(input: MemoryExecutionObservationInput): void
  /** 会话被删除：把这个来源的证据整体标成不可用。 */
  markSessionSourceDeleted(sessionId: string): void
  /** 等排队中的采集全部落地（收尾与测试用）。 */
  flush(): Promise<void>
}

/** 证据采集桥实现。 */
export class MemoryEvidenceBridge implements MemoryEvidenceBridgeApi {
  private readonly log = Log.tag('MemoryEvidenceBridge')
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: MemoryStoreBackend,
    private readonly options: MemoryEvidenceBridgeOptions
  ) {}

  public captureUserMessage(payload: MemoryHostUserMessageEvent): void {
    if (!this.canCapture(this.options.isChatCaptureEnabled, payload.sessionId)) return
    if (!isArray(payload.messages)) return
    const message = [...payload.messages].reverse().find((candidate) => candidate?.role === 'user')
    if (!message) return
    const content = this.readCapturableText(message.textBlocks)
    if (isBlank(content)) return
    this.enqueue([
      {
        sourceType: 'chat_message',
        trustLevel: 'user_stated',
        sourceId: message.messageId?.trim() || `${payload.sessionId}:user:${message.timestamp ?? Date.now()}`,
        sessionId: payload.sessionId,
        workspaceRoot: payload.workspaceRoot?.trim(),
        ...this.resolveScope(payload.sessionId, payload.workspaceRoot, payload.contextId),
        occurredAt: message.timestamp,
        title: titleFromContent(content),
        content,
        category: 'conversation',
        privacyClass: 'personal',
        metadata: {
          role: 'user',
          contextId: payload.contextId,
          agentSurfaceId: toNullable(payload.agentSurfaceId),
        },
      },
    ])
  }

  public captureSessionSnapshot(snapshot: MemoryHostSessionSnapshot): void {
    if (!this.canCapture(this.options.isChatCaptureEnabled, snapshot.sessionId)) return
    const sessionTitle = snapshot.title?.trim() ?? ''
    const workspaceRoot = snapshot.workspaceRoot?.trim() ?? ''
    const evidence = snapshot.messages
      .map((message) =>
        this.toEvidence(
          snapshot.sessionId,
          sessionTitle,
          workspaceRoot,
          message,
          snapshot.contextId
        )
      )
      .filter(isPresent)
    if (!isEmpty(evidence)) this.enqueue(evidence)
  }

  /**
   * Computer Use 只落最小动作证据：不保存截图、模型图像、工具结果或输入文本原文。
   * 同一 toolCallId 重放时由来源唯一键幂等去重。
   */
  public captureComputerUseObservation(input: MemoryComputerUseObservationInput): void {
    if (!this.canCapture(this.options.isComputerUseCaptureEnabled, input.sessionId)) return
    const description = describeComputerUseObservation(input.toolName, input.args)
    if (!description) return

    this.enqueue([
      {
        sourceType: 'computer_use',
        trustLevel: 'system_observed',
        sourceId: `${input.sessionId}:${input.toolCallId}`,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot?.trim(),
        ...this.resolveScope(input.sessionId, input.workspaceRoot, input.contextId),
        occurredAt: input.occurredAt,
        title: input.taskTitle?.trim() || 'Computer Use 操作',
        content: description,
        category: 'task',
        privacyClass: 'personal',
        metadata: {
          toolName: input.toolName,
          taskKey: input.sessionId,
          phase: 'computer-use',
          rawScreenshotRetained: false,
          typedTextRetained: false,
        },
      },
    ])
  }

  /** 工作区工具只记录已完成动作及最小目标线索，不复制命令输出或文件正文。 */
  public captureWorkspaceToolObservation(input: MemoryWorkspaceToolObservationInput): void {
    if (!this.canCapture(this.options.isWorkspaceCaptureEnabled, input.sessionId)) return
    const description = describeWorkspaceObservation(input)
    this.enqueue([
      {
        sourceType: 'workspace_event',
        trustLevel: 'system_observed',
        sourceId: `${input.sessionId}:${input.toolCallId}`,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot?.trim(),
        ...this.resolveScope(input.sessionId, input.workspaceRoot, input.contextId),
        occurredAt: input.occurredAt,
        title: input.taskTitle || '工作区任务',
        content: description,
        category: 'task',
        privacyClass: 'personal',
        metadata: {
          toolName: input.toolName,
          categoryId: input.categoryId,
          taskKey: input.sessionId,
          phase: input.categoryId,
          rawResultRetained: false,
        },
      },
    ])
  }

  /** 执行生命周期只记录阶段/终态，不保存错误正文、模型输出或上下文载荷。 */
  public captureExecutionObservation(input: MemoryExecutionObservationInput): void {
    if (!this.canCapture(this.options.isExecutionCaptureEnabled, input.sessionId)) return
    const kind = input.kind.trim()
    if (isBlank(kind)) return
    this.enqueue([
      {
        sourceType: 'execution_event',
        trustLevel: 'system_observed',
        sourceId: `${input.sessionId}:${input.sourceEventId}:${kind}`,
        sessionId: input.sessionId,
        executionId: input.executionId?.trim(),
        workspaceRoot: input.workspaceRoot?.trim(),
        ...this.resolveScope(input.sessionId, input.workspaceRoot, input.contextId),
        occurredAt: input.occurredAt,
        title: input.taskTitle || '执行任务',
        content: `任务执行状态进入「${kind.slice(0, MemoryTuning.capture.phaseMaxChars)}」。`,
        category: 'task',
        privacyClass: 'personal',
        metadata: {
          taskKey: input.sessionId,
          phase: kind,
          rawPayloadRetained: false,
        },
      },
    ])
  }

  /** 会话源被删除时不物理抹除记忆，只让其 Evidence 退出有效支持集合。 */
  public markSessionSourceDeleted(sessionId: string): void {
    const normalized = sessionId.trim()
    if (isBlank(normalized)) return
    this.enqueueAction(async () => {
      await this.store.governSourceEligibility?.(normalized, 'source_deleted')
    })
  }

  public async flush(): Promise<void> {
    await this.pending
  }

  /**
   * 可采集的正文：剔掉冻结的环境回合上下文块（`<environment-context>…`）。
   *
   * 那些块由 renderer 追加进 user 消息的 textBlocks，内含浏览器页面标题 / URL 等第三方可控
   * 文本。它不是用户陈述，绝不能以 `user_stated` 采集，否则外部网页标题会以「用户已确认事实」
   * 身份污染画像（R-041 注入防御在采集层被击穿）。
   *
   * 消息与会话快照**两条路都走这里**：同一条消息（同一个 sourceId）后到的快照会覆盖先到的
   * 过滤版，只在其中一条上过滤等于没有过滤。
   */
  private readCapturableText(textBlocks: readonly string[]): string {
    const marker = this.options.environmentContextBlockOpenTag?.trim()
    return textBlocks
      .filter(isNonBlankString)
      .filter((block) => !marker || !block.trimStart().startsWith(marker))
      .join('\n')
      .trim()
  }

  private toEvidence(
    sessionId: string,
    sessionTitle: string,
    workspaceRoot: string,
    message: MemoryHostTranscriptMessage,
    contextId?: LooseOptional<string>
  ): Nullable<MemoryEvidenceInput> {
    const content = this.readCapturableText(message.textBlocks)
    if (isBlank(content)) return null

    return {
      sourceType: 'chat_message',
      trustLevel: message.role === 'user' ? 'user_stated' : 'agent_derived',
      sourceId: message.id,
      sessionId,
      workspaceRoot,
      ...this.resolveScope(sessionId, workspaceRoot, contextId),
      occurredAt: message.timestamp,
      title: sessionTitle || titleFromContent(content),
      content,
      category: 'conversation',
      privacyClass: 'personal',
      metadata: { role: message.role, sessionTitle },
    }
  }

  private enqueue(inputs: MemoryEvidenceInput[]): void {
    this.enqueueAction(async () => {
      // `consolidate: false` = 由本桥自己决定何时触发整理（与直连 domain 时逐字一致）。
      const captured = await this.store.captureBatch(inputs, { consolidate: false })
      if (
        captured.insertedCount > 0
        && (this.options.isGrowthEnabled?.() ?? true)
        && supportsMemoryBackendVerb(this.store, 'dream')
      ) {
        await this.store.dream?.({ trigger: 'immediate', maxEvidence: MemoryTuning.capture.immediateDreamBatch })
      }
    })
  }

  private enqueueAction(action: () => void | Promise<void>): void {
    this.pending = this.pending
      .then(async () => {
        await action()
      })
      .catch((error) => {
        this.log.warn('memory evidence capture failed', AppError.from(error))
      })
  }

  private canCapture(sourceEnabled: LooseOptional<() => boolean>, sessionId: string): boolean {
    if (!this.options.isEnabled()) return false
    if (!(sourceEnabled?.() ?? true)) return false

    return this.options.isSessionCaptureAllowed?.(sessionId) ?? true
  }






  private resolveScope(
    sessionId: string,
    workspaceRoot?: LooseOptional<string>,
    contextId?: LooseOptional<string>
  ): Pick<MemoryEvidenceInput, 'scopeType' | 'scopeId'> {
    return this.options.resolveScope({ sessionId, workspaceRoot, contextId })
  }
}

