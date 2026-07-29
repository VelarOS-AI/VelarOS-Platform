import type { CatalogLocale } from '@catalog/catalogPrimitives'
import type { MessageKey } from '@catalog/i18n'
import type {
  ComponentLibraryEntry,
  ComponentLibrarySection,
} from '@catalog/models/componentLibraryTypes'
import type { ComponentLibraryTranslate } from '@catalog/page/componentLibraryPageTypes'

interface LocalizedEntryPatch {
  domain?: string
  usage?: string
  avoid?: string
  examples?: Record<string, string>
}

interface LocalizedRecommendationPatch {
  title?: string
  description?: string
}

const zhExampleLabels: Record<string, string> = {
  variants: '变体',
  toolbar: '工具栏',
  'form-controls': '表单控件',
  choices: '选择控件',
  badges: '徽标',
  panels: '面板',
  tabs: '局部视图',
  'ui-token-scale': '变量梯度',
  'surface-token-scale': '色彩梯度',
  'workbench-token-scale': '作用域变量梯度',
  'main-window-preview': '界面预览',
  'editor-preview': '编辑器预览',
  'chat-message-bubble-states': '样例：用户、已完成助手和流式助手',
  'chat-guidance-queue-fixture': '样例：可排序引导队列',
  'chat-runtime-notices': '样例：等待输入和失败提示',
  'chat-runtime-skeleton': '样例：侧栏加载骨架',
  'browser-linked-chat-pane-fixture': '样例：浏览器侧栏对话',
  'workspace-session-fixture': '样例：工作区选择器',
  'workspace-git-fixture': '样例：有改动的分支',
  'tool-result-fixture': '样例：分组工具结果',
  'tool-result-states': '样例：提升状态',
  'session-sticky-dock-fixture': '样例：会话级卡片停靠栏',
  'chat-interaction-notice-fixture': '样例：对话通知语气',
  'interaction-suggestion-card-fixture': '样例：建议卡壳层',
  'tool-renderers-fixture': '样例：命令输出与 update_plan 计划卡片',
  'composer-neutral-switch': '通用：对话 composer 菜单内的 neutral Switch',
  'buttons-interactive-demo': 'Button / IconButton 属性',
  'feedback-interactive-demo': 'Badge / Panel 属性',
  'choice-controls-interactive-demo': 'Switch / Checkbox / SegmentedControl 属性',
  'velar-sail-mark-interactive-demo': '可配置预览',
  'button-auxiliary': '复制与删除线框按钮',
  'data-table': '数据表与业务表',
  'business-surface-variants': '变体',
  'overlay-fixture': '样例：对话框与浮层',
  'disclosure-surfaces': '折叠与调试表面',
}

