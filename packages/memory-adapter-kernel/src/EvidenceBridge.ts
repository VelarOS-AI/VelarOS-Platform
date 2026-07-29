import { isArray, isBlank, isEmpty, isFiniteNumber,isNonBlankString, isPresent, isString, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { MemoryDomain, MemoryEvidenceInput } from '@velaros-ai/memory'

import type {
  MemoryHostScopeResolver,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessageEvent,
} from './HostContracts'

interface MemoryEvidenceBridgeOptions {
  isEnabled: () => boolean
  isGrowthEnabled?: () => boolean
  isChatCaptureEnabled?: () => boolean
  isWorkspaceCaptureEnabled?: () => boolean
  isComputerUseCaptureEnabled?: () => boolean
  isExecutionCaptureEnabled?: () => boolean
  resolveScope: MemoryHostScopeResolver
  /** Host protocol marker excluded from user-stated Evidence. */
  environmentContextBlockOpenTag?: string
}

interface ComputerUseObservationInput {
  sessionId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  workspaceRoot?: LooseOptional<string>
  occurredAt?: number
  taskTitle?: LooseOptional<string>
  contextId?: LooseOptional<string>
}

interface WorkspaceToolObservationInput extends ComputerUseObservationInput {
  categoryId: 'workspace-inspect' | 'workspace-edit' | 'workspace-execute' | 'code-intelligence'
  taskTitle: string
}

interface ExecutionObservationInput {
  sessionId: string
  sourceEventId: string
  kind: string
  taskTitle: string
  workspaceRoot?: LooseOptional<string>
  executionId?: LooseOptional<string>
  occurredAt?: number
  contextId?: LooseOptional<string>
}

/**
 * Chat/Workspace 等宿主事件进入长期记忆的唯一主进程桥。
 *
 * Renderer 不再判断“什么值得记”，这里只把获授权的原始事件规范化为 Evidence；
 * 去重由 `(source_type, source_id)` 保证，意义提炼由 MemoryDream 负责。
 */
export class MemoryEvidenceBridge {
  private readonly log = Log.tag('MemoryEvidenceBridge')
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly domain: MemoryDomain,
    private readonly options: MemoryEvidenceBridgeOptions
  ) {}

  public captureUserMessage(payload: MemoryHostUserMessageEvent): void {
    if (!this.canCapture(this.options.isChatCaptureEnabled) || !isArray(payload.messages)) return
    const message = [...payload.messages].reverse().find((candidate) => candidate?.role === 'user')
    if (!message) return
    // 冻结的环境回合上下文块（<environment-context>…）被 renderer 追加进 user 消息 textBlocks，
    // 内含浏览器页面标题/URL 等第三方可控文本。它不是用户陈述，绝不能以 user_stated 采集，
    // 否则外部网页标题会以「用户已确认事实」身份污染画像（R-041 注入防御在采集层被击穿）。
    const content = message.textBlocks
      .filter(isNonBlankString)
      .filter((block) => {
        const marker = this.options.environmentContextBlockOpenTag?.trim()
        return !marker || !block.trimStart().startsWith(marker)
      })
      .join('\n')
      .trim()
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
        title: this.titleFromContent(content),
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
    if (!this.canCapture(this.options.isChatCaptureEnabled)) return
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
  public captureComputerUseObservation(input: ComputerUseObservationInput): void {
    if (!this.canCapture(this.options.isComputerUseCaptureEnabled)) return
    const description = this.describeComputerUseObservation(input.toolName, input.args)
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
  public captureWorkspaceToolObservation(input: WorkspaceToolObservationInput): void {
    if (!this.canCapture(this.options.isWorkspaceCaptureEnabled)) return
    const description = this.describeWorkspaceObservation(input)
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
  public captureExecutionObservation(input: ExecutionObservationInput): void {
    if (!this.canCapture(this.options.isExecutionCaptureEnabled)) return
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
        content: `任务执行状态进入「${kind.slice(0, 80)}」。`,
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
    this.enqueueAction(() => {
      this.domain.setSessionEvidenceEligibility(normalized, 'source_deleted')
    })
  }

  public async flush(): Promise<void> {
    await this.pending
  }

  private toEvidence(
    sessionId: string,
    sessionTitle: string,
    workspaceRoot: string,
    message: MemoryHostTranscriptMessage,
    contextId?: LooseOptional<string>
  ): Nullable<MemoryEvidenceInput> {
    const content = message.textBlocks
      .filter(isNonBlankString)
      .join('\n')
      .trim()
    if (isBlank(content)) return null

    return {
      sourceType: 'chat_message',
      trustLevel: message.role === 'user' ? 'user_stated' : 'agent_derived',
      sourceId: message.id,
      sessionId,
      workspaceRoot,
      ...this.resolveScope(sessionId, workspaceRoot, contextId),
      occurredAt: message.timestamp,
      title: sessionTitle || this.titleFromContent(content),
      content,
      category: 'conversation',
      privacyClass: 'personal',
      metadata: { role: message.role, sessionTitle },
    }
  }

  private enqueue(inputs: MemoryEvidenceInput[]): void {
    this.enqueueAction(() => {
      const captured = this.domain.captureEvidenceBatch(inputs, false)
      if (captured.insertedCount > 0 && (this.options.isGrowthEnabled?.() ?? true)) {
        this.domain.runDream({ trigger: 'immediate', maxEvidence: 25 })
      }
    })
  }

  private enqueueAction(action: () => void): void {
    this.pending = this.pending
      .then(() => {
        action()
      })
      .catch((error) => {
        this.log.warn('memory evidence capture failed', AppError.from(error))
      })
  }

  private canCapture(sourceEnabled?: () => boolean): boolean {
    return this.options.isEnabled() && (sourceEnabled?.() ?? true)
  }

  private titleFromContent(content: string): string {
    const line = content.split('\n').find((item) => !isBlank(item.trim())) ?? content
    const normalized = line.replace(/\s+/g, ' ').trim()
    return normalized.length <= 72 ? normalized : `${normalized.slice(0, 71).trimEnd()}…`
  }

  private describeComputerUseObservation(
    toolName: string,
    args: Record<string, unknown>
  ): Nullable<string> {
    switch (toolName) {
      case 'computer_screenshot':
        return '为当前任务观察了主屏幕；原始截图未进入长期记忆。'
      case 'computer_screen_size':
        return '为当前任务读取了主屏幕几何信息。'
      case 'computer_move':
        return `为当前任务移动了鼠标到 (${this.numberOrUnknown(args.x)}, ${this.numberOrUnknown(args.y)})。`
      case 'computer_click':
        return `为当前任务在 (${this.numberOrUnknown(args.x)}, ${this.numberOrUnknown(args.y)}) 执行了 ${isString(args.button) ? args.button : 'left'} 点击。`
      case 'computer_type':
        return `为当前任务向桌面焦点输入了文本；仅保留长度 ${isString(args.text) ? args.text.length : 0}，原文未进入长期记忆。`
      case 'computer_key':
        return `为当前任务发送了按键 ${isString(args.keys) ? args.keys.slice(0, 100) : 'unknown'}。`
      default:
        return null
    }
  }

  private describeWorkspaceObservation(input: WorkspaceToolObservationInput): string {
    const target = this.readWorkspaceTarget(input.args)
    const targetText = target ? `，目标 ${target}` : ''
    switch (input.categoryId) {
      case 'workspace-edit':
        return `通过 ${input.toolName} 完成了一次工作区修改${targetText}；文件正文未复制进长期记忆。`
      case 'workspace-execute':
        return `通过 ${input.toolName} 完成了一次工作区执行${targetText}；命令和输出原文未复制进长期记忆。`
      case 'code-intelligence':
        return `通过 ${input.toolName} 检查了代码结构${targetText}；查询结果原文未复制进长期记忆。`
      case 'workspace-inspect':
        return `通过 ${input.toolName} 检查了工作区${targetText}；读取内容未复制进长期记忆。`
    }
  }

  private readWorkspaceTarget(args: Record<string, unknown>): string {
    for (const key of ['path', 'filePath', 'rootPath', 'cwd']) {
      const value = args[key]
      if (isString(value) && !isBlank(value.trim())) return value.trim().slice(0, 240)
    }
    return ''
  }

  private numberOrUnknown(value: unknown): string {
    return isFiniteNumber(value) ? String(value) : 'unknown'
  }

  private resolveScope(
    sessionId: string,
    workspaceRoot?: LooseOptional<string>,
    contextId?: LooseOptional<string>
  ): Pick<MemoryEvidenceInput, 'scopeType' | 'scopeId'> {
    return this.options.resolveScope({ sessionId, workspaceRoot, contextId })
  }
}

export type {
  ComputerUseObservationInput,
  ExecutionObservationInput,
  MemoryEvidenceBridgeOptions,
  WorkspaceToolObservationInput,
}
