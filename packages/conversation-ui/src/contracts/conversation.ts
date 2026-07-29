/**
 * Pure presentation contracts owned by Conversation UI.
 *
 * Product/runtime packages adapt their richer domain objects to these structural DTOs at the
 * composition boundary. Keep this module data-only: no Kernel, Agent, Workspace, IPC or store
 * imports are allowed here.
 */

export type AppLocale = 'zh-CN' | 'en-US'

export type ChatProviderId =
  | 'velar'
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'xai'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'mistral'
  | 'minimax'
  | 'groq'
  | 'volcengine'
  | 'ollama'
  | 'lmstudio'
  | 'freellmapi'
  | 'custom'
  | (string & {})

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra'
export type RunProfileSelectionId = 'auto' | 'compact' | 'balanced' | 'expanded'
export type WorkspaceSpaceKind = 'project' | 'browser' | 'system'
export type AgentRoleId = 'chat' | 'operator' | 'architect' | 'coder' | 'browser' | 'primary-agent'
export type ExecutionTaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_confirmation'
  | 'awaiting_input'
  | 'aborted'
  | 'completed'
  | 'failed'
export type MicrophonePermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'unknown'

export type ChatPromptFeatureId =
  | 'plan'
  | 'proposal'
  | 'office'
  | 'office-document'
  | 'office-spreadsheet'
  | 'office-presentation'
  | 'office-pdf-convert'
  | 'office-pdf-edit'
  | 'office-latex-pdf'
  | 'computer-use'
  | 'html-artifact'
  | 'workbench-editor'
  | 'widget'

export type ToolCategoryId =
  | 'general'
  | 'web'
  | 'browser'
  | 'memory'
  | 'knowledge'
  | 'office'
  | 'system-control'
  | 'computer-control'
  | 'scheduling'
  | 'workspace'
  | 'workspace-inspect'
  | 'workspace-edit'
  | 'workspace-execute'
  | 'code-intelligence'

export type ToolPermission =
  | 'fs:read'
  | 'fs:write'
  | 'process:exec'
  | 'process:exec:unsafe'
  | 'system:open'
  | 'system:app'
  | 'workspace:root'
  | 'screen:capture'
  | 'window:track'
  | 'input:control'
  | 'network'
  | 'memory:read'
  | 'memory:write'

export type ToolRenderKind =
  | 'command'
  | 'file-change'
  | 'edit-diff'
  | 'edit-rollback'
  | 'file-move'
  | 'refactor'
  | 'plan'
  | 'search'
  | 'list-files'
  | 'browse-remote'
  | 'browser'
  | 'memory'
  | 'knowledge'
  | 'git'
  | 'office-doc'
  | 'artifact'
  | 'widget'
  | 'read-local'
  | 'install'
  | 'system-tools'
  | 'tool-catalog'
  | 'tool-map'
  | 'tool-read'
  | 'tool-replace'
  | 'tool-reflect'
  | 'goal'
  | 'active-directive'
  | 'archive'
  | 'user-confirmation'
  | 'user-action'
  | 'agent-dispatch'
  | 'active-project-infer'
  | 'dev-environment-summary'
  | 'project-discovery-rescan'
  | 'workspace-roots'
  | 'project-catalog'
  | 'project-metadata'
  | 'generic'

export type ToolActivityKind =
  | 'file-change'
  | 'command'
  | 'direct-file-read'
  | 'multi-file-read'
  | 'search'
  | 'file-move'
  | 'user-input'
  | 'user-confirmation'
  | 'verification-command'

export interface TextBlock {
  type: 'text'
  text: string
  tone?: 'default' | 'error'
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  streamId?: string
  translatedText?: string
  translatedLocale?: AppLocale
  translationVisible?: boolean
}

export interface ToolCallBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  categoryId?: ToolCategoryId
  result?: unknown
  serializedResult?: string
  resultStoredInWorkspace?: boolean
  error?: string
  isRunning?: boolean
  startedAt?: number
  finishedAt?: number
  progress?: string
  title?: string
  metadata?: Record<string, unknown>
  effects?: StreamToolResultEffects
  widgetArtifact?: {
    artifactId: string
    versionId: string
  }
  widgetArtifactSnapshot?: {
    artifactId: string
    versionId: string
    title: string
    htmlSource: string
    compiledHtml: string
    sessionId: string
    createdFromMessageId: string
    createdFromToolCallId: string
    createdAt: number
  }
  modelImage?: {
    mediaType: 'image/jpeg' | 'image/png'
    data: string
    size?: number
  }
}

