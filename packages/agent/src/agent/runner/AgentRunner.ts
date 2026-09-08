import type { ModelMessage } from 'ai'

import type { ChatPromptFeatureId, ToolCategoryId } from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import { isEmpty, isTrue, Log, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  type AgentRuntimeCapabilityPorts,
  collectCapabilityContext,
  resolveCapabilityCategoryDefinitions,
  resolveCapabilityContextCollectors,
  resolveCapabilityValidationInterpreters,
} from '../../capabilities'
import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import { findCurrentGoalArtifact, toGoalSnapshot } from '../../tool-library/builtin/Goals'
import { CodingSessionTracker } from '../CodingSessionTracker'
import { resolveAgentContextPhase } from '../ContextPhase'
import {
  type AgentExecutionLimits,
  resolveAgentExecutionLimits,
} from '../ExecutionLimits'
import type { PrimaryAgentProfile } from '../PrimaryAgentProfile'
import type { QueryLoop } from '../QueryLoop'
import { buildRunVerificationSummary } from '../RunCompletion'
import type { AgentExecutionConfig } from '../RuntimeConfiguration'
import type { AgentRuntimeInputPort } from '../RuntimeInputPort'
import type { SoloAwaitPendingBackgroundJobs } from '../SoloBackgroundCompletionGate'
import type { SoloStreamLoop } from '../SoloLoop'
import { TaskApprovalState } from '../TaskApprovalState'

import type {
  AgentRunnerComponents,
  AgentRunnerDomainServices,
  AgentRunnerInfrastructure,
} from './AgentRunnerTypes'
import type { AgentSurfaceProfile, AgentSurfaceProfileProvider } from './AgentSurfaceProfile'
import { AgentWorkflowCoordinator } from './AgentWorkflowCoordinator'
import { buildApprovalRegistryKey, resolveSubAgentExecutionKey } from './codingTracking'
import { hasActiveExecutionGoal, resolveExecutionWallClockDeadlineMs } from './goalLifecycle'
import type {
  RunnerCancelBackgroundJob,
  RunnerCodingSessionPolicyBundle,
  RunnerConfigService,
  RunnerExecutionEnvironmentPort,
  RunnerExecutionScope,
  RunnerReadBackgroundJobOutput,
  RunnerSubAgentDispatcher,
  RunnerSubAgentOptions,
  RunnerToolContext,
  RunnerToolContextBuilder,
  RunnerToolRegistry,
  RunnerWaitBackgroundJobs,
} from './host-ports'

interface AgentRunnerConfig extends AgentExecutionConfig {
  surfaceProfile?: AgentSurfaceProfile
  consumeTurnContextNote?: () => Nullable<string>
  awaitPendingBackgroundJobs?: SoloAwaitPendingBackgroundJobs
  readBackgroundJobOutput?: RunnerReadBackgroundJobOutput
  waitBackgroundJobs?: RunnerWaitBackgroundJobs
  cancelBackgroundJob?: RunnerCancelBackgroundJob
}

interface StreamSoloWorkerOptions {
  consumeGuidance?: () => Nullable<ModelMessage>
  runtimeInput?: AgentRuntimeInputPort
}

const passthroughExecutionEnvironment: RunnerExecutionEnvironmentPort = {
  run: (_input, action) => action({}),
}

class AgentRunner<TToolContext extends RunnerToolContext = RunnerToolContext> {
  private readonly sessionApprovalRegistry = new Map<string, TaskApprovalState>()
  private readonly taskApprovalListeners = new Set<(sessionId: string) => void>()
  private readonly sessionPageInRegistry = new Map<
    string,
    { toolNames: Set<string>; categories: Set<ToolCategoryId> }
  >()
  private readonly log = Log.tag('AgentRunner')
  private readonly contextHelper: RunnerToolContextBuilder<TToolContext>
  private readonly primaryAgentStreamLoop: SoloStreamLoop<TToolContext, ExecutionEventBus>
  private readonly queryLoop: QueryLoop<TToolContext, ExecutionEventBus>
  private readonly primaryAgentProfile: PrimaryAgentProfile
  private readonly subAgentDispatcher: RunnerSubAgentDispatcher<TToolContext>
  private readonly workflowCoordinator: AgentWorkflowCoordinator<TToolContext>
  private readonly capabilityPorts?: AgentRuntimeCapabilityPorts
  private readonly executionEnvironment: RunnerExecutionEnvironmentPort
  private readonly configService: RunnerConfigService
  private readonly toolRegistry: RunnerToolRegistry
  private readonly codingSessionPolicy: RunnerCodingSessionPolicyBundle
  private readonly surfaceProfileProvider: AgentSurfaceProfileProvider
  private readonly executionLimits: AgentExecutionLimits

