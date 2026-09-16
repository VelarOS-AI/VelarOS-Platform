// 域：工具页的**激活语义**——「这张页现在能不能用、用不了该做什么」的唯一推导处。
// 本文件是工具空间四个模块的底座：Search / Queries / Replace 都从这里取页、取激活指引、
// 取模型面的 reason/activation ref，反向没有任何依赖（改这里会影响全部三个上层）。
//
// ## 从哪读起
// 两条链，入口各一：
//  1. `buildToolDiscoveryCards` —— 页的唯一来源，直通 tool-space-resolver，不做任何加工。
//  2. `buildToolActivationGuide` —— 页 → 激活指引。先按 `card.availability` 选择激活方式
//     （`direct_call`、`page_in_only`、`request_approval`、`request_user_action`、`inspect_reasons`），
//     再由 `withActivationDependencies` 补上 `buildToolDependencyGuides` 算出的依赖清单与
//     `buildActivationFlow` 拼出的分步流程。`buildToolActivationRef` 是它的模型面瘦身版。
//
// ## 关键不变量
//  1. **本文件不认识任何具体能力**。分类 id、域 id、工具名全部来自宿主注入的描述符；出现在这里的
//     只有形状与流程。语义中立门（`check:agent-arch` 防线⑤）连注释一起扫，改这里时别写具体产品词。
//  2. **页是唯一真相，激活指引是纯派生**。`ToolDiscoveryCard.availability / reasons` 由 resolver 定，
//     本文件只把它翻译成"下一步调什么"。反过来在这里推断可用性会与 resolver 打架。
//  3. **`activationFlow` 一条都不许落空**。空流程等于让模型自己猜下一步，实测会退化成重复
//     page-in 同一张不可用页；每个 method 分支都必须至少 push 一条可执行指令。
//
// ## 非显然的妥协
//  - 依赖建模只认 `reasons` 里的四组信号（approval / plugin.user_action / runtime / resident），
//    不做能力自有资源的推断——「缺什么前置」属于能力描述符的表达力，在这里补一张本地表会与
//    注入侧打架且必然过时。

import { isEmpty } from '@velaros-ai/core'

import type { ToolCategoryId } from '../../types/agent.js'
import type { ToolActivationGuide, ToolActivationMethod, ToolActivationRef,ToolDependencyGuide, ToolDependencyRef, ToolDiscoveryCard, ToolDiscoveryReason, ToolReasonRef } from '../../types/builtin.js'
import type { KernelToolContext as ToolContext } from '../../types/tool-context.js'
import { buildToolSpacePages } from '../tools/tool-space-resolver'

/**
 * 取当前上下文下的全部工具页，直通 `buildToolSpacePages`、**不做任何加工**。
 * 它是工具空间全部页的唯一来源：可用性与 reasons 都由 resolver 定，这里只转手，
 * 在本层加工会与 resolver 打架（不变量②）。
 */
export function buildToolDiscoveryCards(ctx: ToolContext): ToolDiscoveryCard[] {
  return buildToolSpacePages(ctx)
}

/** 由工具分类 id 拼出对应的能力页 id（`capability:<categoryId>`）——申请启用时 page-in 的就是它。 */
export function activationCapabilityIdForCategory(categoryId: ToolCategoryId): string {
  return `capability:${categoryId}`
}

/**
 * 取一张页对应的能力页 id：**插件页返回 null**（插件不按分类授权，它自己就是启用单位），
 * 其余按页所属分类拼 `capability:<categoryId>`。返回 null 时调用方退回用页自身的 id。
 */
function activationCapabilityIdForCard(card: ToolDiscoveryCard): Nullable<string> {
  if (card.kind === 'plugin') return null
  return activationCapabilityIdForCategory(card.categoryId)
}