export interface StreamToolResultEffects {
  workspaceRefresh?: boolean
  fileChanged?: boolean
  browserContextChanged?: boolean
  workspaceMutated?: boolean
  changedRoot?: string
}

export interface HtmlArtifactBlock {
  type: 'html-artifact'
  artifactId: string
  protocolVersion?: string
  title: string
  html: string
  protocolText?: string
  protocolDiagnostics?: Array<{
    code: string
    message: string
    phase: 'protocol'
    patchType?: 'replace' | 'append' | 'style' | 'script'
    patchId?: string
    createdAt?: number
  }>
  patches?: Array<
    | { type: 'replace'; target?: string; html: string }
    | { type: 'append'; target?: string; html: string }
    | { type: 'style'; styleId: string; css: string }
    | { type: 'script'; scriptId: string; code: string }
  >
  patchRevision?: number
  isStreaming?: boolean
  initialHeight?: number
  updateCount?: number
  createdAt?: number
  updatedAt?: number
}

export interface AssistantGeneratedFileBlock {
  type: 'assistant-generated-file'
  id: string
  mediaType: string
  data?: string
  size: number
  filename?: string
  storedInWorkspace?: boolean
}

export interface AssistantSourceBlock {
  type: 'assistant-source'
  id: string
  sourceType: 'url'
  url: string
  title?: string
}

export interface CapabilityAutoApprovalNoticeBlock {
  type: 'capability-auto-approval'
  notice: {
    id: string
    categories: ToolCategoryId[]
    promptFeatures: string[]
    reason: string
    message: string
    approvedAt: number
  }
}

export interface WorkspaceAutoApprovalNotice {
  id: string
  path: string
  reason: string
  action: 'add' | 'mutation'
  message: string
  approvedAt: number
}

export interface WorkspaceAutoApprovalNoticeBlock {
  type: 'workspace-auto-approval'
  notice: WorkspaceAutoApprovalNotice
}

export type UserActionCardTone = 'info' | 'warning' | 'success' | 'danger'
export type UserActionCardIcon =
  | 'info'
  | 'warning'
  | 'success'
  | 'danger'
  | 'plugin'
  | 'plan'
  | 'target'
  | 'tool'
  | 'workspace'
  | 'memory'
export type UserActionCardActionIcon =
  | 'confirm'
  | 'plugin'
  | 'plan'
  | 'target'
  | 'open'
  | 'send'
  | 'reject'
  | 'input'
  | 'tool'
  | 'workspace'
  | 'memory'

export type UserActionFormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkboxes'
export type UserActionFormValue = string | number | boolean | string[]

export interface UserActionFormOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
}

export interface UserActionFormField {
  id: string
  type: UserActionFormFieldType
  label: string
  required?: boolean
  placeholder?: string
  help?: string
  options?: UserActionFormOption[]
  min?: number
  max?: number
  step?: number
  maxLength?: number
  defaultValue?: UserActionFormValue
}

export interface UserActionCardTextInput {
  placeholder?: string
  required?: boolean
  maxLength?: number
}

interface UserActionCardActionBase {
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  completedDescription?: string
  disableAfterClick?: boolean
}

export type UserActionCardAction =
  | (UserActionCardActionBase & { kind: 'enable_prompt_features'; promptFeatures: string[] })
  | (UserActionCardActionBase & { kind: 'acknowledge' })
  | (UserActionCardActionBase & { kind: 'reject'; input?: UserActionCardTextInput })
  | (UserActionCardActionBase & { kind: 'submit_input'; input: UserActionCardTextInput })
  | (UserActionCardActionBase & { kind: 'submit_form' })

export interface UserActionCardResult {
  cardId: string
  actionKind: UserActionCardAction['kind'] | 'timeout' | 'skip'
  approved: boolean
  message?: string
  values?: Record<string, UserActionFormValue>
  timedOut?: boolean
}

export interface UserActionCard {
  id: string
  title: string
  description: string
  tone: UserActionCardTone
  icon: UserActionCardIcon
  blocking: boolean
  actions: UserActionCardAction[]
  artifact?: { path: string; label?: string }
  form?: {
    layout?: 'stack' | 'grid'
    submitLabel?: string
    cancelLabel?: string
    fields: UserActionFormField[]
    presentation?: 'wizard'
  }
  timeoutMs?: number
  createdAt: number
}

