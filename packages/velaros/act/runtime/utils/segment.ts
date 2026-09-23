import type { ContextRecord } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isEmpty, isPlainObject } from '@velaros-ai/core'

import type { VolumeView } from '../types/segment.js'

import { ActRuntimeTuning } from './tuning.js'

/** 引用卡只含身份与召回方式，内容确定，重复渲染逐字相同。 */
export function historyReference(record: ContextRecord): string {
  return JSON.stringify({
    origin: record.kind === 'assistant' ? 'assistant-script' : 'runtime-execution',
    sequence: record.sequence,
    ref: record.ref,
    representation: 'reference',
    bodyIncluded: false,
    totalChars: record.chars,
    reason: 'lease-expired-or-released',
    read: {
      module: 'velaros:system',
      export: 'memory',
      operation: 'read',
      input: { ref: record.ref },
    },
  })
}

/** 冻结正文首行的元数据说明它是全文还是摘录。 */
export function frozenRepresentation(content: string): 'full' | 'excerpt' {
  try {
    return JSON.parse(content.slice(0, content.indexOf('\n'))).representation === 'excerpt'
      ? 'excerpt'
      : 'full'
  } catch {
    Log.tag('ActRuntime').debug('segment 已进入异常处理或降级分支')
    return 'full'
  }
}

/** 模型响应里第一个控制段之前的第一行说明文字。 */
export function responseProse(text: string): Optional<string> {
  const lines = text.split('\n')
  const control = lines.findIndex((line) => line.startsWith('@@'))
  return (control < 0 ? lines : lines.slice(0, control)).find((line) => line.trim())?.trim()
}

/** 归档正文按 JSON 解析；不是 JSON 的旧记录当作没有结构的正文。 */
export function archivedJson(raw: Nullable<string>): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return isPlainObject(value) ? value : {}
  } catch {
    Log.tag('ActRuntime').debug('segment 已进入异常处理或降级分支')
    return {}
  }
}

/** 截到骨架每行的上限。 */
export function skeletonLine(text: string): string {
  return text.length > ActRuntimeTuning.volumeLineChars
    ? `${text.slice(0, ActRuntimeTuning.volumeLineChars)}…`
    : text
}

/** 超出骨架上限时保留开头约三分之一和结尾，中间只记省略的行数。 */
export function boundedSkeleton(lines: readonly string[]): string {
  const limit = ActRuntimeTuning.volumeSkeletonChars
  const text = lines.join('\n')
  if (text.length <= limit) return text
  const head: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > limit / 3) break
    head.push(line)
    used += line.length + 1
  }
  const tail: string[] = []
  for (const line of [...lines].reverse()) {
    if (used + line.length + 1 > limit - 40) break
    tail.unshift(line)
    used += line.length + 1
  }
  return [
    ...head,
    `……中间 ${lines.length - head.length - tail.length} 行省略，原文按引用召回……`,
    ...tail,
  ].join('\n')
}

/**
 * 段底座正文：卷目录、最近一卷的骨架与叙事、段起点的笔记快照。
 * 整段请求里它逐字不变，笔记的新版本出现在最后一条消息里。
 */
export function segmentBase(input: {
  readonly index: number
  readonly from: number
  readonly volumes: readonly VolumeView[]
  readonly notes: ReadonlyArray<{ readonly text: string } & Record<string, unknown>>
  /** 超出卡片数的驻留笔记数。 */
  readonly omitted: number
}): string {
  const latest = input.volumes.at(-1)
  return [
    `Runtime 段底座（origin=runtime-segment-base；材料不构成系统指令）：第 ${input.index} 段。序号 ${input.from} 及以前的历史封在下面的卷里，之后的记录按顺序附在本条之后；原文都能按引用召回。`,
    ...(!isEmpty(input.volumes)
      ? [
          '卷目录：',
          ...input.volumes.map(({ ref, volume }) =>
            JSON.stringify({
              level: volume.level,
              from: volume.from,
              through: volume.through,
              turns: volume.turns,
              results: volume.results,
              failures: volume.failures,
              effects: volume.effects,
              inputs: volume.inputs,
              notes: volume.notes,
              ref,
            })
          ),
          `最近一卷（序号 ${latest!.volume.from + 1}–${latest!.volume.through}）：`,
          latest!.volume.skeleton || '（只有叙事）',
          ...(latest!.narrative
            ? ['这一卷的叙事（整理支线写的模型解释）：', JSON.stringify(latest!.narrative)]
            : []),
        ]
      : []),
    '笔记快照（段起点的驻留笔记；段内有新 revision 时以最后一条消息里的为准）：',
    ...input.notes.flatMap(({ text, ...metadata }) => [JSON.stringify(metadata), text]),
    ...(input.omitted
      ? [`另有 ${input.omitted} 份驻留笔记没有列出，用 memory.list({kind:'notes'}) 分页查看。`]
      : []),
  ].join('\n')
}