/** 把一条不可用原因压成 `<layer>.<code>` 的扁平键（如 `approval.required`），供依赖项回带给模型对账。 */
function reasonKey(reason: ToolDiscoveryReason): string {
  return `${reason.layer}.${reason.code}`
}

/** 判断这张页的 reasons 里是否有某个 `layer` + `code` 的信号（精确匹配两项，一条都没有即为假）。 */
function hasReason(
  card: ToolDiscoveryCard,
  layer: ToolDiscoveryReason['layer'],
  code: string
): boolean {
  return card.reasons.some((reason) => reason.layer === layer && reason.code === code)
}

/**
 * 由页的 reasons 推出依赖清单（每条都带 pageIn / nextTool / activationHint，是能直接执行的指令）。
 * 只认四组信号，且可叠加：`approval.required` → 申请能力页（必需）；
 * `plugin.user_action_required` → 走动作卡请求用户动作（必需）；
 * `runtime.unavailable` / `runtime.no_available_tools` → 运行态阻塞、回 map 找替代（必需，pageId 为 null）；
 * `resident.loadable` → 已授权未驻留、page-in 即可（**非必需**，不进 activationFlow 的前置段）；
 * `resident.visible` / `capability.enabled` → 记一条 `satisfied` 的非必需项，纯粹告诉模型这条已经就绪。
 * 刻意不推断能力自有的前置资源——「缺什么前置」属于能力描述符的表达力，在这里补本地表必然与注入侧
 * 打架且会过时。一条信号都没有时返回空数组。
 */
function buildToolDependencyGuides(card: ToolDiscoveryCard): ToolDependencyGuide[] {
  const dependencies: ToolDependencyGuide[] = []
  const capabilityId = activationCapabilityIdForCard(card)

  if (hasReason(card, 'approval', 'required')) {
    dependencies.push({
      id: capabilityId ?? card.id,
      kind: 'capability',
      state: 'requires_approval',
      required: true,
      summary: '目标工具所属能力尚未启用；先申请能力页，优先按 capability 一类激活。',
      pageId: capabilityId ?? card.id,
      pageIn: [capabilityId ?? card.id],
      nextTool: 'tooling:replace',
      reasonKeys: ['approval.required'],
      activationHint: `先 tooling:replace(pageIn:["${capabilityId ?? card.id}"])；授权通过后，目标工具会按动态工具空间预算换入/暴露。`,
    })
  }

  if (hasReason(card, 'plugin', 'user_action_required')) {
    dependencies.push({
      id: 'plugin_user_action',
      kind: 'plugin',
      state: 'requires_user_action',
      required: true,
      summary: '目标能力依赖外部连接器或用户侧动作，必须向用户展示动作卡。',
      pageId: 'tool:interaction:show_action_cards',
      pageIn: ['tool:interaction:show_action_cards'],
      nextTool: 'interaction:show_action_cards',
      reasonKeys: ['plugin.user_action_required'],
      activationHint:
        '先定位阻塞页；再换入 interaction:show_action_cards，构造 blocking=true 的插件卡（enable_prompt_features 标"批准" + 一个 reject 标"拒绝"）等待用户完成。',
    })
  }

  if (
    hasReason(card, 'runtime', 'unavailable') ||
    hasReason(card, 'runtime', 'no_available_tools')
  ) {
    dependencies.push({
      id: 'runtime_available_tool',
      kind: 'runtime',
      state: 'blocked',
      required: true,
      summary: '工具或能力在当前运行态不可用。',
      pageId: null,
      pageIn: [],
      nextTool: 'tooling:map',
      reasonKeys: card.reasons.filter((reason) => reason.layer === 'runtime').map(reasonKey),
      activationHint: '回到 tooling:map 或 tooling:map(op:"find") 查看替代工具或等待运行态恢复。',
    })
  }

  if (hasReason(card, 'resident', 'loadable')) {
    dependencies.push({
      id: `resident:${card.id}`,
      kind: 'residency',
      state: 'loadable',
      required: false,
      summary: '工具已授权但不在本轮可见工具空间；需要先 page-in，让真实 schema 在下一轮暴露。',
      pageId: card.id,
      pageIn: [card.id],
      nextTool: 'tooling:replace',
      reasonKeys: ['resident.loadable'],
      activationHint: 'tooling:replace(pageIn:[tool]) 后下一轮调用真实工具。',
    })
  }

  if (hasReason(card, 'resident', 'visible') || hasReason(card, 'capability', 'enabled')) {
    dependencies.push({
      id: card.kind === 'tool' ? `resident:${card.id}` : card.id,
      kind: card.kind === 'tool' ? 'residency' : 'capability',
      state: 'satisfied',
      required: false,
      summary: card.kind === 'tool' ? '工具已在本轮可见工具空间中。' : '能力已经启用。',
      pageId: card.id,
      pageIn: [],
      nextTool: card.kind === 'tool' ? card.name : null,
      reasonKeys: card.reasons
        .filter((reason) => reason.layer === 'resident' || reason.layer === 'capability')
        .map(reasonKey),
      activationHint:
        card.kind === 'tool' ? '直接调用真实工具。' : '查看具体工具页决定直接调用或 page-in。',
    })
  }

  return dependencies
}

