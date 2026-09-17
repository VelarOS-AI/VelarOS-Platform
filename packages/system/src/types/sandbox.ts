/**
 * 演练沙箱：system:sandbox 的入参与结果，以及实现自己的工作类型（镜像清单与文件印记、落回时的冲突与失败回执）。只在包内用，不出包；对外的沙箱数据在 `system.ts`。
 */

import type { SandboxApplyResult, SandboxDiff, SandboxDiscardResult, SandboxIgnoredMode, SandboxRecord } from '@velaros-ai/rehearsal-sandbox/contracts'

/** 镜像里一个文件的印记：大小、修改时间、权限位；符号链接记它指向哪。 */
export interface SystemSandboxFileStamp {
  size: number
  mtimeMs: number
  mode: number
  link?: string
}

/** 遍历一棵树得到的印记表：相对 posix 路径 → 印记。 */
export type SystemSandboxStampTable = Record<string, SystemSandboxFileStamp>

/**
 * 镜像清单，落在沙箱目录旁的 manifest.json，内核重启后仍能用。
 * files 是创建时源目录里每个文件的印记（落回前核对源目录有没有变过），mirror 是刚复制完镜像里每个条目的印记（算镜像相对创建时的变化）；两边修改时间不同，所以分两张表。
 */
export interface SystemSandboxManifest {
  version: 1
  record: SandboxRecord
  files: SystemSandboxStampTable
  mirror: SystemSandboxStampTable
}

/** 落回时的一处冲突：源目录里这个文件自镜像以来被改过、丢了、凭空出现了，或者它的上级路径是符号链接（落回会写到源目录外）。 */
export interface SystemSandboxConflict {
  path: string
  reason: 'changed' | 'missing' | 'appeared' | 'link'
  message: string
}

/** 落回失败回执的 details：什么都没写（executionOutcome 固定是 not-applied），conflicts 列出每处冲突。 */
export interface SystemSandboxApplyFailureDetails {
  executionOutcome: 'not-applied'
  conflicts: SystemSandboxConflict[]
}

// ── system:sandbox 的入参与结果 ─────────────────────────────────

/** system:sandbox 的入参：action 选动作；create 用 source、network、ignored，diff 用 maxFiles，apply 用 paths；除 create 外都要 sandboxId。 @modelVisible */
export type SystemSandboxInput = {
  action: 'create' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: SandboxIgnoredMode
  sandboxId?: string
  paths?: string[]
  maxFiles?: number
}

/** 建好沙箱的回执：沙箱记录加一句怎么用镜像的提醒。 @modelVisible */
export interface SystemSandboxCreated extends SandboxRecord {
  note: string
}

/** 落回的回执：真正落回的三列；什么都没落或只落了指定路径时 note 说明。 @modelVisible */
export interface SystemSandboxApplied extends SandboxApplyResult {
  note?: string
}

/** system:sandbox 的结果：create、diff、apply、discard 各自的回执。 @modelVisible */
export type SystemSandboxResult = SystemSandboxCreated | SandboxDiff | SystemSandboxApplied | SandboxDiscardResult
