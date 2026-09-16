import { isEmpty } from '@velaros-ai/core'

import type { PromptBudgetOptions, PromptCompositionResult, PromptContribution } from '../../types/guidance.js'
import type { AgentModTurnContextAppendage } from '../../types/mods.js'
import type { BuiltContext } from '../../types/runner.js'

/**
 * 转义要写进 XML 属性值的文本（`&` 必须最先换，否则会把后面几步产生的实体再转一遍）。
 * 提示词里的段名由贡献方给定，段名里带引号或尖括号时不转义会直接把 `<section>` 标签拆坏。
 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * 把段落正文裹进 CDATA，使其中的尖括号、`&` 等一律按字面文本传给模型，不必逐字符转义。
 * 正文里若本就含 `]]>`（会提前闭合 CDATA），按标准手法拆成 `]]]]><![CDATA[>` 续接，内容逐字不变。
 */
export function wrapCdata(text: string): string {
  return `<![CDATA[\n${text.replaceAll(']]>', ']]]]><![CDATA[>')}\n]]>`
}

/**
 * 把一个提示词贡献渲染成一段 `<section name="…">`：段名优先用 label（去空白），label 空则回落到 id，
 * 保证永远有个可辨认的名字。名字过属性转义，正文进 CDATA。
 */
export function formatPromptSection(part: PromptContribution): string {
  const name = part.label?.trim() || part.id
  return [
    `  <section name="${escapeXmlAttribute(name)}">`,
    wrapCdata(part.text),
    '  </section>',
  ].join('\n')
}

/**
 * 把若干段拼成一个完整的提示词块（`<instructions>` 或 `<current_context>`），段序即入参顺序。
 * 两个块各自是自洽的 XML 文档，供应方把 current 块挪到历史之后投递也不会拆坏结构。
 */
export function formatPromptBlock(args: {
  name: 'instructions' | 'current_context'
  parts: PromptContribution[]
}): string {
  return [
    `<${args.name}>`,
    ...args.parts.map((part) => formatPromptSection(part)),
    `</${args.name}>`,
  ].join('\n')
}

/**
 * 拼出最终 system prompt，并给出 `stableCutoff` = 稳定前缀的字符长度。
 *
 * 稳定段（`<instructions>`）永远在前、易变段（`<current_context>`）在后，这个顺序是前缀缓存能否命中的前提：
 * 前缀逐字不变，供应方才会复用缓存。`stableCutoff` 就是给缓存/审计标出"到这里为止是稳定的"。
 * 没有易变段时只输出稳定块，cutoff 等于整串长度。
 */
export function buildStructuredSystemPrompt(args: {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
}): { systemPrompt: string; stableCutoff: number } {
  // 提示词治理元数据属于 `BuiltContext.segments`，不交给模型；模型只收到描述性段落。
  // stable 与 current 两块各自是完整的 XML，供应商投递时把 current 块挪到历史之后也不会拆坏文档。
  const stablePrefix = formatPromptBlock({
    name: 'instructions',
    parts: args.stableParts,
  })

  if (isEmpty(args.dynamicParts)) return { systemPrompt: stablePrefix, stableCutoff: stablePrefix.length }

  return {
    systemPrompt: [
      stablePrefix,
      formatPromptBlock({
        name: 'current_context',
        parts: args.dynamicParts,
      }),
    ].join('\n'),
    stableCutoff: stablePrefix.length,
  }
}

/**
 * 这一段在预算超标时是否**允许**被裁掉：`retention: 'protected'` 不裁、来源是用户的不裁
 * （用户自己写进上下文的东西不能被预算悄悄吞掉），剩下的要 `priority >= 1000` 才算可裁——
 * 优先级数值越小越重要，1000 以内是内核级段落，宁可超预算也留着。
 */
export function canTrimPromptPart(part: PromptContribution): boolean {
  if (part.retention === 'protected') return false
  if (part.source === 'user') return false

  return part.priority >= 1_000
}

/**
 * 按字符预算裁剪提示词段落，直到整串长度落进 `maxChars`，并留下一份可审计的裁剪 trace。
 *
 * 每轮从可裁段里挑**优先级数值最大**（最不重要）的那个，同优先级挑正文最长的（一次裁掉最多字节，减少轮数），
 * 从稳定或易变段里摘掉，并把它记进 `skipped`（带上"被哪个档位的多少字符预算裁的"原因）——
 * 静默裁剪是最难查的一类行为漂移，所以裁了什么必须留痕。
 * 可裁段用尽仍超预算时**主动停手**（宁可超也不动受保护段），此时 charsAfter 会大于 maxChars。
 * 没有预算或 `maxChars <= 0` 时原样返回，trace 为 null。
 */