/**
 * 拼出给模型照做的分步激活流程：先放**必需且尚未满足**的依赖的 activationHint（satisfied 的不占位），
 * 再按激活方式追加最后一步——`direct_call` 直接调用、`page_in_only` 换入本页（能力页额外提醒下一轮
 * 还要看目标工具页）、`request_approval` 换入能力页申请、`request_user_action` 换入前置入口再请求用户动作
 * （没有 pageIn 时退化成「看 reasons」）、其余走 `inspect_reasons` 让模型改查替代。最后整体去重。
 * **每个分支都至少 push 一条可执行指令**是硬不变量：空流程会让模型自己猜，实测会退化成反复 page-in
 * 同一张不可用页。
 */
function buildActivationFlow(input: {
  card: ToolDiscoveryCard
  method: ToolActivationMethod
  pageIn: readonly string[]
  nextTool: Nullable<string>
  dependencies: readonly ToolDependencyGuide[]
}): string[] {
  const flow = input.dependencies
    .filter((dependency) => dependency.required && dependency.state !== 'satisfied')
    .map((dependency) => dependency.activationHint)

  if (input.method === 'direct_call') {
    flow.push(`直接调用 ${input.card.name}，使用本轮 AI SDK tools 中的完整 schema。`)
  } else if (input.method === 'page_in_only') {
    if (input.card.kind === 'capability') {
      flow.push(
        `tooling:replace(pageIn:["${input.card.id}"]) 启用该能力；下一轮重新查看具体工具页状态，再按目标工具 activation 调用。`
      )
    } else {
      flow.push(`tooling:replace(pageIn:["${input.card.id}"])，下一轮直接调用 ${input.card.name}。`)
    }
  } else if (input.method === 'request_approval') {
    const target = input.pageIn[0] ?? input.card.id
    flow.push(
      `tooling:replace(pageIn:["${target}"]) 请求启用能力；通过后重新读取工具状态或下一轮调用。`
    )
  } else if (input.method === 'request_user_action') {
    if (!isEmpty(input.pageIn)) {
      flow.push(
        `先 tooling:replace(pageIn:${JSON.stringify(input.pageIn)}) 换入前置入口，再调用 ${input.nextTool ?? '对应工具'} 完成用户动作。`
      )
    } else {
      flow.push('查看 reasons，按能力提供方声明的阻塞项请求用户动作。')
    }
  } else {
    flow.push('查看 reasons 和 dependency guide，改查替代工具或处理阻塞条件。')
  }

  return [...new Set(flow)]
}

