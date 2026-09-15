import { isAbsolute, relative, resolve } from 'node:path'

import { z } from 'zod'

import { createApprovalOperationKey, createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectToolNames } from '../../contract/constants'
import type { ProjectSandboxPort, ProjectToolContext } from '../../contract/requires'
import type { ProjectSandboxDiff } from '../../types/project'
import { analyzeCommandExecution, buildBackgroundCommandConfirmationMessage } from '../../utils/command-policy'

import { ProjectExecutionCapability } from './capabilities'
import { defineProjectTool } from './shared'

interface ProjectSandboxInput {
  action: 'create' | 'run' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: 'link' | 'copy' | 'skip'
  sandboxId?: string
  command?: string
  timeoutMs?: number
  maxOutputChars?: number
  paths?: string[]
  maxFiles?: number
}

/** 宿主没接沙箱端口时这个工具不可用，也不出现在工具面上。 */
function requireSandboxPort(context: ProjectToolContext): ProjectSandboxPort {
  const port = context.project.sandbox
  if (!port) throw new AppError('UNAVAILABLE', '当前宿主没有接入演练沙箱。')
  return port
}

/** 把 source 解析成项目根之内的绝对路径；项目之外的目录拒绝，项目空间的沙箱只镜像项目。 */
function resolveSourceInsideProject(rootPath: string, source: LooseOptional<string>): string {
  const resolved = resolve(rootPath, source ?? '.')
  const inside = relative(rootPath, resolved)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new AppError('VALIDATION', `沙箱的源目录必须在当前项目之内：${source ?? '.'}`)
  return resolved
}

/** 按调用方给的相对路径筛选三列；不给就全部。给了但三列里都没有的路径列在 unknown 里。 */
function selectChanges(changes: ProjectSandboxDiff, paths: LooseOptional<readonly string[]>): { created: string[]; modified: string[]; deleted: string[]; unknown: string[] } {
  if (!paths || isEmpty(paths)) return { created: [...changes.created], modified: [...changes.modified], deleted: [...changes.deleted], unknown: [] }
  const wanted = new Set(paths.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')))
  const pick = (list: readonly string[]): string[] => list.filter((path) => wanted.has(path))
  const known = new Set([...changes.created, ...changes.modified, ...changes.deleted])
  return { created: pick(changes.created), modified: pick(changes.modified), deleted: pick(changes.deleted), unknown: [...wanted].filter((path) => !known.has(path)) }
}

/** 生成落回项目前给用户看的确认文案：三列的条数和前几条路径。 */
function applyConfirmationMessage(source: string, selection: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] }): string {
  const preview = (list: readonly string[]): string => list.slice(0, 20).join('、') + (list.length > 20 ? ` 等 ${list.length} 个` : '')
  const lines = [`即将把演练沙箱里的改动落回项目 ${source}：新增 ${selection.created.length} 个、覆盖 ${selection.modified.length} 个、删除 ${selection.deleted.length} 个文件。`]
  if (!isEmpty(selection.deleted)) lines.push(`删除：${preview(selection.deleted)}`)
  if (!isEmpty(selection.modified)) lines.push(`覆盖：${preview(selection.modified)}`)
  if (!isEmpty(selection.created)) lines.push(`新增：${preview(selection.created)}`)
  lines.push('删除和覆盖不经过 project:change 的撤销账本；落回前会核对这些文件自建沙箱以来没被别人改过，改过就整批不落。')
  return lines.join('\n')
}

async function runProjectSandbox(input: ProjectSandboxInput, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  const port = requireSandboxPort(context)
  const rootPath = context.project.getRootPath()
  const sandboxId = input.sandboxId ?? ''
  if (input.action !== 'create' && !sandboxId) throw new AppError('VALIDATION', `${input.action} 需要 create 返回的 sandboxId`)

  if (input.action === 'create') {
    const source = resolveSourceInsideProject(rootPath, input.source)
    const record = await port.createSandbox({ source, network: !!input.network, ignored: input.ignored ?? 'link' })
    return {
      ...record,
      note: `镜像根是 ${record.root}。项目工具出不了项目边界，所以要跑的脚本先用 project:file 写进项目再 create，或者直接用 run 传命令；镜像里的命令写不到镜像外，${record.network ? '可以联网' : '连不上网'}。跑完用 diff 看变化，用完 discard。`,
    }
  }

  if (input.action === 'run') {
    if (!input.command) throw new AppError('VALIDATION', 'run 需要 command')
    // 沙箱里的命令出不了镜像，所以不走项目的修改授权；危险命令仍然让用户看一眼。
    const plan = analyzeCommandExecution(input.command)
    if (plan.isDangerous) {
      const decision = await context.approval.awaitConfirmationDecision(
        buildBackgroundCommandConfirmationMessage(input.command, plan, `演练沙箱 ${sandboxId}`, false),
        context.abortSignal,
        createManualApprovalOptions({
          approvalRisk: 'high',
          riskScope: 'project-command:dangerous',
          operation: {
            key: createApprovalOperationKey('shell-command', { command: input.command.trim(), cwd: `sandbox:${sandboxId}`, background: false }),
            label: input.command,
            target: `sandbox:${sandboxId}`,
          },
        })
      )
      if (!decision.approved) return { approved: false, skipped: true, sandboxId, command: input.command, message: decision.message }
    }
    return port.runInSandbox({ sandboxId, command: input.command, timeoutMs: input.timeoutMs, maxOutputChars: input.maxOutputChars }, context.abortSignal)
  }

  if (input.action === 'diff') return port.diffSandbox({ sandboxId, maxFiles: input.maxFiles })
  if (input.action === 'discard') return port.discardSandbox(sandboxId)

  // 落回：先算差量摆给用户看，过项目的修改授权和用户确认，才写。
  const changes = await port.diffSandbox({ sandboxId, maxFiles: 2000 })
  const selection = selectChanges(changes, input.paths)
  if (!isEmpty(selection.unknown)) throw new AppError('VALIDATION', `这些路径在沙箱里没有变化：${selection.unknown.slice(0, 10).join('、')}`)
  if (isEmpty(selection.created) && isEmpty(selection.modified) && isEmpty(selection.deleted)) return { sandboxId, created: [], modified: [], deleted: [], skippedGit: changes.gitChanged, note: '镜像里没有文件变化，什么都没落。' }
  const authorization = await context.project.prepareMutation({ operation: `把演练沙箱 ${sandboxId} 的改动落回项目` })
  if (!authorization.approved) return { approved: false, skipped: true, sandboxId, message: authorization.rejectionMessage ?? authorization.message }
  const decision = await context.approval.awaitConfirmationDecision(
    applyConfirmationMessage(changes.source, selection),
    context.abortSignal,
    createManualApprovalOptions({
      approvalRisk: 'high',
      riskScope: 'project-sandbox:apply',
      operation: {
        key: createApprovalOperationKey('sandbox-apply', { sandboxId, created: selection.created.length, modified: selection.modified.length, deleted: selection.deleted.length }),
        label: `把演练沙箱的改动落回 ${changes.source}`,
        target: changes.source,
      },
    })
  )
  if (!decision.approved) return { approved: false, skipped: true, sandboxId, message: decision.message }
  return port.applySandbox({ sandboxId, paths: input.paths })
}