  constructor(
    components: AgentRunnerComponents<TToolContext>,
    domainServices: AgentRunnerDomainServices,
    infrastructure: AgentRunnerInfrastructure
  ) {
    this.contextHelper = components.contextHelper
    this.primaryAgentStreamLoop = components.primaryAgentStreamLoop
    this.queryLoop = components.queryLoop
    this.primaryAgentProfile = components.primaryAgentProfile
    this.subAgentDispatcher = components.subAgentDispatcher
    this.workflowCoordinator = new AgentWorkflowCoordinator(this.subAgentDispatcher)
    this.capabilityPorts = infrastructure.capabilityPorts
    this.executionEnvironment =
      domainServices.executionEnvironment ?? passthroughExecutionEnvironment
    this.configService = infrastructure.configService
    this.toolRegistry = infrastructure.toolRegistry
    this.codingSessionPolicy = infrastructure.codingSessionPolicy
    this.surfaceProfileProvider = infrastructure.surfaceProfileProvider
    this.executionLimits = resolveAgentExecutionLimits(infrastructure.executionLimitOverrides)
  }

  public async streamSoloWorker(
    messages: ModelMessage[],
    config: AgentRunnerConfig,
    events: ExecutionEventBus,
    options: StreamSoloWorkerOptions = {}
  ): Promise<void> {
    const systemConfig = this.configService.systemConfig
    const abortController = config.abortController ?? new AbortController()
    const sessionId = config.sessionId ?? `window:${config.windowId ?? 0}`
    return this.executionEnvironment.run({ sessionId, config }, (scope) =>
      this.streamPrimaryAgent(
        messages,
        config,
        systemConfig,
        abortController,
        sessionId,
        events,
        options,
        scope
      )
    )
  }