/**
 * 给一份只写了 method / summary / pageIn / nextTool / notes 的半成品激活指引补齐后两块：
 * 由页推出的 `dependencies`，以及据此拼出的 `activationFlow`。
 * 各个 availability 分支只需描述「怎么用」，依赖与流程统一在这里长出来，不必各分支重复一遍。
 */
function withActivationDependencies(
  card: ToolDiscoveryCard,
  guide: Omit<ToolActivationGuide, 'dependencies' | 'activationFlow'>
): ToolActivationGuide {
  const dependencies = buildToolDependencyGuides(card)
  return {
    ...guide,
    dependencies,
    activationFlow: buildActivationFlow({
      card,
      method: guide.method,
      pageIn: guide.pageIn,
      nextTool: guide.nextTool,
      dependencies,
    }),
  }
}

/**
 * 把一张工具页翻译成完整的激活指引——「这张页现在能不能用、用不了该做什么」的唯一推导处。
 * 按 `card.availability` 分派激活方式：`visible` → `direct_call`；
 * `loadable` → `page_in_only`，并按页种类（plugin / capability / tool）给不同的说明，
 * 其中能力页与插件页本身不可执行，启用后还得回看目标工具页；
 * `requires_approval` → `request_approval`（page-in 能力页，插件页退回页自身 id）；
 * `requires_user_action` → `request_user_action`，其中由插件声明的用户动作走动作卡、
 * 其余只能让模型看 reasons；其他一切情况兜底到 `inspect_reasons`，指回 tooling:map 找替代。
 * 每条出口都过 `withActivationDependencies` 补依赖与流程。本函数只做翻译，不自行推断可用性。
 */
export function buildToolActivationGuide(card: ToolDiscoveryCard): ToolActivationGuide {
  if (card.availability === 'visible') return withActivationDependencies(card, {
      method: 'direct_call',
      summary: '已在本轮 AI SDK tools 中暴露完整 schema，可直接调用。',
      pageIn: [],
      capabilityId: activationCapabilityIdForCard(card),
      nextTool: card.kind === 'tool' ? card.name : null,
      notes: ['按当前工具 schema 直接构造参数。'],
    })

  if (card.availability === 'loadable') {
    switch (card.kind) {
      case 'plugin':
        return withActivationDependencies(card, {
          method: 'page_in_only',
          summary:
            '插件可静默启用；用 tooling:replace page-in 插件页，下一轮再调用目标能力的真实工具。',
          pageIn: [card.id],
          capabilityId: activationCapabilityIdForCard(card),
          nextTool: 'tooling:replace',
          notes: [
            '插件页本身不是可执行工具；启用后重新查看目标工具页，或直接调用下一轮暴露的入口工具。',
          ],
        })
      case 'capability':
        return withActivationDependencies(card, {
          method: 'page_in_only',
          summary:
            '该能力已预授权但尚未启用；用 tooling:replace page-in 启用能力，下一轮再按具体工具页状态调用目标工具。',
          pageIn: [card.id],
          capabilityId: activationCapabilityIdForCard(card),
          nextTool: 'tooling:replace',
          notes: [
            '能力页本身不是可执行工具；启用后重新查看目标工具页，按目标工具的 toolOsState、activation 和真实 schema 执行。',
          ],
        })
      case 'tool':
        return withActivationDependencies(card, {
          method: 'page_in_only',
          summary:
            '已授权但未驻留；先用 tooling:replace page-in，下一轮通过真实工具 schema 调用。',
          pageIn: [card.id],
          capabilityId: activationCapabilityIdForCard(card),
          nextTool: 'tooling:replace',
          notes: [
            '主模型不通过反射代理或单工具详情读取来构造参数。',
            '需要执行该工具时，用 replace page-in，让真实 schema 在下一轮暴露。',
          ],
        })
    }
  }

  if (card.availability === 'requires_approval') {
    const capabilityId = activationCapabilityIdForCard(card)
    return withActivationDependencies(card, {
      method: 'request_approval',
      summary: '能力尚未启用；先用 tooling:replace 请求启用能力或目标工具页。',
      pageIn: [capabilityId ?? card.id],
      capabilityId,
      nextTool: 'tooling:replace',
      notes: ['replace 通过后，下一轮再调用真实工具；未通过则按 requiresApprovalDetails 处理。'],
    })
  }

  if (card.availability === 'requires_user_action') {
    const pluginUserAction = card.reasons.some(
      (reason) => reason.layer === 'plugin' && reason.code === 'user_action_required'
    )
    return withActivationDependencies(card, {
      method: 'request_user_action',
      summary: pluginUserAction
          ? '外部连接器或用户侧动作尚未完成；先用 interaction:show_action_cards 请求用户动作。'
          : '需要先完成能力提供方声明的用户动作；查看 reasons 和 dependencies。',
      pageIn: pluginUserAction
          ? ['tool:interaction:show_action_cards']
          : [],
      capabilityId: activationCapabilityIdForCard(card),
      nextTool: pluginUserAction
          ? 'interaction:show_action_cards'
          : null,
      notes: ['完成用户动作后重新查看工具页状态，不要重复调用当前不可用工具。'],
    })
  }

  return withActivationDependencies(card, {
    method: 'inspect_reasons',
    summary: '当前不可用；先查看 reasons，改查工具空间状态清单或选择替代工具。',
    pageIn: [],
    capabilityId: activationCapabilityIdForCard(card),
    nextTool: 'tooling:map',
    notes: ['用 tooling:map 或 tooling:map(op:"find"/"page") 查看系统所有工具状态、功能摘要和替代路径。'],
  })
}