const zhRecommendationPatches: Record<string, LocalizedRecommendationPatch> = {
  'buttons:primary-command': {
    title: '设置弹窗底部（保存流）',
    description: 'outline 取消 + 主按钮保存，均为 size="sm"，放在 SettingsPanelDialog footer。',
  },
  'buttons:secondary-command': {
    title: '危险操作确认底部',
    description: 'outline 关闭 + destructive 确认，保持紧凑 sm 高度。',
  },
  'buttons:toolbar-icon': {
    title: '分区搜索（设置页）',
    description: '与 SkillSettingsPanel 区块搜索一致：AnchoredPopover 锚点内 ghost + icon-sm。',
  },
  'buttons:visible-boundary': {
    title: '区块标题附加操作（技能）',
    description: '与 SkillSettingsPanel 标题行一致：在搜索 Popover 旁使用 ghost icon-sm 创建按钮。',
  },
  'fields:compact-filter': {
    title: 'Popover 内筛选输入',
    description: '与 Memory/Skill 设置搜索 Popover 相同：size="sm" 的 Input 与本地化 placeholder。',
  },
  'fields:select-with-description': {
    title: '表单栅格里的 Select',
    description: '绑定草稿态的 Select size="sm"。',
  },
  'fields:textarea-notes': {
    title: '长文本字段',
    description: '多行 Textarea size="sm"。',
  },
  'fields:calendar-date-picker': {
    title: '定时任务日期锚点',
    description:
      '对话框内需要日期锚点时使用 CalendarDatePicker；如果业务存时间戳，再组合独立的 TimePicker。',
  },
  'choice-controls:quiet-switch': {
    title: '权限行开关',
    description: '与 PermissionToggleCard 相同：SettingsRow + Switch size="sm"，不使用 tone 覆盖。',
  },
  'choice-controls:segmented-local-mode': {
    title: '设置卡片内的策略切换',
    description: '设置卡片头部的 SegmentedControl 做策略/模式切换，而非应用主导航。',
  },
  'choice-controls:tool-catalog-checkbox': {
    title: '工具行复选框',
    description: '与 ToolCatalogPanel 相同：行尾的 Checkbox size="sm" 与堆叠文案。',
  },
  'feedback:action-card': {
    title: '对话中的操作反馈卡片',
    description: '使用明确的状态语气、紧凑标题/描述与 Phosphor 图标按钮。',
  },
  'tabs:local-tabs': {
    title: '设置页外壳',
    description:
      '与 SettingsPage 相同：ScrollArea + Stack + Tabs；请复用 SettingsTabsFrame 避免复制外壳。',
  },
  'velar-sail-mark:startup-intro': {
    title: '开屏（steady 船标）',
    description:
      'StartupIntro 将放大的 steady 船标放在 appStartupSailScene 内，并使用滑动风线；外层容器在开屏阶段设置 aria-busy。',
  },
  'velar-sail-mark:sidebar-tiny': {
    title: '侧栏收起时的船标',
    description:
      'SidebarHeader 在侧栏收起时于 ghost 品牌 Button 内展示 tiny + steady 船标（展开时显示文字标题）。',
  },
  'velar-sail-mark:empty-state-large': {
    title: '对话空状态',
    description:
      'EmptyState 在居中 Stack 顶部放 large + steady 船标，其下为 WorkspaceSessionControl。',
  },
  'disclosure-surfaces:tool-catalog-category': {
    title: '工具目录分组',
    description:
      'ToolCatalogPanel 用 Disclosure + surface="muted"、meta 计数与行尾 Checkbox 承载每个分类。',
  },
  'disclosure-surfaces:tool-call-card': {
    title: '对话工具折叠块',
    description:
      'ToolCallBlock 用 ToolDisclosureCard 展示状态与前导图标，内层 Stack 承载参数/结果；紧凑模式退回 CompactToolRow。',
  },
  'disclosure-surfaces:widget-debug-frame': {
    title: 'Widget 调试外框',
    description:
      'WidgetToolRender 使用独立 shell 包裹内联预览，头部有弱背景，左侧标题更醒目，右侧保留复制、下载、重跑与源码 action。',
  },
  'data-table:settings-business-data-table': {
    title: '设置列表基于 BusinessDataTable',
    description:
      '设置里的表格不是第二套表格基元：SkillManagementPanel 在 BusinessDataTable 上叠无边框样式、可选 headerSlot 工具条、排序列、行操作与客户端分页。新增类似列表应对齐该实现，而不是在组件库再挂一层「业务表格」条目。',
  },
  'fields:settings-memory-and-model-forms': {
    title: '设置里的模型 / 系统表单组合',
    description:
      'ModelSelectionControl、ModelProviderConfigCard、ModelSettingsStatusBlock、DefaultEditorSelectRow、SystemPromptAppendField 等仍由本节 Input / Select / Textarea / SettingsRow 等基元堆叠而成；请直接对照源码实现，而不是在业务组件分区重复开条目。',
  },
  'layout-primitives:project-discovery-roots-list': {
    title: '可编辑扫描根列表',
    description:
      'ProjectDiscoveryRootsPanel 在设置卡片内用 Stack、行内操作与边框 token 组成密集列表；在「布局基元」推荐用法中对照实现即可。',
  },
  'business-surfaces:memory-record-detail-pane': {
    title: '检查面板分区',
    description: '使用 BusinessSurface 的 default / code 变体承载摘要与代码式正文；见推荐用法。',
  },
}

