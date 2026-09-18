/**
 * 证据采集的文案规则：标题生成、观察描述的拼装、目标参数的读取。
 *
 * 这些都是纯规则，不碰实例状态；采集桥只负责把宿主事件喂进来、把结果排队入库。
 */

import { isBlank, isFiniteNumber, isString } from '@velaros-ai/core'

import type { MemoryWorkspaceToolObservationInput } from '../types/host.js'

import { MemoryTuning } from './tuning.js'

/** 由正文推出一条证据的标题：取第一行非空文本，压缩空白，按上限截断。 */
export function titleFromContent(content: string): string {
  const line = content.split('\n').find((item) => !isBlank(item.trim())) ?? content
  const normalized = line.replace(/\s+/gu, ' ').trim()
  const limit = MemoryTuning.capture.titleMaxChars
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`
}

/** 把一个参数值写进中文描述：不是有限数字就写「未知」。 */
export function numberOrUnknown(value: unknown): string {
  return isFiniteNumber(value) ? String(value) : '未知'
}

/** 从工具入参里找出「对谁做的」：按 path / filePath / rootPath / cwd 顺序取第一个有值的，按上限截断。 */
export function readWorkspaceTarget(args: Record<string, unknown>): string {
  for (const key of ['path', 'filePath', 'rootPath', 'cwd']) {
    const value = args[key]
    if (isString(value) && !isBlank(value.trim())) return value.trim().slice(0, MemoryTuning.capture.targetMaxChars)
  }
  return ''
}

/** 把一次桌面操作观察写成一句中文；不认识的工具返回 null（这一条就不采集）。 */
export function describeComputerUseObservation(
  toolName: string,
  args: Record<string, unknown>,
): Nullable<string> {
  switch (toolName) {
    case 'computer:screenshot':
      return '为当前任务观察了主屏幕；原始截图未进入长期记忆。'
    case 'computer:move':
      return `为当前任务移动了鼠标到 (${numberOrUnknown(args.x)}, ${numberOrUnknown(args.y)})。`
    case 'computer:click':
      return `为当前任务在 (${numberOrUnknown(args.x)}, ${numberOrUnknown(args.y)}) 执行了${isString(args.button) ? `「${args.button}」` : '左键'}点击。`
    case 'computer:type':
      return `为当前任务向桌面焦点输入了文本；仅保留长度 ${isString(args.text) ? args.text.length : 0}，原文未进入长期记忆。`
    case 'computer:key':
      return `为当前任务发送了按键 ${isString(args.keys) ? args.keys.slice(0, MemoryTuning.capture.keysMaxChars) : '未知'}。`
    default:
      return null
  }
}

/** 把一次工作区工具观察写成一句中文，按类别分档措辞。 */
export function describeWorkspaceObservation(input: MemoryWorkspaceToolObservationInput): string {
  const target = readWorkspaceTarget(input.args)
  const targetText = target ? `，目标 ${target}` : ''
  switch (input.categoryId) {
    case 'project-changes':
      return `通过 ${input.toolName} 完成了一次项目修改${targetText}；文件正文未复制进长期记忆。`
    case 'project-execution':
      return `通过 ${input.toolName} 完成了一次项目执行${targetText}；命令和输出原文未复制进长期记忆。`
    case 'development-code':
      return `通过 ${input.toolName} 检查了代码结构${targetText}；查询结果原文未复制进长期记忆。`
    case 'project-files':
      return `通过 ${input.toolName} 检查了项目文件${targetText}；读取内容未复制进长期记忆。`
  }
}