  private async streamPrimaryAgent(
    messages: ModelMessage[],
    config: AgentRunnerConfig,
    systemConfig: RunnerConfigService['systemConfig'],
    abortController: AbortController,
    sessionId: string,
    events: ExecutionEventBus,
    options: StreamSoloWorkerOptions,
    executionScope: RunnerExecutionScope
  ): Promise<void> {
    const { surfaceProfile: resolvedSurfaceProfile, ...runtimeConfig } = config
    const requestedPromptFeatures = this.resolveRuntimePromptFeatures(runtimeConfig.promptFeatures)
    const surfaceProfile =
      resolvedSurfaceProfile ?? this.resolveAgentSurfaceProfile(runtimeConfig)
    const loopConfig: AgentRunnerConfig = {
      ...runtimeConfig,
      sessionId,
      agentSurfaceId: surfaceProfile.id,
      abortController,
      promptFeatures: requestedPromptFeatures,
    }
    const thinkingDepth = loopConfig.thinkingDepth ?? systemConfig.thinkingDepth
    const approvalRegistryKey = buildApprovalRegistryKey(
      surfaceProfile.id,
      sessionId,
      runtimeConfig.sessionLineage
    )
    const previousApprovals = this.sessionApprovalRegistry.get(sessionId)
    const previousPageIn = this.sessionPageInRegistry.get(approvalRegistryKey)
    const surfaceRunPolicy = this.surfaceProfileProvider.deriveRunPolicy({
      profile: surfaceProfile,
      declaredScope: runtimeConfig.scope,
      promptFeatures: requestedPromptFeatures,
      previousApprovedCategories: previousApprovals
        ? previousApprovals.getApprovedToolCategories()
        : [],
    })
    const residentCategoryIds = Object.values(
      resolveCapabilityCategoryDefinitions(this.capabilityPorts)
    )
      .filter((category) => category.toolOs.defaultState === 'resident')
      .map((category) => category.id)
    const taskApprovals = previousApprovals ?? new TaskApprovalState()
    if (!previousApprovals) taskApprovals.subscribe(() => {
      this.taskApprovalListeners.forEach((listener) => listener(sessionId))
    })
    this.sessionApprovalRegistry.set(sessionId, taskApprovals)
    const codingSession = new CodingSessionTracker(
      surfaceRunPolicy.initialToolCategories,
      surfaceRunPolicy.initialPromptFeatures,
      surfaceRunPolicy.restoredApprovedCategories,
      undefined,
      {
        taskApprovals,
        allowedToolCategories: surfaceRunPolicy.allowedToolCategories,
        thinkingDepth,
        toolSurfaceProfile: loopConfig.toolSurfaceProfile,
        runProfile: loopConfig.runProfile,
        activeToolCategories: surfaceRunPolicy.initialActiveToolCategories,
        activeCapabilityScope: surfaceRunPolicy.activeSpace,
        promptFeaturePolicy: this.codingSessionPolicy.promptFeaturePolicy,
        toolCategoryToolNames: this.codingSessionPolicy.toolCategoryToolNames,
        externalTouchCooldownMs: this.codingSessionPolicy.externalTouchCooldownMs,
        normalizeResourceId: this.codingSessionPolicy.normalizeResourceId,
        residentToolCategories: residentCategoryIds,
        validationInterpreters: [
          ...(this.codingSessionPolicy.validationInterpreters ?? []),
          ...resolveCapabilityValidationInterpreters(this.capabilityPorts),
        ],
        activityCategories: this.codingSessionPolicy.activityCategories,
        reminderProducers: this.codingSessionPolicy.reminderProducers,
      }
    )
    if (previousPageIn) {
      codingSession.enableToolCategories([...previousPageIn.categories], 'restore-page-residency')
      codingSession.enableToolNames([...previousPageIn.toolNames], 'restore-page-residency')
    }
    const resolution = this.primaryAgentProfile.resolve({
      knownToolNames: this.toolRegistry.names,
      selectedSkillIds: loopConfig.selectedSkillIds,
      promptFeatures: requestedPromptFeatures,
      activeCapabilityScope: surfaceRunPolicy.activeSpace,
      hiddenToolNames: surfaceProfile.toolPolicy.hiddenToolNames,
      allowSubAgents: surfaceRunPolicy.allowSubAgents,
    })
    const dispatchConfig: AgentExecutionConfig = {
      ...loopConfig,
      sessionId,
      agentSurfaceId: surfaceProfile.id,
      abortController,
    }
    const executionTimers = new TimerScope({ name: `AgentRunner.execution.${sessionId}` })
    try {
      const toolContext = this.contextHelper.buildToolContext({
        abortController,
        config: loopConfig,
        codingSession,
        roleState: {
          getAllowedToolNames: () => resolution.allowedTools,
          getEnabledToolCategories: () => resolution.enabledToolCategories,
          getResolution: () => resolution,
        },
        disabledToolNames: systemConfig.disabledToolNames,
        capabilityPorts: this.capabilityPorts,
        resourceId: executionScope.resourceId,
        execution: loopConfig.execution,
        events,
        query: surfaceRunPolicy.allowSubAgents
          ? async (task, opts) => this.query(task, toolContext, opts)
          : async () => {
              throw new AppError(
                'PERMISSION',
                `Agent surface "${surfaceProfile.id}" does not allow sub-agent queries.`
              )
            },
        dispatchSubAgent: optionalWhen(surfaceRunPolicy.allowSubAgents, async (input) =>
          this.subAgentDispatcher.dispatch({
            input,
            parentCtx: toolContext,
            events,
            config: dispatchConfig,
          })
        ),
        runAgentWorkflow: optionalWhen(surfaceRunPolicy.allowSubAgents, async (input) =>
          this.workflowCoordinator.run({
            input,
            parentCtx: toolContext,
            events,
            config: dispatchConfig,
          })
        ),
        readBackgroundJobOutput: loopConfig.readBackgroundJobOutput,
        waitBackgroundJobs: loopConfig.waitBackgroundJobs,
        cancelBackgroundJob: loopConfig.cancelBackgroundJob,
      })
      codingSession.attachToolContext(toolContext)
      events.emitState(ChatRuntimeEvents.phase('collecting-context'))
      const initialContextPhase = resolveAgentContextPhase({
        turn: 1,
        history: messages,
        agentSurfaceId: surfaceProfile.id,
        unattended: loopConfig.unattended,
        goalMode: loopConfig.goalMode,
        selectedSkillIds: loopConfig.selectedSkillIds,
        promptFeatures: loopConfig.promptFeatures,
      })
      const shouldCollectCapabilityContext =
        initialContextPhase.phase === 'operational' &&
        resolveCapabilityContextCollectors(this.capabilityPorts).length > 0
      const capabilityContext = shouldCollectCapabilityContext
        ? await collectCapabilityContext(this.capabilityPorts, messages, {
            developerContext: loopConfig.developerContext,
            sessionLineage: loopConfig.sessionLineage,
            thinkingDepth,
            executionScope: executionScope.metadata,
          })
        : null
      const history: ModelMessage[] = [...messages]
      const executionStartedAt = Date.now()
      const executionWallClockDeadlineMs = resolveExecutionWallClockDeadlineMs(
        loopConfig.goalMode,
        this.executionLimits
      )
      executionTimers.after(
        executionWallClockDeadlineMs,
        () => {
          const abortForDeadline = (deadlineMs: number): void => {
            if (abortController.signal.aborted) return
            this.log.warn('execution wall clock deadline reached', { sessionId, deadlineMs })
            abortController.abort()
          }
          if (isTrue(loopConfig.goalMode)) {
            abortForDeadline(executionWallClockDeadlineMs)
            return
          }
          void hasActiveExecutionGoal(toolContext)
            .then((hasActiveGoal) => {
              if (!hasActiveGoal) return abortForDeadline(executionWallClockDeadlineMs)
              if (executionTimers.isDisposed || abortController.signal.aborted) return
              const remainingMs = Math.max(
                0,
                this.executionLimits.goalExecutionWallClockTimeoutMs -
                  (Date.now() - executionStartedAt)
              )
              executionTimers.after(
                remainingMs,
                () =>
                  abortForDeadline(this.executionLimits.goalExecutionWallClockTimeoutMs),
                { label: 'execution-goal-wall-clock-deadline' }
              )
            })
            .catch(() => abortForDeadline(executionWallClockDeadlineMs))
        },
        { label: 'execution-wall-clock-deadline' }
      )
      const loopResult = await this.primaryAgentStreamLoop.execute({
        history,
        config: loopConfig,
        chatConfig: this.configService.chatConfig,
        systemConfig,
        abortController,
        toolContext,
        resolution,
        capabilityContext,
        refreshCapabilityContext: optionalWhen(
          shouldCollectCapabilityContext,
          (nextHistory) =>
            collectCapabilityContext(this.capabilityPorts, nextHistory, {
              developerContext: loopConfig.developerContext,
              sessionLineage: loopConfig.sessionLineage,
              thinkingDepth,
              executionScope: executionScope.metadata,
            })
        ),
        events,
        runtimeInput: options.runtimeInput,
        consumeGuidance: options.consumeGuidance,
        consumeTurnContextNote: loopConfig.consumeTurnContextNote,
        awaitPendingBackgroundJobs: loopConfig.awaitPendingBackgroundJobs,
      })
      if (loopResult.status === 'completed') {
        const goal = findCurrentGoalArtifact(await toolContext.activeContext.listActiveContextArtifacts({
          status: 'all', kinds: ['requirement'],
        }))
        events.emitRuntime(ChatRuntimeEvents.done(undefined, {
          verification: buildRunVerificationSummary(codingSession.getSnapshot()),
          goalStatus: goal ? toGoalSnapshot(goal).status : undefined,
        }))
      } else if (loopResult.status === 'error') {
        throw new AppError('RUNTIME', 'Agent execution was blocked.')
      }
    } finally {
      this.persistSessionLeases(approvalRegistryKey, codingSession)
      executionTimers.dispose()
      this.primaryAgentStreamLoop.clearSession(sessionId)
      this.subAgentDispatcher.clearExecution(
        resolveSubAgentExecutionKey({
          executionId: loopConfig.execution?.executionId,
          sessionId,
        })
      )
    }
  }