const zhEntryPatches: Record<string, LocalizedEntryPatch> = {
  buttons: {
    domain: '主窗口',
    usage:
      'Button 用于设置弹窗、TopBar 等；IconButton 用于分区搜索、SettingsSection 标题附加区（ghost + icon-sm）；CopyButton 与 DeleteOutlineIconButton 用于剪贴板与危险图标操作。',
    avoid: '图标独占点击不要用 Button；IconButton 内不要放可见文字；对话框 footer 保持 sm 密度。',
  },
  fields: {
    domain: '主窗口',
    usage:
      '设置表单使用 Select/Textarea、分区 Popover 内的 Input 等；扩展控件用 NumberInput / Picker。模型 / 系统设置里的其它表单行见本页「推荐用法」中的源码索引。',
    avoid: '不要把 IPC DTO 直接绑到控件；由 hooks/settings 映射成 view model。',
  },
  'choice-controls': {
    domain: '主窗口',
    usage:
      'PermissionToggleCard 的 SettingsRow+Switch、设置卡片头部的 SegmentedControl 策略切换、ToolCatalogPanel 行内 Checkbox；这些业务文件是基元的参考组合，见本页示例与推荐用法，而非在业务分区重复开条目。',
    avoid: '不要用纯文字 Button 承载持久二元状态；不要用 Tabs 代替 SegmentedControl 做应用主导航。',
  },
  feedback: {
    domain: '主窗口',
    usage:
      'ActionCard 用于紧凑操作反馈；徽标/面板/SettingsSection 参考模型与系统设置卡片的排版。',
    avoid: 'ActionCard 不要塞长文；表格或大段说明用 SettingsCard / Panel。',
  },
  'velar-sail-mark': {
    domain: '品牌',
    usage:
      '船标：StartupIntro 在 appStartupSailScene 内使用放大的 steady 船标与滑动风线；侧栏收起时 SidebarHeader 在 ghost 品牌 Button 内用 tiny+steady；EmptyState 在 WorkspaceSessionControl 之上叠 large+steady 与滑动风线。',
    avoid:
      '不要在单行密集工具栏里堆多个船标；tiny 留给轨道 chrome，splash 留给开屏，large 留给空状态与大面积留白。',
  },
  overlays: {
    domain: '主窗口',
    usage:
      'Dialog 用于通用阻塞；SettingsPanelDialog 用于设置/检查类面板（软分割、footer）；Popover / AnchoredPopover / Tooltip / CascadingMenu / ImagePreviewDialog 按场景选用。',
    avoid: '不要用浮层代替整页布局；菜单保持紧凑，示例中避免隐含副作用。',
  },
  'disclosure-surfaces': {
    domain: '调试 / 工具结果',
    usage:
      'Disclosure 用于设置或目录式分组（ToolCatalogPanel）；ToolDisclosureCard 用于对话工具块（ToolCallBlock）；WidgetToolRender 作为带头部背景的默认展开 shell；CompactToolRow 用于单行摘要。',
    avoid: '不要在调试渲染里手写 `<details>` 样式；状态点不要重复套在 ToolDisclosureCard 外。',
  },
  'data-table': {
    domain: '主窗口',
    usage:
      'DataTable 用于带外框条纹与分页的通用表；BusinessDataTable 默认无边框列表样式。技能等设置列表是该基元上的组合实现，见本页「推荐用法」。',
    avoid: '不要用于对话流式长文；语义保持原生 table。',
  },
  'business-surfaces': {
    domain: '主窗口',
    usage:
      'BusinessSurface 用于 SettingsPanelDialog 内与详情里的无框 tonal 块（如 SkillEditorDialog）；详情分区组合见「推荐用法」。',
    avoid: '不要用它替换通用布局里的 Panel；仅用于业务/只读块。',
  },
  'layout-primitives': {
    domain: '主窗口',
    usage:
      'Stack / Inline / List / ScrollArea / CollapsibleNav 组合密集界面；AppShell 与 App.tsx 一致。项目发现根目录等列表壳见「推荐用法」。文档或 Story 中请使用 `embedded` 并在外层写死高度，避免 `100vh` 撑破可滚动页面。',
    avoid: '能用 Stack/Inline 表达时不要写一次性间距包装。',
  },
  tabs: {
    domain: '主窗口',
    usage: '设置页使用 SettingsPage + SettingsTabsFrame 的 Tabs 外壳承载各设置分区。',
    avoid: '不要把该外壳模式套到对话主导航；对话导航仍在 shell / 顶栏。',
  },
  'workspace-session-control': {
    domain: '工作区',
    usage: '用于展示、添加或切换当前会话绑定的工作区。',
    avoid: '不要在父页面里重新调用 preload 来拼装这里已经维护的工作区状态。',
  },
  'workspace-git-commit-control': {
    domain: 'Git',
    usage: '用于对话或工作台界面共享分支、提交和同步操作。',
    avoid: '不要在 feature 面板里重复获取 Git 摘要或复制提交行为。',
  },
  'tool-result-summary-list': {
    domain: '工具结果',
    usage: '用于在对话、调试或工作台界面紧凑展示分组工具活动。',
    avoid: '不要直接传入原始 ToolCallBlock；先映射成稳定 view model。',
  },
  'tool-result-live-renderers': {
    domain: '工具结果',
    usage: '用于提升可在调试面板外面向用户展示的稳定渲染器。',
    avoid: '不要把仅用于调试的事件形状泄漏到普通对话 UI。',
  },
  'session-sticky-dock': {
    domain: '对话展示',
    usage: '用于在对话顶部固定一组可插入的会话级业务卡片，并支持整体折叠。',
    avoid: '不要把 dock 绑定到某一种卡片；通过 item view model 传入可插入的卡片内容。',
  },
  'chat-interaction-notice': {
    domain: '对话展示',
    usage: '用于对话内轻量通知条（运行中、警告、错误）。',
    avoid: '不要绑定 ChatRuntimeState；由上层传入 tone 与文案。',
  },
  'interaction-suggestion-card': {
    domain: '对话展示',
    usage: '用于对话内 ActionCard 建议卡的统一壳层。',
    avoid: '不要把 block 解析或 IPC 放进壳层组件。',
  },
  'tool-renderers': {
    domain: '调试 / 工具输出',
    usage:
      '用于 bash / update_plan 等工具输出的折叠与紧凑行：`ToolRendererExample` fixtures 内需同时预览命令输出与「计划卡片」两种 ToolCallBlock 形状。',
    avoid: '更新计划时不要新建一次性卡片；通过 ToolCallBlock 复用内置工具渲染注册。',
  },
  'chat-message-bubble': {
    domain: '对话展示',
    usage: '用于审阅用户和助手消息状态的可见契约：附件、工具活动、流式输出和行内状态。',
    avoid: '组件库样例不要挂接真实的打开路径、安装动作或 reveal 操作。',
  },
  'chat-guidance-queue': {
    domain: '对话输入',
    usage: '用于审阅引导队列的拖拽排序、单行省略、立即引导、退回输入框编辑和删除。',
    avoid: '不要在队列行内直接编辑；编辑操作应先从队列取出，并恢复到聊天输入框。',
  },
  'chat-runtime-states': {
    domain: '对话展示',
    usage: '用于审阅对话流周围的运行时提示和加载状态。',
    avoid: '不要把组件库样例接到真实 runtime 回调或活动会话。',
  },
  'browser-linked-chat-pane': {
    domain: '对话 / 浏览器',
    usage: '用于浏览器模式需要一个共享当前对话界面的停靠对话面板。',
    avoid: '组件库样例不要打开弹出窗口；浏览器 fixture 保持在进程内。',
  },
  'ui-foundation-tokens': {
    domain: '主窗口 + 共享 UI',
    usage:
      '用于 UI 和业务组件共享的排版、间距、圆角和控件密度；组件库表格中的数值在渲染时从 `:root` 经 getComputedStyle 读取。',
    avoid: '重复组件尺寸不要写一次性 px；优先新增或复用 token。',
  },
  'surface-status-tokens': {
    domain: '主窗口',
    usage:
      '优先使用语义化表面、边框和状态 token，再选择原始颜色值；组件库表格中的数值在渲染时从 `:root` 经 getComputedStyle 读取。',
    avoid: '不要把状态颜色编码到单个组件或 feature CSS module 里。',
  },
  'workbench-scoped-tokens': {
    domain: '工作台 / 编辑器窗口',
    usage:
      '仅在 workbench 根作用域下用于类 IDE 的密集面板、树、标签和编辑器 chrome；组件库预览容器挂载与 Workbench `.root` 相同类名，数值从该节点 getComputedStyle 读取。',
    avoid: '不要在对话、设置、shell 或主窗口业务组件中消费 --workbench-*。',
  },
  'main-window-domain': {
    domain: '对话 / 设置 / Shell',
    usage: '作为默认产品界面使用：平静密度、柔和面板、共享 UI tokens。',
    avoid: '不要把 workbench 专用 token 引入对话、设置或 shell 组件。',
  },
  'editor-domain': {
    domain: '工作台',
    usage: '用于类 IDE 的密集界面、文件树、编辑器标签、Git diff 和终端区域。',
    avoid: '不要创建第二套行为栈；通过 scope 和 variant 适配共享 UI。',
  },
}

