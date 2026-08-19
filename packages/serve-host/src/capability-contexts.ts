import { isAbsolute, resolve } from 'node:path'

import {
  type ApprovalPort,
  defaultDenyApprovalPort,
} from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'
import type { ProjectToolContext } from '@velaros-ai/project/agent'
import { withProjectApproval } from '@velaros-ai/project/composition'
import { isPathInsideProjectRoot } from '@velaros-ai/project/files'
import type { ProjectKernel } from '@velaros-ai/project/runtime'
import type {
  SystemToolContext,
  SystemToolSystemApi,
} from '@velaros-ai/system'

import type { VelarHostConfigStore } from './config'

export function createVelarHostSystemToolContext(
  system: SystemToolSystemApi,
  signal: AbortSignal,
): SystemToolContext {
  return {
    abortSignal: signal,
    system,
    approval: defaultDenyApprovalPort,
  }
}

function createProjectApprovalPort(config: VelarHostConfigStore): ApprovalPort {
  const decide = (riskScope?: string) => {
    const capability = config.snapshot().value.capabilities.project
    return riskScope?.startsWith('project-command:')
      ? capability.execute
      : capability.write
  }
  return {
    async awaitConfirmation(_message, _signal, options) {
      if (!decide(options?.riskScope)) {
        throw new AppError('PERMISSION', 'Velar Host 未授权这项项目操作。')
      }
    },
    async awaitConfirmationDecision(_message, _signal, options) {
      const approved = decide(options?.riskScope)
      return {
        approved,
        message: approved ? null : 'Velar Host 未授权这项项目操作。',
        autoApproved: approved,
      }
    },
  }
}

export function createVelarHostProjectToolContext(input: {
  readonly projectRoot: string
  readonly kernel: ProjectKernel
  readonly system: SystemToolSystemApi
  readonly config: VelarHostConfigStore
  readonly signal: AbortSignal
}): ProjectToolContext {
  const projectRoot = resolve(input.projectRoot)
  let activeDirectory = projectRoot
  const approval = createProjectApprovalPort(input.config)

  const resolveInsideProject = (path: string): string => {
    const target = isAbsolute(path) ? resolve(path) : resolve(activeDirectory, path)
    if (!isPathInsideProjectRoot(projectRoot, target)) {
      throw new AppError('PERMISSION', `路径超出 Host 项目边界：${path}`)
    }
    return target
  }

  const project = {
    getRootPath: () => projectRoot,
    async runInDirectory<T>(path: string, action: () => Promise<T>): Promise<T> {
      const previous = activeDirectory
      activeDirectory = resolveInsideProject(path)
      try {
        return await action()
      } finally {
        activeDirectory = previous
      }
    },
    kernel: async () => input.kernel,
    runWithApproval: <T>(action: () => Promise<T>) => withProjectApproval(
      { approval, abortSignal: input.signal },
      action,
    ),
    async prepareMutation(request: { cwd?: string; operation: string }) {
      const rootPath = request.cwd ? resolveInsideProject(request.cwd) : projectRoot
      const approved = input.config.snapshot().value.capabilities.project.write
      return {
        approved,
        rootPath,
        switched: rootPath !== projectRoot,
        alreadyAuthorized: approved,
        rejectionMessage: approved ? null : 'Velar Host 未授权修改当前项目。',
        message: approved ? '当前项目已授权。' : '当前项目未授权写入。',
        authorizationScope: 'project' as const,
      }
    },
    runCommand: (command: string, options = {}, allowDangerous = false, signal?: AbortSignal) =>
      input.system.runCommand(
        command,
        { ...options, cwd: activeDirectory },
        allowDangerous,
        signal ?? input.signal,
      ),
  }

  return {
    abortSignal: input.signal,
    project,
    system: {
      canStartBackgroundCommands: () => input.system.canStartBackgroundCommands(),
    },
    approval,
  }
}