  private persistSessionLeases(
    approvalRegistryKey: string,
    codingSession: CodingSessionTracker
  ): void {
    const toolNames = codingSession.getBudgetOverrideToolNames()
    const categories = codingSession.getBudgetOverrideToolCategories()
    if (!isEmpty(toolNames) || !isEmpty(categories)) {
      this.sessionPageInRegistry.set(approvalRegistryKey, {
        toolNames: new Set(toolNames),
        categories: new Set(categories),
      })
    } else {
      this.sessionPageInRegistry.delete(approvalRegistryKey)
    }
  }

  public getTaskApprovalRecords(sessionId: string) {
    return this.sessionApprovalRegistry.get(sessionId)?.list() ?? []
  }

  public revokeTaskApproval(sessionId: string, id: string): boolean {
    return !!this.sessionApprovalRegistry.get(sessionId)?.revoke(id)
  }

  public subscribeTaskApprovals(listener: (sessionId: string) => void): () => void {
    this.taskApprovalListeners.add(listener)
    return () => { this.taskApprovalListeners.delete(listener) }
  }

  public clearTaskApprovals(sessionId: string): void {
    const approvals = this.sessionApprovalRegistry.get(sessionId)
    this.sessionApprovalRegistry.delete(sessionId)
    approvals?.dispose()
  }

