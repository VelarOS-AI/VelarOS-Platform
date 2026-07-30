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

  workspace.restoreSessionState({
    targets: stateRecordsWithId(parsed.targets, 'targetId'),
    evidence: stateRecordsWithId(parsed.evidence, 'evidenceId'),
    transactions: stateRecordsWithId(parsed.transactions, 'transactionId'),
  })
}

function exportWorkspaceCliState(workspace: Workspace): WorkspaceCliState {
  return { schemaVersion: WorkspaceCliStateSchemaVersion, ...workspace.exportSessionState() }
}

function workspaceCliStatePath(root: string): string {
  return join(root, WorkspaceCliStateDir, WorkspaceCliStateFile)
}

/**
 * 从磁盘状态文件里挑出「是对象且带非空 id」的条目。
 *
 * 这是磁盘 → 内核的反序列化边界：损坏或半写的条目**逐条跳过**而不是整体拒绝——一条坏事务
 * 不该让整个 CLI 会话失忆。返回值的元素类型由调用点声明，本函数只保证 id 存在（§1.4 白名单①）。
 */
function stateRecordsWithId<T>(values: unknown, idKey: string): T[] {
  if (!isArray(values)) return []
  const records: T[] = []
  for (const value of values) {
    if (!isPlainObject(value)) continue
    const idValue = value[idKey]
    if (isString(idValue) && idValue) records.push(value as T)
  }
  return records
}