export interface UserActionCardBlock {
  type: 'user-action-card'
  card: UserActionCard
}

export interface SystemToolInstallSuggestionBlock {
  type: 'system-tool-install-suggestion'
  suggestion: {
    id: string
    toolId: string
    label: string
    command: string
    packageName: string
    reason: string
    installCommand: Nullable<string>
    installAvailable: boolean
    detectedAt: number
    triggeredBy: {
      scope: 'workspace' | 'system'
      command: string
    }
    alternatives?: Array<{
      id: string
      label: { 'zh-CN': string; 'en-US': string }
      description: { 'zh-CN': string; 'en-US': string }
      draft: { 'zh-CN': string; 'en-US': string }
    }>
  }
}

export interface ScheduledTaskProposalBlock {
  type: 'scheduled-task-proposal'
  proposal: {
    id: string
    name: string
    prompt: string
    createdAt: number
  }
}

export interface FlaggedTaskSuggestionBlock {
  type: 'flagged-task'
  suggestion: {
    id: string
    title: string
    tldr: string
    prompt: string
    files: string[]
    workspaceRoot: Nullable<string>
    space: Nullable<WorkspaceSpaceKind>
    createdAt: number
  }
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | HtmlArtifactBlock
  | AssistantGeneratedFileBlock
  | AssistantSourceBlock
  | CapabilityAutoApprovalNoticeBlock
  | WorkspaceAutoApprovalNoticeBlock
  | UserActionCardBlock
  | SystemToolInstallSuggestionBlock
  | ScheduledTaskProposalBlock
  | FlaggedTaskSuggestionBlock

export interface ChatAttachmentMeta {
  id: string
  kind: 'image' | 'file'
  name: string
  mediaType: string
  size: number
  path?: string
  lastModified?: number
}

export interface SerializedImageAttachment {
  id: string
  kind: 'image'
  filename: string
  mediaType: string
  data: string
  size: number
}

export interface BrowserElementSelectionRect {
  x: number
  y: number
  width: number
  height: number
  centerX: number
  centerY: number
}

export interface BrowserElementSelection {
  id: string
  url: string
  title: string
  label: string
  tagName: string
  role: Nullable<string>
  text: string
  selector: Nullable<string>
  attributes: Record<string, string>
  rect: BrowserElementSelectionRect
  viewportWidth: number
  viewportHeight: number
  target: Nullable<{
    ref?: LooseOptional<string>
    css: Nullable<string>
    role: Nullable<string>
    text: Nullable<string>
    name: Nullable<string>
    frame?: LooseOptional<{
      css: Nullable<string>
      name: Nullable<string>
      title: Nullable<string>
      url: Nullable<string>
    }>
    attributes: Record<string, string>
  }>
  capturedAt: number
  interactionSteps?: Array<
    BrowserElementSelection & {
      action: 'click' | 'select'
      sequence: number
      interactionSteps?: never
    }
  >
}

export type TurnContextSourceId =
  | 'workspace.editor-focus'
  | 'workspace.editor-selection'
  | 'workspace.filesystem-touches'
  | 'workspace.project-roots'
  | 'task.lifecycle'
  | 'browser.manual-activity'
  | 'browser.current-page'
  | 'memory.recall'

export interface TurnContextDelta {
  id: string
  sourceId: TurnContextSourceId
  seq: number
  occurredAt: number
  label: string
  summaryText: string
  inspect?: { tool: string; argsHint?: Record<string, unknown> }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  runId?: string
  turnId?: string
  blocks: ContentBlock[]
  attachments?: ChatAttachmentMeta[]
  browserElementSelections?: BrowserElementSelection[]
  turnContext?: {
    receipt: {
      observedThrough: Partial<
        Record<TurnContextSourceId, { generation: string; seq: number }>
      >
      includedDeltaIds: string[]
      dismissedDeltaIds: string[]
      anchorGeneration: string
      anchorCarrierMessageId: string
    }
    chips: Array<{
      sourceId: TurnContextSourceId
      label: string
    }>
    deltas?: TurnContextDelta[]
  }
  serialized?: {
    messageId?: string
    runId?: string
    turnId?: string
    timestamp?: number
    role: 'user' | 'assistant'
    textBlocks: string[]
    imageAttachments?: SerializedImageAttachment[]
    toolCalls: Array<{
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      serializedResult?: string
    }>
  }
  serializedStoredInWorkspace?: boolean
  guidanceStatus?: 'awaiting-decision' | 'pending' | 'sent'
  timestamp: number
}

export interface ChatSuggestionItem {
  id: string
  title: string
  prompt: string
  reason: string
  confidence: number
}

export interface ModelPricingEntry {
  provider: string
  model: string
  aliases: readonly string[]
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  source: string
}

export interface ModelPricingCatalog {
  currency: 'USD'
  version: string
  updatedAt: string
  expiresAt: string
  entries: readonly ModelPricingEntry[]
}

export type ChatContextUsageAccountingSource =
  | 'provider'
  | 'provider-count'
  | 'gateway-cost'
  | 'local-estimate'
export type ChatContextUsageAccountingConfidence = 'high' | 'medium' | 'low'

export interface StreamUsageTelemetryPayload {
  kind: 'usage-telemetry'
  turn: Nullable<number>
  provider?: LooseOptional<ChatProviderId>
  model: string
  inputTokens: Nullable<number>
  outputTokens: Nullable<number>
  visibleOutputTokens?: LooseOptional<number>
  totalTokens: Nullable<number>
  reasoningTokens: Nullable<number>
  cachedInputTokens?: LooseOptional<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  finishReasons?: LooseOptional<string[]>
  rawFinishReasons?: LooseOptional<string[]>
  source: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
  timestamp: number
}

export type TeamExecutionPhase =
  | 'creating-task'
  | 'collecting-context'
  | 'preparing-tools'
  | 'building-prompt'
  | 'requesting-model'
  | 'preparing'
  | 'understanding'
  | 'planning'
  | 'researching'
  | 'executing'
  | 'executing-tool'
  | 'waiting-user-browser'
  | 'capturing-browser-screenshot'
  | 'verifying'
  | 'synthesizing'
  | 'waiting-confirmation'
  | 'completed'

export interface StreamTurnContextPayload {
  kind: 'turn-context'
  turn: number
  roleRuntimeModel: LooseOptional<{
    provider: ChatProviderId
    model: string
    providerModel?: LooseOptional<string>
    contextWindow?: LooseOptional<number>
    resolutionSource: 'provider-pool' | 'chat-config'
    resolutionTrace: Array<{
      provider: ChatProviderId
      model: string
      providerModel?: LooseOptional<string>
      status: 'selected' | 'skipped'
      reason?: LooseOptional<string>
    }>
    fallbackReason?: LooseOptional<string>
  }>
}

export interface WorkspaceTaskTarget {
  kind: 'session' | 'project' | 'browser-site' | 'system'
  rootPath?: LooseOptional<string>
  browserUrl?: LooseOptional<string>
  browserSessionId?: LooseOptional<string>
}

export interface PlanTaskDagContract {
  inputs: string[]
  expectedOutputs: string[]
  dependencies: string[]
  artifactSchema: string
  summaryPrompt: string
  nodeId: string
  dependencySummaries: Array<{
    nodeId: string
    summary: string
  }>
  latestSummary?: LooseOptional<string>
}

export interface StreamWorkerThreadPayload {
  kind: 'worker-thread'
  event: 'started' | 'status' | 'delta' | 'chat-event' | 'output' | 'completed' | 'failed'
  threadId: string
  activationId?: LooseOptional<string>
  taskId?: LooseOptional<string>
  nodeId?: LooseOptional<string>
  title: string
  agentName?: LooseOptional<string>
  roleId?: LooseOptional<AgentRoleId>
  phase?: LooseOptional<TeamExecutionPhase>
  status?: LooseOptional<ExecutionTaskStatus>
  workspaceTarget?: LooseOptional<WorkspaceTaskTarget>
  dag?: LooseOptional<PlanTaskDagContract>
  timestamp: number
  input?: LooseOptional<string>
  text?: LooseOptional<string>
  summary?: LooseOptional<string>
  error?: LooseOptional<string>
  chatEvent?: LooseOptional<unknown>
  subagentType?: LooseOptional<string>
  customAgentName?: LooseOptional<string>
  mode?: LooseOptional<'sync' | 'async'>
  model?: LooseOptional<string>
  result?: LooseOptional<unknown>
}

export interface ChatContextEvidenceRecord {
  id: string
  toolCallId: string
  toolName: string
  kind: 'file-read' | 'file-change' | 'command-output' | 'verification' | 'artifact' | 'generic'
  importance: 'pinned' | 'high' | 'medium' | 'low'
  lifecycle: 'active' | 'pinned' | 'consumed' | 'verified' | 'demoted' | 'stale' | 'reread-required'
  createdAt: number
  summary: string
  path?: LooseOptional<string>
  revision?: LooseOptional<string>
  contentHash?: LooseOptional<string>
  excerpt?: LooseOptional<string>
  fullPayloadRef?: LooseOptional<string>
  freshness?: LooseOptional<'fresh' | 'stale' | 'unknown'>
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface ChatStreamReasoningEvent {
  type: 'reasoning'
  payload: { id: string; text: string }
}

export type ChatStreamEvent =
  | ChatStreamReasoningEvent
  | {
      type: 'tool-call'
      payload: {
        toolCallId: string
        toolName: string
        args: Record<string, unknown>
        categoryId?: ToolCategoryId
      }
    }
  | {
      type: 'tool-progress'
      payload: { toolCallId: string; chunk: string; timestamp?: number }
    }
  | {
      type: 'tool-metadata'
      payload: {
        toolCallId: string
        title?: string
        metadata?: Record<string, unknown>
        timestamp?: number
      }
    }
  | {
      type: 'tool-result'
      payload: {
        toolCallId: string
        result: unknown
        error?: string
        effects?: StreamToolResultEffects
        evidence?: ChatContextEvidenceRecord[]
        modelImage?: { data: string; mediaType: 'image/png' | 'image/jpeg' }
      }
    }
  | { type: 'worker-thread'; payload: StreamWorkerThreadPayload }
  | { type: 'state'; payload: { kind: string } }
  | { type: 'debug'; payload: { kind: string } }
  | { type: 'notice'; kind: string; payload: unknown }
  | { type: 'end' }
  | { type: 'error'; payload: { code?: string; message?: string } }

export interface WorkspaceRootEntry {
  path: string
  active: boolean
  exists: boolean
  removable: boolean
  source: 'project'
}

export interface WorkspaceBackgroundProcessInfo {
  taskId: Nullable<string>
  sessionId: Nullable<string>
  pid: Nullable<number>
  logPath: Nullable<string>
  ports: number[]
  reason: Nullable<string>
  terminateCommand: Nullable<string>
  forceTerminateCommand: Nullable<string>
  fallbackTerminateCommand: Nullable<string>
  requested: boolean
  autoStarted: boolean
}

export interface WorkspaceVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

export interface WorkspaceCommandResult {
  command: string
  cwd: string
  exitCode: Nullable<number>
  signal: Nullable<string>
  stdout: string
  stderr: string
  logPath?: LooseOptional<string>
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  success: boolean
  backgroundProcess?: LooseOptional<WorkspaceBackgroundProcessInfo>
  verification: WorkspaceVerificationSummary
  systemToolSuggestion?: LooseOptional<SystemToolInstallSuggestionBlock['suggestion']>
}

export interface SystemFileChangePreviewResult {
  changeId: string
  rootPath?: string
  path: string
  created: boolean
  deleted?: boolean
  rolledBack: boolean
  revertAvailable?: boolean
  beforeContent: string
  afterContent: string
}

export interface SystemBackgroundTaskTerminateResult {
  taskId: string
  sessionId: Nullable<string>
  pid: number
  signal: 'SIGTERM' | 'SIGKILL'
  statusBefore: string
  statusAfter: string
  terminated: boolean
  message: string
}

export interface WorkspaceCheckpointFileDiff {
  root: string
  path: string
  patch: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
  binary: boolean
}

export interface WorkspaceCheckpointDiffFailure {
  root: string
  fromCommitId: string
  toCommitId: string
  error: string
}

export type ChatGoalLifecycleAction =
  | 'resume'
  | 'pause'
  | 'block'
  | 'complete'
  | 'cancel'
  | 'remove'

export interface ActiveContextArtifact {
  id: string
  kind: 'plan' | 'decision' | 'requirement'
  scope: 'session' | 'workspace'
  status: 'active' | 'completed' | 'archived'
  sessionId: string
  workspaceRoot?: LooseOptional<string>
  title: string
  content: string
  sourceMessageId?: LooseOptional<string>
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}