  private resolveAgentSurfaceProfile(config: AgentExecutionConfig): AgentSurfaceProfile {
    if (config.agentSurfaceId)
      return this.surfaceProfileProvider.resolve({ agentSurfaceId: config.agentSurfaceId })
    return this.surfaceProfileProvider.resolve({ developerContext: config.developerContext })
  }

  private resolveRuntimePromptFeatures(
    promptFeatures?: readonly ChatPromptFeatureId[]
  ): ChatPromptFeatureId[] {
    return [...new Set(promptFeatures ?? [])]
  }

  public async query(
    task: string,
    parentCtx: TToolContext,
    opts: RunnerSubAgentOptions = {}
  ): Promise<string> {
    const systemConfig = this.configService.systemConfig
    const subAgentParentCtx: TToolContext = {
      ...parentCtx,
      codingSession: parentCtx.codingSession.forkForSubAgent?.() ?? parentCtx.codingSession,
    }
    try {
      return await this.queryLoop.execute({
        task,
        opts: {
          ...opts,
          consumeRelayedGuidance: opts.consumeRelayedGuidance,
        },
        parentCtx: subAgentParentCtx,
        chatConfig: this.configService.chatConfig,
        systemConfig,
        collectCapabilityContext: (messages) =>
          collectCapabilityContext(this.capabilityPorts, messages, {
            developerContext: subAgentParentCtx.developerContext,
            sessionLineage: subAgentParentCtx.sessionLineage,
            thinkingDepth: opts.runtimeOverride?.thinkingDepth ?? systemConfig.thinkingDepth,
          }),
      })
    } finally {
      // A failed or cancelled worker can already have changed shared resources.
      if (subAgentParentCtx.codingSession !== parentCtx.codingSession) {
        parentCtx.codingSession.mergeSnapshot?.(subAgentParentCtx.codingSession.getSnapshot())
      }
    }
  }
}

export { AgentRunner }
export type { AgentRunnerConfig }