function getLocalizedExampleLabel(exampleId: string, label: string): string {
  return zhExampleLabels[exampleId] ?? label.replace(/^Fixture: /, '样例：')
}

function getLocalizedRecommendations(
  entry: ComponentLibraryEntry
): ComponentLibraryEntry['recommendations'] {
  return entry.recommendations?.map((recommendation) => {
    const patch = zhRecommendationPatches[`${entry.id}:${recommendation.id}`]

    if (!patch) return recommendation

    return {
      ...recommendation,
      title: patch.title ?? recommendation.title,
      description: patch.description ?? recommendation.description,
    }
  })
}

function translateRegistryFacet(
  t: ComponentLibraryTranslate,
  facet: 'registrySections' | 'registryEntries',
  facetId: string,
  fallback: string
): string {
  const key = `componentLibrary.${facet}.${facetId}` as MessageKey
  const translated = t(key)

  return translated === key ? fallback : translated
}

/** Section nav / doc breadcrumb titles — follows current UI locale (`t`). */
export function resolveComponentLibrarySectionTitleDisplay(
  t: ComponentLibraryTranslate,
  sectionId: string,
  registryFallbackTitle: string
): string {
  return translateRegistryFacet(t, 'registrySections', sectionId, registryFallbackTitle)
}

/**
 * Sidebar + document heading label. Registry keeps English `entry.name` for codegen & API merging;
 * this is user-facing display only.
 */
