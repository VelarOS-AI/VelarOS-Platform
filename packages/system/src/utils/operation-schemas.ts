/**
 * 七个操作的入参校验。
 *
 * 抽出来是因为**校验与说明是两件事**，而工具时代把它们塞进了同一个 schema：
 * `.describe()` 写给模型看、`strictObject`/`min`/`max` 拿来拦东西。
 * 模型那边的真相源现在是 `@AgentView` 从源码生成的声明（`baselines/code-surface/system.d.ts`），
 * 字段什么意思写在类型的注释上。这里的 `.describe()` 只为还活着的旧工具面留着，旧面退休时跟着走；
 * 真正长期有用的是那些约束。
 *
 * **上限不在这里。** 预算属于那件能力自己（`assertFileBatchSize`、readChars 的分配循环、
 * `clampPositive`），谁拥有预算谁兜底；靠调用方这一侧的 schema 拦，换一个入口就漏了——
 * 实测过：`run` 的 timeoutMs 与 maxOutputChars 一度**只有** schema 在拦，绕开它调操作方法就没有上限。
 * 这里剩下的只有形状：TS 类型表达不了的那几样（整数、非负、非空串、拒绝多余键），
 * 而且只在动态口子上才轮得到它们——静态那条路编译器已经拦了。
 */

import { z } from 'zod'

import { RehearsalSandboxLimits } from '@velaros-ai/rehearsal-sandbox/contracts'
import { ShellCommandKinds } from '@velaros-ai/shell-command/contracts'

import { SystemCommandLimits, SystemFileLimits } from '../contract/constants.js'

/** 读：files 每项一个文件。 */
export const readInputSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string().min(1).describe('文件路径，支持 ~；相对路径相对 system:run 的默认目录。'),
    offset: z.number().int().nonnegative().optional().describe('从第几个字符开始读，默认 0。'),
    maxChars: z.number().int().positive().optional().describe(`最多返回多少字符，默认也是上限 ${SystemFileLimits.readChars}。没取完时只给完整的行，从 range.end 接着读；某一行本身比预算还长时才会从行中间截。`),
    version: z.string().min(1).optional().describe('读改动前留下的某个版本，版本号来自 read 或 edit 的结果；只有本次运行里 edit 留下的版本能召回。'),
  })).min(1).describe(`要读的文件，每项一个，一次最多 ${SystemFileLimits.readFiles} 个。`),
})

/** 看图片：files 每项一张。 */
export const viewInputSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string().min(1).describe('图片路径，支持 ~；相对路径相对 system:run 的默认目录。'),
  })).min(1).describe(`要看的图片，每项一张，一次最多 ${SystemFileLimits.viewFiles} 张。`),
})

/** 写：files 每项一个文件，一个文件可以改几处。 */
export const editInputSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string().min(1).describe('文件路径，支持 ~；相对路径相对 system:run 的默认目录。'),
    newText: z.string().optional().describe('整个文件写入的内容，不存在就新建；改几处时不用给，改动写在 edits 里。'),
    edits: z.array(z.strictObject({
      range: z.strictObject({
        offset: z.number().int().nonnegative().describe('起点字符位置。'),
        end: z.number().int().nonnegative().describe('终点字符位置，不含。'),
      }).describe('system:read 返回的 range，只在这段里改。'),
      oldText: z.string().optional().describe('要换掉的原文，只在 range 里找、必须只出现一次；不给就把整段换成 newText。'),
      newText: z.string().describe('换成的新文本。'),
    })).min(1).max(SystemFileLimits.editsPerFile).optional().describe('要改的地方，每项一处；同一个文件的几处一起改，全成或全不成，各处不能重叠。'),
    restore: z.string().min(1).optional().describe('回滚到这个版本，版本号来自 read 或 edit 结果里的 version 或 previousVersion；不和 newText、edits 同用，可以带 version 先核对文件没被改过。'),
    version: z.string().min(1).optional().describe('read 返回的这个文件的版本号；给了就先核对文件没被改过，改过就整批不写并给出当前版本。'),
  })).min(1).describe(`要写的文件，每项一个，一次最多 ${SystemFileLimits.editFiles} 个；每项只用 newText、edits、restore 中的一种。`),
})

