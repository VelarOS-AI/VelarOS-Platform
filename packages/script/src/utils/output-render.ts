import { createHash } from 'node:crypto'

import {
  isArray,
  isEmpty,
  isFiniteNumber,
  isObject,
  isPositiveNumber,
  isString,
  isUndefined,
  stringifyPretty,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ScriptOutputLimits } from '../contract/constants.js'
import type {
  ScriptOutputBlock,
  ScriptOutputCapture,
  ScriptOutputDisplay,
  ScriptOutputFormat,
  ScriptOutputManifest,
  ScriptOutputPresentation,
  ScriptOutputProjection,
  ScriptOutputSummary,
  ScriptOutputView,
} from '../types/output.js'

/** 原值指纹不包含执行号和采集时间，用于严格绑定摘要。 */
export function outputContentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 将单个 JSON Pointer 解析为自己的数据属性，不访问原型。 */
function selectPointer(value: unknown, path: string): { found: boolean; value?: unknown } {
  let current = value
  for (const key of isEmpty(path)
    ? []
    : path
        .slice(1)
        .split('/')
        .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || !isObject(current) || !Object.hasOwn(current, key)) return { found: false }
    current = Reflect.get(current, key)
  }
  return { found: true, value: current }
}

/** 按类型选择完整条目或完整行；预算不足返回引用，不构造半个 JSON。 */
function renderBlock(
  block: ScriptOutputBlock,
  index: number,
  view: ScriptOutputView,
  ref: string,
  budget: number,
  summaries: readonly ScriptOutputSummary[],
  taskRevision: string,
  display?: ScriptOutputDisplay
): ScriptOutputPresentation {
  const type =
    block.options.type ?? (isString(block.value) ? 'text' : isArray(block.value) ? 'list' : 'json')
  const item: ScriptOutputPresentation = {
    key: block.key,
    type,
    purpose: block.options.purpose,
    language: block.options.language,
    contentHash: outputContentHash(block.value),
    representation: 'reference',
    text: '',
    bodyIncluded: false,
    rawRef: ref,
    pointer: `/output/blocks/${index}/value`,
    // pointer 召回字符串时返回解码原文，采集用的 JSON 字符数另保存在 block.chars。
    totalChars: isString(block.value) ? block.value.length : block.chars,
    totalItems: isArray(block.value) ? block.value.length : undefined,
  }
  const reference = (reason: string, selection?: unknown) => ({
    ...item,
    reason,
    selection: toOptional(selection),
  })
  const cap = Math.min(budget, view.maxChars ?? budget)
  if (view.mode === 'reference' || cap === 0)
    return reference(view.mode === 'reference' ? 'source-policy' : 'view-budget')
  if (type === 'image' || type === 'file') {
    const data = block.value as Record<string, unknown>
    const info = Object.fromEntries(
      ['name', 'label', 'mediaType', 'bytes', 'ref']
        .filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, isString(data[key]) ? (data[key] as string).slice(0, 500) : data[key]])
    )
    return reference(type === 'image' ? 'native-attachment-required' : 'file-reference', info)
  }
  if (view.mode === 'summary') {
    const summary = summaries.find(
      (s) =>
        s.key === block.key && s.contentHash === item.contentHash && s.taskRevision === taskRevision
    )
    return summary && summary.text.length <= cap
      ? {
          ...item,
          representation: 'summary',
          text: summary.text,
          bodyIncluded: true,
          reason: 'model-interpretation',
        }
      : reference(summary ? 'summary-budget' : 'summary-unavailable')
  }
  // 等价编码是宿主能力；选择视图仍按原值解释，不能借此把局部/摘要标成完整。
  if (
    display &&
    display.key === block.key &&
    display.contentHash === item.contentHash &&
    !view.paths &&
    !view.lines &&
    isUndefined(view.maxItems) &&
    isUndefined(view.edge)
  )
    return display.text.length <= cap
      ? { ...item, representation: 'full', text: display.text, bodyIncluded: true }
      : reference('full-unavailable')
  let selected = block.value
  let selection: unknown
  let stringOffset = 0
  let partial = false
  if (view.paths) {
    const fields = view.paths.map((path) => ({ path, ...selectPointer(selected, path) }))
    selected = { fields }
    selection = { paths: view.paths, missing: fields.filter((f) => !f.found).map((f) => f.path) }
    partial = true
  } else if (isArray(selected)) {
    const total = selected.length
    const count = Math.min(total, view.maxItems ?? total)
    const start = view.edge === 'tail' ? total - count : 0
    selected = selected.slice(start, start + count)
    selection = { from: start, shown: count, total, unit: 'items' }
    partial = count < total
  } else if (isString(selected) && view.lines) {
    const lines = selected.split('\n')
    const [start, end] = view.lines
    stringOffset = lines.slice(0, start - 1).reduce((sum, line) => sum + line.length + 1, 0)
    stringOffset = Math.min(stringOffset, selected.length)
    selected = lines.slice(start - 1, end).join('\n')
    selection = {
      lines: [start, Math.min(end, lines.length)],
      totalLines: lines.length,
      missing: start > lines.length,
    }
    partial = start > 1 || end < lines.length
  }
  const stringify = (v: unknown) =>
    (type === 'text' || type === 'code') && isString(v) ? v : stringifyPretty(v)
  let text = stringify(selected)
  if (view.mode === 'full' && (partial || text.length > cap))
    return reference('full-unavailable', selection)
  if (text.length > cap) {
    partial = true
    if (isArray(selected)) {
      const values = selected
      let low = 0
      let high = values.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const part = view.edge === 'tail' ? values.slice(-mid) : values.slice(0, mid)
        if (stringify(part).length <= cap) low = mid
        else high = mid - 1
      }
      if (low === 0) return reference('view-budget', selection)
      const offset =
        (selection as { from: number }).from + (view.edge === 'tail' ? values.length - low : 0)
      selected = view.edge === 'tail' ? values.slice(-low) : values.slice(0, low)
      text = stringify(selected)
      selection = {
        from: offset,
        shown: low,
        total: (block.value as unknown[]).length,
        unit: 'items',
      }
    } else if (isString(selected) && (type === 'text' || type === 'code')) {
      const lines = selected.split('\n')
      const kept: string[] = []
      let chars = 0
      for (const line of view.edge === 'tail' ? [...lines].reverse() : lines) {
        if (chars + line.length + (!isEmpty(kept) ? 1 : 0) > cap) break
        kept.push(line)
        chars += line.length + (kept.length > 1 ? 1 : 0)
      }
      if (isEmpty(kept)) return reference('line-exceeds-budget', selection)
      text = (view.edge === 'tail' ? kept.reverse() : kept).join('\n')
      if (view.edge === 'tail') stringOffset += selected.length - text.length
      selection = {
        ...(selection as object),
        shownLines: kept.length,
        edge: view.edge ?? 'head',
        omittedLines: lines.length - kept.length,
      }
    } else {
      if (!selected || !isObject(selected)) return reference('view-budget', selection)
      const entries = Object.entries(selected)
      const share = Math.floor(cap / Math.max(1, entries.length))
      const fields = Object.fromEntries(
        entries.map(([key, value]) => [
          key,
          JSON.stringify(value).length <= share
            ? value
            : {
                representation: 'reference',
                rawRef: ref,
                pointer: view.paths
                  ? undefined
                  : `${item.pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
                chars: isString(value) ? value.length : JSON.stringify(value).length,
              },
        ])
      )
      // 小字段保留原值，长文本使用剩余预算展示完整行；片段与原值以引用及字段路径区分。
      const textFields = view.paths
        ? []
        : entries.filter(([, value]) => isString(value) && JSON.stringify(value).length > share)
      for (const [position, [key, value]] of textFields.entries()) {
        if (!isString(value)) continue
        const used = stringify(fields).length
        const fieldCap = used + Math.floor(Math.max(0, cap - used) / (textFields.length - position))
        const original = fields[key]
        fields[key] = value
        if (stringify(fields).length <= fieldCap) continue
        fields[key] = original
        let best = original
        let low = 1
        let high = Math.min(value.length - 1, cap)
        while (low <= high) {
          const mid = Math.floor((low + high) / 2)
          const rendered = renderBlock(
            { key, value, chars: JSON.stringify(value).length, options: { type: 'text' } },
            index,
            { edge: view.edge },
            ref,
            mid,
            summaries,
            taskRevision
          )
          if (!rendered.bodyIncluded) {
            low = mid + 1
            continue
          }
          fields[key] = {
            ...original,
            representation: 'excerpt',
            text: rendered.text,
            selection: rendered.selection,
          }
          if (stringify(fields).length <= fieldCap) {
            best = fields[key]
            low = mid + 1
          } else high = mid - 1
        }
        fields[key] = best
      }
      selected = fields
      text = stringify(selected)
      if (text.length > cap) return reference('view-budget', selection)
    }
  }
  // 字符偏移按存档原文计算，保留缩进和原始 CRLF 宽度；仅凭行号无法安全续读 memory.read。
  if (partial && isString(block.value) && (type === 'text' || type === 'code') && !view.paths)
    selection = {
      ...(selection as object),
      chars: { from: stringOffset, shown: text.length, total: block.value.length, unit: 'utf16' },
    }
  return {
    ...item,
    representation: partial ? 'excerpt' : 'full',
    text,
    bodyIncluded: true,
    selection: toOptional(selection),
    reason: partial ? 'source-selection-or-budget' : undefined,
  }
}

/** 使用同一个编码结果计量并交付；文本正文不再额外加 JSON 转义。 */
function encodeOutput(
  blocks: readonly ScriptOutputPresentation[],
  omittedBlocks: number,
  allocatedChars: number,
  issues: readonly string[],
  format: ScriptOutputFormat
): string {
  const metadata = {
    omittedBlocks,
    displayChars:
      omittedBlocks > 0 || blocks.some((block) => block.representation !== 'full')
        ? allocatedChars
        : undefined,
    issues: !isEmpty(issues) ? issues : undefined,
  }
  if (format === 'json') return JSON.stringify({ blocks, ...metadata })
  return [
    JSON.stringify(metadata),
    ...blocks.flatMap(({ text, ...block }) => [JSON.stringify(block), ...(text ? [text] : [])]),
  ].join('\n')
}

/**
 * Script 统一解释展示申请。整体显式配置硬覆盖；否则把数字上限或无上限 full 块的实际 JSON 编码合并，
 * 普通块保留原默认份额。只为确有申请的块渲染正文，不把请求预算当作宿主授权。
 */
export function requestOutputBudget(
  capture: ScriptOutputCapture,
  manifest?: ScriptOutputManifest,
  ref = '',
  displays: readonly ScriptOutputDisplay[] = []
): { maxChars: number; explicit: boolean } {
  const config =
    manifest && Object.hasOwn(manifest.config, 'maxChars') ? manifest.config : capture.config
  if (!isUndefined(config.maxChars))
    return {
      maxChars: Math.max(0, Math.min(config.maxChars, ScriptOutputLimits.maxDisplayChars)),
      explicit: true,
    }
  const requested = capture.blocks.flatMap((block, index) => {
    const view =
      manifest?.outputs.find((output) => output.key === block.key)?.view ?? block.options.view ?? {}
    return (isPositiveNumber(view.maxChars) ||
      (view.mode === 'full' && isUndefined(view.maxChars))) &&
      view.mode !== 'reference' &&
      view.mode !== 'summary' &&
      block.options.type !== 'image' &&
      block.options.type !== 'file'
      ? [{ block, index, view }]
      : []
  })
  if (isEmpty(requested)) return { maxChars: ScriptOutputLimits.displayChars, explicit: false }
  const blocks = requested.map(({ block, index, view }) =>
    renderBlock(
      block,
      index,
      view,
      ref,
      ScriptOutputLimits.maxDisplayChars,
      [],
      '',
      displays.find((item) => item.key === block.key)
    )
  )
  const encoded = encodeOutput(
    blocks,
    0,
    ScriptOutputLimits.maxDisplayChars,
    capture.issues.slice(0, ScriptOutputLimits.issues),
    'json'
  ).length
  const ordinary = requested.length < capture.blocks.length ? ScriptOutputLimits.displayChars : 0
  return {
    maxChars: Math.min(
      ScriptOutputLimits.maxDisplayChars,
      Math.max(ScriptOutputLimits.displayChars, encoded + ordinary)
    ),
    explicit: true,
  }
}

/** 按实际交付编码分配全局预算；正文、目录与省略说明一起计量。 */
export function projectOutputs(
  capture: ScriptOutputCapture,
  ref: string,
  maxChars: number,
  manifest?: ScriptOutputManifest,
  summaries: readonly ScriptOutputSummary[] = [],
  taskRevision = '',
  format: ScriptOutputFormat = 'json',
  displays: readonly ScriptOutputDisplay[] = []
): ScriptOutputProjection {
  if (format !== 'json' && format !== 'text')
    throw new AppError('VALIDATION', '输出展示编码必须是 json 或 text')
  const originalRequest = requestOutputBudget(capture, manifest, ref).maxChars
  const requestedChars =
    format === 'text' && displays.length
      ? Math.max(originalRequest, requestOutputBudget(capture, manifest, ref, displays).maxChars)
      : originalRequest
  const allocatedChars = Math.max(0, Math.min(requestedChars, maxChars))
  const issues = capture.issues.slice(0, ScriptOutputLimits.issues)
  const ordered = capture.blocks
    .map((block, index) => ({
      block,
      index,
      view: manifest?.outputs.find((o) => o.key === block.key)?.view ?? block.options.view ?? {},
      display:
        format === 'text'
          ? displays.find(
              (item) =>
                item.key === block.key && item.contentHash === outputContentHash(block.value)
            )
          : undefined,
    }))
    .sort(
      (a, b) =>
        Number(Boolean(b.block.options.required)) - Number(Boolean(a.block.options.required)) ||
        { high: 0, normal: 1, low: 2 }[a.block.options.priority ?? 'normal'] -
          { high: 0, normal: 1, low: 2 }[b.block.options.priority ?? 'normal'] ||
        (a.block.options.key && b.block.options.key
          ? a.block.key.localeCompare(b.block.key, 'en')
          : a.index - b.index)
    )
  let blocks = ordered.map(({ block, index, view }) =>
    renderBlock(block, index, { ...view, mode: 'reference' }, ref, 0, summaries, taskRevision)
  )
  let omittedBlocks = 0
  // 放不下（有块被省略或只露出一部分）时写出这次的展示预算，模型对得上是自己交多了
  const encode = () => encodeOutput(blocks, omittedBlocks, allocatedChars, issues, format)
  // 短值的完整元数据可能比引用卡更短；按当前整体编码选更小的完整表示后再准入目录。
  if (format === 'text')
    for (let i = 0; i < blocks.length; i++) {
      const { block, index, view, display } = ordered[i]!
      const complete = renderBlock(
        block,
        index,
        view,
        ref,
        allocatedChars,
        summaries,
        taskRevision,
        display
      )
      if (complete.representation !== 'full') continue
      const previous = blocks[i]!
      const before = encode().length
      blocks[i] = complete
      if (encode().length > before) blocks[i] = previous
    }
  while (!isEmpty(blocks) && encode().length > allocatedChars) {
    blocks.pop()
    omittedBlocks++
  }
  const expand = (i: number, budget: number) => {
    const { block, index, view, display } = ordered[i]!
    const previous = blocks[i]!
    blocks[i] = renderBlock(block, index, view, ref, budget, summaries, taskRevision, display)
    if (encode().length <= allocatedChars) return
    // 转义和省略元数据也占预算；在实际编码后的总长内找片段，避免一次减半空出大量空间。
    let low = 0
    let high = budget - 1
    let best = previous
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      blocks[i] = renderBlock(block, index, view, ref, mid, summaries, taskRevision, display)
      if (encode().length <= allocatedChars) {
        best = blocks[i]!
        low = mid + 1
      } else high = mid - 1
    }
    blocks[i] = best
  }
  for (let i = 0; i < blocks.length; i++) {
    const remaining = Math.max(0, allocatedChars - encode().length)
    expand(
      i,
      ordered[i]!.block.options.required ||
        (format === 'text' && ordered[i]!.block.options.priority === 'high')
        ? remaining
        : Math.floor(remaining / (blocks.length - i))
    )
  }
  // 短块、显式上限与引用卡用不完的份额，按既定优先级返还给尚未完整展示的块。
  // 保留其他块的现有正文，只在同一全局预算内扩展；原值与展示策略不变。
  for (let i = 0; i < blocks.length && encode().length < allocatedChars; i++)
    if (blocks[i]!.representation !== 'full' || ordered[i]!.display) expand(i, allocatedChars)
  let prompt = encode()
  if (prompt.length > allocatedChars) {
    prompt = ''
    blocks = []
    omittedBlocks = capture.blocks.length
  }
  return { format, blocks, prompt, requestedChars, allocatedChars, omittedBlocks, issues }
}

/** 只移除已确认交付的正文；同一编码计量，无法缩短时保留原投影。 */
export function withoutOutputBodies(
  projection: ScriptOutputProjection,
  identities: ReadonlyArray<{ key: string; contentHash: string }>,
  maxChars?: number
): ScriptOutputProjection {
  if (!isUndefined(maxChars) && !isFiniteNumber(maxChars))
    throw new AppError('VALIDATION', '输出引用化的宿主上限必须是有限数字')
  let blocks = projection.blocks.map((block) =>
    block.bodyIncluded &&
    identities.some((item) => item.key === block.key && item.contentHash === block.contentHash)
      ? {
          ...block,
          text: '',
          representation: 'reference' as const,
          bodyIncluded: false,
          reason: 'body-in-history',
        }
      : block
  )
  const allocatedChars = isUndefined(maxChars)
    ? projection.allocatedChars
    : Math.max(0, Math.min(projection.allocatedChars, Math.floor(maxChars)))
  if (
    allocatedChars === projection.allocatedChars &&
    blocks.every((block, index) => block === projection.blocks[index])
  )
    return projection
  let omittedBlocks = projection.omittedBlocks
  const encode = () =>
    encodeOutput(blocks, omittedBlocks, allocatedChars, projection.issues, projection.format)
  let prompt = encode()
  if (isUndefined(maxChars))
    return prompt.length <= projection.prompt.length && prompt.length <= allocatedChars
      ? { ...projection, blocks, prompt }
      : projection
  const originalPrompt = encodeOutput(
    projection.blocks,
    projection.omittedBlocks,
    allocatedChars,
    projection.issues,
    projection.format
  )
  // 极短正文的引用卡可能更长；原表示仍放得下时保留它，不扩大实际用量或改写相同表示。
  if (prompt.length > originalPrompt.length && originalPrompt.length <= allocatedChars)
    return {
      ...projection,
      prompt: originalPrompt,
      allocatedChars,
    }
  // 缩减的宿主份额连元数据也放不下时只保留省略计数，不能把剩余块伪称完整交付。
  while (!isEmpty(blocks) && prompt.length > allocatedChars) {
    blocks = blocks.slice(0, -1)
    omittedBlocks++
    prompt = encode()
  }
  if (prompt.length > allocatedChars) prompt = ''
  return { ...projection, blocks, prompt, allocatedChars, omittedBlocks }
}