export function resolveComponentLibraryEntryDisplayName(
  t: ComponentLibraryTranslate,
  entryId: string,
  registryFallbackName: string
): string {
  return translateRegistryFacet(t, 'registryEntries', entryId, registryFallbackName)
}

function getLocalizedEntry(entry: ComponentLibraryEntry): ComponentLibraryEntry {
  const patch = zhEntryPatches[entry.id]

  if (!patch)
    return {
      ...entry,
      examples: entry.examples.map((example) => ({
        ...example,
        label: getLocalizedExampleLabel(example.id, example.label),
      })),
      generalExamples: entry.generalExamples?.map((example) => ({
        ...example,
        label: getLocalizedExampleLabel(example.id, example.label),
      })),
      recommendations: getLocalizedRecommendations(entry),
    }

  return {
    ...entry,
    domain: patch.domain ?? entry.domain,
    usage: patch.usage ?? entry.usage,
    avoid: patch.avoid ?? entry.avoid,
    examples: entry.examples.map((example) => ({
      ...example,
      label: patch.examples?.[example.id] ?? getLocalizedExampleLabel(example.id, example.label),
    })),
    generalExamples: entry.generalExamples?.map((example) => ({
      ...example,
      label: patch.examples?.[example.id] ?? getLocalizedExampleLabel(example.id, example.label),
    })),
    recommendations: getLocalizedRecommendations(entry),
  }
}

export function getLocalizedComponentLibrarySections(
  sections: ComponentLibrarySection[],
  locale: CatalogLocale,
  t: ComponentLibraryTranslate
): ComponentLibrarySection[] {
  return sections.map((section) => ({
    ...section,
    title: resolveComponentLibrarySectionTitleDisplay(t, section.id, section.title),
    entries: locale === 'zh-CN' ? section.entries.map(getLocalizedEntry) : section.entries,
  }))
}