export function applyPromptBudget(args: {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
  skipped: BuiltContext['skippedSegments']
  budget?: LooseOptional<PromptBudgetOptions>
}): {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
  skipped: BuiltContext['skippedSegments']
  budgetTrace: BuiltContext['promptBudget']
} {
  if (!args.budget || args.budget.maxChars <= 0) return {
      stableParts: args.stableParts,
      dynamicParts: args.dynamicParts,
      skipped: args.skipped,
      budgetTrace: null,
    }

  const stableParts = [...args.stableParts]
  const dynamicParts = [...args.dynamicParts]
  const skipped = [...args.skipped]
  const initialPrompt = buildStructuredSystemPrompt({
    stableParts,
    dynamicParts,
  }).systemPrompt
  const charsBefore = initialPrompt.length
  let trimmedSegmentCount = 0

  while (
    buildStructuredSystemPrompt({
      stableParts,
      dynamicParts,
    }).systemPrompt.length >
    args.budget.maxChars
  ) {
    const candidates = [...stableParts, ...dynamicParts]
      .filter(canTrimPromptPart)
      .sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority

        return right.text.length - left.text.length
      })
    const candidate = candidates[0]
    if (!candidate) {
      break
    }

    const stableIndex = stableParts.findIndex((part) => part.id === candidate.id)
    if (stableIndex >= 0) {
      stableParts.splice(stableIndex, 1)
    } else {
      const dynamicIndex = dynamicParts.findIndex((part) => part.id === candidate.id)
      if (dynamicIndex >= 0) {
        dynamicParts.splice(dynamicIndex, 1)
      }
    }

    trimmedSegmentCount += 1
    skipped.push({
      id: candidate.id,
      label: candidate.label,
      stability: candidate.stability,
      source: candidate.source,
      priority: candidate.priority,
      reason: `trimmed by run profile ${args.budget.profile} (max ${args.budget.maxChars} chars)`,
    })
  }

  const charsAfter = buildStructuredSystemPrompt({
    stableParts,
    dynamicParts,
  }).systemPrompt.length

  return {
    stableParts,
    dynamicParts,
    skipped,
    budgetTrace: {
      profile: args.budget.profile,
      maxChars: args.budget.maxChars,
      charsBefore,
      charsAfter,
      trimmedSegmentCount,
    },
  }
}

/**
 * 把 mod 在 `turn-context:assemble` 上追加的段并进本轮 dynamic 段。
 *
 * 空文本与 id 已存在的追加一律丢弃（mod 不能借重名覆盖官方段），其余按 priority 与内置段一起重排，
 * 因此追加段和内置段共用同一份预算、同一条裁剪规则。没有一条有效追加时原样返回 `composition.dynamicParts`，不新建数组。
 */
export function appendModTurnContextParts(args: {
  composition: PromptCompositionResult
  appended: readonly AgentModTurnContextAppendage[]
  defaultPriority: number
}): PromptContribution[] {
  const { composition, appended } = args
  if (appended.length === 0) return composition.dynamicParts

  const known = new Set(
    [...composition.stableParts, ...composition.dynamicParts].map((part) => part.id)
  )
  const extras: PromptContribution[] = []
  for (const item of appended) {
    const text = item.text.trim()
    if (isEmpty(text) || known.has(item.id)) continue
    known.add(item.id)
    extras.push({
      id: item.id,
      label: item.label,
      tier: 'runtime',
      stability: 'dynamic',
      source: 'mod',
      priority: item.priority ?? args.defaultPriority,
      retention: 'normal',
      text,
    })
  }
  if (isEmpty(extras)) return composition.dynamicParts

  return [...composition.dynamicParts, ...extras].sort(
    (left, right) => left.priority - right.priority
  )
}

/**
 * 组装收尾：先按预算裁剪，再拼成最终 system prompt，并原样带出段落 trace。
 *
 * 返回的 `segments` 是真正进了提示词的那些，`skippedSegments` 是被谓词过滤或被预算裁掉的那些——
 * 两份都必须留着，静默裁剪是历史上最难查的一类行为漂移。
 */
export function finalizePromptBuild(args: {
  composition: PromptCompositionResult
  dynamicParts: PromptContribution[]
  budget?: LooseOptional<PromptBudgetOptions>
}): BuiltContext {
  const budgeted = applyPromptBudget({
    stableParts: args.composition.stableParts,
    dynamicParts: args.dynamicParts,
    skipped: args.composition.skipped,
    budget: args.budget,
  })
  const { systemPrompt, stableCutoff } = buildStructuredSystemPrompt({
    stableParts: budgeted.stableParts,
    dynamicParts: budgeted.dynamicParts,
  })

  return {
    systemPrompt,
    stableCutoff,
    segments: [...budgeted.stableParts, ...budgeted.dynamicParts].map((part) => ({
      id: part.id,
      label: part.label,
      stability: part.stability,
      source: part.source,
      priority: part.priority,
      retention: part.retention,
      text: part.text,
    })),
    skippedSegments: budgeted.skipped.map((part) => ({
      id: part.id,
      label: part.label,
      stability: part.stability,
      source: part.source,
      priority: part.priority,
      reason: part.reason,
    })),
    promptBudget: budgeted.budgetTrace,
  }
}