/** 跑命令。 */
export const runInputSchema = z.strictObject({
  command: z.string().min(1).describe('要执行的 shell 命令。'),
  cwd: z.string().optional().describe('命令的工作目录；不传用宿主给的默认目录。'),
  shell: z.enum(ShellCommandKinds).optional().describe('用哪个 shell 执行；不传用环境报告里的默认 shell。只能填环境报告列为可用的那几个，填了本机没有的会在执行之前被拒，报错里给出可用的清单。'),
  timeoutMs: z.number().int().positive().optional().describe('命令超时时间，单位毫秒。'),
  background: z.boolean().optional().describe('后台启动，立即返回后台任务；长驻服务传 true。'),
  interactive: z.boolean().optional().describe('命令需要用户输入时传 true：命令在控制台里跑，用户在卡片里输入。'),
  maxOutputChars: z.number().int().positive().optional().describe('stdout/stderr 返回字符上限。'),
  parallel: z.boolean().optional().describe('命令只读、可以和别的命令同时跑时传 true，调度器会并发执行。'),
  allowRepeat: z.boolean().optional().describe('要故意再跑一遍完全相同的命令时传 true，否则同样的调用会被拦。'),
})

/** 刷新环境：不收参数，收了也不看。 */
export const refreshEnvironmentInputSchema = z.record(z.string(), z.unknown())

/** 列后台任务。 */
export const listTasksInputSchema = z.strictObject({
  limit: z.number().int().positive().optional().describe('最多返回数量。'),
  onlyRunning: z.boolean().optional().describe('是否只返回运行中任务。'),
  taskId: z.string().min(1).max(SystemCommandLimits.taskIdChars).optional().describe('精确后台任务 id；取自 system:run 的 backgroundProcess.taskId。'),
})

/** 演练沙箱的四个动作。 */
export const sandboxInputSchema = z.strictObject({
  action: z.enum(['create', 'diff', 'apply', 'discard']).describe('create 建沙箱；diff 看镜像相对创建时的变化；apply 把变化落回源目录（会向用户确认）；discard 删掉镜像。'),
  source: z.string().min(1).optional().describe('create：要镜像的目录，支持 ~；不传就是 system:run 的默认目录。'),
  network: z.boolean().optional().describe('create：镜像里的命令能不能联网，默认不能。'),
  ignored: z.enum(['link', 'copy', 'skip']).optional().describe('create：gitignore 忽略的目录怎么处理：link 链接到真实目录（能读不能写，默认）、copy 复制、skip 不要；忽略的文件一律不复制。'),
  sandboxId: z.string().min(1).max(RehearsalSandboxLimits.idChars).optional().describe('diff / apply / discard：create 返回的沙箱 id。'),
  paths: z.array(z.string().min(1)).max(RehearsalSandboxLimits.applyPaths).optional().describe('apply：只落这些相对路径；不传就全部。'),
  maxFiles: z.number().int().positive().max(RehearsalSandboxLimits.diffFilesMax).optional().describe(`diff：新增与修改各列最多列多少条，默认 ${RehearsalSandboxLimits.diffFiles}；删除列永远完整。`),
})

/**
 * 按 schema 校验一次入参，失败时给一句**能让模型直接改对**的话。
 *
 * 逐条列出「哪个字段、错在哪」，而不是回一句「参数不合法」——代码面里模型拿到这句话之后
 * 要自己改程序再发一轮，话说不清就等于白花一轮。路径带上下标（`files[2].path`），
 * 因为一次调用里有一批文件，不说是第几个它没法定位。
 */
export function parseOperationInput(
  schema: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> } } },
  input: unknown
): { value: unknown } | { error: string } {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { value: parsed.data }
  const issues = (parsed.error?.issues ?? []).map((issue) => {
    const where = issue.path.reduce<string>(
      (path, key) => (typeof key === 'number' ? `${path}[${key}]` : path.length === 0 ? String(key) : `${path}.${String(key)}`),
      ''
    )
    return where.length === 0 ? issue.message : `${where}：${issue.message}`
  })
  return { error: issues.length === 0 ? '入参不合法。' : `入参不合法——${issues.join('；')}。` }
}
