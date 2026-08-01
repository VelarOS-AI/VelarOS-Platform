import { isAbsolute, resolve } from 'node:path'

import { defaultDenyApprovalPort } from '@velaros-ai/core/tool-contract'
import type { OfficeToolContext } from '@velaros-ai/office-tools'
import type {
  SystemToolContext,
  SystemToolSystemApi,
} from '@velaros-ai/system-tools'
import { isPathInsideWorkspaceRoot } from '@velaros-ai/workspace'

import type { VelarHostConfigStore } from './config'

export function createVelarHostSystemToolContext(
  system: SystemToolSystemApi,
  signal: AbortSignal,
): SystemToolContext {
  return {
    abortSignal: signal,
    hasWorkspaceRoot: () => true,
    system,
    approval: defaultDenyApprovalPort,
    execution: null,
  }
}

export function createVelarHostOfficeToolContext(input: {
  readonly workspaceRoot: string
  readonly system: SystemToolSystemApi
  readonly config: VelarHostConfigStore
  readonly signal: AbortSignal
}): OfficeToolContext {
  const workspaceRoot = resolve(input.workspaceRoot)
  let activeRoot = workspaceRoot

  const resolveInsideWorkspace = (path: string): string => {
    const target = isAbsolute(path) ? resolve(path) : resolve(activeRoot, path)
    if (!isPathInsideWorkspaceRoot(workspaceRoot, target)) {
      throw new Error(`Office path is outside the Host workspace: ${path}`)
    }
    return target
  }

  return {
    abortSignal: input.signal,
    hasWorkspaceRoot: () => true,
    workspace: {
      getRootPath: () => activeRoot,
      async runInDirectory<T>(cwd: string, action: () => Promise<T>): Promise<T> {
        const previous = activeRoot
        activeRoot = resolveInsideWorkspace(cwd)
        try {
          return await action()
        } finally {
          activeRoot = previous
        }
      },
      async prepareMutationWorkspace(request) {
        const approved = input.config.snapshot().value.capabilities.workspace.write
        const requestedRoot = request.cwd ? resolveInsideWorkspace(request.cwd) : activeRoot
        return {
          approved,
          rootPath: requestedRoot,
          switched: requestedRoot !== workspaceRoot,
          alreadyAuthorized: approved,
          rejectionMessage: approved ? null : 'Velar Host 未授权修改当前工作区。',
          message: approved ? '当前工作区已授权。' : '当前工作区未授权写入。',
          authorizationScope: 'workspace',
        }
      },
    },
    system: {
      inspectEnvironment: (commands) => input.system.inspectEnvironment(commands),
      createSystemToolInstallSuggestion: (request) =>
        input.system.createSystemToolInstallSuggestion(request),
      runCommand: (command, options, allowDangerous) =>
        input.system.runCommand(command, options, allowDangerous, input.signal),
    },
  }
}
