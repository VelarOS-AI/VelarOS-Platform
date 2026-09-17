/**
 * 七个工具的入参 schema——**这是旧工具面的东西，随它一起退休。**
 *
 * 在工具时代它身兼两职：`.describe()` 是模型看到的参数说明（经 `z.toJSONSchema` 发给 provider），
 * 约束是那条路上唯一的关——模型直接发 JSON，没有任何编译期检查，不拦不行。
 *
 * 代码面不用它，一个字都不用：模型那边的真相源是 `@AgentView` 生成的声明
 * （`baselines/code-surface/system.d.ts`），入参合不合法由**操作方法自己**拦——
 * 那本来就是它的职责，它要处理路径不存在、文件太大、编码认不出，顺手把形状也看了；
 * 盖在调用方这一侧的校验换个入口就漏（`run` 的 timeoutMs 曾经只有 schema 在拦，就是这么漏的）。
 *
 * 所以这里**不要再加新东西**。要拦什么，写进那个操作方法里。
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
