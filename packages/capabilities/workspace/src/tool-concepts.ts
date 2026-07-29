import { createToolConceptLookup, defineToolConcepts } from '@velaros-ai/core/tool-contract'

export const WorkspaceConcepts = defineToolConcepts({
  preferTargetId: '优先使用已解析 targetId；无法提前解析目标时再退回 path 定位。',
  targetIdBindsRevision: 'targetId 绑定 revision，文件变更后需重新解析。',
  revisionGuard: '编辑前应取得最新 snapshot.revision 并作为 baseRevision 防护乐观锁。',
  boundedRead: '读取必须有界：range、maxBytes、maxChars 三选一，或显式传 allowUnbounded:true。',
  pathInOperation: '没有 targetId 时，path 必须写在 operation 内。',
  pathDiscovery: '按文件名、目录名或 glob 发现路径时使用路径发现工具，而不是正文搜索。',
  editLifecycle:
    '简单改动优先用 commit_edit（prepare+validate+apply 合一）；需人工审阅大 diff 时再拆成 prepare→apply。',
  postconditionDefault:
    '默认 core 只直接执行 must_contain、must_not_contain、changed_files_allowlist、max_changed_lines；其余类型需注册对应 validator 才生效。',
  validatorsFromStatus: '可用校验器 id 见 status().validators。',
} as const)

export const WorkspaceInspectEvidenceProtocol = [
  '路径发现或正文搜索 -> 轻量元数据或有界读取 -> 目标解析 -> evidence 构建。',
  '路径发现和正文搜索只负责定位候选；元数据检查只取轻量信息；读取必须按 range、maxBytes 或 maxChars 有界。',
  '目标解析产生带 revision 的 targetId；证据构建产生目标附近上下文、revision、citation 与 EvidencePack。',
  '证据不足、低置信或互相矛盾时，改写 query、收窄 filter 或读取相邻 bounded range 后再回答或编辑。',
] as const

export type WorkspaceConceptId = keyof typeof WorkspaceConcepts

export const concept = createToolConceptLookup(WorkspaceConcepts)