export const projectSandbox = defineProjectTool<ProjectSandboxInput>({
  name: ProjectToolNames.sandbox,
  category: 'project-execution',
  role: 'edit',
  summary: '演练沙箱：把项目（或其中一个目录）镜像到临时区，脚本先在镜像里跑（写不到镜像外），diff 看变了什么，确认后 apply 落回项目。',
  suitable: ['要一次改很多文件、删目录、跑迁移或批处理脚本之前，先在镜像里跑一遍看结果。', '拿不准一段脚本会不会误删误改的时候。'],
  forbidden: ['改一两个文件直接用 project:edit 或 project:file；只读命令直接用 project:run。', '不要把镜像里的结果当成已经发生：落回之前项目一个字节都没变。'],
  protocol: ['项目工具出不了项目边界：脚本先用 project:file 写进项目再 create（脚本随镜像一起进沙箱），或者用 run 直接传命令；镜像里的文件用 diff 的文本差量看，或者 run 一条 cat。'],
  usage: [
    'create 镜像整个项目或 source 指定的子目录；run 在镜像里跑命令，写到源目录会直接失败，所以脚本里算错的路径在这里只会报错。',
    'diff 看新增、修改、删除三列和文本差量；不对就改脚本再 run，镜像随便糟蹋。',
    'apply 把文件变化落回项目，会先向用户确认并列出删除与覆盖；项目里的文件在这期间被别人改过就整批不落。git 历史的变化不落回，要在项目里重放那几条 git 命令。',
    '用完 discard。gitignore 忽略的目录（node_modules 等）缺省是指向真实目录的链接，脚本能用依赖但写不进去；要在镜像里重新构建就 create 时传 ignored=copy。',
  ],
  examples: [
    { action: 'create' },
    { action: 'run', sandboxId: '20260915-183000-3fa2c1', command: 'bun scripts/migrate.ts' },
    { action: 'diff', sandboxId: '20260915-183000-3fa2c1' },
    { action: 'apply', sandboxId: '20260915-183000-3fa2c1' },
    { action: 'discard', sandboxId: '20260915-183000-3fa2c1' },
  ],
  notes: ['镜像里的命令连不上网，除非 create 时传 network=true；镜像仓库推不出去。宿主没有进程约束后端时建不出沙箱，这个工具也不会出现。', '落回不经过 project:change 的撤销账本，要撤销用 git。'],
  schema: z.strictObject({
    action: z.enum(['create', 'run', 'diff', 'apply', 'discard']).describe('create 建沙箱；run 在镜像里跑命令；diff 看镜像相对创建时的变化；apply 把变化落回项目（会向用户确认）；discard 删掉镜像。'),
    source: z.string().min(1).optional().describe('create：要镜像的项目内目录，相对项目根；不传就是整个项目。'),
    network: z.boolean().optional().describe('create：镜像里的命令能不能联网，默认不能。'),
    ignored: z.enum(['link', 'copy', 'skip']).optional().describe('create：gitignore 忽略的目录怎么处理：link 链接到真实目录（能读不能写，默认）、copy 复制、skip 不要；忽略的文件一律不复制。'),
    sandboxId: z.string().min(1).max(64).optional().describe('run / diff / apply / discard：create 返回的沙箱 id。'),
    command: z.string().min(1).optional().describe('run：在镜像根里执行的 shell 命令。'),
    timeoutMs: z.number().int().positive().max(600_000).optional().describe('run：超时毫秒数。'),
    maxOutputChars: z.number().int().positive().max(50_000).optional().describe('run：最多返回多少字符的输出。'),
    paths: z.array(z.string().min(1)).max(500).optional().describe('apply：只落这些相对路径；不传就全部。'),
    maxFiles: z.number().int().positive().max(2000).optional().describe('diff：新增与修改各列最多列多少条，默认 200；删除列永远完整。'),
  }),
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: ProjectExecutionCapability,
  exposure: { tier: 'common', rank: 60 },
  hideWhenUnavailable: true,
  isAvailable: (context) => !!context.project.sandbox,
  isConcurrencySafe: () => false,
  execute: runProjectSandbox,
})
