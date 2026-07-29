import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isArray, isPlainObject,isString, stringifyPretty } from '@velaros-ai/core'

import type { Workspace } from '../core/workspace.js'
import { createRecommendedWorkspace } from '../presets/index.js'
import {
  createFileFilterProvider,
  createNodeCommandProvider,
  createSecretRedactionProvider,
} from '../providers/index.js'

export interface CreateWorkspaceCliWorkspaceOptions {
  cwd: string
}

const WorkspaceCliStateSchemaVersion = 1
const WorkspaceCliStateDir = '.velaros-workspace'
const WorkspaceCliStateFile = 'state.json'
const WorkspaceCliStateGlob = `${WorkspaceCliStateDir}/**`

interface WorkspaceCliState {
  schemaVersion: typeof WorkspaceCliStateSchemaVersion
  targets?: unknown
  evidence?: unknown
  transactions?: unknown
}

export async function createWorkspaceCliWorkspace(
  options: CreateWorkspaceCliWorkspaceOptions
): Promise<Workspace> {
  const workspace = await createRecommendedWorkspace({
    root: options.cwd,
    corePolicy: {
      readDeny: [WorkspaceCliStateGlob],
      writeDeny: [WorkspaceCliStateGlob],
      protectedFiles: [WorkspaceCliStateGlob],
    },
    providers: {
      command: createNodeCommandProvider(),
      fileFilter: createFileFilterProvider({
        exclude: ['node_modules/**', '.git/**', 'dist/**', 'coverage/**', WorkspaceCliStateGlob],
      }),
      secretRedaction: createSecretRedactionProvider(),
    },
  })
  await restoreWorkspaceCliState(workspace)
  return workspace
}

export async function persistWorkspaceCliState(workspace: Workspace): Promise<void> {
  const state = exportWorkspaceCliState(workspace)
  const filePath = workspaceCliStatePath(workspace.root)
  await mkdir(join(workspace.root, WorkspaceCliStateDir), { recursive: true })
  await writeFile(filePath, `${stringifyPretty(state)}\n`, 'utf8')
}

async function restoreWorkspaceCliState(workspace: Workspace): Promise<void> {
  let parsed: WorkspaceCliState
  try {
    parsed = JSON.parse(await readFile(workspaceCliStatePath(workspace.root), 'utf8')) as WorkspaceCliState
  } catch {
    // arch-guard:silent-catch-ok 状态文件不存在或损坏时按全新 CLI 会话恢复。
    return
  }
  if (parsed.schemaVersion !== WorkspaceCliStateSchemaVersion) return

  const statefulWorkspace = workspaceStateMaps(workspace)
  statefulWorkspace.targets = new Map(stateEntriesById(parsed.targets, 'targetId'))
  statefulWorkspace.evidence = new Map(stateEntriesById(parsed.evidence, 'evidenceId'))
  statefulWorkspace.transactions = new Map(stateEntriesById(parsed.transactions, 'transactionId'))
}

function exportWorkspaceCliState(workspace: Workspace): WorkspaceCliState {
  const statefulWorkspace = workspaceStateMaps(workspace)
  return {
    schemaVersion: WorkspaceCliStateSchemaVersion,
    targets: [...statefulWorkspace.targets.values()],
    evidence: [...statefulWorkspace.evidence.values()],
    transactions: [...statefulWorkspace.transactions.values()],
  }
}

function workspaceCliStatePath(root: string): string {
  return join(root, WorkspaceCliStateDir, WorkspaceCliStateFile)
}

function stateEntriesById(values: unknown, idKey: string): Array<[string, any]> {
  if (!isArray(values)) return []
  const entries: Array<[string, any]> = []
  for (const value of values) {
    if (!isStateRecord(value)) continue
    const idValue = value[idKey]
    if (isString(idValue) && idValue) {
      entries.push([idValue, value])
    }
  }
  return entries
}

function isStateRecord(value: unknown): value is Record<string, any> {
  return isPlainObject(value)
}

function workspaceStateMaps(workspace: Workspace): {
  targets: Map<string, any>
  evidence: Map<string, any>
  transactions: Map<string, any>
} {
  return workspace as unknown as {
    targets: Map<string, any>
    evidence: Map<string, any>
    transactions: Map<string, any>
  }
}