/**
 * 把一条不可用原因瘦身成模型面的 ref：只留 layer / code / message，
 * 内部诊断字段不带出去（模型需要的是「哪一层挡住了、怎么说的」，不是排障细节）。
 */
export function summarizeReasonRef(reason: ToolDiscoveryReason): ToolReasonRef {
  return {
    layer: reason.layer,
    code: reason.code,
    message: reason.message,
  }
}

/**
 * 把一条依赖瘦身成模型面的 ref：保留 id/kind/state/required/pageId/pageIn/nextTool/reasonKeys
 * 这些**可执行**的部分，丢掉 `summary` 与 `activationHint` 两段散文——它们已经在 activationFlow 里
 * 逐条出现过，在每条依赖上再重复一遍纯属占预算。
 */
function summarizeDependencyRef(dependency: ToolDependencyGuide): ToolDependencyRef {
  return {
    id: dependency.id,
    kind: dependency.kind,
    state: dependency.state,
    required: dependency.required,
    pageId: dependency.pageId,
    pageIn: dependency.pageIn,
    nextTool: dependency.nextTool,
    reasonKeys: dependency.reasonKeys,
  }
}

/**
 * 把完整激活指引瘦身成模型面的 ref：留 method/pageIn/capabilityId/nextTool 与瘦身后的依赖清单，
 * 丢掉 summary、notes 与 activationFlow 三段文本。工具页清单里每张页都要带一份 activation，
 * 散文在这个位置太贵——需要完整版的地方（如单页详情）另走 `buildToolActivationGuide`。
 */
function summarizeActivationRef(activation: ToolActivationGuide): ToolActivationRef {
  return {
    method: activation.method,
    pageIn: activation.pageIn,
    capabilityId: activation.capabilityId,
    nextTool: activation.nextTool,
    dependencies: activation.dependencies.map(summarizeDependencyRef),
  }
}

/**
 * 一步取出某页的**模型面**激活 ref：先推完整指引再瘦身。
 * 工具页清单、find 结果等每页都要带一份 activation 的地方用它。
 */
export function buildToolActivationRef(card: ToolDiscoveryCard): ToolActivationRef {
  return summarizeActivationRef(buildToolActivationGuide(card))
}
